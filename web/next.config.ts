import path from "node:path";

import type { NextConfig } from "next";

import fs from "node:fs";

// A production build states claims only from the real claims.json (SPEC §9.3), so it must exist.
const isTestBuild = process.env.NEXT_PUBLIC_TEST_BUILD === "1";
// CI's bundle check builds production code only to grep it; it is never deployed.
const isBundleCheck = process.env.FOUNDLING_BUNDLE_CHECK === "1";
const claimsFile = path.join(import.meta.dirname, "..", "claims.json");
if (!isTestBuild && !isBundleCheck && process.argv.includes("build") && !fs.existsSync(claimsFile)) {
  throw new Error("claims.json is missing at the repo root; a production build cannot state claims without it");
}

// The terms page needs its date and the 1Click terms link before it can be published.
const terms = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "content", "terms.json"), "utf8")) as { date: string; oneClickTosUrl: string };
if (!isTestBuild && !isBundleCheck && process.argv.includes("build") && (terms.date === "TBD" || !terms.oneClickTosUrl.startsWith("https://"))) {
  throw new Error("content/terms.json still has TBD values; fill the terms date and the 1Click terms URL before a production build");
}

// The mock wallet is swapped in at build time, so a production bundle never contains it.
const walletMock = isTestBuild ? "./lib/wallet/mock.ts" : "./lib/wallet/no-mock.ts";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { resolveAlias: { "@foundling/wallet-mock": walletMock } },
  webpack: (cfg) => {
    cfg.resolve.alias["@foundling/wallet-mock"] = path.join(import.meta.dirname, walletMock);
    return cfg;
  },
  reactStrictMode: true,
  // proofs/ and tools/ sit outside web/; trace them into the server bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  outputFileTracingIncludes: {
    "/proof": ["../proofs/**/*", "../tools/attack-registry.json", "./fixtures/**/*"],
    "/": ["./fixtures/**/*", "../claims.json", "./tests/fixtures/claims.json"],
  },
};

export default nextConfig;
