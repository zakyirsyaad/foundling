/** Production build checks, run from next.config.ts. Pure so they can be tested. */
export interface GuardInput {
  isBuild: boolean;
  testBuild: boolean;
  bundleCheck: boolean;
  vercel: boolean;
  claimsExists: boolean;
  terms: { date: string; oneClickTosUrl: string };
}

export function buildGuardProblems(i: GuardInput): string[] {
  const problems: string[] = [];
  // Test switches turn on the mock wallet and test-only 1Click overrides: never on a real deploy.
  if (i.vercel && i.testBuild) problems.push("NEXT_PUBLIC_TEST_BUILD is set on Vercel; it loads the mock wallet and test overrides");
  if (i.vercel && i.bundleCheck) problems.push("FOUNDLING_BUNDLE_CHECK is set on Vercel; it skips the claims and terms guards");
  if (!i.isBuild || i.testBuild || i.bundleCheck) return problems;
  if (!i.claimsExists) problems.push("claims.json is missing at the repo root; a production build cannot state claims without it");
  if (i.terms.date === "TBD" || !i.terms.oneClickTosUrl.startsWith("https://")) problems.push("content/terms.json still has TBD values; fill the terms date and the 1Click terms URL before a production build");
  return problems;
}
