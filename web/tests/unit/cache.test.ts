import { createTtlCache } from "@/lib/chain/cache";

test("the TTL cache loads once per window", async () => {
  let t = 0;
  const load = vi.fn(async () => 1);
  const c = createTtlCache<number>(45_000, () => t);
  await c.get("k", load);
  t = 44_999;
  await c.get("k", load);
  expect(load).toHaveBeenCalledTimes(1);
  t = 45_000;
  await c.get("k", load);
  expect(load).toHaveBeenCalledTimes(2);
});
test("concurrent callers share one load", async () => {
  let resolve!: (n: number) => void;
  const load = vi.fn(() => new Promise<number>((r) => (resolve = r)));
  const c = createTtlCache<number>(1_000, () => 0);
  const a = c.get("k", load);
  const b = c.get("k", load);
  resolve(7);
  expect(await Promise.all([a, b])).toEqual([7, 7]);
  expect(load).toHaveBeenCalledTimes(1);
});
test("a failed load is not cached", async () => {
  const c = createTtlCache<number>(1_000, () => 0);
  await expect(c.get("k", async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
  expect(await c.get("k", async () => 3)).toBe(3);
});
test("a zero TTL never caches", async () => {
  const load = vi.fn(async () => 1);
  const c = createTtlCache<number>(0, () => 0);
  await c.get("k", load);
  await c.get("k", load);
  expect(load).toHaveBeenCalledTimes(2);
});
