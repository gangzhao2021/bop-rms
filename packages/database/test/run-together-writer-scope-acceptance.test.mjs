import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createTenantTransactionRunner, runTogether } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const brand = "018f3f7a-8b1c-7a11-8d01-000000000041";
const storeA = "018f3f7a-8b1c-7a11-8d01-000000000042";
const storeB = "018f3f7a-8b1c-7a11-8d01-000000000043";
const row = (n) => "018f3f7a-8b1c-7a11-8d01-" + n.toString(16).padStart(12, "0");

/**
 * v15 hotfix review (runTogether): a `runTogether` call commits once, and a deferred constraint
 * trigger runs at that COMMIT under the scope then held. Since 6f83a65f that was the scope the
 * call's last run wrote, so a row written by an earlier run under Store A was checked under Store
 * B's scope when a later run read under Store B, as 1300_036's batch cancellation binding check
 * was under the Brand scope: row-level security hides the row and the check refuses it.
 *
 * Under the restricted NOBYPASSRLS pilot API role (the rendered pilot ACL; the TEST-ONLY table
 * below is granted only to it, for this test) on the pilot's own createTenantTransactionRunner:
 * a TEST-ONLY table under Store row-level security with a deferred binding check, as the owner
 * tables have. The writer's scope is what COMMIT holds; a second scope may read, never write.
 */
it("runTogether's one COMMIT runs deferred checks under the scope of the run that wrote", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_tgt_scope" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = await createPilotApiRole(admin, context, "wp2423_tws");
    const pool = new pg.Pool({
      ...context.clientConfig,
      max: 2,
      connectionTimeoutMillis: 5000,
      query_timeout: 10_000,
    });
    try {
      // TEST-ONLY: a Store-scoped table with a deferred check that reads it back under RLS.
      await admin.query(`
        CREATE SCHEMA wp2423_probe;
        CREATE TABLE wp2423_probe.bound_row (
          row_id uuid PRIMARY KEY, brand_id uuid NOT NULL, store_id uuid NOT NULL);
        ALTER TABLE wp2423_probe.bound_row ENABLE ROW LEVEL SECURITY;
        ALTER TABLE wp2423_probe.bound_row FORCE ROW LEVEL SECURITY;
        CREATE POLICY bound_row_store ON wp2423_probe.bound_row
          USING (brand_id::text = current_setting('bop.brand_id', true)
            AND store_id::text = current_setting('bop.store_id', true))
          WITH CHECK (brand_id::text = current_setting('bop.brand_id', true)
            AND store_id::text = current_setting('bop.store_id', true));
        CREATE FUNCTION wp2423_probe.bound_row_check() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM wp2423_probe.bound_row WHERE row_id = NEW.row_id) THEN
            RAISE EXCEPTION 'unbound row' USING ERRCODE = '23514';
          END IF;
          RETURN NULL;
        END $$;
        CREATE CONSTRAINT TRIGGER bound_row_bound AFTER INSERT ON wp2423_probe.bound_row
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wp2423_probe.bound_row_check();
        GRANT USAGE ON SCHEMA wp2423_probe TO ${api};
        GRANT SELECT, INSERT ON wp2423_probe.bound_row TO ${api};
      `);
      const restricted = {
        options: pool.options,
        async connect() {
          const client = await pool.connect();
          await client.query("SET ROLE " + api);
          return client;
        },
      };
      const atA = createTenantTransactionRunner(restricted, { brandId: brand, storeId: storeA });
      const atB = createTenantTransactionRunner(restricted, { brandId: brand, storeId: storeB });
      const insert = (n, store) => (tx) =>
        tx.query(
          "INSERT INTO wp2423_probe.bound_row (row_id,brand_id,store_id) VALUES ($1,$2,$3)",
          [row(n), brand, store],
        );
      const count = async () =>
        (await admin.query("SELECT count(*)::int AS n FROM wp2423_probe.bound_row")).rows[0].n;

      // Store A writes, then Store B only reads: COMMIT checks A's row under A (before: under B,
      // so the check could not see it and the whole call failed).
      await runTogether(async () => {
        await atA.run(insert(1, storeA));
        await atB.run((tx) => tx.query("SELECT count(*) FROM wp2423_probe.bound_row", []));
      });
      assert.equal(await count(), 1);

      // A second scope writing in the same call is refused before its write: nothing commits.
      await assert.rejects(
        runTogether(async () => {
          await atA.run(insert(2, storeA));
          await atB.run(insert(3, storeB));
        }),
        { code: "TENANT_DATABASE_TRANSACTION_FAILED" },
      );
      assert.equal(await count(), 1);

      // The same scope may write again in a later run of the call.
      await runTogether(async () => {
        await atA.run(insert(4, storeA));
        await atB.run((tx) => tx.query("SELECT 1", []));
        await atA.run(insert(5, storeA));
      });
      assert.equal(await count(), 3);
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
