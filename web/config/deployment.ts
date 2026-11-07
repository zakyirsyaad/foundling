import { z } from "zod";

import mainnet from "./networks/mainnet.json";
import testnet from "./networks/testnet.json";

export type Network = "mainnet" | "testnet";
export type ChainId = "base" | "arb" | "eth";

export interface OriginChain {
  id: ChainId;
  label: string;
  originAsset: string;
  marginMs: number;
  deadlineMs: number;
  enabled: boolean;
}

export interface OneClickConfig {
  baseUrl: string;
  quotePublicKey: string;
  chains: readonly OriginChain[];
}

export interface DeploymentConfig {
  network: Network;
  vaultId: string;
  rpcUrls: readonly string[];
  apiOrigin: string | null;
  usdc: string;
  usdcE: string | null;
  wnear: string;
  oneClick: OneClickConfig | null;
  sample: "m12" | null;
  testBuild: boolean;
  /** The public origin, e.g. https://foundling.xyz: canonical links, Open Graph and the sitemap. */
  siteUrl: string | null;
  landingCacheSeconds: number;
  appCacheSeconds: number;
}

const LANDING_CACHE_SECONDS = 45;
const APP_CACHE_SECONDS = 20;

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const accountId = z.string().min(2).max(64).regex(ACCOUNT_ID, "not a NEAR account id");

const chainSchema = z.object({
  id: z.enum(["base", "arb", "eth"]),
  label: z.string().min(1),
  originAsset: z.string().startsWith("nep141:"),
  marginMs: z.number().int().positive(),
  deadlineMs: z.number().int().positive(),
  enabled: z.boolean(),
});

const oneClickSchema = z.object({
  baseUrl: z.url({ protocol: /^https$/ }),
  quotePublicKey: z.string(),
  chains: z.array(chainSchema).min(1),
});

function urlAllowed(raw: string, testBuild: boolean): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || (testBuild && url.protocol === "http:");
  } catch {
    return false;
  }
}

function parseUrls(raw: string | undefined, testBuild: boolean): string[] {
  const urls = (raw ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error("NEXT_PUBLIC_RPC_URLS needs at least one URL");
  for (const u of urls) {
    if (!urlAllowed(u, testBuild)) throw new Error(`RPC URL must be https: ${u}`);
  }
  return urls;
}

/** Origin only, so a stray path or trailing slash never doubles up in canonical links. */
function parseSiteUrl(raw: string | undefined, testBuild: boolean): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!urlAllowed(value, testBuild)) throw new Error(`site URL must be https: ${value}`);
  return new URL(value).origin;
}

function cacheSeconds(env: Record<string, string | undefined>, testBuild: boolean): { landing: number; app: number } {
  const raw = env.FOUNDLING_CACHE_SECONDS;
  if (raw === undefined) return { landing: LANDING_CACHE_SECONDS, app: APP_CACHE_SECONDS };
  if (!testBuild) throw new Error("FOUNDLING_CACHE_SECONDS is only for a test build");
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error("FOUNDLING_CACHE_SECONDS must be a whole number");
  return { landing: seconds, app: Math.min(seconds, APP_CACHE_SECONDS) };
}

function tokens(network: Network, env: Record<string, string | undefined>) {
  if (network === "mainnet") {
    if (env.NEXT_PUBLIC_USDC_ID || env.NEXT_PUBLIC_WNEAR_ID) {
      throw new Error("mainnet pins USDC and wNEAR; NEXT_PUBLIC_USDC_ID and NEXT_PUBLIC_WNEAR_ID are testnet only");
    }
    return { usdc: mainnet.usdc, usdcE: mainnet.usdcE, wnear: mainnet.wnear };
  }
  return {
    usdc: accountId.parse(env.NEXT_PUBLIC_USDC_ID),
    usdcE: testnet.usdcE,
    wnear: accountId.parse(env.NEXT_PUBLIC_WNEAR_ID),
  };
}

/** Test build only: the mock 1Click URL and signing key, and which origin chains are on. */
function testOneClick(pinned: OneClickConfig, env: Record<string, string | undefined>): OneClickConfig {
  const on = env.NEXT_PUBLIC_ONECLICK_CHAINS?.split(",").map((c) => c.trim());
  return {
    baseUrl: env.NEXT_PUBLIC_ONECLICK_URL?.trim() || pinned.baseUrl,
    quotePublicKey: env.NEXT_PUBLIC_ONECLICK_KEY?.trim() || pinned.quotePublicKey,
    chains: on ? pinned.chains.map((c) => ({ ...c, enabled: on.includes(c.id) })) : pinned.chains,
  };
}

export function loadConfig(env: Record<string, string | undefined>): DeploymentConfig {
  const network = z.enum(["mainnet", "testnet"]).parse(env.NEXT_PUBLIC_NETWORK);
  const testBuild = env.NEXT_PUBLIC_TEST_BUILD === "1";
  const apiRaw = env.NEXT_PUBLIC_API_ORIGIN?.trim() || null;
  if (apiRaw !== null && !urlAllowed(apiRaw, testBuild)) throw new Error(`API origin must be https: ${apiRaw}`);
  const cache = cacheSeconds(env, testBuild);
  const sample = env.NEXT_PUBLIC_SAMPLE?.trim() || null;
  if (sample !== null && sample !== "m12") throw new Error(`unknown sample: ${sample}`);
  const pinned = network === "mainnet" ? oneClickSchema.parse(mainnet.oneClick) : null;
  const oneClick = pinned && testBuild ? testOneClick(pinned, env) : pinned;
  return {
    network,
    vaultId: accountId.parse(env.NEXT_PUBLIC_VAULT_ID),
    rpcUrls: parseUrls(env.NEXT_PUBLIC_RPC_URLS, testBuild),
    apiOrigin: apiRaw,
    ...tokens(network, env),
    oneClick,
    sample,
    testBuild,
    siteUrl: parseSiteUrl(env.NEXT_PUBLIC_SITE_URL, testBuild),
    landingCacheSeconds: cache.landing,
    appCacheSeconds: cache.app,
  };
}

