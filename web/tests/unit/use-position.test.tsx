import { act, renderHook } from "@testing-library/react";

import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { usePosition } from "@/lib/chain/usePosition";
import { fixtureSnapshot } from "../fixtures/snapshot";

const read = vi.fn();
vi.mock("@/lib/chain/vault", async (orig) => {
  const actual = await orig<typeof import("@/lib/chain/vault")>();
  return { ...actual, readPosition: (...a: unknown[]) => read(...a) };
});
vi.mock("@/lib/chain/rpc", () => ({ createRpcClient: () => ({ gasPrice: async () => 100_000_000n }) }));

const position: Position = {
  account: "alice.near",
  shares: 5n,
  pending: 0n,
  netDeposit: 5n,
  claimable: { usdc: 0n, wnear: 0n },
  registered: { vault: true, usdc: true, wnear: true },
  balances: { usdc: 0n, usdcE: 0n, near: 0n },
  allowed: true,
};

beforeEach(() => {
  read.mockReset();
  read.mockResolvedValue(position);
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

test("by default every new snapshot reads the position again", async () => {
  const s = await fixtureSnapshot();
  const { rerender } = renderHook(({ snap }: { snap: VaultSnapshot }) => usePosition("alice.near", snap), { initialProps: { snap: s } });
  await settle();
  rerender({ snap: { ...s, blockHeight: s.blockHeight + 1n } });
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
});

test("on change, a poll that only moves the block does not read the position again", async () => {
  const s = await fixtureSnapshot();
  const { result, rerender } = renderHook(({ snap }: { snap: VaultSnapshot }) => usePosition("alice.near", snap, { refresh: "change" }), { initialProps: { snap: s } });
  await settle();
  expect(result.current.position?.shares).toBe(5n);
  rerender({ snap: { ...s, blockHeight: s.blockHeight + 1n } });
  rerender({ snap: { ...s, blockHeight: s.blockHeight + 2n } });
  await settle();
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.current.position?.shares).toBe(5n);
});

test("on change, a settled cycle or a move in total shares reads the position again", async () => {
  const s = await fixtureSnapshot();
  const { rerender } = renderHook(({ snap }: { snap: VaultSnapshot }) => usePosition("alice.near", snap, { refresh: "change" }), { initialProps: { snap: s } });
  await settle();
  rerender({ snap: { ...s, lastNonce: s.lastNonce + 1n } });
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
  rerender({ snap: { ...s, lastNonce: s.lastNonce + 1n, totalShares: s.totalShares + 1n } });
  await settle();
  expect(read).toHaveBeenCalledTimes(3);
});

test("on change, reload and a new account still read", async () => {
  const s = await fixtureSnapshot();
  const { result, rerender } = renderHook(({ account }: { account: string }) => usePosition(account, s, { refresh: "change" }), { initialProps: { account: "alice.near" } });
  await settle();
  act(() => result.current.reload());
  await settle();
  expect(read).toHaveBeenCalledTimes(2);
  rerender({ account: "bob.near" });
  await settle();
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls[2]![2]).toBe("bob.near");
});
