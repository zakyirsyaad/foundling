import path from "node:path";

import { render, screen } from "@testing-library/react";

import { Footer } from "@/features/landing/Footer";
import { Header } from "@/features/landing/Header";
import { Home } from "@/features/landing/Home";
import { ProofView } from "@/features/proof/ProofView";
import { TrustView } from "@/features/trust/TrustView";
import { loadClaims } from "@/lib/claims";
import { proofFacts } from "@/lib/proof/facts";
import { fixtureSnapshot } from "../fixtures/snapshot";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));

const claims = loadClaims(path.resolve(__dirname, "../fixtures/claims.json"));

test("Home lays out the sections in order with one not-claimed block", () => {
  const { container } = render(<Home claims={claims} keysLine="Testnet rehearsal (m12) · x · 1 access key · as of block #1" />);
  expect(Array.from(container.querySelectorAll("main > section")).map((s) => s.id)).toEqual(["hero", "built-on", "how-it-works", "demo", "guarantees", "not-claimed", "closing"]);
  expect(container.querySelectorAll('[data-copy-exempt="not-claimed"]')).toHaveLength(1);
  expect(screen.getByTestId("keys-line")).toHaveTextContent("1 access key");
});
test("Home uses claim text for passed claims and downgrade text otherwise", () => {
  const { container } = render(<Home claims={claims} keysLine="x" />);
  expect(container.querySelector("[data-claim=born-without-keys]")).toHaveTextContent("The vault account has no access keys.");
  expect(container.querySelector("[data-claim=born-without-keys]")).not.toHaveAttribute("data-downgraded");
  expect(screen.getByText("Cross-chain deposits through NEAR Intents are in testing.")).toBeInTheDocument();
  expect(container.querySelector("#how-it-works")).toHaveTextContent("A NEAR AI advisor is planned and not yet checked.");
});
test("the hero states the keyless vault only once that claim passes", () => {
  const { unmount } = render(<Home claims={claims} keysLine="x" />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("A vault born without keys.");
  unmount();
  const unchecked = claims.map((c) => (c.id === "born-without-keys" ? { ...c, status: "skip" as const } : c));
  render(<Home claims={unchecked} keysLine="x" />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("A vault meant to be born without keys.");
});
test("Home uses the partner name once a claim passes", () => {
  const passed = claims.map((c) => ({ ...c, status: "pass" as const }));
  const { container } = render(<Home claims={passed} keysLine="x" />);
  expect(container.querySelector("#built-on")).toHaveTextContent("NEAR Intents");
  expect(container.querySelector("#built-on")).toHaveTextContent("NEAR AI");
});
test("Header and Footer carry the spec links", () => {
  render(<><Header /><Footer /></>);
  for (const name of ["Foundling", "How it works", "Proof", "Trust", "GitHub", "Open app", "Terms"]) expect(screen.getAllByRole("link", { name }).length).toBeGreaterThan(0);
  expect(screen.getByText("Not audited · hackathon build")).toBeInTheDocument();
  expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
});
test("ProofView lists facts, attacks and the unprovable", async () => {
  const snapshot = await fixtureSnapshot({}, 1);
  const source = { kind: "sample" as const, label: "Testnet rehearsal vault (m12)", snapshot };
  const facts = proofFacts(source, { synthetic: true, commitment: null, accessKeys: 0 }, "testnet");
  render(<ProofView source={source} facts={facts} attacks={[{ name: "over-cap", expected: "Rejected(OVER_CAP)", result: "Not run yet" }]} synthetic />);
  expect(screen.getByTestId("proof-source")).toHaveTextContent("Testnet rehearsal vault (m12)");
  expect(screen.getAllByRole("button", { name: "Copy command" })).toHaveLength(4);
  expect(screen.getByRole("cell", { name: "over-cap" })).toBeInTheDocument();
  expect(screen.getByText(/They test the checker, not this vault/)).toBeInTheDocument();
});
test("ProofView without a source says the vault is not readable", () => {
  render(<ProofView source={null} facts={[]} attacks={[]} synthetic={false} />);
  expect(screen.getByTestId("proof-unreadable")).toBeInTheDocument();
});
test("TrustView renders with a snapshot and without one", async () => {
  const snapshot = await fixtureSnapshot();
  const { unmount } = render(<TrustView snapshot={snapshot} label="Testnet rehearsal vault (m12)" />);
  expect(screen.getByRole("table", { name: "Roles" })).toHaveTextContent("lead.near");
  expect(screen.getByText(/stuck_after = 900 s/)).toBeInTheDocument();
  unmount();
  render(<TrustView snapshot={null} label={null} />);
  expect(screen.getAllByText("Vault not readable right now.")).toHaveLength(2);
});
