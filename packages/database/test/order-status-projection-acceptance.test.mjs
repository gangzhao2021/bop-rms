import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f6400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-03T14:00:00.000Z";

async function seedOrder(client) {
  await client.query(
    `INSERT INTO rms_ordering.order_number_counter (brand_id,store_id,business_date,next_sequence,updated_at) VALUES ($1,$2,'2026-08-03',43,$3)`,
    [id(1), id(2), at],
  );
  await client.query(
    `INSERT INTO rms_ordering.order_number_allocation
    (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,business_date_configuration_id,business_date_configuration_version,business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation)
    VALUES ($1,$2,$3,'2026-08-03',42,'42',$4,$5,1,$6,'America/Toronto','04:00:00','2026-08-03T08:00:00.000Z','Exact')`,
    [id(10), id(1), id(2), at, id(3), `sha256:${"a".repeat(64)}`],
  );
  await client.query(
    `INSERT INTO rms_ordering.order_header
    (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at)
    VALUES ($1,$2,$3,'2026-08-03','42','Pickup','Qr',$4,$4,1,'Submitted','Open','NotReported',$5)`,
    [id(10), id(1), id(2), id(4), at],
  );
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relname,relforcerowsecurity FROM pg_class WHERE oid IN ('rms_ordering.order_status_projection_generation'::regclass,'rms_ordering.order_status_projection'::regclass) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 2);
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );
    await seedOrder(client);
    const snapshot = JSON.stringify({
      canonicalPhase: "Submitted",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Unavailable",
      batches: [],
    });
    await client.query(
      `INSERT INTO rms_ordering.order_status_projection_generation
      (generation_id,brand_id,store_id,order_id,projection_name,projection_version,source_version,source_checkpoint,projected_at,freshness_status,customer_guest_session_id,order_number,submitted_at,projection_snapshot_json)
      VALUES ($1,$2,$3,$4,'ordering_order_status_v1',1,1,$5,$6,'Fresh',$7,'42',$6,$8::jsonb)`,
      [id(20), id(1), id(2), id(10), id(21), at, id(4), snapshot],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_status_projection (order_id,brand_id,store_id,generation_id,source_version,source_checkpoint,projected_at) VALUES ($1,$2,$3,$4,1,$5,$6)`,
      [id(10), id(1), id(2), id(20), id(21), at],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_ordering.order_status_projection_generation
      (generation_id,brand_id,store_id,order_id,projection_name,projection_version,source_version,source_checkpoint,projected_at,freshness_status,customer_guest_session_id,order_number,submitted_at,projection_snapshot_json)
      VALUES ($1,$2,$3,$4,'ordering_order_status_v1',1,1,$5,$6,'Fresh',$7,'42',$6,$8::jsonb)`,
        [id(22), id(1), id(2), id(10), id(23), at, id(4), snapshot],
      ),
      /order_status_generation_source_unique/u,
    );
    await client.query(
      `INSERT INTO rms_ordering.order_status_projection_generation
      (generation_id,brand_id,store_id,order_id,projection_name,projection_version,source_version,source_checkpoint,projected_at,freshness_status,customer_guest_session_id,order_number,submitted_at,projection_snapshot_json)
      VALUES ($1,$2,$3,$4,'ordering_order_status_v1',1,2,$5,$6,'Fresh',$7,'42',$6,$8::jsonb)`,
      [id(24), id(1), id(2), id(10), id(25), at, id(4), snapshot],
    );
    await client.query(
      `UPDATE rms_ordering.order_status_projection SET generation_id=$1,source_version=2,source_checkpoint=$2 WHERE order_id=$3`,
      [id(24), id(25), id(10)],
    );
    const active = await client.query(
      `SELECT generation_id,source_version,source_checkpoint FROM rms_ordering.order_status_projection WHERE order_id=$1`,
      [id(10)],
    );
    assert.deepEqual(active.rows[0], {
      generation_id: id(24),
      source_version: 2,
      source_checkpoint: id(25),
    });
    await assert.rejects(
      client.query(
        `UPDATE rms_ordering.order_status_projection SET generation_id=$1,source_version=1,source_checkpoint=$2 WHERE order_id=$3`,
        [id(20), id(21), id(10)],
      ),
      /order status projection must advance monotonically/u,
    );
    await client.query(
      `UPDATE rms_ordering.order_status_projection_generation SET order_number='999' WHERE generation_id=$1`,
      [id(20)],
    );
    assert.equal(
      (
        await client.query(
          `SELECT order_number FROM rms_ordering.order_status_projection_generation WHERE generation_id=$1`,
          [id(20)],
        )
      ).rows[0].order_number,
      "42",
    );
  } finally {
    await client.end();
  }
}

it("persists an immutable, Store-scoped generation and atomically switches the active projection", async () => {
  await withIsolatedDatabase({ caseId: "order_status", root }, prove);
}, 180_000);
