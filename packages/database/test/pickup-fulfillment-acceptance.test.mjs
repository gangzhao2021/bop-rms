import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { it } from "vitest";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const tables = ["fulfillment", "fulfillment_creation_operation", "fulfillment_item"];

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
  await client.query(
    `INSERT INTO rms_fulfillment.fulfillment_creation_operation (
       fulfillment_creation_operation_id,brand_id,store_id,fulfillment_id,source_event_id,
       confirmation_id,order_id,source_evidence_digest,semantic_binding_digest,occurred_at,
       data_classification
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'IndirectIdentifier')`,
    [
      id(seed + 9),
      id(2),
      storeId,
      id(seed),
      id(seed + 4),
      id(seed + 3),
      id(seed + 1),
      sha("b"),
      sha("d"),
      "2026-08-11T18:00:00.000Z",
    ],
  );
}

async function scopedRows(client, role, storeId) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [id(2)]);
    await client.query("SELECT set_config('bop.store_id', $1, true)", [storeId]);
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(
      "SELECT fulfillment_id::text FROM rms_fulfillment.fulfillment ORDER BY fulfillment_id",
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp1600_${context.runId}`;
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
    assert.equal(security.rows.length, 3);
    assert.equal(
      security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );

    await insertPickup(client, 100);
    await insertPickup(client, 200, id(99));
    await assert.rejects(
      client.query(
        `INSERT INTO rms_fulfillment.fulfillment (
           fulfillment_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,source_event_id,
           source_aggregate_version,source_snapshot_digest,source_evidence_id,source_evidence_version,
           source_evidence_digest,fulfillment_type,canonical_phase,aggregate_version,created_at,
           correlation_id,data_classification
         ) SELECT $1,brand_id,store_id,order_id,$2,$3,$4,2,$5,$6,1,$7,'Pickup','Pending',1,
           created_at,$8,'IndirectIdentifier'
         FROM rms_fulfillment.fulfillment WHERE fulfillment_id=$9`,
        [id(300), id(301), id(302), id(303), sha("e"), id(304), sha("f"), id(305), id(100)],
      ),
      /fulfillment_order_unique/u,
    );
    await assert.rejects(
      client.query(
        "UPDATE rms_fulfillment.fulfillment_item SET ready_quantity=1 WHERE fulfillment_item_id=$1",
        [id(107)],
      ),
      /append-only/u,
    );
    await client.query(
      "DELETE FROM rms_fulfillment.fulfillment_creation_operation WHERE fulfillment_creation_operation_id=$1",
      [id(109)],
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_fulfillment.fulfillment_creation_operation WHERE fulfillment_creation_operation_id=$1",
          [id(109)],
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
    await client.query(`GRANT SELECT ON rms_fulfillment.fulfillment TO ${role}`);
    assert.deepEqual(await scopedRows(client, role, id(3)), [{ fulfillment_id: id(100) }]);
    assert.deepEqual(await scopedRows(client, role, id(98)), []);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves the WP-1600 one-per-Order append-only forced-RLS Pickup boundary", async () => {
  await withIsolatedDatabase({ caseId: "pickup_fulfillment", root }, prove);
});
