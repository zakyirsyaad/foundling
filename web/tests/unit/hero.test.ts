import { keysLine } from "@/lib/proof/keysLine";
import { fixtureSnapshot } from "../fixtures/snapshot";

test("the hero line labels the sample", async () => {
  const snapshot = await fixtureSnapshot({ vaultId: "vault.fdl-m12-0d1276.testnet" });
  expect(keysLine({ kind: "sample", label: "Testnet rehearsal vault (m12)", snapshot }, "testnet")).toBe("Testnet rehearsal (m12) · vault.…tnet · 0 access keys · as of block #200");
});
test("the live line names the network and the vault", async () => {
  const snapshot = await fixtureSnapshot({}, 1);
  expect(keysLine({ kind: "live", snapshot }, "mainnet")).toBe("mainnet · vault.foundling.near · 1 access key · as of block #200");
});
test("no source gives the unreadable line", () => {
  expect(keysLine(null, "mainnet")).toBe("Vault not readable right now. Check it yourself with the command below.");
});
