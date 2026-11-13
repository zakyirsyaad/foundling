import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const tokens = JSON.parse(fs.readFileSync(path.join(root, "../docs/design/foundling-mono.tokens.json"), "utf8"));
const css = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

test("globals.css carries every colour token for both themes", () => {
  const light = block(":root {");
  const darkHand = block(':root[data-theme="dark"]');
  const darkSystem = block(':root:not([data-theme="light"])');
  for (const t of tokens.color.tokens.filter((t: { name: string }) => !t.name.startsWith("terminal-"))) {
    if (typeof t.value === "string") continue;
    expect(light).toContain(`--${t.name}: ${t.value.light};`);
    expect(darkHand).toContain(`--${t.name}: ${t.value.dark};`);
    expect(darkSystem).toContain(`--${t.name}: ${t.value.dark};`);
  }
});
test("destructive is the one red", () => {
  expect(block(":root {")).toContain("--destructive: var(--danger);");
});

const site = fs.readFileSync(path.join(root, "app/site.css"), "utf8");
const theme = block("@theme inline");

test("the radius scale in the theme matches the design tokens", () => {
  for (const t of tokens.radius.tokens.filter((t: { name: string }) => t.name !== "radius-full")) {
    expect(theme).toContain(`--${t.name}: ${t.value};`);
  }
  expect(tokens.radius.tokens.map((t: { value: string }) => t.value)).toEqual(["6px", "8px", "12px", "9999px"]);
});

test("no component writes its own radius: every one comes from the scale", () => {
  for (const source of [css.slice(css.indexOf("@layer base")), site]) {
    const stray = (source.match(/border-radius:\s*[^;]+;/g) ?? []).filter(
      (rule) => !/var\(--radius-(sm|md|lg)\)|9999px|: 0;/.test(rule),
    );
    expect(stray).toEqual([]);
  }
});

test("controls come in the sizes the tokens name", () => {
  const sizes = Object.fromEntries(tokens.size.tokens.map((t: { name: string; value: string }) => [t.name, t.value]));
  expect(sizes).toEqual({ "control-sm": "36px", "control-md": "44px", "control-lg": "52px" });
  expect(css).toMatch(/\.fm-btn \{[^}]*height: 44px;/);
  expect(css).toMatch(/\.fm-btn--sm \{[^}]*height: 36px;/);
  expect(css).toMatch(/\.fm-btn--lg \{[^}]*height: 52px;/);
});

test("the one accent colour is a token in both themes", () => {
  const names = tokens.color.tokens.map((t: { name: string }) => t.name);
  expect(names).toContain("brand");
  expect(names).toContain("brand-bg");
  expect(theme).toContain("--color-brand: var(--brand);");
  expect(theme).toContain("--color-brand-bg: var(--brand-bg);");
});
