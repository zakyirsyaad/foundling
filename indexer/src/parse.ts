/**
 * Turns one FastNEAR `/v0/transactions` entry into the vault's NEP-297 events (WEBSITE §5, index loop steps 4–5).
 * A log counts only when the vault itself executed the receipt and the receipt succeeded; the transaction's
 * own status is ignored, because a partly failed transaction still carries valid events.
 */
import { z } from "zod";

const EVENT_PREFIX = "EVENT_JSON:";
const STANDARD = "foundling";
const NS_PER_MS = 1_000_000n;

const outcomeSchema = z.object({
  block_timestamp: z.union([z.number(), z.string()]),
  block_height: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  id: z.string(),
  outcome: z.object({
    logs: z.array(z.string()),
    executor_id: z.string(),
    status: z.record(z.string(), z.unknown()),
  }),
});

export const fastnearTxSchema = z.object({
  transaction: z.object({ hash: z.string(), signer_id: z.string() }).passthrough(),
  receipts: z.array(z.object({ execution_outcome: outcomeSchema }).passthrough()),
}).passthrough();

export type FastnearTx = z.infer<typeof fastnearTxSchema>;

export interface ParsedEvent {
  vaultId: string;
  receiptId: string;
  logIndex: number;
  txHash: string;
  blockHeight: bigint;
  receiptIndex: number;
  blockTime: Date;
  name: string;
  nonce: bigint | null;
  account: string | null;
  data: Record<string, unknown>;
}

const eventSchema = z.object({
  standard: z.literal(STANDARD),
  event: z.string().min(1),
  data: z.union([z.tuple([]), z.tuple([z.record(z.string(), z.unknown())])]),
});

type Outcome = z.infer<typeof outcomeSchema>;

function isSuccess(status: Record<string, unknown>): boolean {
  return "SuccessValue" in status || "SuccessReceiptId" in status;
}

/** The event body of a foundling log, or null for anything else (plain text, bad JSON, other standards). */
function readEvent(log: string): z.infer<typeof eventSchema> | null {
  if (!log.startsWith(EVENT_PREFIX)) return null;
  let json: unknown;
  try {
    json = JSON.parse(log.slice(EVENT_PREFIX.length));
  } catch {
    return null;
  }
  const parsed = eventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function toNonce(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function blockTime(ts: number | string): Date {
  return new Date(Number(BigInt(typeof ts === "number" ? Math.trunc(ts) : ts) / NS_PER_MS));
}

function eventsOf(vaultId: string, txHash: string, eo: Outcome): ParsedEvent[] {
  if (eo.outcome.executor_id !== vaultId || !isSuccess(eo.outcome.status)) return [];
  return eo.outcome.logs.flatMap((log, logIndex) => {
    const ev = readEvent(log);
    if (!ev) return [];
    const data = ev.data[0] ?? {};
    return [{
      vaultId,
      receiptId: eo.id,
      logIndex,
      txHash,
      blockHeight: BigInt(eo.block_height),
      receiptIndex: eo.index,
      blockTime: blockTime(eo.block_timestamp),
      name: ev.event,
      nonce: toNonce(data.nonce),
      account: typeof data.account === "string" ? data.account : null,
      data,
    }];
  });
}

export function sortEvents(events: ParsedEvent[]): ParsedEvent[] {
  return [...events].sort((a, b) =>
    a.blockHeight !== b.blockHeight ? (a.blockHeight < b.blockHeight ? -1 : 1)
      : a.receiptIndex !== b.receiptIndex ? a.receiptIndex - b.receiptIndex
        : a.logIndex - b.logIndex);
}

export function parseTransaction(vaultId: string, tx: FastnearTx): ParsedEvent[] {
  const { transaction, receipts } = fastnearTxSchema.parse(tx);
  return sortEvents(receipts.flatMap((r) => eventsOf(vaultId, transaction.hash, r.execution_outcome)));
}
