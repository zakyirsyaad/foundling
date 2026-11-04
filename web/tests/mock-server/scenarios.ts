import { assetsJson, policyJson, vaultViews } from "../fixtures/vault";
import { API_ROUTES } from "./api-fixtures";
import type { Scenario } from "./state";

export const VAULT = "vault.foundling.testnet";
export const USDC = "usdc.foundling.testnet";
export const WNEAR = "wrap.testnet";

const decisions = Object.fromEntries([41, 40, 39].map((n) => [`published_decision:{"nonce":${n}}`, n === 40 ? null : `{"action":"buy","nonce":${n}}`]));
/** Defaults for any account the tests connect; a /__tx call overrides them per account. */
const accountDefaults = { shares_of: "0", pending_of: "0", net_deposit_of: "0", claimable_of: "0", storage_balance_of: null, ft_balance_of: "50000000", is_allowed: true, bucket_claim: "0", bucket: null };
const views = { ...vaultViews, ...accountDefaults, ...decisions, published_decision: null, assets: { ...assetsJson, usdc: USDC, wnear: WNEAR } };

const inflightRunning = { nonce: 9, token_in: "Usdc", token_out: "Wnear", amount_in: "12400000", min_amount_out: "1", amount_out: null, shares_snapshot: "96000000000000", shares_burned: "0", recovered: "0", stuck_since: null };
/** alice.testnet holds 10% of the shares and is registered everywhere. */
const holder = {
  'shares_of:{"account":"alice.testnet"}': "9600000000000",
  'storage_balance_of:{"account_id":"alice.testnet"}': { total: "1", available: "0" },
};

function base(name: string): Scenario {
  return { name, views, perAccount: {}, accessKeys: 0, rpcDown: false, apiDown: false, oneClickDown: false, extra: { api: API_ROUTES } };
}

const builders: Record<string, () => Scenario> = {
  normal: () => base("normal"),
  "rpc-down": () => ({ ...base("rpc-down"), rpcDown: true }),
  "api-down": () => ({ ...base("api-down"), apiDown: true }),
  frozen: () => ({ ...base("frozen"), views: { ...views, is_frozen: true } }),
  halted: () => ({ ...base("halted"), views: { ...views, is_halted: true } }),
  "not-ready": () => ({ ...base("not-ready"), views: { ...views, is_setup_done: false } }),
  "frozen-with-queue": () => ({ ...base("frozen-with-queue"), views: { ...views, is_frozen: true }, perAccount: { [VAULT]: { 'pending_of:{"account":"alice.testnet"}': "3000000", 'storage_balance_of:{"account_id":"alice.testnet"}': { total: "1", available: "0" } } } }),
  "swap-running": () => ({
    ...base("swap-running"),
    views: { ...views, inflight: inflightRunning, stage: { Swapping: { nonce: 9, attempt: 0, entered_at: Math.floor(Date.now() / 1000) } } },
    perAccount: { [VAULT]: holder },
    extra: { api: API_ROUTES, swapNonce: 9 },
  }),
  "swap-done": () => ({
    ...base("swap-done"),
    views: { ...views, last_nonce: 9, 'bucket:{"nonce":9}': { token: "Wnear", result: "1000", snapshot: "1", unclaimed: "1" } },
    perAccount: { [VAULT]: { ...holder, 'bucket_claim:{"nonce":9,"account":"alice.testnet"}': "1000000" } },
  }),
  claimable: () => ({ ...base("claimable"), perAccount: { [VAULT]: { ...holder, 'claimable_of:{"account":"alice.testnet","token":"Usdc"}': "2000000" } } }),
  "unregistered-holder": () => ({ ...base("unregistered-holder"), perAccount: { [VAULT]: holder } }),
  stuck: () => ({
    ...base("stuck"),
    views: { ...views, inflight: { ...inflightRunning, stuck_since: Math.floor(Date.now() / 1000) - 100 }, stage: { Stuck: { nonce: 9, step: "Swap", attempt: 1, since: Math.floor(Date.now() / 1000) - 100 } } },
    perAccount: { [VAULT]: holder },
  }),
  "awaiting-stale": () => ({ ...base("awaiting-stale"), views: { ...views, policy: { ...policyJson, abort_after_blocks: 100 }, stage: { AwaitingDecision: { nonce: 42, entered_block: 1 } } } }),
  closed: () => ({ ...base("closed"), views: { ...views, policy: { ...policyJson, open_deposits: false } } }),
};

export function scenario(name: string): Scenario {
  const build = builders[name];
  if (!build) throw new Error(`unknown scenario ${name}`);
  return build();
}

export function registerScenario(name: string, build: () => Scenario): void {
  builders[name] = build;
}
