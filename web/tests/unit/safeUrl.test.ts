import { safeHttpsUrl } from "@/lib/format/safeUrl";

test("only https links leave the page", () => {
  expect(safeHttpsUrl("https://example.org/a.wasm")).toBe("https://example.org/a.wasm");
  expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
  expect(safeHttpsUrl("http://example.org")).toBeNull();
  expect(safeHttpsUrl("data:text/html,<script>")).toBeNull();
  expect(safeHttpsUrl("not a url")).toBeNull();
  expect(safeHttpsUrl("https://user:pass@example.org/")).toBeNull();
});
