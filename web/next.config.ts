import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // proofs/ and tools/ sit outside web/; trace them into the server bundle.
  outputFileTracingRoot: path.join(import.meta.dirname, ".."),
  outputFileTracingIncludes: {
    "/proof": ["../proofs/**/*", "../tools/attack-registry.json", "./fixtures/**/*"],
    "/": ["./fixtures/**/*"],
  },
};

export default nextConfig;
