import { cliCommand } from "@/lib/wallet/cli";

test("a wallet call has an equivalent near-cli command", () => {
  const tx = { receiverId: "usdc.near", methodName: "ft_transfer_call", args: { receiver_id: "vault.near", amount: "5000000", msg: "deposit" }, gas: 120n * 10n ** 12n, deposit: 1n };
  expect(cliCommand(tx, "alice.near", "mainnet")).toBe(
    `near contract call-function as-transaction usdc.near ft_transfer_call json-args '{"receiver_id":"vault.near","amount":"5000000","msg":"deposit"}' prepaid-gas '120 Tgas' attached-deposit '1 yoctoNEAR' sign-as 'alice.near' network-config mainnet sign-with-keychain send`,
  );
});
test("without an account the signer is a placeholder", () => {
  const tx = { receiverId: "vault.near", methodName: "advance", args: { nonce: 3 }, gas: 130n * 10n ** 12n, deposit: 0n };
  expect(cliCommand(tx, null, "testnet")).toContain("sign-as YOUR_ACCOUNT.near");
  expect(cliCommand(tx, null, "testnet")).toContain("attached-deposit '0 yoctoNEAR'");
});
