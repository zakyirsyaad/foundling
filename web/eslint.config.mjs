import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  { ignores: [".next/**", ".next-mainnet/**", "node_modules/**", "coverage/**", "test-results/**", "playwright-report/**", "next-env.d.ts"] },
  ...nextVitals,
  // On-chain data is shown as text only (WEBSITE §6).
  { rules: { "no-restricted-syntax": ["error", { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Show on-chain and API data as text only." }] } },
];

export default config;
