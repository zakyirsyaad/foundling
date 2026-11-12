import { render } from "@testing-library/react";
import { useEffect } from "react";

import { config } from "@/config";
import { Portfolio } from "@/features/portfolio/Portfolio";
import type { Position, VaultSnapshot } from "@/lib/chain/types";
import { fixtureSnapshot } from "../fixtures/snapshot";

const h = vi.hoisted(() => ({ snap: null as unknown, position: null as unknown, mounts: 0 }));

vi.mock("@/config", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/config")>();
  return { ...m, config: { ...m.config, oneClick: m.config.oneClick ?? { url: "https://1click.test", key: null, chains: [] } } };
});
vi.mock("@/lib/chain/useVaultSnapshot", () => ({ useVaultSnapshot: () => ({ snapshot: h.snap, unreadable: false, fresh: true, loading: false }) }));
vi.mock("@/lib/chain/usePosition", () => ({ usePosition: () => ({ position: h.position, gasPrice: 100_000_000n, reload: () => {} }) }));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ wallet: null, account: "alice.testnet" }) }));
vi.mock("@/lib/wallet/useTx", () => ({ useTx: () => ({ state: { kind: "idle" }, run: () => {}, acknowledge: () => {} }) }));

const pos: Position = {
  account: "alice.testnet", shares: 5n, pending: 0n, netDeposit: 0n, claimable: { usdc: 0n, wnear: 0n },
  registered: { vault: true, usdc: true, wnear: true }, balances: { usdc: 50_000_000n, usdcE: 0n, near: 10n ** 24n }, allowed: true,
};

function Probe() {
  useEffect(() => {
    h.mounts += 1;
  }, []);
  return <p>cross-chain card</p>;
}

test("the cross-chain card is not remounted when a position re-read fails and comes back", async () => {
  const snap = await fixtureSnapshot();
  h.snap = { ...snap, assets: { ...snap.assets, usdc: config.usdc, wnear: config.wnear } } satisfies VaultSnapshot;
  h.position = pos;
  h.mounts = 0;
  const slots = { crossChain: () => <Probe /> };
  const { rerender, getByText } = render(<Portfolio slots={slots} />);
  expect(getByText("cross-chain card")).toBeInTheDocument();
  h.position = null;
  rerender(<Portfolio slots={slots} />);
  h.position = pos;
  rerender(<Portfolio slots={slots} />);
  expect(h.mounts).toBe(1);
});
