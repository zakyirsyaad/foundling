import { render, screen } from "@testing-library/react";

import { AppHeader } from "@/features/vault/AppHeader";
import { SharePriceChart } from "@/features/vault/SharePriceChart";
import { VaultBanner } from "@/features/vault/VaultBanner";
import { fixtureSnapshot } from "../fixtures/snapshot";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/cycles" }));

test("the app header shows the vault, the network and the tabs", () => {
  render(<AppHeader vaultId="vault.foundling.testnet" network="testnet" />);
  expect(screen.getByTestId("network-badge")).toHaveTextContent("testnet");
  expect(screen.getByRole("link", { name: "Cycles" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
});
test("the banner picks the most serious vault state", async () => {
  const s = await fixtureSnapshot();
  const { rerender } = render(<VaultBanner s={{ ...s, halted: true, frozen: true }} unreadable={false} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Halted");
  rerender(<VaultBanner s={{ ...s, frozen: true }} unreadable={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("Frozen");
  rerender(<VaultBanner s={{ ...s, setupDone: false }} unreadable={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("Not ready");
  rerender(<VaultBanner s={{ ...s, account: { ...s.account, amount: 0n } }} unreadable={false} />);
  expect(screen.getByRole("status")).toHaveTextContent("below its reserve");
  rerender(<VaultBanner s={s} unreadable />);
  expect(screen.getByRole("status")).toHaveTextContent("Showing block #201");
  rerender(<VaultBanner s={null} unreadable />);
  expect(screen.getByRole("status")).toHaveTextContent("No RPC answered");
  rerender(<VaultBanner s={s} unreadable={false} />);
  expect(screen.queryByRole("status")).toBeNull();
});
test("the chart needs two points", () => {
  const p = { nonce: 1n, at: "2026-11-01T00:00:00Z", book: { usdc: 1_000_000n, wnear: 0n }, totalShares: 10n ** 12n, oracle: null };
  const { rerender } = render(<SharePriceChart points={[p]} usdcDecimals={6} />);
  expect(screen.getByText("Not enough cycles for a chart yet.")).toBeInTheDocument();
  rerender(<SharePriceChart points={[p, { ...p, nonce: 2n, at: "2026-11-02T00:00:00Z" }]} usdcDecimals={6} />);
  expect(screen.getByRole("img", { name: "Share price by cycle" })).toBeInTheDocument();
});
