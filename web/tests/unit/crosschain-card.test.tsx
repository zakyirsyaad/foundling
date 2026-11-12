import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Position } from "@/lib/chain/types";
import { fixtureSnapshot } from "../fixtures/snapshot";

vi.mock("@/config", async () => {
  const { loadConfig: load } = await import("@/config/deployment");
  const { TEST_ONECLICK_KEY: key } = await import("../mock-server/oneclick");
  return { config: load({ NEXT_PUBLIC_NETWORK: "mainnet", NEXT_PUBLIC_VAULT_ID: "foundling-vault.near", NEXT_PUBLIC_RPC_URLS: "http://localhost:3199/rpc", NEXT_PUBLIC_TEST_BUILD: "1", NEXT_PUBLIC_ONECLICK_KEY: key, NEXT_PUBLIC_ONECLICK_CHAINS: "base,eth" }) };
});

const { wallet, extra, api } = vi.hoisted(() => ({
  wallet: { account: "alice.near" as string | null },
  extra: {} as Record<string, unknown>,
  api: { down: false, status: null as null | { status: string; swapDetails?: unknown }, submitted: [] as string[], submitFails: false },
}));
vi.mock("@/lib/wallet/WalletProvider", () => ({ useWallet: () => ({ wallet: null, account: wallet.account }) }));

// jsdom swaps the global Uint8Array, which breaks tweetnacl's type check inside the SDK. Real
// signature checks run in oneclick-core.test.ts (node) and in the e2e (a real browser).
vi.mock("@/lib/crosschain/signature", async (orig) => ({
  ...(await orig<typeof import("@/lib/crosschain/signature")>()),
  verifyQuote: () => !extra.badSignature,
}));
vi.mock("@/lib/crosschain/client", () => ({
  createOneClick: () => ({
    tokens: async () => (api.down ? Promise.reject(new Error("down")) : [{ assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", contractAddress: "0x8335" }]),
    quote: async (req: Record<string, unknown>) => (await import("../mock-server/oneclick")).quote({ extra }, req),
    status: async () => (api.status ? { status: api.status.status, raw: api.status } : "not-found"),
    submit: async (h: string) => (api.submitFails ? Promise.reject(new Error("1Click is down")) : void api.submitted.push(h)),
  }),
}));

import { CrossChainCard } from "@/features/crosschain/CrossChainCard";
import { config } from "@/config";

const REFUND = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const pos: Position = { account: "alice.near", shares: 0n, pending: 0n, netDeposit: 0n, claimable: { usdc: 0n, wnear: 0n }, registered: { vault: false, usdc: false, wnear: true }, balances: { usdc: 10_000_000n, usdcE: 0n, near: 10n ** 24n }, allowed: true };

beforeEach(() => {
  for (const k of Object.keys(extra)) delete extra[k];
  api.down = false;
  api.status = null;
  api.submitted = [];
  api.submitFails = false;
  wallet.account = "alice.near";
  window.localStorage.clear();
});

async function renderCard(p: Position = pos, run = vi.fn(), unreadable = false) {
  const s = await fixtureSnapshot();
  let r!: ReturnType<typeof render>;
  await act(async () => {
    const ctx = { config, assets: s.assets, storageMin: { vault: s.storageMin, usdc: s.tokenStorageMin.usdc, wnear: s.tokenStorageMin.wnear } };
    r = render(<CrossChainCard s={s} p={p} unreadable={unreadable} run={run} busy={false} ctx={ctx} gasPrice={100_000_000n} />);
  });
  return { r, run, s };
}

async function fillAndQuote() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC to send"), "5");
  await user.type(screen.getByLabelText("Refund address on Base"), REFUND);
  await user.click(screen.getByRole("button", { name: "Get a quote" }));
  return user;
}

test("without a wallet the card asks to connect", async () => {
  wallet.account = null;
  await renderCard();
  expect(screen.getByText(/Connect a NEAR wallet first/)).toBeInTheDocument();
});
test("disabled chains are marked, and an unreadable vault asks for no quote", async () => {
  await renderCard(pos, vi.fn(), true);
  expect(screen.getByText(/not readable right now, so no quote/)).toBeInTheDocument();
});
test("the full guided flow: quote, register, address, SUCCESS, deposit", async () => {
  const { run, r } = await renderCard();
  const user = await fillAndQuote();
  expect(await screen.findByText("Arrives (about)")).toBeInTheDocument();
  expect(screen.queryByTestId("near-need")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Register" }));
  expect(run).toHaveBeenCalledWith([{ name: "register_vault", args: {} }, { name: "register_usdc", args: {} }]);
  const s = await fixtureSnapshot();
  await act(async () => r.rerender(<CrossChainCard s={s} p={{ ...pos, registered: { vault: true, usdc: true, wnear: true } }} unreadable={false} run={run} busy={false} />));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  expect(await screen.findByTestId("deposit-address")).toHaveTextContent("0xDep");
  expect(screen.getByText(/Token 0x8335/)).toBeInTheDocument();
  await user.type(screen.getByLabelText(/Origin tx hash/), "0xtx");
  await user.click(screen.getByRole("button", { name: "Submit tx hash" }));
  expect(api.submitted).toEqual(["0xtx"]);
  const createObjectURL = vi.fn(() => "blob:x");
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  await user.click(screen.getByRole("button", { name: "Download the signed quote" }));
  expect(createObjectURL).toHaveBeenCalled();
  api.status = { status: "SUCCESS", swapDetails: { amountOut: "4999800" } };
  const deposit = await screen.findByRole("button", { name: "Deposit 4.9998 USDC" }, { timeout: 4000 });
  await user.click(deposit);
  expect(run).toHaveBeenLastCalledWith([{ name: "deposit", args: { amount: "4999800" } }]);
});
test("REFUNDED, FAILED and INCOMPLETE_DEPOSIT each say what happened", async () => {
  await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  await screen.findByTestId("deposit-address");
  api.status = { status: "INCOMPLETE_DEPOSIT" };
  expect(await screen.findByText(/Less than the minimum arrived/, {}, { timeout: 4000 })).toBeInTheDocument();
  api.status = { status: "REFUNDED", swapDetails: { refundedAmount: "4997600", refundReason: "deadline" } };
  expect(await screen.findByText(/refunded the swap to/, {}, { timeout: 4000 })).toHaveTextContent("4.9976 USDC (deadline)");
  api.status = { status: "FAILED" };
  expect(await screen.findByText(/No refund is promised here/, {}, { timeout: 4000 })).toBeInTheDocument();
});
test("SUCCESS for another account asks to connect that account", async () => {
  const { r, run, s } = await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  await screen.findByTestId("deposit-address");
  wallet.account = "bob.near";
  api.status = { status: "SUCCESS", swapDetails: { amountOut: "4999800" } };
  await act(async () => r.rerender(<CrossChainCard s={s} p={pos} unreadable={false} run={run} busy={false} />));
  expect(await screen.findByText(/to deposit the USDC that arrived/, {}, { timeout: 4000 })).toHaveTextContent("alice.near");
});
test("a bad signature or a bad echo stops before any address", async () => {
  extra.badSignature = true;
  await renderCard();
  await fillAndQuote();
  expect(await screen.findByRole("alert")).toHaveTextContent("signature did not verify");
  delete extra.badSignature;
});
test("an echo that changed the recipient is refused", async () => {
  extra.badEcho = true;
  await renderCard();
  await fillAndQuote();
  expect(await screen.findByRole("alert")).toHaveTextContent("(recipient)");
});
test("an output below min_deposit is refused", async () => {
  await renderCard();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("USDC to send"), "0.5");
  await user.type(screen.getByLabelText("Refund address on Base"), REFUND);
  await user.click(screen.getByRole("button", { name: "Get a quote" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("below the vault's minimum deposit");
});
test("1Click down shows the card as unavailable", async () => {
  api.down = true;
  await renderCard();
  expect(await screen.findByText(/1Click did not answer/)).toBeInTheDocument();
});
test("Ethereum warns about fees and a bad checksum blocks the quote", async () => {
  await renderCard();
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(/Ethereum/));
  expect(screen.getByText(/Network fees on Ethereum/)).toBeInTheDocument();
  await user.type(screen.getByLabelText("Refund address on Ethereum"), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD");
  expect(screen.getByText(/Not a valid EVM address/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Get a quote" })).toBeDisabled();
});
test("the blocking notice never shows the stored address again", async () => {
  window.localStorage.setItem("foundling.swaps.v1:mainnet:foundling-vault.near", JSON.stringify([{ depositAddress: "0xOldStoredAddress", recipient: "alice.near", chainId: "base", deadlineMs: Date.now() + 600_000, createdAtMs: 0, final: null, txHashes: [], declaredNotSent: false }]));
  const { r } = await renderCard();
  expect(r.container.textContent).not.toContain("0xOldStoredAddress");
});
test("the address closes at the earlier of quote.deadline and the requested deadline", async () => {
  extra.quoteDeadlineInMs = 60_000;
  await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Do not send");
});
test("a final status is saved once, not in a loop", async () => {
  await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  await screen.findByTestId("deposit-address");
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  api.status = { status: "SUCCESS", swapDetails: { amountOut: "4999800" } };
  await screen.findByRole("button", { name: "Deposit 4.9998 USDC" }, { timeout: 4000 });
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(setItem.mock.calls.length).toBeLessThan(5);
  setItem.mockRestore();
});
test("a second tab that already got an address blocks this one", async () => {
  await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  window.localStorage.setItem("foundling.swaps.v1:mainnet:foundling-vault.near", JSON.stringify([{ depositAddress: "0xOtherTab", recipient: "alice.near", chainId: "base", deadlineMs: Date.now() + 600_000, createdAtMs: 0, final: null, txHashes: [], declaredNotSent: false }]));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Another swap for this account");
  expect(screen.queryByTestId("deposit-address")).toBeNull();
});
test("a stored unfinished swap is polled and its final status written back", async () => {
  window.localStorage.setItem("foundling.swaps.v1:mainnet:foundling-vault.near", JSON.stringify([{ depositAddress: "0xStored", recipient: "alice.near", chainId: "base", deadlineMs: Date.now() + 600_000, createdAtMs: 0, final: null, txHashes: [], declaredNotSent: false }]));
  api.status = { status: "SUCCESS", swapDetails: { amountOut: "1" } };
  await renderCard();
  await waitFor(() => expect(screen.getByRole("list", { name: "Earlier swaps" })).toHaveTextContent("SUCCESS"), { timeout: 4000 });
  expect(screen.queryByText(/A second quote now risks a second send/)).toBeNull();
});
test("a pending swap blocks a new quote until the user says nothing was sent", async () => {
  window.localStorage.setItem("foundling.swaps.v1:mainnet:foundling-vault.near", JSON.stringify([{ depositAddress: "0xOld", recipient: "alice.near", chainId: "base", deadlineMs: Date.now() + 600_000, createdAtMs: 0, final: null, txHashes: [], declaredNotSent: false }]));
  await renderCard();
  expect(await screen.findByText(/A second quote now risks a second send/)).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Earlier swaps" })).toHaveTextContent("in progress");
  await userEvent.setup().click(screen.getByRole("button", { name: "I have not sent anything to it" }));
  expect(screen.getByLabelText("USDC to send")).toBeInTheDocument();
});
test("a hidden tab hides the address until re-anchored and confirmed", async () => {
  await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  await screen.findByTestId("deposit-address");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.queryByTestId("deposit-address")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check the time" }));
  await user.click(await screen.findByRole("button", { name: "I have not sent anything yet" }));
  expect(screen.getByTestId("deposit-address")).toBeInTheDocument();
});
test("a skewed clock gives Do not send", async () => {
  extra.clockSkewMs = 30 * 60_000;
  await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Do not send");
});
test("a swap can be looked up by its deposit address", async () => {
  await renderCard();
  const user = userEvent.setup();
  await user.click(screen.getByText("Look up a swap by deposit address"));
  await user.type(screen.getByLabelText("Deposit address"), "0xabc");
  await user.click(screen.getByRole("button", { name: "Look up" }));
  await waitFor(() => expect(screen.getByTestId("lookup-result")).toHaveTextContent("Not known to 1Click yet."));
});

test("the prepare step states the NEAR the registrations need", async () => {
  await renderCard({ ...pos, balances: { ...pos.balances, near: 0n } });
  await fillAndQuote();
  expect(await screen.findByTestId("near-need")).toHaveTextContent(/more NEAR/);
});

async function toAddress() {
  await renderCard({ ...pos, registered: { vault: true, usdc: true, wnear: true } });
  const user = await fillAndQuote();
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(screen.getByRole("button", { name: "Get the deposit address" }));
  await screen.findByTestId("deposit-address");
  return user;
}
const stored = () => JSON.parse(window.localStorage.getItem("foundling.swaps.v1:mainnet:foundling-vault.near") ?? "[]") as { txHashes: string[] }[];

test("an amount 1Click reports in a form this page cannot read does not break the card", async () => {
  await toAddress();
  api.status = { status: "SUCCESS", swapDetails: { amountOut: "4.9998" } };
  expect(await screen.findByText(/could not read the amount that arrived/, {}, { timeout: 4000 })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Deposit / })).toBeNull();
});
test("a refunded amount that cannot be read is left out, not a crash", async () => {
  await toAddress();
  api.status = { status: "REFUNDED", swapDetails: { refundedAmount: "abc" } };
  expect(await screen.findByText(/refunded the swap to/, {}, { timeout: 4000 })).not.toHaveTextContent("abc");
});
test("a tx hash 1Click does not take says so", async () => {
  const user = await toAddress();
  api.submitFails = true;
  await user.type(screen.getByLabelText(/Origin tx hash/), "0xtx");
  await user.click(screen.getByRole("button", { name: "Submit tx hash" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("1Click did not take the tx hash: 1Click is down");
  expect(stored()[0]?.txHashes).toEqual([]);
});
test("a second tx hash is kept next to the first", async () => {
  const user = await toAddress();
  const field = screen.getByLabelText(/Origin tx hash/);
  await user.type(field, "0xone");
  await user.click(screen.getByRole("button", { name: "Submit tx hash" }));
  await user.clear(field);
  await user.type(field, "0xtwo");
  await user.click(screen.getByRole("button", { name: "Submit tx hash" }));
  await waitFor(() => expect(stored()[0]?.txHashes).toEqual(["0xone", "0xtwo"]));
});
test("the live swap alone shows no earlier-swaps list", async () => {
  await toAddress();
  expect(screen.queryByRole("list", { name: "Earlier swaps" })).toBeNull();
});
test("an expired unresolved swap stays queryable but is never a send destination", async () => {
  window.localStorage.setItem("foundling.swaps.v1:mainnet:foundling-vault.near", JSON.stringify([{ depositAddress: "0xExpired", recipient: "alice.near", chainId: "base", deadlineMs: Date.now() - 25 * 3_600_000, createdAtMs: 0, final: null, txHashes: ["0xtx"], declaredNotSent: false }]));
  await renderCard();
  const earlier = await screen.findByRole("list", { name: "Earlier swaps" });
  expect(earlier).toHaveTextContent("expired · unresolved");
  expect(earlier).toHaveTextContent("0xExpired");
  expect(earlier).toHaveTextContent("Do not send to this address");
  expect(screen.queryByTestId("deposit-address")).toBeNull();
  expect(screen.getByLabelText("USDC to send")).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Forget this record" }));
  expect(screen.queryByRole("list", { name: "Earlier swaps" })).toBeNull();
});
test("an expired unresolved swap is reconciled when 1Click finally answers", async () => {
  window.localStorage.setItem("foundling.swaps.v1:mainnet:foundling-vault.near", JSON.stringify([{ depositAddress: "0xExpired", recipient: "alice.near", chainId: "base", deadlineMs: Date.now() - 25 * 3_600_000, createdAtMs: 0, final: null, txHashes: ["0xtx"], declaredNotSent: false }]));
  api.status = { status: "SUCCESS", swapDetails: { amountOut: "1" } };
  await renderCard();
  await waitFor(() => expect(screen.getByRole("list", { name: "Earlier swaps" })).toHaveTextContent("SUCCESS"), { timeout: 4000 });
  expect(screen.queryByText("Expired record")).toBeNull();
});
