import type { DeploymentConfig } from "@/config/deployment";

/**
 * Hosts near-connect fetches at run time: the default wallet manifest and the wallet executor
 * scripts it lists (read from near-connect 0.11.4 and the live manifest on 2026-11-04). Executors
 * run in a sandboxed srcdoc iframe that inherits this policy. A wallet that needs another host shows
 * a CSP error in the console; add it here after checking it (WEBSITE §11).
 */
export const WALLET_HOSTS = [
  "https://raw.githubusercontent.com",
  "https://cdn.jsdelivr.net",
  "https://wallet.intear.tech",
  "https://logout-bridge-service.intear.tech",
  "https://trezu.app",
  "https://evm-on-near.dev",
  "https://near-mobile-production.aws.peersyst.tech",
  "https://app.hot-labs.org",
  "https://wallet.meteorwallet.app",
  "https://app.mynearwallet.com",
  "https://wallet.near.org",
] as const;

const origin = (url: string) => new URL(url).origin;

export function buildCsp(cfg: DeploymentConfig, nonce: string, dev: boolean): string {
  const connect = new Set<string>(["'self'", ...cfg.rpcUrls.map(origin), ...WALLET_HOSTS]);
  if (cfg.apiOrigin) connect.add(origin(cfg.apiOrigin));
  if (cfg.oneClick) connect.add(origin(cfg.oneClick.baseUrl));
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes come from React (meter widths), recharts and the wallet popup.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${[...connect].join(" ")}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (!cfg.testBuild && !dev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
