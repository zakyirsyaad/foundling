import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TxStatus } from "@/features/portfolio/TxStatus";

test("an unknown outcome warns and asks the person to check before signing again", async () => {
  const acknowledge = vi.fn();
  render(<TxStatus state={{ kind: "unknown", raw: "wallet timeout" }} onAcknowledge={acknowledge} />);
  expect(screen.getByRole("alert")).toHaveTextContent(/did not confirm whether this transaction was sent/);
  await userEvent.setup().click(screen.getByRole("button", { name: "I checked my wallet; nothing was sent" }));
  expect(acknowledge).toHaveBeenCalledOnce();
});

test("an interrupted request keeps the same acknowledgement path", async () => {
  const acknowledge = vi.fn();
  render(<TxStatus state={{ kind: "interrupted" }} onAcknowledge={acknowledge} />);
  expect(screen.getByRole("alert")).toHaveTextContent(/before this page reloaded/);
  await userEvent.setup().click(screen.getByRole("button", { name: "I checked my wallet; nothing was sent" }));
  expect(acknowledge).toHaveBeenCalledOnce();
});
