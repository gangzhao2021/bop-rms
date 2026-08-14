import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9c00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T22:00:00.000Z";
const digest = (c) => `sha256:${c.repeat(64)}`;
async function seedOrder(client) {
  await client.query(
    `INSERT INTO rms_ordering.order_number_counter(brand_id,store_id,business_date,next_sequence,updated_at) VALUES($1,$2,'2026-08-13',2,$3)`,
    [id(1), id(2), at],
  );
  await client.query(
    `INSERT INTO rms_ordering.order_number_allocation(order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,business_date_configuration_id,business_date_configuration_version,business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) VALUES($1,$2,$3,'2026-08-13',1,'1',$4,$5,1,$6,'America/Toronto','04:00:00','2026-08-13T08:00:00.000Z','Exact')`,
    [id(10), id(1), id(2), at, id(3), digest("a")],
  );
  await client.query(
    `INSERT INTO rms_ordering.order_header(order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES($1,$2,$3,'2026-08-13','1','Pickup','Pos',$4,$4,1,'Submitted','Open','NotReported',$5)`,
    [id(10), id(1), id(2), id(4), at],
  );
}
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2110_${context.runId}`;
  await admin.connect();
  try {
    await seedOrder(admin);
    await admin.query(
      `INSERT INTO rms_ordering.order_amendment(amendment_id,tenant_id,brand_id,store_id,order_id,requested_by_actor_id,reason_code,expected_order_version,quote_id,quote_version,quote_input_digest,currency_code,original_total_minor,revised_total_minor,delta_minor,kitchen_status,fulfillment_status,approval_required,customer_notice_code,requested_at) VALUES($1,$2,$3,$4,$5,$6,'GUEST_REQUEST',1,$7,2,$8,'CAD',1000,1250,250,'NotStarted','NotStarted',false,'NOTICE_REQUIRED',$9)`,
      [id(20), id(30), id(1), id(2), id(10), id(4), id(21), digest("b"), at],
    );
    await admin.query(
      `INSERT INTO rms_ordering.order_amendment_change(amendment_id,brand_id,store_id,order_id,change_kind,target_order_item_id,replacement_snapshot_digest,quantity_delta,note_code) VALUES($1,$2,$3,$4,'AddItem',NULL,$5,1,NULL)`,
      [id(20), id(1), id(2), id(10), digest("c")],
    );
    await admin.query(
      `INSERT INTO rms_ordering.order_amendment_state_record(amendment_state_id,amendment_id,brand_id,store_id,order_id,aggregate_version,status,decided_by_actor_id,occurred_at) VALUES($1,$2,$3,$4,$5,1,'Applied',$6,$7)`,
      [id(22), id(20), id(1), id(2), id(10), id(4), at],
    );
    await admin.query(
      `INSERT INTO rms_ordering.order_amendment_operation_record(operation_id,amendment_id,brand_id,store_id,order_id,action_code,intent_digest,result_aggregate_version,result_state_id,outbox_event_id,occurred_at) VALUES($1,$2,$3,$4,$5,'Submit',$6,1,$7,$8,$9)`,
      [id(23), id(20), id(1), id(2), id(10), digest("d"), id(22), id(24), at],
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_ordering.order_amendment SET revised_total_minor=1 WHERE amendment_id=$1`,
          [id(20)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_ordering.order_amendment_state_record SET status='Rejected' WHERE amendment_id=$1`,
          [id(20)],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.order_amendment(amendment_id,tenant_id,brand_id,store_id,order_id,requested_by_actor_id,reason_code,expected_order_version,quote_id,quote_version,quote_input_digest,currency_code,original_total_minor,revised_total_minor,delta_minor,kitchen_status,fulfillment_status,approval_required,customer_notice_code,requested_at) VALUES($1,$2,$3,$4,$5,$6,'BAD_SCOPE',1,$7,1,$8,'CAD',1,1,0,'NotStarted','NotStarted',false,'NOTICE',$9)`,
        [id(40), id(30), id(1), id(99), id(10), id(4), id(41), digest("e"), at],
      ),
      /order_amendment_order_fk/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_ordering,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_ordering.order_amendment,rms_ordering.order_amendment_change,rms_ordering.order_amendment_state_record TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_ordering.order_amendment`)).rowCount, 0);
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(1), id(2)],
    );
    assert.equal((await admin.query(`SELECT * FROM rms_ordering.order_amendment`)).rowCount, 1);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_ordering.order_amendment`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("keeps Order Amendment money, scope and state history exact and append-only", async () => {
  await withIsolatedDatabase({ caseId: "order_amendment", root }, prove);
}, 120_000);
