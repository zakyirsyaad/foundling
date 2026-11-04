import path from "node:path";

import type { NextConfig } from "next";

import fs from "node:fs";

// A production build states claims only from the real claims.json (SPEC §9.3), so it must exist.
const isTestBuild = process.env.NEXT_PUBLIC_TEST_BUILD === "1";
const claimsFile = path.join(import.meta.dirname, "..", "claims.json");
if (!isTestBuild && process.argv.includes("build") && !fs.existsSync(claimsFile)) {
  throw new Error("claims.json is missing at the repo root; a production build cannot state claims without it");
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // proofs/ and tools/ sit outside web/; trace them into the server bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  outputFileTracingIncludes: {
    "/proof": ["../proofs/**/*", "../tools/attack-registry.json", "./fixtures/**/*"],
    "/": ["./fixtures/**/*", "../claims.json", "./tests/fixtures/claims.json"],
  },
};

export default nextConfig;
