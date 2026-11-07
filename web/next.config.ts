import path from "node:path";

import type { NextConfig } from "next";

import fs from "node:fs";

import { buildGuardProblems } from "./lib/build/guards";

const isTestBuild = process.env.NEXT_PUBLIC_TEST_BUILD === "1";
// CI's bundle check builds production code only to grep it; it is never deployed.
const isBundleCheck = process.env.FOUNDLING_BUNDLE_CHECK === "1";
const terms = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "content", "terms.json"), "utf8")) as { date: string; oneClickTosUrl: string };
const problems = buildGuardProblems({
  isBuild: process.argv.includes("build"),
  testBuild: isTestBuild,
  bundleCheck: isBundleCheck,
  vercel: Boolean(process.env.VERCEL),
  claimsExists: fs.existsSync(path.join(import.meta.dirname, "..", "claims.json")),
  terms,
  network: process.env.NEXT_PUBLIC_NETWORK,
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
});
if (problems.length) throw new Error(problems.join("; "));

// The mock wallet is swapped in at build time, so a production bundle never contains it.
const walletMock = isTestBuild ? "./lib/wallet/mock.ts" : "./lib/wallet/no-mock.ts";

const nextConfig: NextConfig = {
  // A second test build (mainnet config, for the 1Click flows) builds into its own folder.
  distDir: process.env.FOUNDLING_DIST_DIR ?? ".next",
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
    "/trust": ["./fixtures/**/*"],
  },
};

export default nextConfig;
