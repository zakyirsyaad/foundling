/** WEBSITE §8: the exit paths render without the history API, so they must not reach lib/history. */
module.exports = {
  forbidden: [
    {
      name: "exits-without-history",
      severity: "error",
      comment: "Portfolio, the stuck panel and the app layout must work when the API is down.",
      from: { path: ["^features/portfolio", "^features/vault/StuckPanel", "^app/app/layout\\.tsx$", "^app/app/portfolio"] },
      to: { path: "^lib/history", reachable: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(node_modules|\\.next)" },
  },
};
