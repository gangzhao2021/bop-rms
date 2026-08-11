import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { it } from "vitest";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a408-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const tables = ["kds_operator_handover", "kds_recovery_reconciliation"];

async function withScope(client, role, storeId) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [id(2)]);
    await client.query("SELECT set_config('bop.store_id', $1, true)", [storeId]);
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await client.query(
      "SELECT kds_operator_handover_id::text FROM rms_kitchen.kds_operator_handover",
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function insertHandover(client, seed, storeId = id(3)) {
  await client.query(
    `INSERT INTO rms_kitchen.kds_operator_handover (
       kds_operator_handover_id,brand_id,store_id,prior_session_id,prior_actor_id,
       prior_final_state,prior_finalized_at,next_session_id,next_actor_id,next_activated_at,
       recorded_at,reason_code,data_classification
     ) VALUES ($1,$2,$3,$4,$5,'Locked',$6,$7,$8,$9,$10,'ShiftHandover','Personal')`,
    [
      id(seed),
      id(2),
      storeId,
      id(seed + 1),
      id(seed + 2),
      "2026-08-11T14:00:00.000Z",
      id(seed + 3),
      id(seed + 4),
      "2026-08-11T14:00:01.000Z",
      "2026-08-11T14:00:02.000Z",
    ],
  );
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp1408_${context.runId}`;
  await client.connect();
  try {
    const inventory = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='rms_kitchen' AND table_name=ANY($1::text[]) ORDER BY table_name`,
      [tables],
    );
    assert.deepEqual(
      inventory.rows.map((row) => row.table_name),
      tables,
    );
    const security = await client.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid=ANY($1::regclass[]) ORDER BY relname`,
      [tables.map((table) => `rms_kitchen.${table}`)],
    );
    assert.equal(security.rows.length, 2);
    assert.equal(
      security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );

    await assert.rejects(
      client.query(
        `INSERT INTO rms_kitchen.kds_recovery_reconciliation (
           kds_recovery_reconciliation_id,brand_id,store_id,operator_actor_id,
           offline_snapshot_digest,offline_checkpoint_id,offline_captured_at,
           source_snapshot_digest,source_checkpoint_id,source_loaded_at,reason_code,
           reconciliation_outcome,command_replay_count,reconciled_at,data_classification
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'NoOfflineMutation',
           'ConvergedNoAction',1,$11,'IndirectIdentifier')`,
        [
          id(20),
          id(2),
          id(3),
          id(21),
          sha("a"),
          id(22),
          "2026-08-11T14:00:00.000Z",
          sha("a"),
          id(22),
          "2026-08-11T14:10:00.000Z",
          "2026-08-11T14:10:01.000Z",
        ],
      ),
      /command_replay_count/u,
    );

    await insertHandover(client, 100);
    await insertHandover(client, 200, id(99));
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kds_operator_handover SET reason_code='Break'
         WHERE brand_id=$1 AND store_id=$2 AND kds_operator_handover_id=$3`,
        [id(2), id(3), id(100)],
      ),
      /append-only/u,
    );
    await client.query(
      `DELETE FROM rms_kitchen.kds_operator_handover
       WHERE brand_id=$1 AND store_id=$2 AND kds_operator_handover_id=$3`,
      [id(2), id(3), id(100)],
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_kitchen.kds_operator_handover WHERE kds_operator_handover_id=$1",
          [id(100)],
        )
      ).rows[0].count,
      1,
    );

    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA rms_kitchen,platform_helpers TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
       platform_helpers.current_store_id() TO ${role}`,
    );
    await client.query(`GRANT SELECT ON rms_kitchen.kds_operator_handover TO ${role}`);
    assert.deepEqual((await withScope(client, role, id(3))).rows, [
      { kds_operator_handover_id: id(100) },
    ]);
    assert.deepEqual((await withScope(client, role, id(98))).rows, []);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves the WP-1408 append-only no-replay KDS continuity boundary", async () => {
  await withIsolatedDatabase({ caseId: "kds_continuity", root }, prove);
});
