import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a406-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;

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

async function insertPublication(client, seed, storeId = id(3)) {
  return await client.query(
    `INSERT INTO rms_kitchen.kitchen_ready_publication (
       kitchen_ready_publication_id,brand_id,store_id,kitchen_ticket_id,order_id,
       order_batch_id,order_item_id,ready_result_id,ticket_version,ready_quantity,
       required_quantity,ticket_item_count,item_outbox_event_id,item_event_semantic_digest,
       correlation_id,causation_operation_id,occurred_at,data_classification,retention_policy_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,4,2,2,1,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id(seed),
      id(2),
      storeId,
      id(seed + 1),
      id(seed + 2),
      id(seed + 3),
      id(seed + 4),
      id(seed + 5),
      id(seed + 6),
      sha("b"),
      id(seed + 7),
      id(seed + 8),
      "2026-08-11T12:00:00.000Z",
      "IndirectIdentifier",
      "KitchenBusinessRecord",
    ],
  );
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp1406_${context.runId}`;
  await client.connect();
  try {
    const table = "kitchen_ready_publication";
    const inventory = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='rms_kitchen' AND table_name=$1`,
      [table],
    );
    assert.deepEqual(inventory.rows, [{ table_name: table }]);

    const security = await client.query(
      `SELECT relrowsecurity,relforcerowsecurity
       FROM pg_class WHERE oid='rms_kitchen.kitchen_ready_publication'::regclass`,
    );
    assert.deepEqual(security.rows, [{ relrowsecurity: true, relforcerowsecurity: true }]);
    const publicGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_kitchen' AND table_name=$1 AND grantee='PUBLIC'`,
      [table],
    );
    assert.equal(publicGrants.rows[0].count, 0);

    const columns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='rms_kitchen' AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    );
    const names = columns.rows.map((row) => row.column_name);
    for (const required of [
      "brand_id",
      "store_id",
      "ready_result_id",
      "item_outbox_event_id",
      "order_outbox_event_id",
      "causation_operation_id",
      "data_classification",
      "retention_policy_code",
    ])
      assert.equal(names.includes(required), true);
    assert.equal(
      names.some((name) => /customer|note|allergen|health|payment|provider/u.test(name)),
      false,
    );

    const constraints = await client.query(
      `SELECT constraint_row.conname,constraint_row.contype,
         CASE WHEN constraint_row.contype='f'
           THEN constraint_row.confrelid::regclass::text ELSE NULL END AS target,
         ARRAY(
           SELECT attribute.attname::text
           FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum,position)
           JOIN pg_attribute AS attribute
             ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=key.attnum
           ORDER BY key.position
         ) AS columns
       FROM pg_constraint AS constraint_row
       WHERE constraint_row.conrelid='rms_kitchen.kitchen_ready_publication'::regclass
       ORDER BY constraint_row.conname`,
    );
    const foreignKeys = constraints.rows.filter((row) => row.contype === "f");
    assert.deepEqual(foreignKeys.map((row) => row.target).sort(), [
      "rms_kitchen.kitchen_order_item_ready_result",
      "rms_kitchen.kitchen_ticket",
      "rms_kitchen.kitchen_work_lifecycle_operation",
    ]);
    assert.equal(
      constraints.rows
        .filter((row) => ["p", "u", "f"].includes(row.contype))
        .every((row) => row.columns[0] === "brand_id" && row.columns[1] === "store_id"),
      true,
    );

    const appendOnly = await client.query(
      `SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_schema='rms_kitchen' AND event_object_table=$1`,
      [table],
    );
    assert.deepEqual(appendOnly.rows, [
      { trigger_name: "kitchen_ready_publication_no_update_trigger" },
    ]);
    const deleteRule = await client.query(
      `SELECT rulename FROM pg_rules WHERE schemaname='rms_kitchen' AND tablename=$1`,
      [table],
    );
    assert.deepEqual(deleteRule.rows, [{ rulename: "kitchen_ready_publication_no_delete" }]);

    await assert.rejects(
      client.query(
        `INSERT INTO rms_kitchen.kitchen_ready_publication (
           kitchen_ready_publication_id,brand_id,store_id,kitchen_ticket_id,order_id,
           order_batch_id,order_item_id,ready_result_id,ticket_version,ready_quantity,
           required_quantity,ticket_item_count,item_outbox_event_id,item_event_semantic_digest,
           correlation_id,causation_operation_id,occurred_at,data_classification,
           retention_policy_code
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1,2,1,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id(1),
          id(2),
          id(3),
          id(4),
          id(5),
          id(6),
          id(7),
          id(8),
          id(9),
          sha("a"),
          id(10),
          id(11),
          "2026-08-11T12:00:00.000Z",
          "IndirectIdentifier",
          "KitchenBusinessRecord",
        ],
      ),
      /kitchen_ready_publication_quantity_check/u,
    );

    await client.query("SET session_replication_role = replica");
    try {
      await insertPublication(client, 100);
      await insertPublication(client, 200, id(99));
    } finally {
      await client.query("SET session_replication_role = origin");
    }
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_ready_publication SET occurred_at=$1
         WHERE brand_id=$2 AND store_id=$3 AND kitchen_ready_publication_id=$4`,
        ["2026-08-11T12:01:00.000Z", id(2), id(3), id(100)],
      ),
      /kitchen work lifecycle evidence is append-only/u,
    );
    assert.equal(
      (
        await client.query(
          `DELETE FROM rms_kitchen.kitchen_ready_publication
           WHERE brand_id=$1 AND store_id=$2 AND kitchen_ready_publication_id=$3`,
          [id(2), id(3), id(100)],
        )
      ).rowCount,
      0,
    );

    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(`GRANT USAGE ON SCHEMA rms_kitchen,platform_helpers TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
       platform_helpers.current_store_id() TO ${role}`,
    );
    await client.query(`GRANT SELECT ON rms_kitchen.kitchen_ready_publication TO ${role}`);
    const visible = await withScope(client, role, id(2), id(3), () =>
      client.query(
        "SELECT kitchen_ready_publication_id::text FROM rms_kitchen.kitchen_ready_publication",
      ),
    );
    assert.deepEqual(visible.rows, [{ kitchen_ready_publication_id: id(100) }]);
    const crossStore = await withScope(client, role, id(2), id(98), () =>
      client.query(
        "SELECT kitchen_ready_publication_id::text FROM rms_kitchen.kitchen_ready_publication",
      ),
    );
    assert.deepEqual(crossStore.rows, []);
  } finally {
    await client.end();
  }
}

it("proves the WP-1406 Kitchen Ready durable publication boundary", async () => {
  await withIsolatedDatabase({ caseId: "kitchen_ready_event", root }, prove);
});
