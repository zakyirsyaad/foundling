import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { loadConfig } from "@/config/deployment";
import { Claims, RedeemForm } from "@/features/portfolio/Exits";
import type { Position } from "@/lib/chain/types";
import { useTx } from "@/lib/wallet/useTx";
import { WalletCancelled } from "@/lib/wallet/types";
import { fixtureSnapshot } from "../fixtures/snapshot";

const find = vi.fn();
vi.mock("@/lib/vault/claims", async (orig) => ({ ...(await orig<typeof import("@/lib/vault/claims")>()), findClaims: (...a: unknown[]) => find(...a) }));

const cfg = loadConfig({ NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_VAULT_ID: "vault.foundling.testnet", NEXT_PUBLIC_RPC_URLS: "http://localhost:3199/rpc", NEXT_PUBLIC_USDC_ID: "usdc.foundling.testnet", NEXT_PUBLIC_WNEAR_ID: "wrap.testnet", NEXT_PUBLIC_TEST_BUILD: "1" });
const pos: Position = { account: "alice.testnet", shares: 9_600_000_000_000n, pending: 0n, netDeposit: 0n, claimable: { usdc: 2_000_000n, wnear: 0n }, registered: { vault: true, usdc: false, wnear: true }, balances: { usdc: 0n, usdcE: 0n, near: 10n ** 24n }, allowed: true };

async function setup() {
  const s = await fixtureSnapshot();
  const assets = { ...s.assets, usdc: cfg.usdc, wnear: cfg.wnear };
  return { s: { ...s, assets }, ctx: { config: cfg, assets, storageMin: { vault: 1n, usdc: 1n, wnear: 1n } } };
}

test("redeem estimates the payout, registers USDC first and stays open when data is old", async () => {
  const { s, ctx } = await setup();
  const run = vi.fn();
  render(<RedeemForm s={s} p={pos} ctx={ctx} run={run} busy={false} unreadable />);
  expect(screen.getByText("Data may be old")).toBeInTheDocument();
  expect(screen.getByTestId("redeem-estimate")).toHaveTextContent("About 9.64 USDC");
  await userEvent.setup().click(screen.getByRole("button", { name: "Redeem" }));
  expect(run.mock.calls[0]![0]).toEqual([{ name: "register_usdc", args: {} }, { name: "redeem", args: { shares: "9600000000000" } }]);
});
test("redeem refuses more shares than held, and flags a running swap", async () => {
  const { s, ctx } = await setup();
  const user = userEvent.setup();
  render(<RedeemForm s={{ ...s, inflight: { nonce: 9n, tokenIn: "Usdc", tokenOut: "Wnear", amountIn: 1n, minAmountOut: 1n, amountOut: null, sharesSnapshot: 1n, sharesBurned: 0n, recovered: 0n, stuckSince: null } }} p={pos} ctx={ctx} run={vi.fn()} busy={false} unreadable={false} />);
  expect(screen.getByText(/A swap is running/)).toBeInTheDocument();
  await user.type(screen.getByRole("textbox"), "99999999999999");
  expect(screen.getByRole("button", { name: "Redeem" })).toBeDisabled();
});
test("claims list bucket claims and claimable, and page back through older cycles", async () => {
  const { s, ctx } = await setup();
  find.mockResolvedValueOnce({ rows: [{ nonce: 40n, amount: 5n, resolved: true }, { nonce: 41n, amount: 2n, resolved: false }], next: 25n }).mockResolvedValueOnce({ rows: [{ nonce: 30n, amount: 1n, resolved: true }], next: null });
  const run = vi.fn();
  const user = userEvent.setup();
  await act(async () => render(<Claims s={s} p={pos} ctx={ctx} run={run} busy={false} />));
  expect(await screen.findByText("Waiting for the swap to finish.")).toBeInTheDocument();
  await user.click(screen.getAllByRole("button", { name: "Claim" })[0]!);
  expect(run.mock.calls[0]![0]).toEqual([{ name: "claim_bucket", args: { nonce: 40 } }]);
  await user.click(screen.getByRole("button", { name: "Withdraw USDC" }));
  expect(run.mock.calls[1]![0]).toEqual([{ name: "register_usdc", args: {} }, { name: "withdraw_claimable", args: { token: "Usdc" } }]);
  await user.click(screen.getByRole("button", { name: "Search older cycles" }));
  await waitFor(() => expect(screen.getByText(/Cycle 30/)).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: "Search older cycles" })).toBeNull();
});
test("no claims says so", async () => {
  const { s, ctx } = await setup();
  find.mockResolvedValueOnce({ rows: [], next: null });
  await act(async () => render(<Claims s={s} p={{ ...pos, claimable: { usdc: 0n, wnear: 0n } }} ctx={ctx} run={vi.fn()} busy={false} />));
  expect(await screen.findByText(/No claims in the last 16 cycles/)).toBeInTheDocument();
});
test("useTx sends, settles, and maps cancel and contract errors", async () => {
  const { ctx } = await setup();
  const send = vi.fn().mockResolvedValueOnce([{ hash: "H1", outcome: null }]).mockRejectedValueOnce(new WalletCancelled()).mockRejectedValueOnce(new Error("Smart contract panicked: NOT_STUCK"));
  const wallet = { send, connect: vi.fn(), disconnect: vi.fn(), accountId: () => "a", onAccountChange: () => () => {} };
  const settled = vi.fn();
  const { result } = renderHook(() => useTx(wallet, ctx, settled));
  await act(async () => result.current.run([{ name: "advance", args: { nonce: 1 } }]));
  expect(result.current.state).toEqual({ kind: "done", hashes: ["H1"] });
  await act(async () => result.current.run([{ name: "advance", args: { nonce: 1 } }]));
  expect(result.current.state).toEqual({ kind: "cancelled" });
  await act(async () => result.current.run([{ name: "advance", args: { nonce: 1 } }]));
  expect(result.current.state).toMatchObject({ kind: "rejected", raw: "Smart contract panicked: NOT_STUCK" });
  expect(settled).toHaveBeenCalledTimes(3);
});
test("useTx refuses out loud when there is no build context", async () => {
  const wallet = { send: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), accountId: () => "a", onAccountChange: () => () => {} };
  const { result } = renderHook(() => useTx(wallet, null, vi.fn()));
  await act(async () => result.current.run([{ name: "deposit", args: { amount: "1" } }]));
  expect(result.current.state).toMatchObject({ kind: "rejected", sentence: expect.stringMatching(/will not sign/) });
  expect(wallet.send).not.toHaveBeenCalled();
});
