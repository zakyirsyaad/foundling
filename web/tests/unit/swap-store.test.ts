// @vitest-environment jsdom
import { type StoredSwap, blockingSwap, createSwapStore, expiredSwap, swapKey } from "@/lib/crosschain/store";

const H = 3_600_000;
function fakeStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m } as unknown as Storage & { m: Map<string, string> };
}
const swap = (addr: string, o: Partial<StoredSwap> = {}): StoredSwap => ({ depositAddress: addr, recipient: "alice.near", chainId: "base", deadlineMs: 10 * H, createdAtMs: 0, final: null, txHashes: [], declaredNotSent: false, ...o });
const key = swapKey("mainnet", "vault.near");

test("the key names the network and the vault", () => {
  expect(key).toBe("foundling.swaps.v1:mainnet:vault.near");
});
test("two tabs on the same storage keep both swaps", () => {
  const storage = fakeStorage();
  const a = createSwapStore(storage, key);
  const b = createSwapStore(storage, key);
  a.upsert(swap("0xA"));
  b.upsert(swap("0xB"));
  expect(a.list().map((s) => s.depositAddress).sort()).toEqual(["0xA", "0xB"]);
  b.upsert(swap("0xA", { txHashes: ["0xtx"] }));
  expect(a.list().find((s) => s.depositAddress === "0xA")?.txHashes).toEqual(["0xtx"]);
});
test("a storage event from another tab reaches onChange", () => {
  const store = createSwapStore(fakeStorage(), key);
  const cb = vi.fn();
  const off = store.onChange(cb);
  window.dispatchEvent(new StorageEvent("storage", { key }));
  window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
  expect(cb).toHaveBeenCalledTimes(1);
  off();
  window.dispatchEvent(new StorageEvent("storage", { key }));
  expect(cb).toHaveBeenCalledTimes(1);
});
test("unresolved swaps are kept past their deadline and past the old pruning window", () => {
  const store = createSwapStore(fakeStorage(), key);
  store.upsert(swap("0xA"));
  store.prune();
  expect(store.list()).toEqual([swap("0xA")]);
  expect(expiredSwap(swap("0xA"), 10 * H + 24 * H + 1)).toBe(true);
  expect(expiredSwap(swap("0xA"), 10 * H - 1)).toBe(false);
  expect(expiredSwap(swap("0xA", { final: "FAILED" }), 10 * H + 24 * H)).toBe(false);
});
test("a finished swap keeps only its tx record", () => {
  const store = createSwapStore(fakeStorage(), key);
  store.upsert(swap("0xA", { final: "SUCCESS", txHashes: ["0xtx"] }));
  store.prune();
  expect(store.list()).toEqual([{ depositAddress: null, recipient: "alice.near", chainId: "base", deadlineMs: 10 * H, createdAtMs: 0, final: "SUCCESS", txHashes: ["0xtx"], declaredNotSent: false }]);
});
test("a pending swap of the same account blocks a new quote", () => {
  const list = [swap("0xA"), swap("0xB", { recipient: "bob.near" }), swap("0xC", { declaredNotSent: true }), swap("0xD", { final: "REFUNDED" }), swap("0xE", { deadlineMs: 1 })];
  expect(blockingSwap(list, "alice.near", 2)?.depositAddress).toBe("0xA");
  expect(blockingSwap(list.slice(1), "alice.near", 2)).toBeNull();
  expect(blockingSwap(list, "carol.near", 2)).toBeNull();
});
test("blocked or broken storage falls back to memory", () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } as unknown as Storage;
  const store = createSwapStore(broken, key);
  store.upsert(swap("0xA"));
  expect(store.list().map((s) => s.depositAddress)).toEqual(["0xA"]);
  const junk = { getItem: () => "{nope", setItem: () => {}, removeItem: () => {} } as unknown as Storage;
  expect(createSwapStore(junk, key).list()).toEqual([]);
  expect(createSwapStore(null, key).list()).toEqual([]);
});
test("an entry the schema rejects does not take the other swaps with it", () => {
  const storage = fakeStorage();
  storage.setItem(key, JSON.stringify([swap("0xA"), { ...swap("0xB"), chainId: "sol" }]));
  const store = createSwapStore(storage, key);
  expect(store.list().map((s) => s.depositAddress)).toEqual(["0xA"]);
  store.prune();
  expect(store.list().map((s) => s.depositAddress)).toEqual(["0xA"]);
});

test("an expired record can be forgotten by its address", () => {
  const storage = fakeStorage();
  const store = createSwapStore(storage, key);
  store.upsert(swap("0xA"));
  store.upsert(swap("0xB"));
  store.remove("0xA");
  expect(store.list().map((s) => s.depositAddress)).toEqual(["0xB"]);
  expect(JSON.parse(storage.getItem(key) ?? "[]")).toHaveLength(1);
});
