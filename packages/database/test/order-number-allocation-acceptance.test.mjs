import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f6000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function allocate(client, orderId, businessDate, allocatedAt) {
  await client.query("BEGIN");
  try {
    const counter = await client.query(
      `INSERT INTO rms_ordering.order_number_counter
       (brand_id,store_id,business_date,next_sequence,updated_at)
       VALUES ($1,$2,$3,2,$4)
       ON CONFLICT (brand_id,store_id,business_date) DO UPDATE
       SET next_sequence = rms_ordering.order_number_counter.next_sequence + 1,
           updated_at = EXCLUDED.updated_at
       RETURNING next_sequence - 1 AS sequence`,
      [id(1), id(2), businessDate, allocatedAt],
    );
    const sequence = counter.rows[0].sequence;
    await client.query(
      `INSERT INTO rms_ordering.order_number_allocation
       (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
        business_date_configuration_id,business_date_configuration_version,
        business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,
        boundary_disambiguation)
       VALUES ($1,$2,$3,$4,$5::bigint,($5::bigint)::text,$6,$7,3,$8,
        'America/Toronto','04:00:00',$9,'Exact')`,
      [
        orderId,
        id(1),
        id(2),
        businessDate,
        sequence,
        allocatedAt,
        id(3),
        `sha256:${"a".repeat(64)}`,
        allocatedAt,
      ],
    );
    await client.query("COMMIT");
    return Number(sequence);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const left = new Client(context.clientConfig);
  const right = new Client(context.clientConfig);
  await Promise.all([admin.connect(), left.connect(), right.connect()]);
  try {
    const security = await admin.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_ordering.order_number_counter'::regclass,
         'rms_ordering.order_number_allocation'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(
      security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );

    const concurrent = await Promise.all([
      allocate(left, id(10), "2026-08-02", "2026-08-02T08:00:00.000Z"),
      allocate(right, id(11), "2026-08-02", "2026-08-02T08:00:00.001Z"),
    ]);
    assert.deepEqual(
      concurrent.sort((a, b) => a - b),
      [1, 2],
    );
    assert.equal(await allocate(admin, id(12), "2026-08-03", "2026-08-03T08:00:00.000Z"), 1);

    const originalOrderNumber = (
      await admin.query(
        `SELECT order_number FROM rms_ordering.order_number_allocation WHERE order_id=$1`,
        [id(10)],
      )
    ).rows[0].order_number;
    await admin.query(
      `UPDATE rms_ordering.order_number_allocation SET order_number='999' WHERE order_id=$1`,
      [id(10)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT order_number FROM rms_ordering.order_number_allocation WHERE order_id=$1`,
          [id(10)],
        )
      ).rows[0].order_number,
      originalOrderNumber,
    );
    await admin.query(`DELETE FROM rms_ordering.order_number_allocation WHERE order_id=$1`, [
      id(10),
    ]);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.order_number_allocation`,
        )
      ).rows[0].count,
      3,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.order_number_allocation
         (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
          business_date_configuration_id,business_date_configuration_version,
          business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,
          boundary_disambiguation)
         SELECT $1,brand_id,store_id,business_date,sequence,order_number,allocated_at,
          business_date_configuration_id,business_date_configuration_version,
          business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,
          boundary_disambiguation
         FROM rms_ordering.order_number_allocation WHERE order_id=$2`,
        [id(13), id(10)],
      ),
      /order_number_allocation_scope_(?:sequence|number)_unique/u,
    );
  } finally {
    await Promise.all([admin.end(), left.end(), right.end()]);
  }
}

it("proves concurrent Store + Business Date order-number allocation", async () => {
  await withIsolatedDatabase({ caseId: "order_number", root }, prove);
}, 180_000);
