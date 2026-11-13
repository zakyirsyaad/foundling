import { render, screen } from "@testing-library/react";

import { PriceTip, axisLabel, chartPoints } from "@/features/vault/SharePriceChart";
import type { NavPoint } from "@/lib/history/client";

test("the chart tooltip uses the theme's popover colours, not a fixed white box", () => {
  render(<PriceTip active label="2026-11-13" payload={[{ value: 0.998485 }]} />);
  const tip = screen.getByTestId("price-tip");
  expect(tip).toHaveClass("bg-popover", "text-popover-foreground");
  expect(tip).toHaveTextContent("2026-11-13");
  expect(tip).toHaveTextContent("0.998485 USDC per share");
});
test("the chart tooltip shows nothing while no point is under the cursor", () => {
  const { container } = render(<PriceTip active={false} label="2026-11-13" payload={[{ value: 1 }]} />);
  expect(container).toBeEmptyDOMElement();
  render(<PriceTip active label="2026-11-13" payload={[]} />);
  expect(screen.queryByTestId("price-tip")).toBeNull();
});

// Mainnet, 2026-11-13: the vault holds wNEAR from cycle 21 on, and the oracle price moves each cycle.
const SHARES = 4n * 10n ** 12n;
const WNEAR = 221_370_821_874_649_239_546_068n;
const sameDay: NavPoint[] = [
  { nonce: 20n, at: "2026-11-13T13:21:16.000Z", book: { usdc: 4_000_000n, wnear: 0n }, totalShares: SHARES, oracle: null },
  { nonce: 22n, at: "2026-11-13T14:21:57.998Z", book: { usdc: 3_202_649n, wnear: WNEAR }, totalShares: SHARES, oracle: { near: 357_365_418n, usdc: 99_977_718n } },
  { nonce: 24n, at: "2026-11-13T15:22:25.580Z", book: { usdc: 3_202_649n, wnear: WNEAR }, totalShares: SHARES, oracle: { near: 349_529_637n, usdc: 99_983_685n } },
];

test("cycles on the same day each get their own point, so a hover cannot land on the first one", () => {
  const points = chartPoints(sameDay, 6);
  expect(points).toHaveLength(3);
  expect(new Set(points.map((p) => p.at)).size).toBe(3);
  expect(points.map((p) => p.nonce)).toEqual(["20", "22", "24"]);
  expect(new Set(points.map((p) => p.price)).size).toBe(3);
});

test("the axis shows the time of day, since one day holds many cycles", () => {
  expect(axisLabel("2026-11-13T14:21:57.998Z")).toBe("11-13 14:21");
  expect(sameDay.map((p) => axisLabel(p.at))).toEqual(["11-13 13:21", "11-13 14:21", "11-13 15:22"]);
});

test("the tooltip names the cycle and its time, read from the point under the cursor", () => {
  const second = chartPoints(sameDay, 6)[1];
  if (!second) throw new Error("the fixture should give a second point");
  render(<PriceTip active label={second.at} payload={[{ value: second.price, payload: second }]} />);
  const tip = screen.getByTestId("price-tip");
  expect(tip).toHaveTextContent("Cycle 22 · 2026-11-13 14:21 UTC");
  expect(tip).toHaveTextContent(`${second.price.toFixed(6)} USDC per share`);
});
