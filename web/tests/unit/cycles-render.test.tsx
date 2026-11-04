import { render, screen, within } from "@testing-library/react";

import { CycleDetail } from "@/features/cycles/CycleDetail";
import { CycleFilterBar, CycleMap, CycleTable, PartialTable } from "@/features/cycles/CycleList";
import type { CycleRow } from "@/lib/history/client";

const done = { pass: 5, skip: 0, fail: 0, state: "done" as const };
const row = (nonce: bigint, last: string, code?: string): CycleRow => ({
  nonce, startedAt: "2026-11-11T09:00:00Z", finishedAt: null, events: [{ name: "cycle_started" }, code ? { name: last, code } : { name: last }],
  amountIn: last === "executed" ? 12_400_000n : null, amountOut: null, txHashes: [`tx${nonce}aaaaaaaaaaaa`], verifier: done, obsRecheck: done,
});

test("the table shows result and proof words from the status table", () => {
  render(<CycleTable rows={[row(41n, "executed"), row(40n, "hold", "NO_DECISION")]} />);
  const r41 = screen.getByRole("row", { name: /#41/ });
  expect(within(r41).getByText("Executed")).toBeInTheDocument();
  expect(within(r41).getByText("Pass")).toBeInTheDocument();
  expect(within(r41).getByText("12.4 USDC")).toBeInTheDocument();
  expect(within(screen.getByRole("row", { name: /#40/ })).getByText("Hold")).toBeInTheDocument();
});
test("an empty history still reads well", () => {
  render(<CycleTable rows={[]} />);
  expect(screen.getByText(/No cycles yet/)).toBeInTheDocument();
});
test("the map has one labelled cell per cycle", () => {
  render(<CycleMap rows={[row(2n, "executed"), row(1n, "cycle_failed")]} />);
  expect(screen.getByRole("link", { name: "Cycle 1: Failed" })).toHaveAttribute("data-word", "Failed");
  expect(screen.getByRole("link", { name: "Cycle 2: Executed" })).toBeInTheDocument();
});
test("the filter marks the active one", () => {
  render(<CycleFilterBar active="hold" />);
  expect(screen.getByRole("link", { name: "Hold" })).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("href", "/app/cycles");
});
test("the partial table labels itself and shows missing decisions", () => {
  render(<PartialTable rows={[{ nonce: 41n, decision: '{"a":1}' }, { nonce: 40n, decision: null }]} />);
  expect(screen.getByText("Partial")).toBeInTheDocument();
  expect(screen.getByText("No decision to verify")).toBeInTheDocument();
});
test("the detail shows the timeline, the limit check, the proof and a copyable command", () => {
  render(<CycleDetail row={row(39n, "rejected", "PRICE_WIDE")} proof={{ verifier: done, obsRecheck: null, replay: "sealed" }} decision={'{"action":"buy"}'} revealAfter={1000n} chainTime={999n} network="testnet" vaultId="vault.foundling.testnet" />);
  expect(screen.getByRole("heading", { name: "Cycle 39" })).toBeInTheDocument();
  expect(screen.getByText("rejected (PRICE_WIDE)")).toBeInTheDocument();
  expect(screen.getByText("Rejected by the contract: PRICE_WIDE.")).toBeInTheDocument();
  expect(screen.getByText("Sealed")).toBeInTheDocument();
  expect(screen.getByText("Checking")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
});
test("an executed cycle says every limit held", () => {
  render(<CycleDetail row={row(41n, "executed")} proof={null} decision={null} revealAfter={0n} chainTime={1n} network="testnet" vaultId="v.testnet" />);
  expect(screen.getByText("Every limit held; the trade ran.")).toBeInTheDocument();
  expect(screen.getByText("No decision to verify")).toBeInTheDocument();
});
