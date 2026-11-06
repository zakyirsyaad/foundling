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
