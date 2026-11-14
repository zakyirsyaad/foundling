import { enabledChainNames } from "@/lib/crosschain/labels";

const chain = (label: string, enabled: boolean) => ({ label, enabled });

test("the card names only the chains that are switched on", () => {
  expect(enabledChainNames([chain("Base", true), chain("Arbitrum", false), chain("Ethereum", false)])).toBe("Base");
  expect(enabledChainNames([chain("Base", true), chain("Arbitrum", false), chain("Ethereum", true)])).toBe("Base or Ethereum");
  expect(enabledChainNames([chain("Base", true), chain("Arbitrum", true), chain("Ethereum", true)])).toBe("Base, Arbitrum or Ethereum");
});

test("with every chain off it names none of them", () => {
  expect(enabledChainNames([chain("Base", false)])).toBe("another chain");
});
