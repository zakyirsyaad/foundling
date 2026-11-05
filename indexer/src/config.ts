/** Indexer settings from env (docs/plans/2026-11-05-backend.md Task 9 `.env.example`). Validated once at start. */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolPaths } from "./proofs/queue";
import { TOOL_TIMEOUT_MS } from "./proofs/run";

/** The repo's tools/ when run from a checkout; the image sets TOOLS_DIR. */
const REPO_TOOLS = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "tools");

const HOSTS = {
  testnet: { fastnear: "https://tx.test.fastnear.com", rpc: "https://rpc.testnet.fastnear.com", archival: "https://archival-rpc.testnet.fastnear.com" },
  mainnet: { fastnear: "https://tx.main.fastnear.com", rpc: "https://rpc.mainnet.fastnear.com", archival: "https://archival-rpc.mainnet.fastnear.com" },
} as const;

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const httpsUrl = z.string().url().refine((u) => u.startsWith("https://"), "RPC URLs must use https");
const urlList = z.string().optional().transform((s) => (s ?? "").split(",").map((u) => u.trim()).filter(Boolean)).pipe(z.array(httpsUrl));

const envSchema = z.object({
  ACTIVE_VAULT_ID: z.string().min(2).max(64).regex(ACCOUNT_ID),
  CHAIN: z.enum(["testnet", "mainnet"]),
  DATABASE_URL_WRITER: z.string().min(1),
  RPC_URLS: urlList,
  ARCHIVAL_RPC_URLS: urlList,
  FASTNEAR_API_KEY: z.string().min(1).optional(),
  OBS_SOURCE: z.enum(["live", "rehearsal"]).default("live"),
  VERIFIER_COMMIT: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  TOOLS_DIR: z.string().min(1).optional(),
  VERIFY_BIN: z.string().min(1).default("foundling-verify"),
  PYTHON: z.string().min(1).default("python3"),
});

export interface IndexerConfig {
  vaultId: string;
  chain: keyof typeof HOSTS;
  databaseUrl: string;
  fastnearUrl: string;
  fastnearApiKey?: string;
  /** Regular nodes first, archival after: old blocks fall through to archival. */
  rpcUrls: string[];
  proofs: { obsSource: "live" | "rehearsal"; verifierCommit?: string; tools: ToolPaths };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): IndexerConfig {
  const e = envSchema.parse(env);
  const hosts = HOSTS[e.CHAIN];
  const rpc = e.RPC_URLS.length ? e.RPC_URLS : [hosts.rpc];
  const archival = e.ARCHIVAL_RPC_URLS.length ? e.ARCHIVAL_RPC_URLS : [hosts.archival];
  return {
    vaultId: e.ACTIVE_VAULT_ID,
    chain: e.CHAIN,
    databaseUrl: e.DATABASE_URL_WRITER,
    fastnearUrl: hosts.fastnear,
    ...(e.FASTNEAR_API_KEY ? { fastnearApiKey: e.FASTNEAR_API_KEY } : {}),
    rpcUrls: [...rpc, ...archival],
    proofs: {
      obsSource: e.OBS_SOURCE,
      ...(e.VERIFIER_COMMIT ? { verifierCommit: e.VERIFIER_COMMIT } : {}),
      tools: {
        python: e.PYTHON,
        fetchProof: join(e.TOOLS_DIR ?? REPO_TOOLS, "fetch_proof.py"),
        recheckObs: join(e.TOOLS_DIR ?? REPO_TOOLS, "recheck_obs.py"),
        verify: e.VERIFY_BIN,
        rpcUrls: archival,
        timeoutMs: TOOL_TIMEOUT_MS,
      },
    },
  };
}
