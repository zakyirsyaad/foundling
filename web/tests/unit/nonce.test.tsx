import { pageNonce } from "@/lib/wallet/nonce";

test("the nonce comes from the page's own scripts, not from a later request", () => {
  const s = document.createElement("script");
  s.nonce = "first-load-nonce";
  document.head.appendChild(s);
  expect(pageNonce("from-a-client-navigation")).toBe("first-load-nonce");
  s.remove();
  expect(pageNonce("fallback")).toBe("fallback");
});
