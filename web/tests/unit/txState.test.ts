import { PENDING_KEY, persistPending, readPending, takePending, txReducer } from "@/lib/wallet/txState";

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
test("pending hashes survive a reload once, for the same page only", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
  persistPending(storage, { path: "/app/portfolio", hashes: ["H1", "H2"] });
  expect(takePending(storage, "/app")).toBeNull();
  expect(takePending(storage, "/app/portfolio")).toEqual({ path: "/app/portfolio", hashes: ["H1", "H2"] });
  expect(takePending(storage, "/app/portfolio")).toBeNull();
});
test("a request sent to the wallet before a reload is remembered without hashes", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
  persistPending(storage, { path: "/app/portfolio", hashes: [] });
  expect(takePending(storage, "/app/portfolio")).toEqual({ path: "/app/portfolio", hashes: [] });
  expect(txReducer({ kind: "idle" }, { type: "interrupted" })).toEqual({ kind: "interrupted" });
  expect(txReducer({ kind: "idle" }, { type: "resumed", hashes: ["H"] })).toEqual({ kind: "sent", hashes: ["H"] });
});
test("storage that throws or holds junk is treated as empty", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } as unknown as Storage;
  expect(() => persistPending(broken, { path: "/", hashes: ["H"] })).not.toThrow();
  expect(takePending(broken, "/")).toBeNull();
  expect(takePending(null, "/")).toBeNull();
  const junk = { getItem: () => "{not json", setItem: () => {}, removeItem: () => {} } as unknown as Storage;
  expect(takePending(junk, "/")).toBeNull();
});

test("a pending request can be read without being consumed", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
  persistPending(storage, { path: "/app/portfolio", hashes: ["H"] });
  expect(readPending(storage, "/app/portfolio")).toEqual({ path: "/app/portfolio", hashes: ["H"] });
  expect(readPending(storage, "/app/portfolio")).toEqual({ path: "/app/portfolio", hashes: ["H"] });
  expect(store.get(PENDING_KEY)).not.toBeNull();
  expect(takePending(storage, "/app/portfolio")).toEqual({ path: "/app/portfolio", hashes: ["H"] });
  expect(store.get(PENDING_KEY)).toBeUndefined();
});
test("an unknown submission outcome is not a rejection and acknowledge returns to idle", () => {
  let s = txReducer({ kind: "awaiting-wallet" }, { type: "unknown", raw: "wallet timeout" });
  expect(s).toEqual({ kind: "unknown", raw: "wallet timeout" });
  expect(txReducer(s, { type: "acknowledged" })).toEqual({ kind: "idle" });
});
