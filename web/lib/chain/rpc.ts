import { parseU128 } from "@/lib/format/units";

export interface Viewed<T> {
  value: T;
  blockHeight: bigint;
}
export interface BlockInfo {
  height: bigint;
  timestampSeconds: bigint;
}
export interface AccountInfo {
  amount: bigint;
  storageUsage: bigint;
  codeHash: string;
}
export interface RpcClient {
  view<T>(contract: string, method: string, args: object, parse: (raw: unknown) => T): Promise<Viewed<T>>;
  finalBlock(): Promise<BlockInfo>;
  viewAccount(accountId: string): Promise<Viewed<AccountInfo>>;
  accessKeyCount(accountId: string): Promise<Viewed<number>>;
  gasPrice(): Promise<bigint>;
}

export class RpcUnavailable extends Error {
  constructor(message = "every RPC endpoint failed") {
    super(message);
    this.name = "RpcUnavailable";
  }
}
export class RpcBudgetExceeded extends Error {
  constructor(budget: number) {
    super(`RPC call budget of ${budget} spent`);
    this.name = "RpcBudgetExceeded";
  }
}
export class ContractViewError extends Error {
  constructor(public readonly contractMessage: string) {
    super(contractMessage);
    this.name = "ContractViewError";
  }
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_BUDGET = 40;
const NANOS_PER_SECOND = 1_000_000_000n;

/** A retryable endpoint failure: the next URL may still answer. */
class EndpointFailed extends Error {}

function toBase64(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
}

function decodeBytes(bytes: unknown): unknown {
  if (!Array.isArray(bytes)) throw new Error("view result is not a byte array");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes as number[])));
}

type RpcEnvelope = { result?: Record<string, unknown>; error?: { cause?: { name?: string }; message?: string } };

async function post(fetchFn: typeof fetch, url: string, body: object, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EndpointFailed(`timeout after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      }),
      timeout,
    ]);
    if (!res.ok) throw new EndpointFailed(`HTTP ${res.status}`);
    const json = (await Promise.race([res.json(), timeout])) as RpcEnvelope;
    if (json.error) throw new ContractViewError(json.error.cause?.name ?? json.error.message ?? "RPC error");
    if (!json.result) throw new EndpointFailed("empty RPC result");
    return json.result;
  } catch (err) {
    if (err instanceof ContractViewError || err instanceof EndpointFailed) throw err;
    throw new EndpointFailed(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** One client per refresh: it tries each URL in order and stops after `budget` calls. */
export function createRpcClient(
  urls: readonly string[],
  opts: { fetch?: typeof fetch; timeoutMs?: number; budget?: number } = {},
): RpcClient {
  if (urls.length === 0) throw new Error("no RPC URLs");
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  let spent = 0;

  async function call(method: string, params: object): Promise<Record<string, unknown>> {
    if (spent >= budget) throw new RpcBudgetExceeded(budget);
    spent += 1;
    const body = { jsonrpc: "2.0", id: "foundling", method, params };
    let last: unknown;
    for (const url of urls) {
      try {
        return await post(fetchFn, url, body, timeoutMs);
      } catch (err) {
        if (err instanceof ContractViewError) throw err;
        last = err;
      }
    }
    throw new RpcUnavailable(last instanceof Error ? last.message : undefined);
  }

  const query = (params: object) => call("query", { finality: "final", ...params });

  return {
    async view(contract, method, args, parse) {
      const r = await query({
        request_type: "call_function",
        account_id: contract,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      });
      if (typeof r.error === "string") throw new ContractViewError(r.error);
      return { value: parse(decodeBytes(r.result)), blockHeight: BigInt(r.block_height as number) };
    },
    async finalBlock() {
      const r = await call("block", { finality: "final" });
      const header = r.header as { height: number; timestamp: string | number };
      return { height: BigInt(header.height), timestampSeconds: BigInt(header.timestamp) / NANOS_PER_SECOND };
    },
    async viewAccount(accountId) {
      const r = await query({ request_type: "view_account", account_id: accountId });
      return {
        value: { amount: parseU128(r.amount), storageUsage: BigInt(r.storage_usage as number), codeHash: String(r.code_hash) },
        blockHeight: BigInt(r.block_height as number),
      };
    },
    async accessKeyCount(accountId) {
      const r = await query({ request_type: "view_access_key_list", account_id: accountId });
      return { value: (r.keys as unknown[]).length, blockHeight: BigInt(r.block_height as number) };
    },
    async gasPrice() {
      const r = await call("gas_price", [null]);
      return parseU128(r.gas_price);
    },
  };
}
