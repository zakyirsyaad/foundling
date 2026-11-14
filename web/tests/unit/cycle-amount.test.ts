import { tradeAmountText } from "@/lib/cycles/amount";

test("a buy shows the USDC that went in", () => {
  // Mainnet cycle 21: 0.4 USDC in, 0.110425676 wNEAR out.
  expect(tradeAmountText(400_000n, 110_425_676_000_000_000_000_000n)).toBe("0.4 USDC");
});
test("a sell shows the wNEAR that went in, not that number read as USDC", () => {
  // Mainnet cycle 34: 0.2213 wNEAR in, 0.737622 USDC out.
  expect(tradeAmountText(221_370_821_874_649_239_540_000n, 737_622n)).toBe("0.2213 wNEAR");
});
test("an amount with no other side stays in USDC", () => {
  expect(tradeAmountText(12_400_000n, null)).toBe("12.4 USDC");
});
test("no amount shows a dash", () => {
  expect(tradeAmountText(null, null)).toBe("—");
});
