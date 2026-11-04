import { act, render, screen } from "@testing-library/react";

import { Overview } from "@/features/vault/Overview";
import { fixtureSnapshot } from "../fixtures/snapshot";

const read = vi.fn();
vi.mock("@/lib/chain/vault", async (orig) => {
  const actual = await orig<typeof import("@/lib/chain/vault")>();
  // Fixtures build snapshots with the real reader; the hook under test gets `read` once a test sets it.
  return { ...actual, readVaultSnapshot: (...a: Parameters<typeof actual.readVaultSnapshot>) => (read.getMockImplementation() ? read(...a) : actual.readVaultSnapshot(...a)) };
});

const nav = { status: "ok" as const, cursor: null, data: [
  { nonce: 1n, at: "2026-11-01T00:00:00Z", book: { usdc: 96_000_000n, wnear: 0n }, totalShares: 96n * 10n ** 12n, oracle: null },
  { nonce: 41n, at: "2026-11-11T00:00:00Z", book: { usdc: 96_400_000n, wnear: 0n }, totalShares: 96n * 10n ** 12n, oracle: null },
] };

test("Overview shows the stats, the meters and the rules", async () => {
  const s = await fixtureSnapshot();
  read.mockResolvedValue(s);
  await act(async () => render(<Overview initial={s} nav={nav} />));
  expect(screen.getByTestId("stage-bar")).toHaveTextContent("Live");
  expect(screen.getByText("Share price since start")).toBeInTheDocument();
  expect(screen.getAllByRole("meter")).toHaveLength(4);
  expect(screen.getByText("25% · 15 USDC")).toBeInTheDocument();
  expect(screen.getByText("Nothing")).toBeInTheDocument();
});
test("Overview with pending history still shows live numbers", async () => {
  const s = await fixtureSnapshot({ inflight: { nonce: 9n, tokenIn: "Usdc", tokenOut: "Wnear", amountIn: 12_400_000n, minAmountOut: 1n, amountOut: null, sharesSnapshot: 1n, sharesBurned: 0n, recovered: 0n, stuckSince: null } });
  read.mockResolvedValue(s);
  await act(async () => render(<Overview initial={s} nav={{ status: "pending", reason: "http" }} />));
  expect(screen.getByText(/History is pending/)).toBeInTheDocument();
  expect(screen.getByText("12.4 USDC")).toBeInTheDocument();
});
test("Overview with no snapshot shows the unreadable banner", async () => {
  read.mockRejectedValue(new Error("down"));
  await act(async () => render(<Overview initial={null} nav={{ status: "pending", reason: "http" }} />));
  expect(screen.getByText("Vault not readable")).toBeInTheDocument();
});
