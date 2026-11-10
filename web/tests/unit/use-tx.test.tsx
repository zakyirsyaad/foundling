import { act, renderHook } from "@testing-library/react";

import { useTx } from "@/lib/wallet/useTx";
import type { WalletApi } from "@/lib/wallet/types";
import { fixtureSnapshot } from "../fixtures/snapshot";

vi.mock("@/lib/wallet/calls", async (orig) => ({
  ...(await orig<typeof import("@/lib/wallet/calls")>()),
  buildTx: () => ({ receiverId: "vault.near", methodName: "redeem", args: {}, gas: 1n, deposit: 1n }),
}));

const wallet = (): WalletApi => ({
  connect: async () => "alice.near",
  disconnect: async () => {},
  accountId: () => "alice.near",
  send: async () => [{ hash: "H1", outcome: {} }],
  onAccountChange: () => () => {},
});

beforeEach(() => window.sessionStorage.clear());

test("a settled transaction is not resumed as sent after a reload", async () => {
  const s = await fixtureSnapshot();
  const ctx = { config: {} as never, assets: s.assets, storageMin: { vault: 0n, usdc: 0n, wnear: 0n } };
  const first = renderHook(() => useTx(wallet(), ctx, () => {}));
  await act(async () => first.result.current.run([{ name: "redeem", args: { shares: "1" } }]));
  expect(first.result.current.state).toEqual({ kind: "done", hashes: ["H1"] });
  first.unmount();
  const reloaded = renderHook(() => useTx(wallet(), ctx, () => {}));
  expect(reloaded.result.current.state).toEqual({ kind: "idle" });
});
