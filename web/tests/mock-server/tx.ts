import type http from "node:http";

import { USDC, VAULT } from "./scenarios";
import { type Scenario, send } from "./state";

type Tx = { receiverId: string; methodName: string; args: Record<string, unknown>; gas: string; deposit: string };

const key = (method: string, args: object) => `${method}:${JSON.stringify(args)}`;
let counter = 0;

function table(s: Scenario, account: string): Record<string, unknown> {
  return (s.perAccount[account] ??= {});
}
function num(s: Scenario, contract: string, method: string, args: object): bigint {
  const t = s.perAccount[contract] ?? {};
  const v = t[key(method, args)] ?? s.views[method];
  return BigInt(typeof v === "string" ? v : "0");
}
function put(s: Scenario, contract: string, method: string, args: object, value: unknown) {
  table(s, contract)[key(method, args)] = value;
}

/** Applies a signed call to the scenario, the way the contract would, for the e2e flows. */
export function txCount(): number {
  return counter;
}

export function handleTx(res: http.ServerResponse, s: Scenario, raw: string): void {
  const { signer, fail, txs } = JSON.parse(raw) as { signer: string; fail: string | null; txs: Tx[] };
  if (fail) return send(res, 400, { error: fail });
  const hashes: string[] = [];
  for (const t of txs) {
    const who = { account: signer };
    const reg = { total: t.deposit, available: "0" };
    if (t.methodName === "storage_deposit") put(s, t.receiverId, "storage_balance_of", { account_id: signer }, reg);
    if (t.methodName === "ft_transfer_call") {
      const amount = BigInt(String(t.args.amount));
      const vault = String(t.args.receiver_id);
      put(s, vault, "pending_of", who, (num(s, vault, "pending_of", who) + amount).toString());
      put(s, t.receiverId, "ft_balance_of", { account_id: signer }, (num(s, t.receiverId, "ft_balance_of", { account_id: signer }) - amount).toString());
    }
    if (t.receiverId === VAULT && t.methodName === "cancel_deposit") {
      const pending = num(s, VAULT, "pending_of", who);
      put(s, VAULT, "pending_of", who, "0");
      put(s, USDC, "ft_balance_of", { account_id: signer }, (num(s, USDC, "ft_balance_of", { account_id: signer }) + pending).toString());
    }
    if (t.receiverId === VAULT && t.methodName === "redeem") {
      const shares = BigInt(String(t.args.shares));
      put(s, VAULT, "shares_of", who, (num(s, VAULT, "shares_of", who) - shares).toString());
      if (s.extra.swapNonce) put(s, VAULT, "bucket_claim", { nonce: s.extra.swapNonce, account: signer }, "1000000");
    }
    if (t.receiverId === VAULT && t.methodName === "withdraw_claimable") put(s, VAULT, "claimable_of", { account: signer, token: t.args.token }, "0");
    if (t.receiverId === VAULT && t.methodName === "claim_bucket") put(s, VAULT, "bucket_claim", { nonce: t.args.nonce, account: signer }, "0");
    hashes.push(`MockTx${++counter}${t.methodName}`);
  }
  void USDC;
  return send(res, 200, { hashes });
}
