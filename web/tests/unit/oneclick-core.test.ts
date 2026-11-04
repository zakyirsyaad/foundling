import recorded from "../fixtures/oneclick/quote-dry.json";
import mainnet from "@/config/networks/mainnet.json";
import { addressView, remainingMs } from "@/lib/crosschain/clock";
import { depositAmount } from "@/lib/crosschain/amount";
import { echoMatches } from "@/lib/crosschain/echo";
import { isEvmAddress } from "@/lib/crosschain/evm";
import { type QuoteRequest, createRequestBuilder } from "@/lib/crosschain/request";
import { quoteProblems, verifyQuote } from "@/lib/crosschain/signature";
import type { OriginChain } from "@/config/deployment";

const base: OriginChain = { id: "base", label: "Base", originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", marginMs: 120_000, deadlineMs: 1_200_000, enabled: true };
const input = { chain: base, amount: 1_000_000n, recipient: "alice.near", refundTo: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", dry: true, destinationAsset: "nep141:usdc.near" };
const withEcho = (q: QuoteRequest) => ({ ...recorded, quoteRequest: q }) as never;
const tweak = (v: unknown) => (typeof v === "boolean" ? !v : typeof v === "number" ? v + 1 : `${String(v)}x`);

test("the request carries every required field with the spec's values", () => {
  const q = createRequestBuilder(() => Date.parse("2026-11-04T13:00:00.000Z"))(input);
  expect(q).toEqual({
    dry: true, swapType: "FLEX_INPUT", slippageTolerance: 100, originAsset: base.originAsset, depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:usdc.near", amount: "1000000", refundTo: input.refundTo, refundType: "ORIGIN_CHAIN",
    recipient: "alice.near", recipientType: "DESTINATION_CHAIN", deadline: "2026-11-04T13:20:00.000Z",
  });
  const eth = createRequestBuilder(() => Date.parse("2026-11-04T13:00:00.000Z"))({ ...input, chain: { ...base, id: "eth", deadlineMs: 2_400_000 } });
  expect(eth.deadline).toBe("2026-11-04T13:40:00.000Z");
});
test("two requests in the same millisecond get different deadlines", () => {
  const build = createRequestBuilder(() => 1_000);
  expect(build(input).deadline).not.toBe(build(input).deadline);
});
test("the recorded dry quote verifies with the pinned key and fails when tampered", () => {
  expect(mainnet.oneClick.quotePublicKey).toBe("ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc");
  expect(verifyQuote(recorded as never, mainnet.oneClick.quotePublicKey)).toBe(true);
  expect(verifyQuote({ ...recorded, quote: { ...recorded.quote, amountOut: "1" } } as never, mainnet.oneClick.quotePublicKey)).toBe(false);
  expect(verifyQuote(recorded as never, "ed25519:11111111111111111111111111111111")).toBe(false);
});
test("every echoed field must match", () => {
  const sent = recorded.quoteRequest as QuoteRequest;
  expect(echoMatches(sent, withEcho(sent))).toEqual({ ok: true });
  for (const field of ["originAsset", "destinationAsset", "amount", "recipient", "refundTo", "swapType", "dry", "depositType", "refundType", "recipientType", "slippageTolerance", "deadline"] as const) {
    const changed = field === "deadline" ? { ...sent, deadline: new Date(Date.parse(sent.deadline) + 1).toISOString() } : { ...sent, [field]: tweak(sent[field]) };
    expect(echoMatches(sent, withEcho(changed as QuoteRequest))).toEqual({ ok: false, field });
  }
});
test("deadline compares as an instant, not a string", () => {
  const a = { ...(recorded.quoteRequest as QuoteRequest), deadline: "2026-11-04T13:00:00.000Z" };
  expect(echoMatches(a, withEcho({ ...a, deadline: "2026-11-04T13:00:00Z" }))).toEqual({ ok: true });
  expect(echoMatches(a, withEcho({ ...a, deadline: "2026-11-04T13:00:00.001Z" }))).toEqual({ ok: false, field: "deadline" });
  expect(echoMatches(a, { ...recorded, quoteRequest: undefined } as never)).toEqual({ ok: false, field: "deadline" });
});
test("a quote whose output cannot be deposited is refused", () => {
  expect(quoteProblems(recorded as never, { minDeposit: 1_000_000n, remainingUserCap: 100_000_000n })).toEqual(["below-min"]);
  expect(quoteProblems(recorded as never, { minDeposit: 1n, remainingUserCap: 500_000n })).toEqual(["over-cap"]);
  expect(quoteProblems(recorded as never, { minDeposit: 1n, remainingUserCap: 100_000_000n })).toEqual([]);
});
test("a wrong device clock cannot keep the address alive", () => {
  const a = { responseTimestampMs: 0, perfAtReceipt: 0, dateAtReceipt: 0 };
  expect(remainingMs(1_200_000, a, 1_100_000, 0)).toBe(100_000);
  expect(remainingMs(1_200_000, a, 0, 1_100_000)).toBe(100_000);
  const skew = { responseTimestampMs: 1_000_000, perfAtReceipt: 50, dateAtReceipt: 400_000 };
  expect(remainingMs(1_200_000, skew, 50, 400_000)).toBe(200_000);
});
test("margins per chain and the hide rules", () => {
  const v = (o: Partial<Parameters<typeof addressView>[0]>) => addressView({ status: "PENDING_DEPOSIT", remainingMs: 600_000, marginMs: 120_000, needsReanchor: false, reloaded: false, ...o });
  expect(v({ remainingMs: 120_000 })).toBe("do-not-send");
  expect(v({ status: "not-found", marginMs: 300_000 })).toBe("show");
  expect(v({ status: "INCOMPLETE_DEPOSIT" })).toBe("show");
  expect(v({ needsReanchor: true })).toBe("hide");
  expect(v({ status: "INCOMPLETE_DEPOSIT", reloaded: true })).toBe("hide");
  expect(v({ status: "unknown" })).toBe("hide");
  expect(v({ status: "other" })).toBe("hide");
  expect(v({ status: "unknown", remainingMs: 0 })).toBe("do-not-send");
});
test("EVM refund addresses", () => {
  expect(isEvmAddress("0x52908400098527886e0f7030069857d2e4169ee7")).toBe(true);
  expect(isEvmAddress("0x52908400098527886E0F7030069857D2E4169EE7")).toBe(true);
  expect(isEvmAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe(true);
  expect(isEvmAddress("0x52908400098527886E0F7030069857D2e4169EE7")).toBe(false);
  expect(isEvmAddress("52908400098527886e0f7030069857d2e4169ee7")).toBe(false);
  expect(isEvmAddress("0x1234")).toBe(false);
  expect(isEvmAddress(" 0x52908400098527886e0f7030069857d2e4169ee7")).toBe(false);
});
test("deposit amount is the smallest of the three", () => {
  expect(depositAmount(10_000_000n, 9_000_000n, 20_000_000n, 1_000_000n)).toEqual({ amount: 9_000_000n, excess: 1_000_000n, belowMin: false });
  expect(depositAmount(10_000_000n, 10_000_000n, 500_000n, 1_000_000n)).toEqual({ amount: 500_000n, excess: 9_500_000n, belowMin: true });
  expect(depositAmount(3n, 10n, 10n, 1n)).toEqual({ amount: 3n, excess: 0n, belowMin: false });
});
