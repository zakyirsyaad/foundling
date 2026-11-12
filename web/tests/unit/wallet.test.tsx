import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { loadConfig } from "@/config/deployment";
import { ConnectButton } from "@/features/vault/ConnectButton";
import { createWallet } from "@/lib/wallet/connector";
import { createMockWallet } from "@/lib/wallet/mock";
import { createMockWallet as noMock } from "@/lib/wallet/no-mock";
import { TxFailed, WalletCancelled } from "@/lib/wallet/types";
import { WalletProvider } from "@/lib/wallet/WalletProvider";

const handlers: Record<string, (e: unknown) => void> = {};
const wallet = { getAccounts: vi.fn(), signAndSendTransactions: vi.fn() };
vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: class {
    constructor(public opts: unknown) {}
    on(name: string, cb: (e: unknown) => void) { handlers[name] = cb; }
    getConnectedWallet() { return Promise.reject(new Error("none")); }
    connect() { return Promise.resolve(wallet); }
    disconnect() { return Promise.resolve(); }
    wallet() { return Promise.resolve(wallet); }
  },
}));

const cfg = loadConfig({ NEXT_PUBLIC_NETWORK: "mainnet", NEXT_PUBLIC_VAULT_ID: "foundling-vault.near", NEXT_PUBLIC_RPC_URLS: "https://rpc.mainnet.fastnear.com" });
const tx = { receiverId: "foundling-vault.near", methodName: "redeem", args: { shares: "1" }, gas: 115n * 10n ** 12n, deposit: 1n };

test("the near-connect wrapper connects, signs and maps hashes", async () => {
  const w = createWallet(cfg, "nonce");
  wallet.getAccounts.mockResolvedValue([{ accountId: "alice.near" }]);
  expect(await w.connect()).toBe("alice.near");
  expect(w.accountId()).toBe("alice.near");
  wallet.signAndSendTransactions.mockResolvedValue([{ transaction: { hash: "H1" } }, { transaction_outcome: { id: "H2" } }]);
  const out = await w.send([tx, tx]);
  expect(out.map((o) => o.hash)).toEqual(["H1", "H2"]);
  expect(wallet.signAndSendTransactions.mock.calls[0]![0].transactions[0]).toEqual({
    receiverId: "foundling-vault.near",
    actions: [{ type: "FunctionCall", params: { methodName: "redeem", args: { shares: "1" }, gas: "115000000000000", deposit: "1" } }],
  });
});
test("a rejection in the wallet becomes WalletCancelled; other errors pass through", async () => {
  const w = createWallet(cfg, "nonce");
  wallet.signAndSendTransactions.mockRejectedValueOnce(new Error("User rejected the request"));
  await expect(w.send([tx])).rejects.toBeInstanceOf(WalletCancelled);
  wallet.signAndSendTransactions.mockRejectedValueOnce(new Error("Smart contract panicked: NOT_STUCK"));
  await expect(w.send([tx])).rejects.toThrow("NOT_STUCK");
});
test("account changes reach the listeners", async () => {
  const w = createWallet(cfg, "nonce");
  const seen: (string | null)[] = [];
  w.onAccountChange((id) => seen.push(id));
  handlers["wallet:signIn"]!({ accounts: [{ accountId: "bob.near" }] });
  handlers["wallet:signOut"]!({});
  expect(seen).toEqual(["bob.near", null]);
  await w.disconnect();
});
test("an empty account list on connect counts as cancelled", async () => {
  wallet.getAccounts.mockResolvedValue([]);
  await expect(createWallet(cfg, "n").connect()).rejects.toBeInstanceOf(WalletCancelled);
});
test("the production stand-in refuses to run", () => {
  expect(() => noMock()).toThrow(/test build/);
});
test("the mock wallet posts calls to the mock server and can be told to cancel or fail", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hashes: ["M1"] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const w = createMockWallet();
  expect(await w.connect()).toBe("alice.testnet");
  expect((await w.send([tx]))[0]!.hash).toBe("M1");
  window.__mockWallet!.next = "cancel";
  await expect(w.send([tx])).rejects.toBeInstanceOf(WalletCancelled);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "NOT_STUCK" }), { status: 400 }));
  window.__mockWallet!.next = "contract:NOT_STUCK";
  await expect(w.send([tx])).rejects.toBeInstanceOf(TxFailed);
  await w.disconnect();
  expect(w.accountId()).toBeNull();
  vi.unstubAllGlobals();
});
test("the connect button connects through the provider and shows the account", async () => {
  window.localStorage.clear();
  const user = userEvent.setup();
  await act(async () => render(<WalletProvider nonce="n"><ConnectButton /></WalletProvider>));
  const button = await screen.findByRole("button", { name: "Connect wallet" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  expect(await screen.findByTestId("account")).toHaveAttribute("title", "alice.testnet");
  await user.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
});
test("an account id from the wallet that is not a NEAR account is dropped", () => {
  const w = createWallet(cfg, "n");
  const seen: (string | null)[] = [];
  w.onAccountChange((id) => seen.push(id));
  handlers["wallet:signIn"]!({ accounts: [{ accountId: "a.near; curl x|sh #" }] });
  expect(seen).toEqual([null]);
  expect(w.accountId()).toBeNull();
});
test("an outcome that failed on chain is thrown with its panic, not returned as done", async () => {
  const w = createWallet(cfg, "nonce");
  wallet.signAndSendTransactions.mockResolvedValueOnce([{ transaction: { hash: "H1" }, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: NOT_STUCK" } } } } }, receipts_outcome: [] }]);
  await expect(w.send([tx])).rejects.toBeInstanceOf(TxFailed);
  wallet.signAndSendTransactions.mockResolvedValueOnce([{ transaction: { hash: "H2" }, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: LOW_GAS" } } } } } } }] }]);
  await expect(w.send([tx])).rejects.toBeInstanceOf(TxFailed);
});
test("an on-chain failure whose text says cancelled is still a failure, not a wallet cancel", async () => {
  const w = createWallet(cfg, "nonce");
  wallet.signAndSendTransactions.mockResolvedValueOnce([{ transaction: { hash: "H1" }, status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: cancelled by market" } } } } }, receipts_outcome: [] }]);
  const err = await w.send([tx]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(TxFailed);
  expect(err).not.toBeInstanceOf(WalletCancelled);
  expect((err as TxFailed).hashes).toEqual(["H1"]);
});
test("a deposit the vault refunded in full is marked refunded", async () => {
  const w = createWallet(cfg, "nonce");
  const zero = Buffer.from(JSON.stringify("0")).toString("base64");
  wallet.signAndSendTransactions.mockResolvedValueOnce([{ transaction: { hash: "H3" }, status: { SuccessValue: zero }, receipts_outcome: [] }]);
  const out = await w.send([{ ...tx, methodName: "ft_transfer_call" }]);
  expect(out[0]).toMatchObject({ hash: "H3", refunded: true });
});
test("only a real rejection counts as cancelled", async () => {
  const w = createWallet(cfg, "nonce");
  wallet.signAndSendTransactions.mockRejectedValueOnce(new Error("user account has insufficient balance"));
  await expect(w.send([tx])).rejects.not.toBeInstanceOf(WalletCancelled);
});
