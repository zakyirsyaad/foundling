//! The one door out of the WASM, written directly on `wasi:http`. The secret lives in this
//! process, so every crate left out is one that cannot read it, and a ready-made client has
//! neither the deadline nor the size cap below.

use foundling_strategy::sources::{call_deadline, Call};
use foundling_strategy::{advisor, Input, Observed, Secret};
use wasip2::clocks::monotonic_clock;
use wasip2::http::outgoing_handler;
use wasip2::http::types::{
    Fields, IncomingResponse, Method, OutgoingBody, OutgoingRequest, Scheme,
};
use wasip2::io::poll::{self, Pollable};
use wasip2::io::streams::StreamError;

const STATUS_OK: u16 = 200;
const JSON_HEADER: (&str, &[u8]) = ("content-type", b"application/json");
/// A block reply is about 20 KB and grows with the shard count.
const MAX_REPLY_BYTES: usize = 256 * 1024;
const READ_CHUNK_BYTES: u64 = 16 * 1024;
/// Every read of a run together, on the WASM's own clock: a host timeout starts over at each
/// stage, so a slow drip could outlast it. Running out ends in a hold, well before the
/// vault's execution limit (45 seconds in SPEC) would turn the run into a `null`.
const RUN_BUDGET_NANOS: u64 = 30_000_000_000;

pub fn observe(secret: &Secret, input: &Input) -> Option<Observed> {
    let run_deadline = monotonic_clock::now() + RUN_BUDGET_NANOS;
    advisor::observe(secret, input.nonce, |call| {
        send(call, call_deadline(monotonic_clock::now(), run_deadline))
    })
}

fn send(call: &Call, deadline: u64) -> Option<Vec<u8>> {
    let response = request(call, deadline)?;
    if response.status() != STATUS_OK {
        return None;
    }
    read_body(&response, deadline)
}

fn request(call: &Call, deadline: u64) -> Option<IncomingResponse> {
    let headers = Fields::new();
    if call.body.is_some() {
        let (name, value) = JSON_HEADER;
        headers.append(name, value).ok()?;
    }
    for (name, value) in &call.headers {
        headers.append(name, value.as_bytes()).ok()?;
    }
    let outgoing = OutgoingRequest::new(headers);
    let method = match call.body {
        Some(_) => Method::Post,
        None => Method::Get,
    };
    outgoing.set_method(&method).ok()?;
    outgoing.set_scheme(Some(&Scheme::Https)).ok()?;
    outgoing.set_authority(Some(call.host)).ok()?;
    outgoing.set_path_with_query(Some(call.path)).ok()?;
    let body = outgoing.body().ok()?;
    let pending = outgoing_handler::handle(outgoing, None).ok()?;
    write_body(body, call.body.as_deref(), deadline)?;
    wait_for(&pending.subscribe(), deadline)?;
    pending.get()?.ok()?.ok()
}

/// After `handle`, so the host drains the body as it is written: a host that buffers one
/// write before the request starts (wasmtime's default) blocks a second one for good, and
/// no deadline reaches inside a blocking call. Each write waits for room on the run's clock.
fn write_body(writer: OutgoingBody, body: Option<&str>, deadline: u64) -> Option<()> {
    if let Some(body) = body {
        let stream = writer.write().ok()?;
        let ready = stream.subscribe();
        let mut rest = body.as_bytes();
        while !rest.is_empty() {
            wait_for(&ready, deadline)?;
            let room = usize::try_from(stream.check_write().ok()?).ok()?;
            let (now, later) = rest.split_at(room.min(rest.len()));
            stream.write(now).ok()?;
            rest = later;
        }
        stream.flush().ok()?;
        wait_for(&ready, deadline)?;
        stream.check_write().ok()?;
        drop(ready);
        drop(stream);
    }
    OutgoingBody::finish(writer, None).ok()
}

fn wait_for(ready: &Pollable, deadline: u64) -> Option<()> {
    let timer = monotonic_clock::subscribe_instant(deadline);
    poll::poll(&[ready, &timer]).contains(&0).then_some(())
}

fn read_body(response: &IncomingResponse, deadline: u64) -> Option<Vec<u8>> {
    let body = response.consume().ok()?;
    let stream = body.stream().ok()?;
    let ready = stream.subscribe();
    let mut reply = Vec::new();
    while reply.len() <= MAX_REPLY_BYTES {
        wait_for(&ready, deadline)?;
        match stream.read(READ_CHUNK_BYTES) {
            Ok(chunk) => reply.extend_from_slice(&chunk),
            Err(StreamError::Closed) => return Some(reply),
            Err(_) => return None,
        }
    }
    None
}
