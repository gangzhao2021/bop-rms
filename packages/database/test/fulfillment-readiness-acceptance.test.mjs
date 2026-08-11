import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { it } from "vitest";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const tables = ["fulfillment_item_ready_result", "fulfillment_ready_operation"];

async function insertPickup(client, seed, storeId = id(3)) {
  await client.query(
    `INSERT INTO rms_fulfillment.fulfillment (
       fulfillment_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,source_event_id,
       source_aggregate_version,source_snapshot_digest,source_evidence_id,source_evidence_version,
       source_evidence_digest,fulfillment_type,canonical_phase,aggregate_version,created_at,
       correlation_id,data_classification
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,2,$8,$9,1,$10,'Pickup','Pending',1,$11,$12,
       'IndirectIdentifier')`,
    [
      id(seed),
      id(2),
      storeId,
      id(seed + 1),
      id(seed + 2),
      id(seed + 3),
      id(seed + 4),
      sha("a"),
      id(seed + 5),
      sha("b"),
      "2026-08-11T18:00:00.000Z",
      id(seed + 6),
    ],
  );
  await client.query(
    `INSERT INTO rms_fulfillment.fulfillment_item (
       fulfillment_item_id,brand_id,store_id,fulfillment_id,order_item_id,ordinal,
       ordered_quantity,ready_quantity,handed_over_quantity,item_state,source_line_digest,
       data_classification
     ) VALUES ($1,$2,$3,$4,$5,1,2,0,0,'Pending',$6,'IndirectIdentifier')`,
    [id(seed + 7), id(2), storeId, id(seed), id(seed + 8), sha("c")],
  );
}

async function insertReady(client, seed, storeId = id(3)) {
  await client.query(
    `INSERT INTO rms_fulfillment.fulfillment_item_ready_result (
       fulfillment_item_ready_result_id,brand_id,store_id,fulfillment_id,fulfillment_item_id,
       order_id,order_batch_id,order_item_id,kitchen_ticket_id,kitchen_ready_result_id,
       source_event_id,ready_quantity,occurred_at,data_classification
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,2,$12,'IndirectIdentifier')`,
    [
      id(seed + 20),
      id(2),
      storeId,
      id(seed),
      id(seed + 7),
      id(seed + 1),
      id(seed + 2),
      id(seed + 8),
      id(seed + 21),
      id(seed + 22),
      id(seed + 23),
      "2026-08-11T18:01:00.000Z",
    ],
  );
  await client.query(
    `INSERT INTO rms_fulfillment.fulfillment_ready_operation (
       fulfillment_ready_operation_id,brand_id,store_id,fulfillment_id,fulfillment_item_id,
       fulfillment_item_ready_result_id,kitchen_ready_result_id,source_event_id,
       aggregate_version_before,aggregate_version_after,phase_before,phase_after,
       semantic_binding_digest,occurred_at,data_classification
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,2,'Pending','Ready',$9,$10,
       'IndirectIdentifier')`,
    [
      id(seed + 24),
      id(2),
      storeId,
      id(seed),
      id(seed + 7),
      id(seed + 20),
      id(seed + 22),
      id(seed + 23),
      sha("d"),
      "2026-08-11T18:01:00.000Z",
    ],
  );
}

async function scopedCount(client, role, storeId, table) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [id(2)]);
    await client.query("SELECT set_config('bop.store_id', $1, true)", [storeId]);
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${table}`);
    await client.query("COMMIT");
    return result.rows[0].count;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp1601_${context.runId}`;
  await client.connect();
  try {
    const inventory = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='rms_fulfillment' AND table_name=ANY($1::text[]) ORDER BY table_name`,
      [tables],
    );
    assert.deepEqual(
      inventory.rows.map((row) => row.table_name),
      tables,
    );
    const security = await client.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid=ANY($1::regclass[]) ORDER BY relname`,
      [tables.map((table) => `rms_fulfillment.${table}`)],
    );
    assert.equal(security.rows.length, 2);
    assert.equal(
      security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );

    await insertPickup(client, 100);
    await insertReady(client, 100);
    await insertPickup(client, 200, id(99));
    await insertReady(client, 200, id(99));

    await assert.rejects(
      client.query(
        `INSERT INTO rms_fulfillment.fulfillment_item_ready_result (
           fulfillment_item_ready_result_id,brand_id,store_id,fulfillment_id,fulfillment_item_id,
           order_id,order_batch_id,order_item_id,kitchen_ticket_id,kitchen_ready_result_id,
           source_event_id,ready_quantity,occurred_at,data_classification
         ) SELECT $1,brand_id,store_id,fulfillment_id,fulfillment_item_id,order_id,order_batch_id,
           order_item_id,$2,$3,$4,ready_quantity,occurred_at,'IndirectIdentifier'
         FROM rms_fulfillment.fulfillment_item_ready_result
         WHERE fulfillment_item_ready_result_id=$5`,
        [id(300), id(301), id(302), id(303), id(120)],
      ),
      /fulfillment_item_ready_result_item_unique/u,
    );
    await assert.rejects(
      client.query(
        "UPDATE rms_fulfillment.fulfillment_ready_operation SET phase_after='Pending' WHERE fulfillment_ready_operation_id=$1",
        [id(124)],
      ),
      /append-only/u,
    );
    await client.query(
      "DELETE FROM rms_fulfillment.fulfillment_item_ready_result WHERE fulfillment_item_ready_result_id=$1",
      [id(120)],
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_fulfillment.fulfillment_item_ready_result WHERE fulfillment_item_ready_result_id=$1",
          [id(120)],
        )
      ).rows[0].count,
      1,
    );

    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA rms_fulfillment,platform_helpers TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
       platform_helpers.current_store_id() TO ${role}`,
    );
    for (const table of tables)
      await client.query(`GRANT SELECT ON rms_fulfillment.${table} TO ${role}`);
    assert.equal(
      await scopedCount(client, role, id(3), "rms_fulfillment.fulfillment_item_ready_result"),
      1,
    );
    assert.equal(
      await scopedCount(client, role, id(98), "rms_fulfillment.fulfillment_item_ready_result"),
      0,
    );
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves the WP-1601 append-only forced-RLS Fulfillment Ready boundary", async () => {
  await withIsolatedDatabase({ caseId: "fulfill_ready", root }, prove);
});
