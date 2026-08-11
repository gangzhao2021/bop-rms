import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { it } from "vitest";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a407-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const tables = [
  "kitchen_allergen_acknowledgement",
  "kitchen_allergen_incident_link",
  "kitchen_allergen_review",
];

async function withScope(client, role, brandId, storeId, operation) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('bop.brand_id', $1, true)", [brandId]);
    await client.query("SELECT set_config('bop.store_id', $1, true)", [storeId]);
    await client.query(`SET LOCAL ROLE ${role}`);
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function insertReview(client, seed, storeId = id(3)) {
  await client.query(
    `INSERT INTO rms_kitchen.kitchen_allergen_review (
       kitchen_allergen_review_id,brand_id,store_id,order_id,kitchen_ticket_id,order_item_id,
       configuration_digest,allergen_references,policy_version_id,recipe_version_references,
       reviewer_actor_id,review_outcome,reviewed_at,valid_until,retain_until,data_classification
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Accepted',$12,$13,$14,'Restricted')`,
    [
      id(seed),
      id(2),
      storeId,
      id(seed + 1),
      id(seed + 2),
      id(seed + 3),
      sha("a"),
      [id(seed + 4)],
      id(seed + 5),
      [id(seed + 6)],
      id(seed + 7),
      "2026-08-11T12:00:00.000Z",
      "2026-08-11T13:00:00.000Z",
      "2028-08-11T12:00:00.000Z",
    ],
  );
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp1407_${context.runId}`;
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
    assert.equal(security.rows.length, 3);
    assert.equal(
      security.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );

    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='rms_kitchen' AND table_name=ANY($1::text[])`,
      [tables],
    );
    assert.equal(
      columns.rows.some((row) => /medical|symptom|customer_note|free_text/u.test(row.column_name)),
      false,
    );

    await client.query("SET session_replication_role = replica");
    try {
      await insertReview(client, 100);
      await insertReview(client, 200, id(99));
    } finally {
      await client.query("SET session_replication_role = origin");
    }

    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_allergen_review SET review_outcome='CannotSafelyAccommodate'
         WHERE brand_id=$1 AND store_id=$2 AND kitchen_allergen_review_id=$3`,
        [id(2), id(3), id(100)],
      ),
      /append-only/u,
    );
    await client.query(
      `DELETE FROM rms_kitchen.kitchen_allergen_review
       WHERE brand_id=$1 AND store_id=$2 AND kitchen_allergen_review_id=$3`,
      [id(2), id(3), id(100)],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_allergen_review
         WHERE kitchen_allergen_review_id=$1`,
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
    await client.query(`GRANT SELECT ON rms_kitchen.kitchen_allergen_review TO ${role}`);
    const visible = await withScope(client, role, id(2), id(3), () =>
      client.query(
        "SELECT kitchen_allergen_review_id::text FROM rms_kitchen.kitchen_allergen_review",
      ),
    );
    assert.deepEqual(visible.rows, [{ kitchen_allergen_review_id: id(100) }]);
    const crossStore = await withScope(client, role, id(2), id(98), () =>
      client.query(
        "SELECT kitchen_allergen_review_id::text FROM rms_kitchen.kitchen_allergen_review",
      ),
    );
    assert.deepEqual(crossStore.rows, []);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves the WP-1407 restricted append-only allergen safety boundary", async () => {
  await withIsolatedDatabase({ caseId: "kitchen_allergen", root }, prove);
});
