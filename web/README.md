# Foundling website (`web/`)

Next.js site for Foundling: the landing (`/`, `/proof`, `/trust`, `/terms`) and the app (`/app`, `/app/cycles`, `/app/portfolio`). The design is in `docs/WEBSITE.md`, the plan in `docs/plans/2026-11-04-web.md`.

## Run locally

Node 24. From the repo root:

```bash
npm ci --ignore-scripts
```

```bash
npm run -w web dev
```

`dev` needs a deployment env (below). For a local sandbox against the test doubles, start the mock server and point the env at it:

```bash
npx -w web tsx tests/mock-server/server.ts
```

Tests:

```bash
npm run -w web test:coverage
```

```bash
npm run -w web e2e
```

`e2e` builds two test builds (testnet on port 3100, mainnet with the 1Click card on 3101) against the mock server on 3199.

Other checks: `npm run -w web check:contract` (call table and events against the Rust source), `npm run -w web depcruise` (exit paths never import the history API), and `npm run -w web oneclick:contract` (manual: dry quotes against the real 1Click, no funds move).

## Environment

Only public configuration; the site holds no secrets.

| Variable | Mainnet | Testnet |
| --- | --- | --- |
| `NEXT_PUBLIC_NETWORK` | `mainnet` | `testnet` |
| `NEXT_PUBLIC_VAULT_ID` | final vault account | rehearsal vault |
| `NEXT_PUBLIC_RPC_URLS` | comma list, https | comma list, https |
| `NEXT_PUBLIC_API_ORIGIN` | `https://api.<domain>` (optional) | optional |
| `NEXT_PUBLIC_USDC_ID`, `NEXT_PUBLIC_WNEAR_ID` | not allowed (pinned) | the mock tokens |
| `NEXT_PUBLIC_SAMPLE` | empty for the final vault | `m12` to show the labelled rehearsal sample |

USDC, USDC.e, wNEAR, the 1Click URL, the pinned 1Click quote key and the origin chains are in `config/networks/mainnet.json`. Each origin chain stays `enabled: false` until its SP4 test passes; the lead flips it.

A production build refuses to start without the repo-root `claims.json` (SPEC §9.3) and with `TBD` left in `content/terms.json`.

## Deploy

Vercel Hobby, one project per network, root directory `web`. Production is promoted by hand by the lead, never automatically from `main`:

```bash
vercel promote <deployment-url>
```

Variables starting with `FOUNDLING_` are for tests and CI only. Never set `FOUNDLING_BUNDLE_CHECK` or `NEXT_PUBLIC_TEST_BUILD` on a real deployment: the first skips the claims and terms guards, the second loads the mock wallet.
