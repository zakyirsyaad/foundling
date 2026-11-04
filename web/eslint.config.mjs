import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: [".next/**", ".next-mainnet/**", "node_modules/**", "coverage/**", "test-results/**", "playwright-report/**", "next-env.d.ts"] },
  ...nextVitals,
];

export default config;
