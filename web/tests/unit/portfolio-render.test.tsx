import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { loadConfig } from "@/config/deployment";
import { DepositForm } from "@/features/portfolio/DepositForm";
import { Positions } from "@/features/portfolio/Positions";
import { TxStatus } from "@/features/portfolio/TxStatus";
import { buildCtxFor } from "@/features/portfolio/Portfolio";
import type { Position } from "@/lib/chain/types";
import { fixtureSnapshot } from "../fixtures/snapshot";

const pos: Position = {
  account: "alice.testnet", shares: 5n, pending: 2_000_000n, netDeposit: 0n, claimable: { usdc: 0n, wnear: 0n },
  registered: { vault: false, usdc: true, wnear: true }, balances: { usdc: 50_000_000n, usdcE: 0n, near: 0n }, allowed: true,
};
const cfg = loadConfig({ NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet", NEXT_PUBLIC_RPC_URLS: "http://localhost:3199/rpc", NEXT_PUBLIC_USDC_ID: "usdc.foundling.testnet", NEXT_PUBLIC_WNEAR_ID: "wrap.testnet", NEXT_PUBLIC_TEST_BUILD: "1" });

async function setup() {
  const s = await fixtureSnapshot();
  const assets = { ...s.assets, usdc: cfg.usdc, wnear: cfg.wnear };
  const snap = { ...s, assets };
  return { snap, ctx: { config: cfg, assets, storageMin: { vault: s.storageMin, usdc: 1n, wnear: 1n } } };
}

test("the deposit form registers first, then deposits, and explains the numbers", async () => {
  const { snap, ctx } = await setup();
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<DepositForm s={snap} p={pos} gasPrice={100_000_000n} reasons={[]} ctx={ctx} network="testnet" busy={false} onSubmit={onSubmit} />);
  expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
  await user.type(screen.getByLabelText("Amount in USDC"), "5");
  expect(screen.getByTestId("near-shortfall")).toBeInTheDocument();
  expect(screen.getByText(/one-time, non-refundable registration/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Deposit" }));
  expect(onSubmit).toHaveBeenCalledWith([{ name: "register_vault", args: {} }, { name: "deposit", args: { amount: "5000000" } }]);
});
test("the form refuses amounts below the minimum, over the cap or over the balance", async () => {
  const { snap, ctx } = await setup();
  const user = userEvent.setup();
  render(<DepositForm s={snap} p={{ ...pos, registered: { ...pos.registered, vault: true } }} gasPrice={1n} reasons={[]} ctx={ctx} network="testnet" busy={false} onSubmit={vi.fn()} />);
  const input = screen.getByLabelText("Amount in USDC");
  await user.type(input, "0.5");
  expect(screen.getByText("That is below the minimum deposit.")).toBeInTheDocument();
  await user.clear(input);
  await user.type(input, "60");
  expect(screen.getByText("That is more than this account holds.")).toBeInTheDocument();
  await user.clear(input);
  await user.type(input, "abc");
  expect(screen.getByRole("button", { name: "Deposit" })).toBeDisabled();
});
test("a gated form explains each reason and shows no input", async () => {
  const { snap, ctx } = await setup();
  render(<DepositForm s={snap} p={pos} gasPrice={1n} reasons={["frozen", "closed-allowlist"]} ctx={ctx} network="testnet" busy={false} onSubmit={vi.fn()} />);
  expect(screen.getByText("The vault is frozen. New deposits are paused.")).toBeInTheDocument();
  expect(screen.getByText(/only from its allowlist/)).toBeInTheDocument();
  expect(screen.queryByLabelText("Amount in USDC")).toBeNull();
});
test("only bridged USDC.e gets its own note", async () => {
  const { snap, ctx } = await setup();
  render(<DepositForm s={snap} p={{ ...pos, balances: { usdc: 0n, usdcE: 5n, near: 0n } }} gasPrice={1n} reasons={[]} ctx={ctx} network="testnet" busy={false} onSubmit={vi.fn()} />);
  expect(screen.getByText(/only bridged USDC.e/)).toBeInTheDocument();
});
test("positions show the queue, shares and claimable separately", async () => {
  const { snap } = await setup();
  render(<Positions s={snap} p={pos} />);
  expect(screen.getByTestId("queue")).toHaveTextContent("2 USDC");
  expect(screen.getByTestId("queue")).toHaveTextContent("Shares mint at the next cycle.");
  expect(screen.getByTestId("shares")).toHaveTextContent("5");
});
test("every transaction state has words", () => {
  const { rerender } = render(<TxStatus state={{ kind: "awaiting-wallet" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for your wallet.");
  rerender(<TxStatus state={{ kind: "sent", hashes: ["H1"] }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Sent.");
  rerender(<TxStatus state={{ kind: "partial", hashes: [], why: "claim-pending" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("claim it once the swap finishes");
  rerender(<TxStatus state={{ kind: "partial", hashes: [], why: "moved-to-claimable" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("moved to claimable");
  rerender(<TxStatus state={{ kind: "rejected", sentence: "Nope.", raw: "PANIC" }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Nope. PANIC");
  rerender(<TxStatus state={{ kind: "idle" }} />);
  expect(screen.queryByRole("status")).toBeNull();
});
test("a token mismatch gives no build context", async () => {
  const s = await fixtureSnapshot();
  expect(buildCtxFor({ ...s, assets: { ...s.assets, usdc: "usdc.foundling.testnet", wnear: "wrap.testnet" } })).not.toBeNull();
  expect(buildCtxFor({ ...s, assets: { ...s.assets, usdc: "evil.testnet", wnear: "wrap.testnet" } })).toBeNull();
  expect(buildCtxFor(null)).toBeNull();
});

test("Max fills the most this account can still add, and Min the smallest deposit", async () => {
  const { snap, ctx } = await setup();
  const user = userEvent.setup();
  const capped = { ...snap, policy: { ...snap.policy, perUserCap: 20_000_000n, minDeposit: 1_000_000n } };
  render(<DepositForm s={capped} p={pos} gasPrice={100_000_000n} reasons={[]} ctx={ctx} network="testnet" busy={false} onSubmit={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Max" }));
  expect(screen.getByLabelText("Amount in USDC")).toHaveValue("20");
  await user.click(screen.getByRole("button", { name: "Min" }));
  expect(screen.getByLabelText("Amount in USDC")).toHaveValue("1");
});
test("an amount the contract would refuse is called out as a problem, not as a hint", async () => {
  const { snap, ctx } = await setup();
  const user = userEvent.setup();
  render(<DepositForm s={snap} p={pos} gasPrice={100_000_000n} reasons={[]} ctx={ctx} network="testnet" busy={false} onSubmit={vi.fn()} />);
  await user.type(screen.getByLabelText("Amount in USDC"), "999999");
  expect(screen.getByRole("alert")).toHaveTextContent(/more than this account holds|over what this account can still add/);
});
