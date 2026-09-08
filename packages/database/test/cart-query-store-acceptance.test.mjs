import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresCartQueryStore } from "../../rms/ordering/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T14:00:00.000Z";
const scope = { brandReference: id(2), storeReference: id(3) };
it("reads scoped Cart facts through a least-privilege read-only PostgreSQL adapter", async () => {
  await withIsolatedDatabase({ caseId: "wp2223_cart_read" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const role = `wp2223_${context.runId}`;
    assert.match(role, /^wp2223_[a-f0-9]+$/u);
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA platform_helpers, rms_ordering TO ${role}`);
      await admin.query(`GRANT SELECT ON rms_ordering.cart, rms_ordering.cart_line TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      for (const cartId of [id(1), id(10)]) {
        await admin.query(
          `INSERT INTO rms_ordering.cart
          (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,aggregate_version,created_at,updated_at)
          VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5)`,
          [cartId, id(2), id(3), id(4), at],
        );
      }
      const selection = {
        menuVersionReference: id(20),
        productVersionReference: id(21),
        catalogChannelCode: "PICKUP",
        catalogOrderTypeCode: "PICKUP",
        ruleEvidence: [],
        validatedAt: at,
      };
      for (const lineId of [id(6), id(5)]) {
        await admin.query(
          `INSERT INTO rms_ordering.cart_line
          (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,added_by_actor_id,added_at,customer_note,catalog_selection_evidence_json)
          VALUES ($1,$2,$3,$4,$5,2,$6::jsonb,$7,$8,$9,$10::jsonb)`,
          [
            lineId,
            id(1),
            id(2),
            id(3),
            id(7),
            JSON.stringify([{ optionReference: id(8), quantity: 1 }]),
            id(4),
            at,
            "Synthetic preparation note",
            JSON.stringify(selection),
          ],
        );
      }
      await admin.query(
        `UPDATE rms_ordering.cart SET lifecycle_status='Active',lifecycle_policy_version_id=$2,
        lifecycle_policy_digest=$3,idle_timeout_seconds=3600,absolute_timeout_seconds=86400,
        idle_expires_at=$4,absolute_expires_at=$5 WHERE cart_id=$1`,
        [
          id(10),
          id(11),
          `sha256:${"a".repeat(64)}`,
          "2026-08-02T15:00:00.000Z",
          "2026-08-03T14:00:00.000Z",
        ],
      );
      let reads = 0;
      const runner = {
        async run(action) {
          const client = new Client({
            ...context.clientConfig,
            query_timeout: 5000,
            connectionTimeoutMillis: 2000,
          });
          await client.connect();
          try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SET LOCAL statement_timeout='5s'");
            assert.equal(
              (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
              "on",
            );
            const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
            reads++;
            await client.query("COMMIT");
            const cleared = await client.query(
              "SELECT current_setting('bop.brand_id',true) AS brand,current_setting('bop.store_id',true) AS store",
            );
            assert(!cleared.rows[0].brand && !cleared.rows[0].store);
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const reader = createPostgresCartQueryStore(runner, scope);
      const legacy = await reader.load(id(1));
      assert.equal(legacy.lifecycle, null);
      assert.equal(legacy.createdAt, at);
      assert.equal(legacy.aggregateVersion, 1);
      assert.deepEqual(
        legacy.items.map((line) => line.cartItemReference),
        [id(5), id(6)],
      );
      assert.deepEqual(legacy.items[0].catalogSelectionEvidence, selection);
      assert.equal(legacy.items[0].customerNote, "Synthetic preparation note");
      assert.deepEqual(legacy.items[0].optionSelections, [{ optionReference: id(8), quantity: 1 }]);
      assert(Object.isFrozen(legacy) && Object.isFrozen(legacy.items));
      const configured = await reader.load(id(10));
      assert.equal(configured.lifecycle.status, "Active");
      assert.equal(configured.lifecycle.idleTimeoutSeconds, 3600);
      assert.equal(configured.lifecycle.absoluteExpiresAt, "2026-08-03T14:00:00.000Z");
      assert.deepEqual(configured.items, []);
      assert.equal(await reader.load(id(90)), null);
      for (const foreign of [
        { ...scope, brandReference: id(91) },
        { ...scope, storeReference: id(92) },
      ])
        assert.equal(await createPostgresCartQueryStore(runner, foreign).load(id(1)), null);
      assert.equal(reads, 5);
      assert.deepEqual(await reader.load(id(1)), legacy);
      await assert.rejects(
        runner.run(async (transaction) =>
          transaction.query("UPDATE rms_ordering.cart SET aggregate_version=2", []),
        ),
        (error) => ["25006", "42501"].includes(error.code),
      );
      assert.equal(
        (
          await admin.query("SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1", [
            id(1),
          ])
        ).rows[0].aggregate_version,
        1,
      );
    } finally {
      await admin.end();
    }
  });
}, 120_000);
