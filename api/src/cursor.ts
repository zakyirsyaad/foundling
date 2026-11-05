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

export const digits = z.string().regex(/^\d{1,20}$/);
