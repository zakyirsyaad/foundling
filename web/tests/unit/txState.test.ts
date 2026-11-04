import { persistPending, takePending, txReducer } from "@/lib/wallet/txState";

test("the happy path", () => {
  let s = txReducer({ kind: "idle" }, { type: "submit" });
  expect(s).toEqual({ kind: "awaiting-wallet" });
  s = txReducer(s, { type: "sent", hashes: ["H"] });
  expect(s).toEqual({ kind: "sent", hashes: ["H"] });
  expect(txReducer(s, { type: "settled" })).toEqual({ kind: "done", hashes: ["H"] });
  expect(txReducer(s, { type: "settled", partial: "claim-pending" })).toEqual({ kind: "partial", hashes: ["H"], why: "claim-pending" });
});
test("a wallet cancel returns to the form", () => {
  expect(txReducer({ kind: "awaiting-wallet" }, { type: "cancelled" })).toEqual({ kind: "cancelled" });
});
test("a contract rejection keeps the raw code next to the sentence", () => {
  expect(txReducer({ kind: "awaiting-wallet" }, { type: "rejected", raw: "Smart contract panicked: NOT_STUCK" })).toMatchObject({ kind: "rejected", raw: "Smart contract panicked: NOT_STUCK" });
});
test("pending hashes survive a reload once, then are gone", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
  persistPending(storage, ["H1", "H2"]);
  expect(takePending(storage)).toEqual(["H1", "H2"]);
  expect(takePending(storage)).toEqual([]);
});
test("storage that throws or holds junk is treated as empty", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } as unknown as Storage;
  expect(() => persistPending(broken, ["H"])).not.toThrow();
  expect(takePending(broken)).toEqual([]);
  expect(takePending(null)).toEqual([]);
  const junk = { getItem: () => "{not json", setItem: () => {}, removeItem: () => {} } as unknown as Storage;
  expect(takePending(junk)).toEqual([]);
});
