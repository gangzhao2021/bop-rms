import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createTenantTransactionRunner, runTogether, withVerifiedChecks } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const brand = "018f3f7a-8b1c-7a11-8d01-000000000051";
const store = "018f3f7a-8b1c-7a11-8d01-000000000052";
const table = "018f3f7a-8b1c-7a11-8d01-000000000053";
const row = (n) => "018f3f7a-8b1c-7a11-8d01-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 M35 (review of the third step, request-check-memo): inside one request a check is
 * answered from the request's earlier read up to the transaction's write fence, where it is sent
 * again for real. When it came back different (another phone joined the table, the party
 * changed within the request), the transaction failed with a retryable conflict that nothing in
 * the staff round retried: staff saw "couldn't send" where the same round used to go through.
 * Now the transaction, which wrote nothing, runs once more as an ordinary one and decides on what
 * is current.
 *
 * Under the restricted NOBYPASSRLS pilot API role on the pilot's own createTenantTransactionRunner:
 * a TEST-ONLY table party (one row per table, the party seated now) read as an owner's stable read,
 * changed by another connection between the request's check and its write.
 */
it("a check that changed before the write fence is decided again on what is current, never refused", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_fence_change" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = await createPilotApiRole(admin, context, "wp2423_vcf");
    const pool = new pg.Pool({
      ...context.clientConfig,
      max: 3,
      connectionTimeoutMillis: 5000,
      query_timeout: 10_000,
    });
    try {
      // TEST-ONLY: the party seated at a table, and the rounds sent for a party.
      await admin.query(`
        CREATE SCHEMA wp2423_probe;
        CREATE TABLE wp2423_probe.seated (table_id uuid PRIMARY KEY, party text NOT NULL);
        CREATE TABLE wp2423_probe.round (round_id uuid PRIMARY KEY, party text NOT NULL);
        INSERT INTO wp2423_probe.seated VALUES ('${table}', 'party one');
        GRANT USAGE ON SCHEMA wp2423_probe TO ${api};
        GRANT SELECT ON wp2423_probe.seated TO ${api};
        GRANT SELECT, INSERT ON wp2423_probe.round TO ${api};
      `);
      const restricted = {
        options: pool.options,
        async connect() {
          const client = await pool.connect();
          await client.query("SET ROLE " + api);
          return client;
        },
      };
      const runner = createTenantTransactionRunner(restricted, { brandId: brand, storeId: store });
      const seated = async (tx) =>
        (
          await tx.query(
            "-- bop:stable-read\nSELECT party FROM wp2423_probe.seated WHERE table_id=$1",
            [table],
          )
        ).rows[0].party;
      const send = (n) => async (tx) => {
        const party = await seated(tx);
        await tx.query("INSERT INTO wp2423_probe.round (round_id,party) VALUES ($1,$2)", [
          row(n),
          party,
        ]);
        return party;
      };
      const rounds = async () =>
        (await admin.query("SELECT round_id::text AS id, party FROM wp2423_probe.round ORDER BY 1"))
          .rows;
      const seat = (party) =>
        admin.query("UPDATE wp2423_probe.seated SET party=$1 WHERE table_id=$2", [party, table]);

      // One request: its check, then another connection changes the table, then its write.
      const sent = await withVerifiedChecks(async () => {
        assert.equal(await runner.run(seated), "party one");
        await seat("party two");
        return runner.run(send(1));
      });
      assert.equal(sent, "party two");
      assert.deepEqual(await rounds(), [{ id: row(1), party: "party two" }]);

      // The same inside runTogether (the guest checks' one transaction).
      const together = await withVerifiedChecks(async () => {
        assert.equal(await runner.run(seated), "party two");
        await seat("party three");
        return runTogether(async () => {
          const party = await runner.run(seated);
          await runner.run(send(2));
          return party;
        });
      });
      assert.equal(together, "party three");
      assert.deepEqual(await rounds(), [
        { id: row(1), party: "party two" },
        { id: row(2), party: "party three" },
      ]);
      // The restricted role is what ran all this.
      const [who] = (
        await pool.query("SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname=$1", [api])
      ).rows;
      assert.equal(who.bypass, false);
    } finally {
      await pool.end();
      await admin.query("DROP SCHEMA IF EXISTS wp2423_probe CASCADE").catch(() => undefined);
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
