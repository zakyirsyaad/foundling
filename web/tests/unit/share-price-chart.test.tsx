import { render, screen } from "@testing-library/react";

import { PriceTip } from "@/features/vault/SharePriceChart";

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
