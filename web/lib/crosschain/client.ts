import type { OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";

import type { QuoteRequest } from "./request";

export class OneClickUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OneClickUnavailable";
  }
}

export type StatusAnswer = { status: string; raw: unknown } | "not-found";

/** The four 1Click calls the browser makes, without an API key (WEBSITE §3). */
export function createOneClick(baseUrl: string, f: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function call(path: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await f(`${baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", accept: "application/json" } });
    } catch (err) {
      throw new OneClickUnavailable(err instanceof Error ? err.message : String(err));
    }
    if (res.status === 404 || res.ok) return res;
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new OneClickUnavailable(body.message ?? `HTTP ${res.status}`);
  }
  return {
    async tokens(): Promise<unknown[]> {
      return (await call("/v0/tokens")).json() as Promise<unknown[]>;
    },
    async quote(r: QuoteRequest): Promise<OneClickQuoteResponse> {
      return (await call("/v0/quote", { method: "POST", body: JSON.stringify(r) })).json() as Promise<OneClickQuoteResponse>;
    },
    async status(depositAddress: string): Promise<StatusAnswer> {
      const res = await call(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
      if (res.status === 404) return "not-found";
      const raw = (await res.json()) as { status: string };
      return { status: raw.status, raw };
    },
    async submit(txHash: string, depositAddress: string): Promise<void> {
      await call("/v0/deposit/submit", { method: "POST", body: JSON.stringify({ txHash, depositAddress }) });
    },
  };
}

export type OneClickClient = ReturnType<typeof createOneClick>;
