import { type DeploymentConfig, loadConfig } from "./deployment";

export type { ChainId, DeploymentConfig, Network, OneClickConfig, OriginChain } from "./deployment";

/**
 * Next inlines `process.env.NEXT_PUBLIC_*` only where it is written out literally,
 * so the browser bundle needs each name spelled here.
 */
export const config: DeploymentConfig = loadConfig({
  NEXT_PUBLIC_NETWORK: process.env.NEXT_PUBLIC_NETWORK,
  NEXT_PUBLIC_VAULT_ID: process.env.NEXT_PUBLIC_VAULT_ID,
  NEXT_PUBLIC_RPC_URLS: process.env.NEXT_PUBLIC_RPC_URLS,
  NEXT_PUBLIC_API_ORIGIN: process.env.NEXT_PUBLIC_API_ORIGIN,
  NEXT_PUBLIC_SAMPLE: process.env.NEXT_PUBLIC_SAMPLE,
  NEXT_PUBLIC_TEST_BUILD: process.env.NEXT_PUBLIC_TEST_BUILD,
  NEXT_PUBLIC_USDC_ID: process.env.NEXT_PUBLIC_USDC_ID,
  NEXT_PUBLIC_WNEAR_ID: process.env.NEXT_PUBLIC_WNEAR_ID,
  NEXT_PUBLIC_ONECLICK_URL: process.env.NEXT_PUBLIC_ONECLICK_URL,
  NEXT_PUBLIC_ONECLICK_KEY: process.env.NEXT_PUBLIC_ONECLICK_KEY,
  NEXT_PUBLIC_ONECLICK_CHAINS: process.env.NEXT_PUBLIC_ONECLICK_CHAINS,
  NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  FOUNDLING_CACHE_SECONDS: process.env.FOUNDLING_CACHE_SECONDS,
});
