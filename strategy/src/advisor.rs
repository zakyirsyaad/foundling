//! The NEAR AI Risk Manager's advisor (SPEC §3.2). It reads public headlines and the market,
//! and answers with a risk score, a confidence and a one-sentence reason. The rule in
//! `decide` lets that score only lower exposure: scale a buy down, veto it, or sell to USDC
//! on a severe and confident risk. Whatever goes wrong here leaves the advisor silent, and a
//! silent advisor blocks a buy and never sells.

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::sources::{observe_market, parse_decimal, Call};
use crate::{from_hex, hash_fields, to_hex, AiRef, Obs, Secret, AI_CLEAR, MAX_PERCENT};

/// General crypto news: The Block first, Cointelegraph if that feed is down.
const FEEDS: [(&str, &str); 2] = [
    ("www.theblock.co", "/rss.xml"),
    ("cointelegraph.com", "/rss"),
];
/// Market context for the AI Risk Manager. Not a rule input, so not in `obs`.
const TICKER_HOST: &str = "api.kraken.com";
const TICKER_PATH: &str = "/0/public/Ticker?pair=NEARUSD";
const TICKER_PAIR: &str = "NEARUSD";
const CHAT_HOST: &str = "cloud-api.near.ai";
const CHAT_PATH: &str = "/v1/chat/completions";
/// Both run inside NEAR's own TEE tier. The list of models changes, and a sealed vault
/// cannot, so the second is asked only when the first cannot be reached. A first model that
/// answers badly leaves the advisor silent: asking again would let a second opinion undo a
/// raised flag.
pub const MODELS: [&str; 2] = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B"];
/// Both models reason by default and the reasoning counts against this, so it leaves room
/// for the few tokens they still spend before the answer.
const MAX_OUTPUT_TOKENS: u32 = 256;
pub const MAX_TITLES: usize = 20;
pub const MAX_TITLE_CHARS: usize = 160;
/// A reason longer than this is cut; it has to fit the Decision's size target (SPEC §3.2).
pub const MAX_NOTE_CHARS: usize = 120;
/// Characters a note keeps; anything else becomes a space, so a note never needs a JSON
/// escape and can never carry markup.
const NOTE_PUNCTUATION: &str = " .,:;%()/'-";
/// Prices in `obs` carry eight decimals; the market line shows four.
const PRICE_ONE: u128 = 100_000_000;
const SHOWN_DECIMALS: u128 = 10_000;
const MAX_CHAT_ID_BYTES: usize = 64;
const FINISHED: &str = "stop";
const REQUEST_TAG: &[u8] = b"foundling/v1/request-tag";

#[derive(Debug, PartialEq)]
pub struct Advice {
    pub ai_risk: u8,
    pub ai_conf: u8,
    pub ai_ref: AiRef,
}

/// What a run saw: `ai_ref` points at the signed reply whose risk and confidence `obs` carries.
#[derive(Debug, PartialEq)]
pub struct Observed {
    pub obs: Obs,
    pub ai_ref: AiRef,
}

impl From<Obs> for Observed {
    fn from(obs: Obs) -> Self {
        Self {
            obs,
            ai_ref: AiRef::default(),
        }
    }
}

#[derive(Deserialize)]
struct Chat {
    id: String,
    model: String,
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    finish_reason: String,
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    risk: u8,
    confidence: u8,
    note: String,
}

#[derive(Deserialize)]
struct TickerReply {
    error: Vec<String>,
    result: std::collections::HashMap<String, Ticker>,
}

/// `o` opens today (00:00 UTC); `h` and `l` are `[today, last 24 hours]`.
#[derive(Deserialize)]
struct Ticker {
    o: String,
    h: [String; 2],
    l: [String; 2],
}

/// Prices first: a market that cannot be read ends the run without spending credit.
pub fn observe(
    secret: &Secret,
    nonce: u64,
    mut send: impl FnMut(&Call) -> Option<Vec<u8>>,
) -> Option<Observed> {
    let obs = observe_market(&mut send)?;
    let advice = secret.ai_key.as_deref().and_then(|key| {
        let tag = request_tag(&from_hex(&secret.salt)?, nonce);
        ask(&secret.params.prompt, &tag, key, &obs, &mut send)
    });
    let Some(advice) = advice else {
        return Some(obs.into());
    };
    Some(Observed {
        obs: Obs {
            ai_flag: AI_CLEAR,
            ai_conf: advice.ai_conf,
            ai_risk: Some(advice.ai_risk),
            ..obs
        },
        ai_ref: advice.ai_ref,
    })
}

/// Ties the signed request to the sealed salt. NEAR AI's signature covers the hash of the
/// request, and without this that is a hash of the prompt and public headlines alone, which
/// would let anyone holding the signature test guesses of the prompt before `reveal`. After
/// `reveal` anyone can recompute it from the salt and the cycle's nonce.
fn request_tag(salt: &[u8], nonce: u64) -> String {
    hash_fields(REQUEST_TAG, &[salt, &nonce.to_be_bytes()])
}

fn ask(
    prompt: &str,
    tag: &str,
    key: &str,
    market: &Obs,
    send: &mut impl FnMut(&Call) -> Option<Vec<u8>>,
) -> Option<Advice> {
    let titles = FEEDS.iter().find_map(|&(host, path)| {
        let feed = send(&Call {
            host,
            path,
            body: None,
            headers: Vec::new(),
        })?;
        read_titles(&feed)
    })?;
    let ticker = send(&Call {
        host: TICKER_HOST,
        path: TICKER_PATH,
        body: None,
        headers: Vec::new(),
    })
    .and_then(|reply| read_ticker(&reply));
    let headlines = format!(
        "{}\n\n{}\n\nref:{tag}",
        titles.join("\n"),
        market_line(market, ticker)
    );
    let (asked, reply) = MODELS.iter().enumerate().find_map(|(index, model)| {
        let reply = send(&Call {
            host: CHAT_HOST,
            path: CHAT_PATH,
            body: Some(chat_body(model, prompt, &headlines)),
            headers: chat_headers(key),
        })?;
        Some((index, reply))
    })?;
    read_advice(&reply, asked)
}

/// `x-no-aliasing` keeps the gateway from answering with another model, whose TEE would not
/// have signed the reply.
fn chat_headers(key: &str) -> Vec<(&'static str, String)> {
    vec![
        ("authorization", format!("Bearer {key}")),
        ("x-no-aliasing", "true".to_string()),
    ]
}

/// Non-streaming, so the reply bytes are what the model's TEE signs.
fn chat_body(model: &str, prompt: &str, headlines: &str) -> String {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": prompt },
            { "role": "user", "content": headlines },
        ],
        "temperature": 0,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": false,
    });
    keep_reasoning_short(model, &mut body);
    body.to_string()
}

/// GLM-5.3 Flash keeps its reasoning to about 20 tokens at `reasoning_effort` "low";
/// switching its thinking off only moves the reasoning into `content`. Qwen turns thinking
/// off through its chat template. (docs.near.ai/cloud/reasoning-models)
fn keep_reasoning_short(model: &str, body: &mut serde_json::Value) {
    if model == MODELS[0] {
        body["reasoning_effort"] = json!("low");
    } else {
        body["chat_template_kwargs"] = json!({ "enable_thinking": false });
    }
}

/// Today's open, the 24-hour high and the 24-hour low, eight decimals like `obs`.
pub fn read_ticker(reply: &[u8]) -> Option<(u128, u128, u128)> {
    let reply: TickerReply = serde_json::from_slice(reply).ok()?;
    if !reply.error.is_empty() {
        return None;
    }
    let ticker = reply.result.get(TICKER_PAIR)?;
    Some((
        parse_decimal(&ticker.o)?,
        parse_decimal(&ticker.h[1])?,
        parse_decimal(&ticker.l[1])?,
    ))
}

/// What the advisor is told about the market: the two prices the rule reads, then the day
/// from Kraken's ticker when it answered.
pub fn market_line(market: &Obs, ticker: Option<(u128, u128, u128)>) -> String {
    let mut line = format!(
        "Market: NEAR/USD Rhea pool {}, Kraken {}",
        price_text(market.pa),
        price_text(market.pb)
    );
    if let Some((open, high, low)) = ticker {
        line.push_str(&format!(
            ", today's open {}, 24h high {}, 24h low {}",
            price_text(open),
            price_text(high),
            price_text(low)
        ));
    }
    line
}

fn price_text(price: u128) -> String {
    let fraction = price % PRICE_ONE / (PRICE_ONE / SHOWN_DECIMALS);
    format!("{}.{fraction:04}", price / PRICE_ONE)
}

/// The reason as published: safe characters only, at most `MAX_NOTE_CHARS`, trimmed.
pub fn clean_note(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || NOTE_PUNCTUATION.contains(character) {
                character
            } else {
                ' '
            }
        })
        .take(MAX_NOTE_CHARS)
        .collect();
    kept.trim().to_string()
}

/// The headlines of a feed. Only the items count: the channel's own title is no news.
pub fn read_titles(feed: &[u8]) -> Option<Vec<String>> {
    let feed = std::str::from_utf8(feed).ok()?;
    let titles: Vec<String> = feed
        .split("<item>")
        .skip(1)
        .filter_map(title_of)
        .take(MAX_TITLES)
        .collect();
    (!titles.is_empty()).then_some(titles)
}

fn title_of(item: &str) -> Option<String> {
    let (_, rest) = item.split_once("<title>")?;
    let (raw, _) = rest.split_once("</title>")?;
    let raw = raw.trim();
    let text = raw
        .strip_prefix("<![CDATA[")
        .and_then(|inner| inner.strip_suffix("]]>"))
        .unwrap_or(raw)
        .trim();
    let title: String = text
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_TITLE_CHARS)
        .collect();
    // A blank title is no headline, and a feed of them should make way for the backup.
    (!title.trim().is_empty()).then_some(title)
}

/// Anything but the exact answer from the model asked, `MODELS[asked]`, counts as no
/// answer: `x-no-aliasing` should already keep another model out, and a reply that still
/// names one would carry a signature for a model the vault never chose. `resp_sig_hash` is
/// the hash of these reply bytes, the same `response_hash` that the TEE's signature covers.
pub fn read_advice(reply: &[u8], asked: usize) -> Option<Advice> {
    let chat: Chat = serde_json::from_slice(reply).ok()?;
    let [choice] = chat.choices.as_slice() else {
        return None;
    };
    if choice.finish_reason != FINISHED
        || !is_chat_id(&chat.id)
        || MODELS.get(asked) != Some(&chat.model.as_str())
    {
        return None;
    }
    let answer: Answer = serde_json::from_str(unfenced(&choice.message.content)?).ok()?;
    if answer.risk > MAX_PERCENT || answer.confidence > MAX_PERCENT {
        return None;
    }
    let note = clean_note(&answer.note);
    Some(Advice {
        ai_risk: answer.risk,
        ai_conf: answer.confidence,
        ai_ref: AiRef {
            chat_id: chat.id,
            resp_sig_hash: to_hex(&Sha256::digest(reply)),
            m: u8::try_from(asked).ok(),
            note: (!note.is_empty()).then_some(note),
        },
    })
}

/// The answer with one exact Markdown fence (```json or ```) peeled off, if it has one. A
/// sealed vault cannot follow a model that starts fencing its JSON, so the fence is allowed,
/// but nothing else around the answer is.
fn unfenced(content: &str) -> Option<&str> {
    const FENCE: &str = "```";
    let content = content.trim();
    let Some(opened) = content.strip_prefix(FENCE) else {
        return Some(content);
    };
    let opened = opened.strip_prefix("json").unwrap_or(opened);
    let inner = opened.strip_prefix('\n')?.strip_suffix(FENCE)?;
    (!inner.contains(FENCE)).then_some(inner)
}

/// The id goes into the Decision, whose reply to the vault has a hard size limit.
fn is_chat_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CHAT_ID_BYTES
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
