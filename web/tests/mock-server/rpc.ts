import type http from "node:http";

import { type Scenario, send } from "./state";


const HEIGHT = 201;
const enc = (v: unknown) => Array.from(Buffer.from(JSON.stringify(v)));

export function handleRpc(res: http.ServerResponse, s: Scenario, raw: string): void {
  if (s.rpcDown) return send(res, 503, { error: "down" });
  const { id, method, params } = JSON.parse(raw);
  const ok = (result: unknown) => send(res, 200, { jsonrpc: "2.0", id, result });
  if (method === "block") return ok({ header: { height: HEIGHT, timestamp: String(BigInt(Date.now()) * 1_000_000n) } });
  if (method === "gas_price") return ok({ gas_price: "100000000" });
  if (method !== "query") return send(res, 200, { jsonrpc: "2.0", id, error: { message: `no ${method}` } });
  const p = params as { request_type: string; account_id: string; method_name?: string; args_base64?: string };
  if (p.request_type === "view_account") return ok({ amount: "10000000000000000000000000", storage_usage: 1000, code_hash: "11111111111111111111111111111111", block_height: HEIGHT });
  if (p.request_type === "view_access_key_list") return ok({ keys: Array.from({ length: s.accessKeys }, () => ({})), block_height: HEIGHT });
  const table = s.perAccount[p.account_id] ?? {};
  const name = p.method_name ?? "";
  const args = p.args_base64 ? Buffer.from(p.args_base64, "base64").toString() : "{}";
  const keyed = `${name}:${args}`;
  const value = keyed in table ? table[keyed] : name in table ? table[name] : s.views[keyed] ?? s.views[name];
  if (value === undefined) return ok({ error: `wasm execution failed with error: MethodResolveError(MethodNotFound) ${name}`, block_height: HEIGHT });
  return ok({ result: enc(value), block_height: HEIGHT, logs: [] });
}
