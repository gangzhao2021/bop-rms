import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a403-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const asOf = "2026-08-09T14:00:00.000Z";
const projectedAt = "2026-08-09T14:00:01.000Z";
const staleProjectedAt = "2026-08-09T14:00:02.001Z";

async function insertRow(client, table, row) {
  const columns = Object.keys(row);
  const parameters = columns.map((_, index) => `$${index + 1}`).join(",");
  return await client.query(
    `INSERT INTO rms_kitchen.${table} (${columns.join(",")}) VALUES (${parameters})`,
    columns.map((column) => row[column]),
  );
}

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

function generation(overrides = {}) {
  return {
    projection_generation_id: id(100),
    brand_id: id(1),
    store_id: id(2),
    projection_name: "kitchen_work_queue_v1",
    projection_version: 1,
    generation_status: "Active",
    source_checkpoint_reference: id(101),
    source_event_binding_digest: sha("a"),
    queue_snapshot_digest: sha("b"),
    ticket_count: 0,
    work_item_count: 0,
    initialized_empty: true,
    as_of_utc: asOf,
    projected_at: projectedAt,
    last_rebuilt_at: null,
    freshness_status: "Fresh",
    rebuild_reference: null,
    rebuild_request_digest: null,
    rebuild_requested_at: null,
    expected_prior_generation_id: null,
    ...overrides,
  };
}

function queueRow(source, generationRow, overrides = {}) {
  return {
    projection_generation_id: generationRow.projection_generation_id,
    brand_id: generationRow.brand_id,
    store_id: generationRow.store_id,
    kitchen_ticket_id: source.kitchenTicketId,
    kitchen_work_item_id: source.kitchenWorkItemId,
    order_id: source.orderId,
    order_batch_id: source.orderBatchId,
    order_item_id: source.orderItemId,
    source_item_ordinal: 1,
    ticket_aggregate_version: 1,
    work_item_version: 1,
    status: "Queued",
    required_quantity: 2,
    completed_quantity: 0,
    localized_display_names_json: JSON.stringify({ "en-CA": "Synthetic noodles" }),
    selected_options_json: JSON.stringify([
      {
        optionReference: id(26),
        quantity: 1,
        localizedNames: { "en-CA": "Synthetic option" },
      },
    ]),
    station_id: id(27),
    original_source_event_id: source.sourceEventId,
    source_event_semantic_digest: sha("c"),
    source_event_occurred_at: source.createdAt,
    work_item_created_at: source.createdAt,
    ...overrides,
  };
}

async function seedSource(client) {
  const source = {
    kitchenTicketId: id(10),
    kitchenWorkItemId: id(20),
    orderId: id(11),
    orderBatchId: id(12),
    orderItemId: id(21),
    confirmationId: id(13),
    sourceEventId: id(14),
    correlationId: id(15),
    sourceEvidenceId: id(16),
    workPlanId: id(17),
    createdAt: asOf,
  };
  await client.query(
    `INSERT INTO rms_kitchen.kitchen_ticket (
       kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,
       consumer_name,consumer_version,source_event_id,source_aggregate_version,
       source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,
       source_evidence_id,source_evidence_version,source_evidence_digest,
       source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,
       work_plan_generated_at,aggregate_version,status,created_by_actor_type,
       updated_by_actor_type,created_at,updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,3,$8,$9,$10,$11,
       $12,2,$13,$9,$14,4,$15,$9,1,'Open','System','System',$9,$9
     )`,
    [
      source.kitchenTicketId,
      id(1),
      id(2),
      source.orderId,
      source.orderBatchId,
      source.confirmationId,
      source.sourceEventId,
      sha("d"),
      source.createdAt,
      source.correlationId,
      sha("e"),
      source.sourceEvidenceId,
      sha("f"),
      source.workPlanId,
      sha("1"),
    ],
  );
  await client.query(
    `INSERT INTO rms_kitchen.kitchen_work_item (
       kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,
       order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,
       version,status,required_quantity,completed_quantity,product_id,product_version_id,
       sku_id,menu_version_id,localized_display_names_json,selected_options_json,
       source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,
       preparation_id,preparation_version,preparation_digest,preparation_instructions_json,
       execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,1,'Queued',2,0,$10,$11,$12,$13,
       $14::jsonb,$15::jsonb,$16,$17,$18,2,$19,$20,5,$21,'[null]'::jsonb,$22,
       'System','System',$23,$23
     )`,
    [
      source.kitchenWorkItemId,
      id(1),
      id(2),
      source.kitchenTicketId,
      source.orderId,
      source.orderBatchId,
      source.orderItemId,
      source.sourceEvidenceId,
      source.workPlanId,
      id(22),
      id(23),
      id(24),
      id(25),
      JSON.stringify({ "en-CA": "Synthetic noodles" }),
      JSON.stringify([]),
      sha("2"),
      id(27),
      id(28),
      sha("3"),
      id(29),
      sha("4"),
      sha("5"),
      source.createdAt,
    ],
  );
  return source;
}

async function setLockScope(client, brandId, storeId) {
  await client.query("SELECT set_config('bop.brand_id', $1, true)", [brandId]);
  await client.query("SELECT set_config('bop.store_id', $1, true)", [storeId]);
}

const lockExpression = `hashtextextended(
  platform_helpers.current_brand_id()::text || ':' ||
  platform_helpers.current_store_id()::text || ':kitchen_work_queue_v1',
  0
)`;

async function prove(context) {
  const client = new Client(context.clientConfig);
  const contender = new Client(context.clientConfig);
  const role = `bop_wp1403_${context.runId}`;
  await client.connect();
  await contender.connect();
  try {
    const migrationCount = await client.query(
      "SELECT count(*)::integer AS count FROM platform_core.migration_history",
    );
    assert.equal(migrationCount.rows[0].count, 48);

    const inventory = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='rms_kitchen' AND table_type='BASE TABLE'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      inventory.rows.map((row) => row.table_name),
      [
        "kitchen_action_record",
        "kitchen_ticket",
        "kitchen_work_item",
        "kitchen_work_queue_projection",
        "kitchen_work_queue_projection_generation",
      ],
    );

    const generationColumns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='rms_kitchen'
         AND table_name='kitchen_work_queue_projection_generation'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      generationColumns.rows.map((row) => row.column_name),
      [
        "projection_generation_id",
        "brand_id",
        "store_id",
        "projection_name",
        "projection_version",
        "generation_status",
        "source_checkpoint_reference",
        "source_event_binding_digest",
        "queue_snapshot_digest",
        "ticket_count",
        "work_item_count",
        "initialized_empty",
        "as_of_utc",
        "projected_at",
        "last_rebuilt_at",
        "freshness_status",
        "rebuild_reference",
        "rebuild_request_digest",
        "rebuild_requested_at",
        "expected_prior_generation_id",
      ],
    );
    const rowColumns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='rms_kitchen' AND table_name='kitchen_work_queue_projection'
       ORDER BY ordinal_position`,
    );
    assert.deepEqual(
      rowColumns.rows.map((row) => row.column_name),
      [
        "projection_generation_id",
        "brand_id",
        "store_id",
        "kitchen_ticket_id",
        "kitchen_work_item_id",
        "order_id",
        "order_batch_id",
        "order_item_id",
        "source_item_ordinal",
        "ticket_aggregate_version",
        "work_item_version",
        "status",
        "required_quantity",
        "completed_quantity",
        "localized_display_names_json",
        "selected_options_json",
        "station_id",
        "original_source_event_id",
        "source_event_semantic_digest",
        "source_event_occurred_at",
        "work_item_created_at",
      ],
    );
    const forbiddenProjectionColumns = [
      "customer_note",
      "allergen",
      "health",
      "preparation",
      "routing",
      "source_line_digest",
      "execution_snapshot_digest",
      "work_plan_digest",
      "actor_id",
      "payment",
      "provider",
    ];
    assert.equal(
      [...generationColumns.rows, ...rowColumns.rows].some((row) =>
        forbiddenProjectionColumns.some((name) => row.column_name.includes(name)),
      ),
      false,
    );

    const forced = await client.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_kitchen.kitchen_work_queue_projection'::regclass,
         'rms_kitchen.kitchen_work_queue_projection_generation'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 2);
    assert.equal(
      forced.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );
    const publicTableGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_kitchen'
         AND table_name IN (
           'kitchen_work_queue_projection',
           'kitchen_work_queue_projection_generation'
         )
         AND grantee='PUBLIC'`,
    );
    assert.equal(publicTableGrants.rows[0].count, 0);

    const scopedConstraints = await client.query(
      `SELECT constraint_row.conname,constraint_row.contype,
         ARRAY(
           SELECT attribute.attname::text
           FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum,position)
           JOIN pg_attribute AS attribute
             ON attribute.attrelid=constraint_row.conrelid
            AND attribute.attnum=key.attnum
           ORDER BY key.position
         ) AS columns,
         CASE WHEN constraint_row.contype='f'
           THEN constraint_row.confrelid::regclass::text
           ELSE NULL
         END AS target
       FROM pg_constraint AS constraint_row
       WHERE constraint_row.conrelid IN (
         'rms_kitchen.kitchen_work_queue_projection'::regclass,
         'rms_kitchen.kitchen_work_queue_projection_generation'::regclass
       )
         AND constraint_row.contype IN ('p','u','f')
       ORDER BY constraint_row.conname`,
    );
    assert.equal(scopedConstraints.rows.length, 6);
    assert.equal(
      scopedConstraints.rows.every(
        (row) => row.columns[0] === "brand_id" && row.columns[1] === "store_id",
      ),
      true,
    );
    assert.deepEqual(
      scopedConstraints.rows.filter((row) => row.contype === "f").map((row) => row.target),
      [
        "rms_kitchen.kitchen_work_queue_projection_generation",
        "rms_kitchen.kitchen_work_queue_projection_generation",
        "rms_kitchen.kitchen_work_item",
      ],
    );

    const projectionIndexes = await client.query(
      `SELECT indexname,indexdef FROM pg_indexes
       WHERE schemaname='rms_kitchen'
         AND tablename IN (
           'kitchen_work_queue_projection',
           'kitchen_work_queue_projection_generation'
         )
       ORDER BY indexname`,
    );
    assert.equal(projectionIndexes.rows.length, 12);
    assert.equal(
      projectionIndexes.rows.every((row) => row.indexdef.includes("(brand_id, store_id")),
      true,
    );
    const activeIndex = projectionIndexes.rows.find(
      (row) => row.indexname === "kitchen_work_queue_generation_one_active_unique",
    );
    assert.match(activeIndex?.indexdef ?? "", /UNIQUE[\s\S]+WHERE \(generation_status = 'Active'/u);
    const rebuildIndex = projectionIndexes.rows.find(
      (row) => row.indexname === "kitchen_work_queue_generation_rebuild_reference_unique",
    );
    assert.match(rebuildIndex?.indexdef ?? "", /UNIQUE[\s\S]+rebuild_reference IS NOT NULL/u);

    const source = await seedSource(client);
    const initial = generation();
    await insertRow(client, "kitchen_work_queue_projection_generation", initial);
    assert.deepEqual(
      (
        await client.query(
          `SELECT initialized_empty,ticket_count,work_item_count,generation_status
           FROM rms_kitchen.kitchen_work_queue_projection_generation
           WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
          [initial.brand_id, initial.store_id, initial.projection_generation_id],
        )
      ).rows,
      [
        {
          initialized_empty: true,
          ticket_count: 0,
          work_item_count: 0,
          generation_status: "Active",
        },
      ],
    );

    await assert.rejects(
      insertRow(
        client,
        "kitchen_work_queue_projection_generation",
        generation({ projection_generation_id: id(102) }),
      ),
      /kitchen_work_queue_generation_one_active_unique/u,
    );
    await assert.rejects(
      insertRow(
        client,
        "kitchen_work_queue_projection_generation",
        generation({
          projection_generation_id: id(103),
          generation_status: "Building",
          source_event_binding_digest: `sha256:${"A".repeat(64)}`,
        }),
      ),
      /source_event_binding_digest/u,
    );
    await assert.rejects(
      insertRow(
        client,
        "kitchen_work_queue_projection_generation",
        generation({
          projection_generation_id: id(104),
          generation_status: "Building",
          freshness_status: "Stale",
        }),
      ),
      /kitchen_work_queue_generation_freshness_check/u,
    );
    await assert.rejects(
      insertRow(
        client,
        "kitchen_work_queue_projection_generation",
        generation({
          projection_generation_id: id(105),
          generation_status: "Building",
          as_of_utc: projectedAt,
          projected_at: asOf,
        }),
      ),
      /kitchen_work_queue_generation_freshness_check/u,
    );
    await assert.rejects(
      insertRow(
        client,
        "kitchen_work_queue_projection_generation",
        generation({
          projection_generation_id: id(106),
          generation_status: "Building",
          rebuild_reference: id(107),
        }),
      ),
      /kitchen_work_queue_generation_rebuild_shape_check/u,
    );

    const shadow = generation({
      projection_generation_id: id(110),
      generation_status: "Building",
      source_checkpoint_reference: id(111),
      source_event_binding_digest: sha("6"),
      queue_snapshot_digest: sha("7"),
      ticket_count: 1,
      work_item_count: 1,
      initialized_empty: false,
      projected_at: staleProjectedAt,
      last_rebuilt_at: staleProjectedAt,
      freshness_status: "Stale",
      rebuild_reference: id(112),
      rebuild_request_digest: sha("8"),
      rebuild_requested_at: asOf,
      expected_prior_generation_id: initial.projection_generation_id,
    });
    await insertRow(client, "kitchen_work_queue_projection_generation", shadow);
    const item = queueRow(source, shadow);
    await assert.rejects(
      insertRow(client, "kitchen_work_queue_projection", {
        ...item,
        source_event_semantic_digest: `sha256:${"C".repeat(64)}`,
      }),
      /source_event_semantic_digest/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_queue_projection", {
        ...item,
        source_event_occurred_at: "2026-08-09T13:59:59.999Z",
      }),
      /kitchen_work_queue_projection_time_order_check/u,
    );
    await insertRow(client, "kitchen_work_queue_projection", item);
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_work_queue_projection
         SET status='Held'
         WHERE brand_id=$1 AND store_id=$2
           AND projection_generation_id=$3 AND kitchen_work_item_id=$4`,
        [item.brand_id, item.store_id, item.projection_generation_id, item.kitchen_work_item_id],
      ),
      /kitchen work queue projection row is immutable/u,
    );
    const deletedItem = await client.query(
      `DELETE FROM rms_kitchen.kitchen_work_queue_projection
       WHERE brand_id=$1 AND store_id=$2
         AND projection_generation_id=$3 AND kitchen_work_item_id=$4`,
      [item.brand_id, item.store_id, item.projection_generation_id, item.kitchen_work_item_id],
    );
    assert.equal(deletedItem.rowCount, 0);
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count
           FROM rms_kitchen.kitchen_work_queue_projection
           WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
          [item.brand_id, item.store_id, item.projection_generation_id],
        )
      ).rows[0].count,
      1,
    );
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_work_queue_projection_generation
         SET queue_snapshot_digest=$1
         WHERE brand_id=$2 AND store_id=$3 AND projection_generation_id=$4`,
        [sha("9"), shadow.brand_id, shadow.store_id, shadow.projection_generation_id],
      ),
      /permits only immutable Building to Active to Retired transitions/u,
    );
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_work_queue_projection_generation
         SET generation_status='Retired'
         WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
        [shadow.brand_id, shadow.store_id, shadow.projection_generation_id],
      ),
      /permits only immutable Building to Active to Retired transitions/u,
    );

    await client.query("BEGIN");
    await setLockScope(client, initial.brand_id, initial.store_id);
    await client.query(`SELECT pg_advisory_xact_lock(${lockExpression})`);
    await client.query(
      `UPDATE rms_kitchen.kitchen_work_queue_projection_generation
       SET generation_status='Retired'
       WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
      [initial.brand_id, initial.store_id, initial.projection_generation_id],
    );
    await client.query(
      `UPDATE rms_kitchen.kitchen_work_queue_projection_generation
       SET generation_status='Active'
       WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
      [shadow.brand_id, shadow.store_id, shadow.projection_generation_id],
    );
    const concurrentlyVisible = await contender.query(
      `SELECT projection_generation_id::text
       FROM rms_kitchen.kitchen_work_queue_projection_generation
       WHERE brand_id=$1 AND store_id=$2 AND generation_status='Active'`,
      [initial.brand_id, initial.store_id],
    );
    assert.deepEqual(concurrentlyVisible.rows, [
      { projection_generation_id: initial.projection_generation_id },
    ]);
    await contender.query("BEGIN");
    await setLockScope(contender, initial.brand_id, initial.store_id);
    const contended = await contender.query(
      `SELECT pg_try_advisory_xact_lock(${lockExpression}) AS acquired`,
    );
    assert.equal(contended.rows[0].acquired, false);
    await client.query("ROLLBACK");
    const acquiredAfterRollback = await contender.query(
      `SELECT pg_try_advisory_xact_lock(${lockExpression}) AS acquired`,
    );
    assert.equal(acquiredAfterRollback.rows[0].acquired, true);
    await contender.query("COMMIT");
    assert.deepEqual(
      (
        await client.query(
          `SELECT projection_generation_id::text,generation_status
           FROM rms_kitchen.kitchen_work_queue_projection_generation
           WHERE brand_id=$1 AND store_id=$2
           ORDER BY projection_generation_id`,
          [initial.brand_id, initial.store_id],
        )
      ).rows,
      [
        { projection_generation_id: initial.projection_generation_id, generation_status: "Active" },
        {
          projection_generation_id: shadow.projection_generation_id,
          generation_status: "Building",
        },
      ],
    );

    await client.query("BEGIN");
    await setLockScope(client, initial.brand_id, initial.store_id);
    await client.query(`SELECT pg_advisory_xact_lock(${lockExpression})`);
    await client.query(
      `UPDATE rms_kitchen.kitchen_work_queue_projection_generation
       SET generation_status='Retired'
       WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
      [initial.brand_id, initial.store_id, initial.projection_generation_id],
    );
    await client.query(
      `UPDATE rms_kitchen.kitchen_work_queue_projection_generation
       SET generation_status='Active'
       WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
      [shadow.brand_id, shadow.store_id, shadow.projection_generation_id],
    );
    await client.query("COMMIT");
    assert.deepEqual(
      (
        await client.query(
          `SELECT projection_generation_id::text,generation_status
           FROM rms_kitchen.kitchen_work_queue_projection_generation
           WHERE brand_id=$1 AND store_id=$2
           ORDER BY projection_generation_id`,
          [initial.brand_id, initial.store_id],
        )
      ).rows,
      [
        {
          projection_generation_id: initial.projection_generation_id,
          generation_status: "Retired",
        },
        { projection_generation_id: shadow.projection_generation_id, generation_status: "Active" },
      ],
    );
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_work_queue_projection_generation
         SET generation_status='Building'
         WHERE brand_id=$1 AND store_id=$2 AND projection_generation_id=$3`,
        [shadow.brand_id, shadow.store_id, shadow.projection_generation_id],
      ),
      /permits only immutable Building to Active to Retired transitions/u,
    );
    await assert.rejects(
      insertRow(
        client,
        "kitchen_work_queue_projection_generation",
        generation({
          projection_generation_id: id(113),
          generation_status: "Building",
          rebuild_reference: shadow.rebuild_reference,
          rebuild_request_digest: shadow.rebuild_request_digest,
          rebuild_requested_at: shadow.rebuild_requested_at,
          expected_prior_generation_id: shadow.projection_generation_id,
        }),
      ),
      /kitchen_work_queue_generation_rebuild_reference_unique/u,
    );

    const sibling = generation({
      projection_generation_id: id(120),
      store_id: id(3),
      source_checkpoint_reference: id(121),
    });
    await insertRow(client, "kitchen_work_queue_projection_generation", sibling);

    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(`GRANT USAGE ON SCHEMA rms_kitchen,platform_helpers TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION
         platform_helpers.current_brand_id(),
         platform_helpers.current_store_id(),
         platform_helpers.is_uuid_v7(uuid)
       TO ${role}`,
    );
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE
         rms_kitchen.kitchen_work_queue_projection_generation,
         rms_kitchen.kitchen_work_queue_projection
       TO ${role}`,
    );
    await client.query(`SET ROLE ${role}`);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_queue_projection_generation",
        )
      ).rows[0].count,
      0,
    );
    await client.query("RESET ROLE");

    const ownGenerations = await withScope(client, role, id(1), id(2), () =>
      client.query(
        "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_queue_projection_generation",
      ),
    );
    assert.equal(ownGenerations.rows[0].count, 2);
    const ownRows = await withScope(client, role, id(1), id(2), () =>
      client.query(
        "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_queue_projection",
      ),
    );
    assert.equal(ownRows.rows[0].count, 1);
    const siblingGenerations = await withScope(client, role, id(1), id(3), () =>
      client.query(
        "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_queue_projection_generation",
      ),
    );
    assert.equal(siblingGenerations.rows[0].count, 1);
    const hiddenSibling = await withScope(client, role, id(1), id(2), () =>
      client.query(
        `SELECT count(*)::integer AS count
         FROM rms_kitchen.kitchen_work_queue_projection_generation
         WHERE store_id=$1`,
        [id(3)],
      ),
    );
    assert.equal(hiddenSibling.rows[0].count, 0);
    await assert.rejects(
      withScope(client, role, id(1), id(2), () =>
        insertRow(
          client,
          "kitchen_work_queue_projection_generation",
          generation({
            projection_generation_id: id(122),
            store_id: id(3),
            generation_status: "Building",
            source_checkpoint_reference: id(123),
          }),
        ),
      ),
      /row-level security/u,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await contender.query("ROLLBACK").catch(() => undefined);
    await client.query("RESET ROLE").catch(() => undefined);
    await contender.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await contender.end();
    await client.end();
  }
}

it("enforces the complete Store-scoped Kitchen queue generation projection", async () => {
  await withIsolatedDatabase({ caseId: "kitchen_queue", root }, prove);
}, 180_000);
