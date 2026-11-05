/** Indexer settings from env (docs/plans/2026-11-05-backend.md Task 9 `.env.example`). Validated once at start. */
import { z } from "zod";

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
});

export interface IndexerConfig {
  vaultId: string;
  chain: keyof typeof HOSTS;
  databaseUrl: string;
  fastnearUrl: string;
  fastnearApiKey?: string;
  /** Regular nodes first, archival after: old blocks fall through to archival. */
  rpcUrls: string[];
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
  };
}
