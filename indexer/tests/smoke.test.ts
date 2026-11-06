import { pingDb } from "@foundling/db";

test("the test database answers", async () => {
  expect(await pingDb(process.env.DATABASE_URL!)).toBe(true);
});
