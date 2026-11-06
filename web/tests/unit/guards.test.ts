import { buildGuardProblems } from "@/lib/build/guards";

const ok = { isBuild: true, testBuild: false, bundleCheck: false, vercel: false, claimsExists: true, terms: { date: "2026-11-10", oneClickTosUrl: "https://x.org" } };

test("a normal production build passes", () => {
  expect(buildGuardProblems(ok)).toEqual([]);
});
test("missing claims or TBD terms stop a production build", () => {
  expect(buildGuardProblems({ ...ok, claimsExists: false }).join()).toMatch(/claims.json/);
  expect(buildGuardProblems({ ...ok, terms: { date: "TBD", oneClickTosUrl: "https://x.org" } }).join()).toMatch(/terms/);
});
test("test-only switches are refused on Vercel", () => {
  expect(buildGuardProblems({ ...ok, testBuild: true, vercel: true }).join()).toMatch(/NEXT_PUBLIC_TEST_BUILD/);
  expect(buildGuardProblems({ ...ok, bundleCheck: true, vercel: true }).join()).toMatch(/FOUNDLING_BUNDLE_CHECK/);
});
test("a local test build or bundle check skips the claims and terms guards", () => {
  expect(buildGuardProblems({ ...ok, testBuild: true, claimsExists: false })).toEqual([]);
  expect(buildGuardProblems({ ...ok, bundleCheck: true, claimsExists: false, terms: { date: "TBD", oneClickTosUrl: "TBD" } })).toEqual([]);
  expect(buildGuardProblems({ ...ok, isBuild: false, claimsExists: false })).toEqual([]);
});
