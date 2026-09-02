import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (c) => `sha256:${c.repeat(64)}`;
const at = "2026-08-13T18:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2104_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_pricing.promotion(promotion_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_LUNCH',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id,version_number,snapshot_digest,lifecycle,promotion_type,currency_code,benefit_scope,benefit_calculation,benefit_rate,stacking,stacking_group_code,priority,budget_minor,usage_minor,usage_count,redemption_limit,effective_from,effective_time_zone,customer_copy_code,created_at) VALUES($1,$2,$3,1,$4,'Published','OrderPercentage','CAD','Order','Percentage',0.10,'SameGroupExclusive','MEAL',10,100000,1250,5,100,$5,'America/Toronto','SYNTHETIC_COPY',$5)`,
      [id(4), id(1), id(2), digest("a"), at],
    );
    await admin.query(
      `UPDATE rms_pricing.promotion SET current_version_id=$1,aggregate_version=2,updated_at=$2 WHERE promotion_id=$3`,
      [id(4), at, id(1)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.promotion_eligibility_reference(promotion_eligibility_reference_id,promotion_version_id,promotion_id,brand_id,reference_kind,public_reference_id) VALUES($1,$2,$3,$4,'Segment',$5)`,
      [id(5), id(4), id(1), id(2), id(6)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.promotion_operation_record(operation_id,promotion_id,brand_id,action_code,intent_digest,result_aggregate_version,result_version_id,outbox_event_id,occurred_at) VALUES($1,$2,$3,'Publish',$4,2,$5,$6,$7)`,
      [id(7), id(1), id(2), digest("b"), id(4), id(8), at],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id,version_number,snapshot_digest,lifecycle,promotion_type,currency_code,benefit_scope,benefit_calculation,benefit_fixed_minor,stacking,priority,budget_minor,usage_minor,usage_count,redemption_limit,effective_from,effective_time_zone,customer_copy_code,created_at) VALUES($1,$2,$3,2,$4,'Draft','OrderFixed','CAD','Order','Fixed',10,'Stackable',1,99.5,0,0,1,$5,'America/Toronto','INVALID',$5)`,
        [id(9), id(1), id(2), digest("c"), at],
      ),
      /promotion_version_money_check/u,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_pricing.promotion_version SET budget_minor=1 WHERE promotion_version_id=$1`,
          [id(4)],
        )
      ).rowCount,
      0,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO ${role}`);
    await admin.query(
      `GRANT SELECT ON rms_pricing.promotion,rms_pricing.promotion_version,rms_pricing.promotion_eligibility_reference TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.promotion`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.promotion`)).rowCount, 1);
    assert.equal(
      (
        await admin.query(
          `SELECT public_reference_id FROM rms_pricing.promotion_eligibility_reference`,
        )
      ).rows[0].public_reference_id,
      id(6),
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.promotion`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("keeps Promotion versions, budget facts, event linkage and Brand RLS exact", async () => {
  await withIsolatedDatabase({ caseId: "promotion_management", root }, prove);
}, 120_000);
