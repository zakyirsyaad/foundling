import { assetsJson, policyJson, vaultViews } from "../fixtures/vault";
import { API_ROUTES } from "./api-fixtures";
import type { Scenario } from "./state";

export const VAULT = "vault.foundling.testnet";
export const USDC = "usdc.foundling.testnet";
export const WNEAR = "wrap.testnet";

const views = { ...vaultViews, assets: { ...assetsJson, usdc: USDC, wnear: WNEAR } };

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
