import { readNav } from "../src/nav";
import { ContractError } from "../src/rpc";

const feed = (price: string, expo = -8) => ({ price, conf: "1", expo, publish_time: 1 });

function rpc(oracle: () => unknown) {
  return {
    async viewAt<T>(_b: bigint, _c: string, method: string): Promise<T> {
      const base: Record<string, unknown> = {
        book: { usdc: "10", wnear: "2" },
        total_shares: "7",
        oracle: { account: "pyth", near_id: "N", usdc_id: "U" },
        policy: { price_max_age: 60 },
      };
      return (method === "list_prices_no_older_than" ? oracle() : base[method]) as T;
    },
  };
}

test("reads book, shares and both prices", async () => {
  await expect(readNav(rpc(() => ({ N: feed("300"), U: feed("100") })), "v", 5n)).resolves.toEqual({
    bookUsdc: 10n, bookWnear: 2n, totalShares: 7n, oracleNear: 300n, oracleUsdc: 100n,
  });
});

test.each([
  ["a missing feed", { N: feed("300"), U: null }],
  ["different exponents", { N: feed("300", -8), U: feed("100", -6) }],
  ["a zero price", { N: feed("0"), U: feed("100") }],
  ["an unreadable answer", "garbage"],
])("%s gives no price", async (_label, answer) => {
  const nav = await readNav(rpc(() => answer), "v", 5n);
  expect([nav.oracleNear, nav.oracleUsdc]).toEqual([null, null]);
});

test("an oracle that refuses the read gives no price", async () => {
  const nav = await readNav(rpc(() => { throw new ContractError("no fresh price"); }), "v", 5n);
  expect(nav.oracleNear).toBeNull();
});

test("an RPC outage is not mistaken for a missing price", async () => {
  await expect(readNav(rpc(() => { throw new Error("every RPC endpoint failed"); }), "v", 5n)).rejects.toThrow(/every RPC/);
});

test("reads one view at a time so a cold archival node is not hit with a burst", async () => {
  let inFlight = 0;
  let peak = 0;
  const base = rpc(() => ({ N: feed("300"), U: feed("100") }));
  const slow = {
    async viewAt<T>(b: bigint, c: string, m: string): Promise<T> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return base.viewAt<T>(b, c, m);
    },
  };
  await readNav(slow, "v", 5n);
  expect(peak).toBe(1);
});
