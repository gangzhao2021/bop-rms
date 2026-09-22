import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const id = (n) => "01909997-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("allows Additional submission while retaining Initial uniqueness and scoped identity", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_add_schema" }, async (context) => {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    try {
      const at = "2026-09-13T12:00:00.000Z",
        hash = "sha256:" + "a".repeat(64);
      await client.query(
        `INSERT INTO rms_ordering.order_number_allocation
        (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
        business_date_configuration_id,business_date_configuration_version,business_date_content_digest,
        time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation)
        VALUES ($1,$2,$3,'2026-09-13',1,'1',$4,$5,1,$6,'America/Toronto','00:00:00',$4,'Exact')`,
        [id(3), id(1), id(2), at, id(4), hash],
      );
      await client.query(
        `INSERT INTO rms_ordering.order_header
        (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,
        dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,
        canonical_phase,closure_status,payment_status,created_at)
        VALUES ($1,$2,$3,'2026-09-13','1','DineIn','Qr',$4,$5,$5,1,'Submitted','Open','NotReported',$6)`,
        [id(3), id(1), id(2), id(8), id(5), at],
      );
      const insert = (reference, kind, store = id(2)) =>
        client.query(
          `INSERT INTO rms_ordering.order_submission_record
        (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,
        source_cart_id,source_cart_version,quote_id,created_at,submission_kind)
        VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)`,
          [reference, id(1), store, id(3), id(5), hash, id(6), id(7), at, kind],
        );
      await insert(id(10), "Initial");
      await insert(id(11), "Additional");
      await assert.rejects(insert(id(12), "Initial"), { code: "23505" });
      await assert.rejects(insert(id(11), "Additional"), { code: "23505" });
      await assert.rejects(insert(id(13), "Additional", id(99)), { code: "23503" });
      const rows = await client.query(
        "SELECT submission_kind FROM rms_ordering.order_submission_record ORDER BY submission_id",
      );
      assert.deepEqual(rows.rows, [
        { submission_kind: "Initial" },
        { submission_kind: "Additional" },
      ]);
    } finally {
      await client.end();
    }
  });
});
