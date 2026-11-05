/** API settings from env (docs/plans/2026-11-05-backend.md Task 9 `.env.example`). Validated once at start. */
import { z } from "zod";

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** An exact origin: CORS echoes it, so no wildcard, path or plain http. */
const origin = z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/, "WEB_ORIGIN must be an https origin without a path");
const proxyRule = z.string().regex(/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-f:]+$/i, "TRUST_PROXY_FROM takes IPs or IPv4 CIDRs");

const envSchema = z.object({
  DATABASE_URL_READER: z.string().min(1),
  ACTIVE_VAULT_ID: z.string().min(2).max(64).regex(ACCOUNT_ID),
  WEB_ORIGIN: origin,
  TRUST_PROXY_FROM: z.string().optional().transform((s) => (s ?? "").split(",").map((r) => r.trim()).filter(Boolean)).pipe(z.array(proxyRule)),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
});

export interface ApiConfig { databaseUrl: string; vaultId: string; webOrigin: string; trustProxyFrom: string[]; port: number }

export function loadConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const e = envSchema.parse(env);
  return { databaseUrl: e.DATABASE_URL_READER, vaultId: e.ACTIVE_VAULT_ID, webOrigin: e.WEB_ORIGIN, trustProxyFrom: e.TRUST_PROXY_FROM, port: e.PORT };
}
