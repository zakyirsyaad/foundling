import type { Db } from "@foundling/db";
import { z } from "zod";
import { digits } from "../cursor";

export interface RouteDeps { db: Db; vaultId: string }

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;
export const limitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT);
export const nonceParam = digits.transform(BigInt);

const STATES = ["queued", "running", "done", "failed_to_build"] as const;
const countsSchema = z.object({ pass: z.number().int().nonnegative(), skip: z.number().int().nonnegative(), fail: z.number().int().nonnegative() });

/** A proof tally as the website reads it; a row whose state is unknown is shown as no tally rather than breaking the page. */
export function tally(counts: unknown, state: string): { pass: number; skip: number; fail: number; state: (typeof STATES)[number] } | null {
  if (!(STATES as readonly string[]).includes(state)) return null;
  const c = countsSchema.safeParse(counts ?? { pass: 0, skip: 0, fail: 0 });
  return c.success ? { ...c.data, state: state as (typeof STATES)[number] } : null;
}

export const iso = (d: Date | null) => (d ? d.toISOString() : null);
export const str = (v: bigint | string | null) => (v === null ? null : String(v));
