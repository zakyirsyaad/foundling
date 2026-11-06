/** The read-only history API (WEBSITE §5). GET only, one vault, enveloped JSON, bounded by rate and concurrency. */
import type { Db } from "@foundling/db";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { failure } from "./envelope";
import { concurrencyLimit, rateLimiter } from "./limits";
import { cycleRoutes } from "./routes/cycles";
import { eventRoutes } from "./routes/events";
import { navRoutes } from "./routes/nav";
import { proofRoutes } from "./routes/proofs";
import { statusRoutes } from "./routes/status";

export const PER_MINUTE = 60;
export const CONCURRENCY = 16;
/** Postgres errors that mean "busy or away", not "broken": query_canceled (statement_timeout), too_many_connections, cannot_connect_now. */
const BUSY_CODES = new Set(["57014", "53300", "57P03"]);
const BUSY_NETWORK = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]);

export interface AppDeps {
  db: Db;
  vaultId: string;
  webOrigin: string;
  trustProxyFrom: string[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

function isBusy(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && (BUSY_CODES.has(code) || BUSY_NETWORK.has(code))) return true;
    if (/timeout exceeded when trying to connect/i.test(e.message)) return true;
  }
  return false;
}

export function createApp(deps: AppDeps): Hono {
  const log = deps.log ?? ((message, fields) => console.error(JSON.stringify({ at: new Date().toISOString(), message, ...fields })));
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
  });
  app.use("*", cors({ origin: (origin) => (origin === deps.webOrigin ? origin : null), allowMethods: ["GET"] }));
  app.use("*", rateLimiter({ perMinute: PER_MINUTE, trustProxyFrom: deps.trustProxyFrom }));
  app.use("*", concurrencyLimit(CONCURRENCY));
  app.on(["POST", "PUT", "PATCH", "DELETE"], "*", (c) => {
    c.header("Allow", "GET");
    return failure(c, 405, "method not allowed");
  });

  const routeDeps = { db: deps.db, vaultId: deps.vaultId };
  app.route("/v1/status", statusRoutes(routeDeps));
  app.route("/v1/cycles", cycleRoutes(routeDeps));
  app.route("/v1/nav", navRoutes(routeDeps));
  app.route("/v1/events", eventRoutes(routeDeps));
  app.route("/v1/proofs", proofRoutes(routeDeps));

  app.notFound((c) => failure(c, 404, "not found"));
  app.onError((err, c) => {
    if (err instanceof ZodError) return failure(c, 400, err.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; "));
    if (isBusy(err)) return failure(c, 503, "busy, try again shortly");
    log("api error", { path: c.req.path, error: err.message });
    return failure(c, 500, "internal error");
  });
  return app;
}
