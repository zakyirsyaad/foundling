/** Keyset cursors: base64url JSON, validated on the way back in. */
import { z } from "zod";

export function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function cursorSchema<T extends z.ZodType>(shape: T) {
  return z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/)
    .transform((s, ctx) => {
      try {
        return JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "bad cursor" });
        return z.NEVER;
      }
    })
    .pipe(shape);
}

const MAX_BIGINT = 2n ** 63n - 1n;
const MAX_INT = 2 ** 31 - 1;
/** A Postgres bigint (nonce, block height): anything larger is a 400, not a failed query. */
export const digits = z.string().regex(/^\d{1,19}$/).refine((s) => /^\d+$/.test(s) && BigInt(s) <= MAX_BIGINT, "out of range");
/** A Postgres integer (receipt index, log index). */
export const smallDigits = z.string().regex(/^\d{1,10}$/).refine((s) => /^\d+$/.test(s) && Number(s) <= MAX_INT, "out of range");
