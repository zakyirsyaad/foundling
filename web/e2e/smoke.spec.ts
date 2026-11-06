import { expect, test } from "@playwright/test";

test("home answers 200", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
});
