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
