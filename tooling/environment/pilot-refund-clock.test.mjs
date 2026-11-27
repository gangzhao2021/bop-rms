import { expect, it } from "vitest";
import { notAfterDatabaseNow } from "./pilot-database-clock.mjs";
import { refundAuthorityCurrent } from "./pilot-refund-workforce.mjs";

// WP-2423 M15: the application clock is a lower bound of the database's, so an instant the
// database stamped can be 1-2 ms after the application's own now. Compared on the database clock,
// an approval made in that window is never refused as "session ended".
const databaseAhead = (aheadMs) => {
  const tx = {
    query: async (sql, values) => {
      expect(sql).toContain("clock_timestamp()");
      return { rows: [{ ok: Date.parse(values[0]) <= Date.now() + aheadMs }] };
    },
  };
  return tx;
};

it("accepts an instant the database just stamped while the application clock is behind", async () => {
  const tx = databaseAhead(2);
  const at = new Date(Date.now() + 2).toISOString();
  expect(await notAfterDatabaseNow(tx, at)).toBe(true);
  const current = refundAuthorityCurrent(tx, async () => true);
  expect(await current(tx, at)).toBe(true);
});

it("still refuses an instant after the database's now, another transaction or a lost authority", async () => {
  const tx = databaseAhead(0);
  expect(await notAfterDatabaseNow(tx, new Date(Date.now() + 60_000).toISOString())).toBe(false);
  const at = new Date(Date.now() - 1).toISOString();
  expect(await refundAuthorityCurrent(tx, async () => true)(databaseAhead(0), at)).toBe(false);
  expect(await refundAuthorityCurrent(tx, async () => false)(tx, at)).toBe(false);
});
