import { render, screen, within } from "@testing-library/react";

import { termsReady } from "@/lib/terms";
import { findForbidden } from "@/content/forbidden";
import { TRUST_SHORT } from "@/content/trust";
import { PartiesTable } from "@/features/trust/PartiesTable";
import { TrustView } from "@/features/trust/TrustView";
import { RolesTable } from "@/features/trust/RolesTable";
import { Rotations } from "@/features/trust/Rotations";

const roles = { governor: "lead.near", keeper: "keeper.lead.near", guardian: "guardian.near" };

test("RolesTable shows the three accounts with what each can and cannot do", () => {
  render(<RolesTable roles={roles} />);
  const table = screen.getByRole("table", { name: "Roles" });
  for (const account of Object.values(roles)) expect(within(table).getByText(account)).toBeInTheDocument();
  expect(within(table).getByText(/^freeze and cancel_keeper_change/)).toBeInTheDocument();
  expect(within(table).getAllByText(/move funds/i).length).toBeGreaterThanOrEqual(3);
});
test("a scheduled rotation shows when it applies", () => {
  render(<Rotations keeperChange={{ account: "new-keeper.near", applyAfter: 1800086400n }} guardianChange={null} />);
  expect(screen.getByText("Scheduled")).toBeInTheDocument();
  expect(screen.getByText("new-keeper.near")).toBeInTheDocument();
  expect(screen.getByText(/2027-01-16 08:00 UTC/)).toBeInTheDocument();
});
test("no rotation says none is scheduled", () => {
  render(<Rotations keeperChange={null} guardianChange={null} />);
  expect(screen.getByText("No rotation is scheduled.")).toBeInTheDocument();
});
test("the parties table names 1Click and the wallet executor with its full risk", () => {
  render(<PartiesTable />);
  expect(screen.getByText("1Click (NEAR Intents)")).toBeInTheDocument();
  expect(screen.getByText(/can ask your wallet to sign any transaction/)).toBeInTheDocument();
  expect(screen.getAllByRole("rowgroup").length).toBeGreaterThan(0);
});
test("terms are not ready while a value is still TBD", () => {
  expect(termsReady({ date: "TBD", oneClickTosUrl: "https://example.org" })).toBe(false);
  expect(termsReady({ date: "2026-11-10", oneClickTosUrl: "TBD" })).toBe(false);
  expect(termsReady({ date: "2026-11-10", oneClickTosUrl: "http://example.org" })).toBe(false);
  expect(termsReady({ date: "2026-11-10", oneClickTosUrl: "https://example.org/terms" })).toBe(true);
});

test("the trust page opens with a short version: what cannot happen, what can, what is still trusted", () => {
  render(<TrustView snapshot={null} label={null} />);
  const short = screen.getByRole("region", { name: "The short version" });
  expect(within(short).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(TRUST_SHORT.map((c) => c.title));
  expect(TRUST_SHORT.map((c) => c.tag)).toEqual(["Cannot happen", "Can happen", "Still trusted"]);
  for (const c of TRUST_SHORT) expect(findForbidden(`${c.title} ${c.body}`)).toEqual([]);
});
