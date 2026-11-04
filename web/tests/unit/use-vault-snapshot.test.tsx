import { act, renderHook } from "@testing-library/react";

import { useVaultSnapshot } from "@/lib/chain/useVaultSnapshot";
import { fixtureSnapshot } from "../fixtures/snapshot";

const read = vi.fn();
vi.mock("@/lib/chain/vault", async (orig) => {
  const actual = await orig<typeof import("@/lib/chain/vault")>();
  // Fixtures build snapshots with the real reader; the hook under test gets `read` once a test sets it.
  return { ...actual, readVaultSnapshot: (...a: Parameters<typeof actual.readVaultSnapshot>) => (read.getMockImplementation() ? read(...a) : actual.readVaultSnapshot(...a)) };
});

beforeEach(() => {
  vi.useFakeTimers();
  read.mockReset();
});
afterEach(() => vi.useRealTimers());

test("refreshes every 10 s while visible and never goes back a block", async () => {
  const s = await fixtureSnapshot();
  read.mockResolvedValueOnce({ ...s, blockHeight: 300n }).mockResolvedValueOnce({ ...s, blockHeight: 250n });
  const { result } = renderHook(() => useVaultSnapshot(s));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(result.current.snapshot?.blockHeight).toBe(300n);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.snapshot?.blockHeight).toBe(300n);
  expect(result.current.fresh).toBe(true);
});
test("does not refresh while the tab is hidden", async () => {
  const s = await fixtureSnapshot();
  read.mockResolvedValue(s);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  try {
    renderHook(() => useVaultSnapshot(s));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(read).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(document, "visibilityState");
  }
});
test("failed reads turn unreadable once the data is older than 60 s", async () => {
  const s = await fixtureSnapshot({ fetchedAtMs: Date.now() });
  read.mockRejectedValue(new Error("down"));
  const { result } = renderHook(() => useVaultSnapshot(s));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(result.current.unreadable).toBe(false);
  expect(result.current.fresh).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(70_000));
  expect(result.current.unreadable).toBe(true);
});
test("no initial snapshot is unreadable", () => {
  read.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useVaultSnapshot(null));
  expect(result.current.unreadable).toBe(true);
});
