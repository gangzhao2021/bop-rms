import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9d00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T23:00:00.000Z";
const digest = (c) => `sha256:${c.repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2111_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch(production_batch_id,tenant_id,brand_id,store_id,recipe_id,recipe_version_id,station_id,planned_yield_microunits,planned_by_actor_id,planned_at) VALUES($1,$2,$3,$4,$5,$6,$7,1000000,$8,$9)`,
      [id(10), id(1), id(2), id(3), id(4), id(5), id(6), id(7), at],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_ingredient_plan(production_ingredient_id,production_batch_id,brand_id,store_id,inventory_item_id,lot_id,planned_quantity_microunits) VALUES($1,$2,$3,$4,$5,$6,500000)`,
      [id(11), id(10), id(2), id(3), id(8), id(9)],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_state_record(production_state_id,production_batch_id,brand_id,store_id,aggregate_version,status,actual_yield_microunits,variance_basis_points,consumption_snapshot_json,quality_hold,quality_exception_reason_code,observed_by_actor_id,observed_at) VALUES($1,$2,$3,$4,1,'Planned',NULL,NULL,NULL,false,NULL,$5,$6),($7,$2,$3,$4,2,'InProgress',NULL,NULL,NULL,false,NULL,$5,$6)`,
      [id(12), id(10), id(2), id(3), id(7), at, id(13)],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_state_record(production_state_id,production_batch_id,brand_id,store_id,aggregate_version,status,actual_yield_microunits,variance_basis_points,consumption_snapshot_json,quality_hold,quality_exception_reason_code,observed_by_actor_id,observed_at) VALUES($1,$2,$3,$4,3,'InProgress',900000,1000,$5::jsonb,true,'YIELD_VARIANCE',$6,$7)`,
      [
        id(14),
        id(10),
        id(2),
        id(3),
        JSON.stringify([
          {
            inventoryItemReference: id(8),
            lotReference: id(9),
            actualQuantityMicrounits: "510000",
          },
        ]),
        id(7),
        at,
      ],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_quality_exception(quality_exception_id,production_batch_id,brand_id,store_id,production_state_id,reason_code,containment_code,recorded_by_actor_id,recorded_at) VALUES($1,$2,$3,$4,$5,'YIELD_VARIANCE','QUARANTINE',$6,$7)`,
      [id(15), id(10), id(2), id(3), id(14), id(7), at],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_operation_record(operation_id,production_batch_id,brand_id,store_id,action_code,intent_digest,result_aggregate_version,result_state_id,outbox_event_id,occurred_at) VALUES($1,$2,$3,$4,'RecordObservation',$5,3,$6,$7,$8)`,
      [id(16), id(10), id(2), id(3), digest("a"), id(14), id(17), at],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_projection_generation(generation_id,brand_id,store_id,projection_version,source_event_sequence,built_at) VALUES($1,$2,$3,1,3,$4)`,
      [id(18), id(2), id(3), at],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_projection(generation_id,brand_id,store_id,production_batch_id,recipe_id,recipe_version_id,station_id,status,planned_yield_microunits,actual_yield_microunits,variance_basis_points,quality_hold,aggregate_version,projected_at) VALUES($1,$2,$3,$4,$5,$6,$7,'InProgress',1000000,900000,1000,true,3,$8)`,
      [id(18), id(2), id(3), id(10), id(4), id(5), id(6), at],
    );
    await admin.query(
      `INSERT INTO rms_kitchen.production_batch_projection_checkpoint(brand_id,store_id,active_generation_id,projection_version,source_event_sequence,updated_at) VALUES($1,$2,$3,1,3,$4)`,
      [id(2), id(3), id(18), at],
    );

    assert.equal(
      (
        await admin.query(
          `UPDATE rms_kitchen.production_batch SET planned_yield_microunits=1 WHERE production_batch_id=$1`,
          [id(10)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_kitchen.production_batch_state_record SET quality_hold=false WHERE production_state_id=$1`,
          [id(14)],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_kitchen.production_batch_ingredient_plan(production_ingredient_id,production_batch_id,brand_id,store_id,inventory_item_id,lot_id,planned_quantity_microunits) VALUES($1,$2,$3,$4,$5,NULL,1.5)`,
        [id(20), id(10), id(2), id(3), id(19)],
      ),
      /production_ingredient_quantity_exact/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_kitchen.production_batch_state_record(production_state_id,production_batch_id,brand_id,store_id,aggregate_version,status,actual_yield_microunits,variance_basis_points,consumption_snapshot_json,quality_hold,quality_exception_reason_code,observed_by_actor_id,observed_at) VALUES($1,$2,$3,$4,4,'Completed',900000,1000,'[]',true,'YIELD_VARIANCE',$5,$6)`,
        [id(21), id(10), id(2), id(3), id(7), at],
      ),
      /production_state_complete_check/u,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_kitchen,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_kitchen.production_batch,rms_kitchen.production_batch_ingredient_plan,rms_kitchen.production_batch_state_record,rms_kitchen.production_batch_projection TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_kitchen.production_batch`)).rowCount, 0);
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(2), id(3)],
    );
    assert.equal((await admin.query(`SELECT * FROM rms_kitchen.production_batch`)).rowCount, 1);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_kitchen.production_batch_ingredient_plan`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM rms_kitchen.production_batch_projection`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_kitchen.production_batch`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("keeps Production Batch quantities, lifecycle evidence and Store RLS exact and append-only", async () => {
  await withIsolatedDatabase({ caseId: "production_batch", root }, prove);
}, 120_000);
