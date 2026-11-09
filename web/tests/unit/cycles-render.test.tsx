import { render, screen, within } from "@testing-library/react";

import { CycleDetail } from "@/features/cycles/CycleDetail";
import { CycleFilterBar, CycleMap, CyclePager, CycleTable, OlderPageUnreadable, PartialTable, cycleCursor } from "@/features/cycles/CycleList";
import type { CycleRow } from "@/lib/history/client";

import { HELD_DECISION } from "../fixtures/decision";

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
  render(<CycleDetail row={row(39n, "rejected", "PRICE_WIDE")} proof={{ verifier: done, obsRecheck: null, replay: "sealed", verifierCommit: null }} decision={'{"action":"buy"}'} revealAfter={1000n} chainTime={999n} network="testnet" vaultId="vault.foundling.testnet" />);
  expect(screen.getByRole("heading", { name: "Cycle 39" })).toBeInTheDocument();
  expect(screen.getByText("rejected (PRICE_WIDE)").closest("li")).toHaveAttribute("data-mark", "stop");
  expect(screen.getByText("cycle_started").closest("li")).toHaveAttribute("data-mark", "done");
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

test("a held cycle explains itself from the published decision", () => {
  render(<CycleDetail row={row(25n, "hold", "NO_DECISION")} proof={null} decision={HELD_DECISION} revealAfter={1000n} chainTime={999n} network="testnet" vaultId="v.testnet" />);
  expect(screen.getByRole("heading", { name: "Why it held" })).toBeInTheDocument();
  expect(screen.getByText("The price rule called for a buy, and the AI tripwire held it back.")).toBeInTheDocument();
  const why = screen.getByRole("list", { name: "How the decision was reached" });
  expect(within(why).getByText("Price rule: risk on, buy").closest("li")).toHaveAttribute("data-mark", "done");
  expect(within(why).getByText("AI tripwire: flagged, confidence 70").closest("li")).toHaveAttribute("data-mark", "stop");
  expect(within(why).getByText("Contract: hold, no trade").closest("li")).toHaveAttribute("data-mark", "wait");
  expect(screen.getByText("Flagged · confidence 70")).toBeInTheDocument();
  expect(screen.getByText("GLM-5.3 Flash")).toBeInTheDocument();
  expect(screen.getByText("3.6356 USD per NEAR · 19:59:06 UTC")).toBeInTheDocument();
  expect(screen.getByText("3.645 USD per NEAR · 19:58:54 UTC")).toBeInTheDocument();
  expect(screen.getByText("0.26%")).toBeInTheDocument();
  expect(screen.getByText("On testnet a rehearsal build reads both prices from its secret, not from the market.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy NEAR AI chat id" })).toBeInTheDocument();
  expect(screen.getByText("Decision as published on chain")).toBeInTheDocument();
});
test("a refused trade names the contract's code in the reason", () => {
  const asked = HELD_DECISION.replace('"action":"none"', '"action":"buy_risk"').replace('"amount_in":"0"', '"amount_in":"99000000"').replace('"ai_flag":1', '"ai_flag":0');
  render(<CycleDetail row={row(39n, "rejected", "OVER_CAP")} proof={null} decision={asked} revealAfter={0n} chainTime={1n} network="testnet" vaultId="v.testnet" />);
  expect(screen.getByRole("heading", { name: "Why it was refused" })).toBeInTheDocument();
  expect(screen.getByText("Contract: refused, OVER_CAP")).toBeInTheDocument();
});
test("the limit check reads the refusal that ended the cycle, not a retried PRICE_UNAVAILABLE", () => {
  const retried: CycleRow = { ...row(39n, "rejected", "PRICE_WIDE"), events: [{ name: "cycle_started" }, { name: "decision" }, { name: "rejected", code: "PRICE_UNAVAILABLE" }, { name: "rejected", code: "PRICE_WIDE" }] };
  render(<CycleDetail row={retried} proof={null} decision={null} revealAfter={0n} chainTime={1n} network="testnet" vaultId="v.testnet" />);
  expect(screen.getByText("Rejected by the contract: PRICE_WIDE.")).toBeInTheDocument();
});
test("a silent advisor's empty ai_ref shows no signed answer", () => {
  const silent = HELD_DECISION.replace('"ai_flag":1', '"ai_flag":2').replace(/"ai_ref":\{[^}]*\}/, '"ai_ref":{"chat_id":"","resp_sig_hash":""}');
  render(<CycleDetail row={row(26n, "hold", "NO_DECISION")} proof={null} decision={silent} revealAfter={0n} chainTime={1n} network="mainnet" vaultId="v.near" />);
  expect(screen.getByText("Silent · no valid answer")).toBeInTheDocument();
  expect(screen.queryByText("Signed answer")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy NEAR AI chat id" })).toBeNull();
});
test("on mainnet the recorded inputs carry no rehearsal note", () => {
  render(<CycleDetail row={row(25n, "hold", "NO_DECISION")} proof={null} decision={HELD_DECISION} revealAfter={0n} chainTime={1n} network="mainnet" vaultId="v.near" />);
  expect(screen.queryByText(/rehearsal build/)).toBeNull();
});
test("text that is not a Decision v1 is shown as it was published, with no reason card", () => {
  render(<CycleDetail row={row(39n, "hold", "NO_DECISION")} proof={null} decision={'{"action":"buy"}'} revealAfter={0n} chainTime={1n} network="testnet" vaultId="v.testnet" />);
  expect(screen.getByText('{"action":"buy"}')).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Why it held" })).toBeNull();
});

const SHA = "b6339b3c0a8c5e2f1d4e7a9b0c3d6e9f2a5b8c1d";
const code = () => screen.getByText((_, el) => el?.tagName === "CODE");
test("the command checks out the verifier commit that built this proof", () => {
  render(<CycleDetail row={row(39n, "executed")} proof={{ verifier: done, obsRecheck: null, replay: "sealed", verifierCommit: SHA }} decision={null} revealAfter={0n} chainTime={1n} network="testnet" vaultId="v.testnet" />);
  expect(code().textContent).toMatch(new RegExp(`^git checkout ${SHA} && python3 tools/fetch_proof.py `));
});
test("without a known verifier commit the command names the one to check out", () => {
  render(<CycleDetail row={row(39n, "executed")} proof={null} decision={null} revealAfter={0n} chainTime={1n} network="testnet" vaultId="v.testnet" />);
  expect(code().textContent).toMatch(/^git checkout VERIFIER_COMMIT && /);
  expect(screen.getByText("Replace VERIFIER_COMMIT with the commit that built this vault's binary.")).toBeInTheDocument();
});
test("the proof note ties the NEAR AI check to the verifier commit", () => {
  render(<CycleDetail row={row(39n, "executed")} proof={null} decision={null} revealAfter={0n} chainTime={1n} network="testnet" vaultId="v.testnet" />);
  expect(screen.queryByText(/not covered yet/)).toBeNull();
  expect(screen.getByText(/Newer verifiers also check the advisor's archived NEAR AI signature/)).toBeInTheDocument();
  expect(screen.getByText(/the commit in the command decides which checks run/)).toBeInTheDocument();
});

test("the pager links to older cycles with the filter kept, and back to the newest", () => {
  render(<CyclePager filter="hold" next="eyJuIjo0MH0" paged />);
  expect(screen.getByRole("link", { name: "Older cycles" })).toHaveAttribute("href", "/app/cycles?filter=hold&cursor=eyJuIjo0MH0");
  expect(screen.getByRole("link", { name: "Newest cycles" })).toHaveAttribute("href", "/app/cycles?filter=hold");
});
test("the first page of a short history has no pager", () => {
  const { container } = render(<CyclePager filter="all" next={null} paged={false} />);
  expect(container).toBeEmptyDOMElement();
});
test("the last page links back to the newest only", () => {
  render(<CyclePager filter="all" next={null} paged />);
  expect(screen.queryByRole("link", { name: "Older cycles" })).toBeNull();
  expect(screen.getByRole("link", { name: "Newest cycles" })).toHaveAttribute("href", "/app/cycles");
});
test("a cursor from the URL is passed on only when it looks like the API's base64url", () => {
  expect(cycleCursor("eyJuIjo0MH0")).toBe("eyJuIjo0MH0");
  expect(cycleCursor(undefined)).toBeUndefined();
  expect(cycleCursor("../etc")).toBeUndefined();
  expect(cycleCursor("a".repeat(513))).toBeUndefined();
});
test("an older page the API cannot read says so and links back to the newest, not to the latest decisions", () => {
  render(<OlderPageUnreadable filter="hold" />);
  expect(screen.getByText("This page of older cycles could not be read. The link may be out of date, or the history is pending.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Newest cycles" })).toHaveAttribute("href", "/app/cycles?filter=hold");
  expect(screen.queryByRole("table")).toBeNull();
});
