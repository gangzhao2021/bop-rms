import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { it } from "vitest";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a502-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const selector = (character) => character.repeat(64);
const tables = [
  "pickup_proof_generation",
  "pickup_proof_invalidation",
  "pickup_proof_operation",
  "pickup_proof_verification",
];

async function seedReadyPickup(client, storeId = id(3), seed = 100) {
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

async function insertGeneration(client, input) {
  await client.query(
    `INSERT INTO rms_fulfillment.pickup_proof_generation (
       capability_id,brand_id,store_id,fulfillment_id,proof_kind,public_order_reference,
       selector_hash,pepper_version,generation,ready_at,expires_at,issued_at,data_classification
     ) VALUES ($1,$2,$3,$4,'HumanCode','AAAAAAAAAAAAAAAAAAAAAA',$5,1,$6,$7,$8,$9,
       'RestrictedCredential')`,
    [
      input.capabilityId,
      id(2),
      input.storeId,
      input.fulfillmentId,
      input.selectorHash,
      input.generation,
      input.readyAt,
      input.expiresAt,
      input.issuedAt,
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
  const role = `bop_wp1602_${context.runId}`;
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
    assert.equal(security.rows.length, 4);
    assert.equal(
      security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );
    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='rms_fulfillment' AND table_name=ANY($1::text[])`,
      [tables],
    );
    assert.equal(
      columns.rows.some((row) => /(?:raw|code|pin|otp|secret)/iu.test(row.column_name)),
      false,
    );

    await seedReadyPickup(client);
    await insertGeneration(client, {
      capabilityId: id(130),
      storeId: id(3),
      fulfillmentId: id(100),
      selectorHash: selector("1"),
      generation: 1,
      readyAt: "2026-08-11T18:01:00.000Z",
      expiresAt: "2026-08-11T19:01:00.000Z",
      issuedAt: "2026-08-11T18:02:00.000Z",
    });
    await client.query(
      `INSERT INTO rms_fulfillment.pickup_proof_operation (
       pickup_proof_operation_id,brand_id,store_id,fulfillment_id,capability_id,verification_id,
       idempotency_id,correlation_id,operation_kind,generation,aggregate_version_before,
       aggregate_version_after,occurred_at,data_classification
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,'Issue',1,2,3,$8,'IndirectIdentifier')`,
      [id(131), id(2), id(3), id(100), id(130), id(132), id(133), "2026-08-11T18:02:00.000Z"],
    );
    await insertGeneration(client, {
      capabilityId: id(140),
      storeId: id(3),
      fulfillmentId: id(100),
      selectorHash: selector("2"),
      generation: 2,
      readyAt: "2026-08-11T18:10:00.000Z",
      expiresAt: "2026-08-11T19:01:00.000Z",
      issuedAt: "2026-08-11T18:10:00.000Z",
    });
    await client.query(
      `INSERT INTO rms_fulfillment.pickup_proof_invalidation (
       pickup_proof_invalidation_id,brand_id,store_id,fulfillment_id,prior_capability_id,
       replacement_capability_id,prior_generation,replacement_generation,invalidated_at,reason,
       data_classification
       ) VALUES ($1,$2,$3,$4,$5,$6,1,2,$7,'Regenerated','IndirectIdentifier')`,
      [id(141), id(2), id(3), id(100), id(130), id(140), "2026-08-11T18:10:00.000Z"],
    );
    await client.query(
      `INSERT INTO rms_fulfillment.pickup_proof_operation (
       pickup_proof_operation_id,brand_id,store_id,fulfillment_id,capability_id,verification_id,
       idempotency_id,correlation_id,operation_kind,generation,aggregate_version_before,
       aggregate_version_after,occurred_at,data_classification
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,'Regenerate',2,3,4,$8,'IndirectIdentifier')`,
      [id(142), id(2), id(3), id(100), id(140), id(143), id(144), "2026-08-11T18:10:00.000Z"],
    );
    await client.query(
      `INSERT INTO rms_fulfillment.pickup_proof_verification (
       pickup_proof_verification_id,brand_id,store_id,fulfillment_id,capability_id,generation,
       verification_method,validation_status,verified_at,correlation_id,data_classification
       ) VALUES ($1,$2,$3,$4,$5,2,'HumanCode','Validated',$6,$7,'IndirectIdentifier')`,
      [id(150), id(2), id(3), id(100), id(140), "2026-08-11T18:20:00.000Z", id(151)],
    );
    await client.query(
      `INSERT INTO rms_fulfillment.pickup_proof_operation (
       pickup_proof_operation_id,brand_id,store_id,fulfillment_id,capability_id,verification_id,
       idempotency_id,correlation_id,operation_kind,generation,aggregate_version_before,
       aggregate_version_after,occurred_at,data_classification
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Verify',2,NULL,NULL,$9,'IndirectIdentifier')`,
      [
        id(152),
        id(2),
        id(3),
        id(100),
        id(140),
        id(150),
        id(153),
        id(154),
        "2026-08-11T18:20:00.000Z",
      ],
    );
    const current = await client.query(
      `SELECT capability_id,generation FROM rms_fulfillment.pickup_proof_generation
       WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3
       ORDER BY generation DESC LIMIT 1`,
      [id(2), id(3), id(100)],
    );
    assert.deepEqual(current.rows, [{ capability_id: id(140), generation: 2 }]);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_fulfillment.pickup_proof_invalidation",
        )
      ).rows[0].count,
      1,
    );
    await assert.rejects(
      insertGeneration(client, {
        capabilityId: id(160),
        storeId: id(3),
        fulfillmentId: id(100),
        selectorHash: selector("2"),
        generation: 3,
        readyAt: "2026-08-11T18:20:00.000Z",
        expiresAt: "2026-08-11T19:01:00.000Z",
        issuedAt: "2026-08-11T18:20:00.000Z",
      }),
      /pickup_proof_generation_selector_unique/u,
    );
    await assert.rejects(
      insertGeneration(client, {
        capabilityId: id(161),
        storeId: id(3),
        fulfillmentId: id(100),
        selectorHash: selector("3"),
        generation: 3,
        readyAt: "2026-08-11T18:20:00.000Z",
        expiresAt: "2026-08-11T19:20:00.001Z",
        issuedAt: "2026-08-11T18:20:00.000Z",
      }),
      /pickup_proof_generation_lifetime_check/u,
    );
    await assert.rejects(
      client.query(
        "UPDATE rms_fulfillment.pickup_proof_generation SET pepper_version=2 WHERE capability_id=$1",
        [id(140)],
      ),
      /append-only/u,
    );
    await seedReadyPickup(client, id(3), 300);
    await assert.rejects(
      client.query(
        `INSERT INTO rms_fulfillment.pickup_proof_verification (
         pickup_proof_verification_id,brand_id,store_id,fulfillment_id,capability_id,generation,
         verification_method,validation_status,verified_at,correlation_id,data_classification
         ) VALUES ($1,$2,$3,$4,$5,2,'HumanCode','Validated',$6,$7,'IndirectIdentifier')`,
        [id(350), id(2), id(3), id(300), id(140), "2026-08-11T18:20:00.000Z", id(351)],
      ),
      /pickup_proof_verification_capability_fkey/u,
    );
    await client.query(
      "DELETE FROM rms_fulfillment.pickup_proof_verification WHERE pickup_proof_verification_id=$1",
      [id(150)],
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_fulfillment.pickup_proof_verification WHERE pickup_proof_verification_id=$1",
          [id(150)],
        )
      ).rows[0].count,
      1,
    );

    await seedReadyPickup(client, id(99), 200);
    await insertGeneration(client, {
      capabilityId: id(230),
      storeId: id(99),
      fulfillmentId: id(200),
      selectorHash: selector("4"),
      generation: 1,
      readyAt: "2026-08-11T18:01:00.000Z",
      expiresAt: "2026-08-11T19:01:00.000Z",
      issuedAt: "2026-08-11T18:02:00.000Z",
    });
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA rms_fulfillment,platform_helpers TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
       platform_helpers.current_store_id() TO ${role}`,
    );
    for (const table of tables)
      await client.query(`GRANT SELECT ON rms_fulfillment.${table} TO ${role}`);
    assert.equal(
      await scopedCount(client, role, id(3), "rms_fulfillment.pickup_proof_generation"),
      2,
    );
    assert.equal(
      await scopedCount(client, role, id(98), "rms_fulfillment.pickup_proof_generation"),
      0,
    );
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves the WP-1602 append-only forced-RLS Pickup Proof boundary", async () => {
  await withIsolatedDatabase({ caseId: "pickup_proof", root }, prove);
});
