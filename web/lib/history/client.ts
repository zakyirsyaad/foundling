import { z } from "zod";

import { type CycleRow, MAX_ROWS, type NavPoint, type ProofResult, type WorkerStatus, cycleSchema, envelopeSchema, navSchema, proofSchema, statusSchema } from "./schemas";

export type { CycleRow, NavPoint, ProofResult, Tally, WorkerStatus } from "./schemas";
export type HistoryResult<T> = { status: "ok"; data: T; cursor: string | null } | { status: "pending"; reason: "unconfigured" | "timeout" | "http" | "invalid" };
export type CycleFilter = "all" | "executed" | "hold" | "other";

/** Short on the server so a page never waits on the API; longer in the browser. */
export const SERVER_TIMEOUT_MS = 1500;
export const BROWSER_TIMEOUT_MS = 5000;

class Timeout extends Error {}

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** History from the read-only API. Never throws: any failure is `pending`, and live pages still render. */
export function createHistoryClient(origin: string | null, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? (typeof window === "undefined" ? SERVER_TIMEOUT_MS : BROWSER_TIMEOUT_MS);

  async function get<T>(path: string, schema: z.ZodType<T>): Promise<HistoryResult<T>> {
    if (!origin) return { status: "pending", reason: "unconfigured" };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Timeout());
      }, timeoutMs);
    });
    try {
      const res = await Promise.race([fetchFn(`${origin}${path}`, { signal: controller.signal, headers: { accept: "application/json" } }), timeout]);
      if (!res.ok) return { status: "pending", reason: "http" };
      const body = envelopeSchema.safeParse(await Promise.race([res.json(), timeout]));
      if (!body.success) return { status: "pending", reason: "invalid" };
      if (!body.data.success) return { status: "pending", reason: "http" };
      if (Array.isArray(body.data.data) && body.data.data.length > MAX_ROWS) return { status: "pending", reason: "invalid" };
      const data = schema.safeParse(body.data.data);
      if (!data.success) return { status: "pending", reason: "invalid" };
      return { status: "ok", data: data.data, cursor: body.data.meta?.cursor ?? null };
    } catch (err) {
      if (err instanceof Timeout) return { status: "pending", reason: "timeout" };
      return { status: "pending", reason: err instanceof SyntaxError ? "invalid" : "http" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status: () => get<WorkerStatus>("/v1/status", statusSchema),
    cycles: (q: { cursor?: string; filter?: CycleFilter } = {}) => get<CycleRow[]>(`/v1/cycles${query({ filter: q.filter, cursor: q.cursor })}`, z.array(cycleSchema)),
    cycle: (nonce: bigint) => get<CycleRow>(`/v1/cycles/${nonce}`, cycleSchema),
    nav: (q: { from?: string; to?: string }) => get<NavPoint[]>(`/v1/nav${query(q)}`, z.array(navSchema)),
    events: (q: { cursor?: string; name?: string } = {}) => get<unknown[]>(`/v1/events${query(q)}`, z.array(z.unknown())),
    proof: (nonce: bigint) => get<ProofResult>(`/v1/proofs/${nonce}`, proofSchema),
  };
}

export type HistoryClient = ReturnType<typeof createHistoryClient>;
