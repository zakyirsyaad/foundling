import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { StuckPanel, haltWarning } from "@/features/vault/StuckPanel";
import { fixtureSnapshot } from "../fixtures/snapshot";

test("the halt warning fires 30 s before the halt clock runs out", () => {
  expect(haltWarning(1_600n, 1_570n)).toBe(true);
  expect(haltWarning(1_600n, 1_569n)).toBe(false);
  expect(haltWarning(1_600n, 1_700n)).toBe(true);
  expect(haltWarning(null, 0n)).toBe(false);
});

async function stuckSnapshot(chainTime = 2_000n) {
  return fixtureSnapshot({
    chainTimeSeconds: chainTime,
    policy: { ...(await fixtureSnapshot()).policy, haltAfter: 600n },
    stage: { kind: "Stuck", nonce: 9n, step: "Swap", attempt: 1, since: 1_500n },
  });
}

test("a stuck vault offers advance as the primary action and says what it can do", async () => {
  const s = await stuckSnapshot();
  const run = vi.fn();
  await act(async () => render(<StuckPanel s={s} fresh run={run} busy={false} canSign />));
  const advance = screen.getByRole("button", { name: "Advance cycle 9" });
  expect(advance).toHaveAttribute("data-variant", "primary");
  expect(screen.getByText(/may go back to Stuck/)).toBeInTheDocument();
  await userEvent.setup().click(advance);
  expect(run).toHaveBeenCalledWith([{ name: "advance", args: { nonce: 9 } }]);
});
test("close to halt_after the panel warns before signing", async () => {
  const s = await stuckSnapshot(2_080n);
  render(<StuckPanel s={s} fresh run={vi.fn()} busy={false} canSign />);
  expect(screen.getByRole("alert")).toHaveTextContent(/halt the vault/);
});
test("recovery waits for a fresh read", async () => {
  const s = await stuckSnapshot();
  render(<StuckPanel s={s} fresh={false} run={vi.fn()} busy={false} canSign />);
  expect(screen.getByRole("button", { name: "Advance cycle 9" })).toBeDisabled();
  expect(screen.getByText("Waiting for a fresh read")).toBeInTheDocument();
});
test("a stale awaiting stage offers only abort_stale_cycle, as a plain button", async () => {
  const base = await fixtureSnapshot();
  const s = { ...base, blockHeight: 1_000n, stage: { kind: "AwaitingDecision" as const, nonce: 4n, enteredBlock: 100n } };
  const run = vi.fn();
  render(<StuckPanel s={s} fresh run={run} busy={false} canSign />);
  const abort = screen.getByRole("button", { name: "Abort stale cycle" });
  expect(abort).not.toHaveAttribute("data-variant", "primary");
  expect(screen.queryByRole("button", { name: /Advance/ })).toBeNull();
  await userEvent.setup().click(abort);
  expect(run).toHaveBeenCalledWith([{ name: "abort_stale_cycle", args: {} }]);
});
test("an expired decision offers expire_decision", async () => {
  const base = await fixtureSnapshot();
  render(<StuckPanel s={{ ...base, stage: { kind: "DecisionReady", nonce: 4n, expiresAt: 1n } }} fresh run={vi.fn()} busy={false} canSign />);
  expect(screen.getByRole("button", { name: "Expire decision" })).toBeInTheDocument();
});
test("an idle vault renders nothing", async () => {
  const { container } = render(<StuckPanel s={await fixtureSnapshot()} fresh run={vi.fn()} busy={false} canSign />);
  expect(container).toBeEmptyDOMElement();
});
test("without a wallet the buttons are replaced by the CLI command", async () => {
  const s = await stuckSnapshot();
  render(<StuckPanel s={s} fresh run={vi.fn()} busy={false} canSign={false} />);
  expect(screen.getByRole("button", { name: "Advance cycle 9" })).toBeDisabled();
  expect(screen.getByText(/advance/, { selector: "code" })).toBeInTheDocument();
});
