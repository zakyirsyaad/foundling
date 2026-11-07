import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CopyButton } from "@/components/fm/CopyButton";
import { Hash } from "@/components/fm/Hash";
import { LimitMeter } from "@/components/fm/LimitMeter";
import { Stat } from "@/components/fm/Stat";
import { Status } from "@/components/fm/Status";
import { Video } from "@/components/fm/Video";

function mockReducedMotion(reduce: boolean) {
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
}

test("Status shows the word and the tone from the table", () => {
  render(<Status group="vault" word="Halted" />);
  expect(screen.getByText("Halted").closest("[data-tone]")).toHaveAttribute("data-tone", "danger");
});
test("Status refuses a word outside the table", () => {
  expect(() => render(<Status group="cycle" word="Pass" />)).toThrow();
});
test("Stat shows label, value and sub line", () => {
  render(<Stat label="Book" value="96.40 USDC" sub="as of block #201" />);
  expect(screen.getByText("Book")).toBeInTheDocument();
  expect(screen.getByText("96.40 USDC")).toHaveClass("mono");
  expect(screen.getByText("as of block #201")).toBeInTheDocument();
});
test("Hash truncates and copies the full value", async () => {
  const user = userEvent.setup();
  render(<Hash value="3f9a00000000c21e" label="code hash" />);
  expect(screen.getByText("3f9a00…c21e")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Copy code hash" }));
  expect(await navigator.clipboard.readText()).toBe("3f9a00000000c21e");
});
test("CopyButton keeps the check mark for the full time after a second click", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.resolve() } });
  vi.useFakeTimers();
  try {
    render(<CopyButton text="a" label="Copy a" icon />);
    const button = screen.getByRole("button", { name: "Copy a" });
    const checked = () => button.querySelector('path[d="M20 6 9 17l-5-5"]') !== null;
    await act(async () => { fireEvent.click(button); });
    expect(checked()).toBe(true);
    act(() => { vi.advanceTimersByTime(1200); });
    await act(async () => { fireEvent.click(button); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(checked()).toBe(true);
    act(() => { vi.advanceTimersByTime(1200); });
    expect(checked()).toBe(false);
  } finally {
    vi.useRealTimers();
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  }
});
test("Hash leaves short values whole", () => {
  render(<Hash value="alice.near" label="account" />);
  expect(screen.getByText("alice.near")).toBeInTheDocument();
});
test("LimitMeter is an accessible meter and says when it is an estimate", () => {
  render(<LimitMeter label="TVL" used={30n} cap={100n} decimals={0} estimate />);
  const m = screen.getByRole("meter", { name: /TVL/ });
  expect(m).toHaveAttribute("aria-valuenow", "30");
  expect(m).toHaveAttribute("aria-valuemax", "100");
  expect(screen.getByText(/estimate/i)).toBeInTheDocument();
});
test("LimitMeter gives ARIA plain percent numbers, even for tiny yoctoNEAR amounts", () => {
  render(<LimitMeter label="Ops budget" used={1_250_000n} cap={5_000_000n} decimals={24} unit="NEAR" />);
  const m = screen.getByRole("meter", { name: "Ops budget" });
  expect(m).toHaveAttribute("aria-valuemin", "0");
  expect(m).toHaveAttribute("aria-valuemax", "100");
  expect(m).toHaveAttribute("aria-valuenow", "25");
  expect(m.getAttribute("aria-valuetext")).toMatch(/NEAR$/);
});
test("LimitMeter without a price says so instead of showing zero", () => {
  render(<LimitMeter label="Exposure" used={null} cap={null} decimals={6} />);
  expect(screen.getByText("Price unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("meter")).toBeNull();
});
test("Video shows only the poster under reduced motion", () => {
  mockReducedMotion(true);
  render(<Video src="/media/hero.mp4" poster="/media/hero.jpg" captions="/media/hero.vtt" alt="Foundling demo" loop />);
  expect(screen.queryByTestId("video-element")).toBeNull();
  expect(screen.getByRole("img", { name: "Foundling demo" })).toHaveAttribute("src", "/media/hero.jpg");
});
test("Video is muted, looped and captioned", () => {
  mockReducedMotion(false);
  render(<Video src="/media/hero.mp4" poster="/media/hero.jpg" captions="/media/hero.vtt" alt="Foundling demo" loop />);
  const v = screen.getByTestId("video-element") as HTMLVideoElement;
  expect(v.muted).toBe(true);
  expect(v.loop).toBe(true);
  expect(v).toHaveAttribute("playsinline");
  expect(v.querySelector("track[kind=captions]")).not.toBeNull();
});
test("Video without a file shows the coming-soon poster", () => {
  mockReducedMotion(false);
  render(<Video src={null} poster={null} captions={null} alt="Foundling demo" />);
  expect(screen.getByText("Video coming soon")).toBeInTheDocument();
});
