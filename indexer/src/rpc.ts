/** Archival JSON-RPC reads at a fixed block, with fallback across URLs (regular nodes first, archival after). */
export const ONE_HOUR_BLOCKS = 6000n;

const TIMEOUT_MS = 8000;
/** Provider-side failures: another node may still answer (same set as web/lib/chain/rpc.ts). */
const PROVIDER_ERRORS = new Set(["INTERNAL_ERROR", "TIMEOUT_ERROR", "UNKNOWN_BLOCK", "NO_SYNCED_BLOCKS", "NOT_SYNCED_YET", "GARBAGE_COLLECTED_BLOCK"]);

class EndpointFailed extends Error {}
type Envelope = { result?: Record<string, unknown>; error?: { cause?: { name?: string }; message?: string; data?: unknown } };

export function createArchivalRpc(urls: string[], f: typeof fetch = fetch) {
  if (urls.length === 0) throw new Error("no RPC URLs configured");

  async function callOne(url: string, method: string, params: object): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "foundling-indexer", method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new EndpointFailed(String(e));
    }
    if (!res.ok) throw new EndpointFailed(`HTTP ${res.status}`);
    const body = (await res.json()) as Envelope;
    if (body.error) {
      const name = body.error.cause?.name ?? "";
      const message = `${name} ${body.error.message ?? ""} ${JSON.stringify(body.error.data ?? "")}`.trim();
      if (PROVIDER_ERRORS.has(name)) throw new EndpointFailed(message);
      throw new Error(`RPC ${method}: ${message}`);
    }
    if (!body.result) throw new EndpointFailed("empty RPC answer");
    return body.result;
  }

  async function call(method: string, params: object): Promise<Record<string, unknown>> {
    const failures: string[] = [];
    for (const url of urls) {
      try {
        return await callOne(url, method, params);
      } catch (e) {
        if (!(e instanceof EndpointFailed)) throw e;
        failures.push(`${url}: ${e.message}`);
      }
    }
    throw new Error(`every RPC endpoint failed (${failures.join("; ")})`);
  }

  return {
    async viewAt<T>(block: bigint, contract: string, method: string, args: object): Promise<T> {
      const result = await call("query", {
        request_type: "call_function",
        block_id: Number(block),
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      });
      if (!Array.isArray(result.result)) throw new Error(`RPC view ${method}: result is not a byte array`);
      return JSON.parse(Buffer.from(result.result as number[]).toString("utf8")) as T;
    },

    async tip(): Promise<bigint> {
      const result = await call("block", { finality: "final" });
      const height = (result.header as { height?: unknown } | undefined)?.height;
      if (typeof height !== "number") throw new Error("RPC block: no header height");
      return BigInt(height);
    },
  };
}

export type ArchivalRpc = ReturnType<typeof createArchivalRpc>;
