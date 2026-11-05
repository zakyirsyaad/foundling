/** Every answer uses one envelope: `{ success, data, error, meta }` (web/lib/history/schemas.ts envelopeSchema). */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function ok(c: Context, data: unknown, cursor?: string | null) {
  return c.json({ success: true, data, error: null, meta: cursor === undefined ? null : { cursor } });
}

export function failure(c: Context, status: ContentfulStatusCode, error: string) {
  return c.json({ success: false, data: null, error, meta: null }, status);
}
