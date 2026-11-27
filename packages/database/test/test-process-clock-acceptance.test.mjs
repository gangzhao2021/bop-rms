// WP-2423 (guest-waits-and-refund-lock, batch 32 review): a database test composes its own
// connections and stamps instants with this process's clock, and the owners compare them with the
// database's clock both ways. The catalog, recipe and inventory reference sources refuse an instant
// before the `statement_timestamp()` they just read (product-reference-history-source-store,
// recipe-reference-source-store, configuration-reference-source-store); the refund execution and
// kitchen queue sources refuse one after `clock_timestamp()`. On a Mac the Docker VM's clock drifts
// from the host's, so the process follows its database's clock before each fixture, and must land
// between the two: a whole-millisecond lower bound (up to a millisecond behind, while a statement's
// reply arrives within a quarter of one) failed the catalog configs at random. Run with this
// host's clock half a second ahead (vitest.refund-execution-clock).
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const rounds = 400;

it("test process clock stays between the database's statement start and its clock", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_test_clock" }, async ({ clientConfig }) => {
    const client = new Client(clientConfig);
    await client.connect();
    try {
      const behind = [],
        ahead = [];
      for (let round = 0; round < rounds; round += 1) {
        const read = await client.query(
          `SELECT to_char(date_trunc('milliseconds',statement_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed`,
        );
        const observed = read.rows[0].observed,
          at = new Date().toISOString();
        if (at < observed) behind.push({ at, observed });
        const later = await client.query(
          "SELECT $1::timestamptz <= date_trunc('milliseconds',clock_timestamp()) AS ok",
          [at],
        );
        if (later.rows[0].ok !== true) ahead.push(at);
      }
      assert.deepEqual(
        { behind: behind.length, ahead: ahead.length },
        { behind: 0, ahead: 0 },
        JSON.stringify({ behind: behind.slice(0, 3), ahead: ahead.slice(0, 3) }),
      );
    } finally {
      await client.end();
    }
  });
});
