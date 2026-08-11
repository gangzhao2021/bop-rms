import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a401-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const confirmedAt = "2026-08-08T14:00:00.000Z";
const evidenceAt = "2026-08-08T13:59:00.000Z";
const planAt = "2026-08-08T14:01:00.000Z";
const createdAt = "2026-08-08T14:02:00.000Z";

async function insertRow(client, table, row) {
  const columns = Object.keys(row);
  const parameters = columns.map((_, index) => `$${index + 1}`).join(",");
  await client.query(
    `INSERT INTO rms_kitchen.${table} (${columns.join(",")}) VALUES (${parameters})`,
    columns.map((column) => row[column]),
  );
}

async function insertRowOnConflictDoNothing(client, table, row) {
  const columns = Object.keys(row);
  const parameters = columns.map((_, index) => `$${index + 1}`).join(",");
  return await client.query(
    `INSERT INTO rms_kitchen.${table} (${columns.join(",")}) VALUES (${parameters})
     ON CONFLICT DO NOTHING`,
    columns.map((column) => row[column]),
  );
}

async function upsertTicket(client, row) {
  const columns = Object.keys(row);
  const parameters = columns.map((_, index) => `$${index + 1}`).join(",");
  return await client.query(
    `INSERT INTO rms_kitchen.kitchen_ticket (${columns.join(",")}) VALUES (${parameters})
     ON CONFLICT (brand_id,store_id,confirmation_id)
     DO UPDATE SET updated_at=EXCLUDED.updated_at
     RETURNING kitchen_ticket_id`,
    columns.map((column) => row[column]),
  );
}

function ticket(overrides = {}) {
  return {
    kitchen_ticket_id: id(1),
    brand_id: id(2),
    store_id: id(3),
    order_id: id(4),
    order_batch_id: id(5),
    confirmation_id: id(6),
    consumer_name: "kitchen.confirmed-order:v1",
    consumer_version: 1,
    source_event_id: id(7),
    source_aggregate_version: 3,
    source_snapshot_digest: sha("a"),
    confirmed_at: confirmedAt,
    correlation_id: id(8),
    semantic_event_binding_digest: sha("b"),
    source_evidence_id: id(9),
    source_evidence_version: 2,
    source_evidence_digest: sha("c"),
    source_evidence_captured_at: evidenceAt,
    work_plan_id: id(10),
    work_plan_version: 4,
    work_plan_digest: sha("d"),
    work_plan_generated_at: planAt,
    aggregate_version: 1,
    status: "Open",
    created_by_actor_type: "System",
    created_by_actor_id: null,
    updated_by_actor_type: "System",
    updated_by_actor_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function workItem(ticketRow, overrides = {}) {
  return {
    kitchen_work_item_id: id(20),
    brand_id: ticketRow.brand_id,
    store_id: ticketRow.store_id,
    kitchen_ticket_id: ticketRow.kitchen_ticket_id,
    order_id: ticketRow.order_id,
    order_batch_id: ticketRow.order_batch_id,
    order_item_id: id(21),
    source_evidence_id: ticketRow.source_evidence_id,
    work_plan_id: ticketRow.work_plan_id,
    source_item_ordinal: 1,
    split_ordinal: 1,
    version: 1,
    status: "Queued",
    required_quantity: 2,
    completed_quantity: 0,
    product_id: id(22),
    product_version_id: id(23),
    sku_id: id(24),
    menu_version_id: id(25),
    localized_display_names_json: JSON.stringify({ "en-CA": "Synthetic noodles" }),
    selected_options_json: JSON.stringify([
      {
        optionReference: id(26),
        quantity: 1,
        localizedNames: { "en-CA": "Synthetic option" },
      },
    ]),
    customer_note: "No onion\nPlease",
    source_line_digest: sha("e"),
    station_id: id(27),
    routing_rule_id: id(28),
    routing_rule_version: 2,
    routing_rule_digest: sha("f"),
    preparation_id: id(29),
    preparation_version: 5,
    preparation_digest: sha("1"),
    preparation_instructions_json: JSON.stringify(["Boil synthetic noodles", "Plate safely"]),
    execution_snapshot_digest: sha("2"),
    created_by_actor_type: "System",
    created_by_actor_id: null,
    updated_by_actor_type: "System",
    updated_by_actor_id: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

function action(ticketRow, overrides = {}) {
  return {
    kitchen_action_record_id: id(30),
    brand_id: ticketRow.brand_id,
    store_id: ticketRow.store_id,
    kitchen_ticket_id: ticketRow.kitchen_ticket_id,
    source_event_id: ticketRow.source_event_id,
    work_plan_id: ticketRow.work_plan_id,
    correlation_id: ticketRow.correlation_id,
    action_version: 1,
    action_code: "KITCHEN_TICKET_CREATED",
    purpose: "CREATE_KITCHEN_TICKET",
    reason_code: "ORDER_CONFIRMED",
    actor_type: "System",
    actor_id: null,
    source_channel: "EVENT_CONSUMER",
    data_classification: "Restricted",
    work_item_count: 1,
    effect_digest: sha("3"),
    occurred_at: createdAt,
    ...overrides,
  };
}

function independentTicket(seed, overrides = {}) {
  return ticket({
    kitchen_ticket_id: id(seed),
    order_id: id(seed + 1),
    order_batch_id: id(seed + 2),
    confirmation_id: id(seed + 3),
    source_event_id: id(seed + 4),
    correlation_id: id(seed + 5),
    source_evidence_id: id(seed + 6),
    work_plan_id: id(seed + 7),
    ...overrides,
  });
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

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp1401_${context.runId}`;
  await client.connect();
  try {
    const inventory = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='rms_kitchen' AND table_type='BASE TABLE'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      inventory.rows.map((row) => row.table_name),
      [
        "kitchen_action_record",
        "kitchen_order_item_ready_result",
        "kitchen_ticket",
        "kitchen_work_item",
        "kitchen_work_lifecycle_operation",
        "kitchen_work_queue_projection",
        "kitchen_work_queue_projection_generation",
      ],
    );
    const migrationCount = await client.query(
      "SELECT count(*)::integer AS count FROM platform_core.migration_history",
    );
    assert.equal(migrationCount.rows[0].count, 49);

    const forced = await client.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_kitchen.kitchen_action_record'::regclass,
         'rms_kitchen.kitchen_order_item_ready_result'::regclass,
         'rms_kitchen.kitchen_ticket'::regclass,
         'rms_kitchen.kitchen_work_item'::regclass,
         'rms_kitchen.kitchen_work_lifecycle_operation'::regclass,
         'rms_kitchen.kitchen_work_queue_projection'::regclass,
         'rms_kitchen.kitchen_work_queue_projection_generation'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 7);
    assert.equal(
      forced.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );
    const updateTriggers = await client.query(
      `SELECT event_object_table,trigger_name
       FROM information_schema.triggers
       WHERE trigger_schema='rms_kitchen' AND event_manipulation='UPDATE'
       ORDER BY event_object_table,trigger_name`,
    );
    assert.deepEqual(updateTriggers.rows, [
      {
        event_object_table: "kitchen_action_record",
        trigger_name: "kitchen_action_record_no_update_trigger",
      },
      {
        event_object_table: "kitchen_order_item_ready_result",
        trigger_name: "kitchen_order_item_ready_result_no_update_trigger",
      },
      {
        event_object_table: "kitchen_ticket",
        trigger_name: "kitchen_ticket_immutable_fields_trigger",
      },
      {
        event_object_table: "kitchen_work_item",
        trigger_name: "kitchen_work_item_immutable_fields_trigger",
      },
      {
        event_object_table: "kitchen_work_lifecycle_operation",
        trigger_name: "kitchen_work_lifecycle_operation_no_update_trigger",
      },
      {
        event_object_table: "kitchen_work_queue_projection",
        trigger_name: "kitchen_work_queue_projection_no_update_trigger",
      },
      {
        event_object_table: "kitchen_work_queue_projection_generation",
        trigger_name: "kitchen_work_queue_generation_transition_trigger",
      },
    ]);
    const updateRules = await client.query(
      `SELECT class.relname,rewrite.rulename
       FROM pg_rewrite AS rewrite
       JOIN pg_class AS class ON class.oid=rewrite.ev_class
       JOIN pg_namespace AS namespace ON namespace.oid=class.relnamespace
       WHERE namespace.nspname='rms_kitchen' AND rewrite.ev_type='2'
       ORDER BY class.relname,rewrite.rulename`,
    );
    assert.deepEqual(updateRules.rows, []);
    const triggerFunctions = await client.query(
      `SELECT proname,prosecdef,proconfig
       FROM pg_proc WHERE pronamespace='rms_kitchen'::regnamespace
       ORDER BY proname`,
    );
    assert.deepEqual(triggerFunctions.rows, [
      {
        proname: "enforce_kitchen_ticket_immutable_fields",
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
      },
      {
        proname: "enforce_kitchen_work_item_immutable_fields",
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
      },
      {
        proname: "enforce_kitchen_work_queue_generation_transition",
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
      },
      {
        proname: "reject_kitchen_action_record_update",
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
      },
      {
        proname: "reject_kitchen_work_lifecycle_append_only_update",
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
      },
      {
        proname: "reject_kitchen_work_queue_projection_update",
        prosecdef: false,
        proconfig: ["search_path=pg_catalog"],
      },
    ]);
    const publicRoutineGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.routine_privileges
       WHERE routine_schema='rms_kitchen' AND grantee='PUBLIC'`,
    );
    assert.equal(publicRoutineGrants.rows[0].count, 0);

    const foreignTargets = await client.query(
      `SELECT DISTINCT confrelid::regclass::text AS target
       FROM pg_constraint
       WHERE contype='f' AND connamespace='rms_kitchen'::regnamespace
       ORDER BY target`,
    );
    assert.deepEqual(foreignTargets.rows, [
      { target: "rms_kitchen.kitchen_ticket" },
      { target: "rms_kitchen.kitchen_work_item" },
      { target: "rms_kitchen.kitchen_work_lifecycle_operation" },
      { target: "rms_kitchen.kitchen_work_queue_projection_generation" },
    ]);
    const indexes = await client.query(
      `SELECT indexname,indexdef FROM pg_indexes
       WHERE schemaname='rms_kitchen' ORDER BY indexname`,
    );
    assert.equal(indexes.rows.length >= 22, true);
    assert.equal(
      indexes.rows.every(
        (row) =>
          row.indexdef.includes("(brand_id, store_id") ||
          row.indexdef.includes("(brand_id DESC, store_id"),
      ),
      true,
    );

    const first = ticket();
    const firstItem = workItem(first);
    const firstAction = action(first);
    await client.query("BEGIN");
    await insertRow(client, "kitchen_ticket", first);
    await insertRow(client, "kitchen_work_item", firstItem);
    await insertRow(client, "kitchen_action_record", firstAction);
    await client.query("COMMIT");

    const reconstructed = await client.query(
      `SELECT consumer_name,consumer_version,source_event_id::text,brand_id::text,store_id::text,
        order_id::text,order_batch_id::text,confirmation_id::text,source_aggregate_version::text,
        source_snapshot_digest,confirmed_at,correlation_id::text,semantic_event_binding_digest,
        source_evidence_id::text,source_evidence_version,source_evidence_digest,
        source_evidence_captured_at,work_plan_id::text,work_plan_version,work_plan_digest,
        work_plan_generated_at,aggregate_version::text,status
       FROM rms_kitchen.kitchen_ticket
       WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3`,
      [first.brand_id, first.store_id, first.kitchen_ticket_id],
    );
    assert.deepEqual(reconstructed.rows, [
      {
        consumer_name: first.consumer_name,
        consumer_version: 1,
        source_event_id: first.source_event_id,
        brand_id: first.brand_id,
        store_id: first.store_id,
        order_id: first.order_id,
        order_batch_id: first.order_batch_id,
        confirmation_id: first.confirmation_id,
        source_aggregate_version: "3",
        source_snapshot_digest: first.source_snapshot_digest,
        confirmed_at: new Date(confirmedAt),
        correlation_id: first.correlation_id,
        semantic_event_binding_digest: first.semantic_event_binding_digest,
        source_evidence_id: first.source_evidence_id,
        source_evidence_version: 2,
        source_evidence_digest: first.source_evidence_digest,
        source_evidence_captured_at: new Date(evidenceAt),
        work_plan_id: first.work_plan_id,
        work_plan_version: 4,
        work_plan_digest: first.work_plan_digest,
        work_plan_generated_at: new Date(planAt),
        aggregate_version: "1",
        status: "Open",
      },
    ]);
    const reconstructedAction = await client.query(
      `SELECT actor_type,actor_id::text,source_channel,data_classification
       FROM rms_kitchen.kitchen_action_record
       WHERE brand_id=$1 AND store_id=$2 AND kitchen_action_record_id=$3`,
      [first.brand_id, first.store_id, firstAction.kitchen_action_record_id],
    );
    assert.deepEqual(reconstructedAction.rows, [
      {
        actor_type: "System",
        actor_id: null,
        source_channel: "EVENT_CONSUMER",
        data_classification: "Restricted",
      },
    ]);
    assert.equal(
      (await insertRowOnConflictDoNothing(client, "kitchen_action_record", firstAction)).rowCount,
      0,
    );

    const otherScope = ticket({ brand_id: id(102), store_id: id(103) });
    await insertRow(client, "kitchen_ticket", otherScope);
    await insertRow(client, "kitchen_work_item", workItem(otherScope));
    await insertRow(client, "kitchen_action_record", action(otherScope));
    const siblingStoreScope = ticket({ store_id: id(105) });
    await insertRow(client, "kitchen_ticket", siblingStoreScope);
    await insertRow(client, "kitchen_work_item", workItem(siblingStoreScope));
    await insertRow(client, "kitchen_action_record", action(siblingStoreScope));

    const publicGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_kitchen' AND grantee='PUBLIC'`,
    );
    assert.equal(publicGrants.rows[0].count, 0);
    const publicSchemaGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.usage_privileges
       WHERE object_schema='rms_kitchen' AND grantee='PUBLIC'`,
    );
    assert.equal(publicSchemaGrants.rows[0].count, 0);

    await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await client.query(`GRANT USAGE ON SCHEMA rms_kitchen,platform_helpers TO ${role}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION
         platform_helpers.current_brand_id(),
         platform_helpers.current_store_id(),
         platform_helpers.is_uuid_v7(uuid)
       TO ${role}`,
    );
    await client.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA rms_kitchen TO ${role}`);

    await client.query(`SET ROLE ${role}`);
    assert.equal(
      (await client.query("SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_ticket"))
        .rows[0].count,
      0,
    );
    await client.query("RESET ROLE");

    const ownCount = await withScope(client, role, first.brand_id, first.store_id, async () =>
      client.query("SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_ticket"),
    );
    assert.equal(ownCount.rows[0].count, 1);
    const otherCount = await withScope(client, role, otherScope.brand_id, otherScope.store_id, () =>
      client.query("SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_ticket"),
    );
    assert.equal(otherCount.rows[0].count, 1);
    const siblingStoreCount = await withScope(
      client,
      role,
      siblingStoreScope.brand_id,
      siblingStoreScope.store_id,
      () => client.query("SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_ticket"),
    );
    assert.equal(siblingStoreCount.rows[0].count, 1);
    const wrongStoreCount = await withScope(client, role, first.brand_id, id(104), () =>
      client.query("SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_ticket"),
    );
    assert.equal(wrongStoreCount.rows[0].count, 0);
    const ownUpsert = await withScope(client, role, first.brand_id, first.store_id, () =>
      upsertTicket(client, first),
    );
    assert.deepEqual(ownUpsert.rows, [{ kitchen_ticket_id: first.kitchen_ticket_id }]);
    const ownActionConflict = await withScope(client, role, first.brand_id, first.store_id, () =>
      insertRowOnConflictDoNothing(client, "kitchen_action_record", firstAction),
    );
    assert.equal(ownActionConflict.rowCount, 0);

    await assert.rejects(
      withScope(client, role, "not-a-uuid", first.store_id, () =>
        client.query("SELECT * FROM rms_kitchen.kitchen_ticket"),
      ),
      /invalid input syntax for type uuid/u,
    );
    await assert.rejects(
      withScope(client, role, first.brand_id, first.store_id, () =>
        insertRow(
          client,
          "kitchen_ticket",
          independentTicket(200, {
            brand_id: otherScope.brand_id,
            store_id: otherScope.store_id,
          }),
        ),
      ),
      /row-level security/u,
    );
    await assert.rejects(
      withScope(client, role, first.brand_id, first.store_id, () =>
        insertRow(client, "kitchen_ticket", otherScope),
      ),
      /row-level security/u,
    );
    await assert.rejects(
      withScope(client, role, first.brand_id, first.store_id, () =>
        upsertTicket(client, otherScope),
      ),
      /row-level security/u,
    );
    await assert.rejects(
      withScope(client, role, first.brand_id, first.store_id, () =>
        insertRowOnConflictDoNothing(client, "kitchen_ticket", otherScope),
      ),
      /row-level security/u,
    );
    await assert.rejects(
      withScope(client, role, first.brand_id, first.store_id, () =>
        insertRowOnConflictDoNothing(client, "kitchen_action_record", action(otherScope)),
      ),
      /row-level security/u,
    );
    const hiddenUpdate = await withScope(client, role, first.brand_id, first.store_id, () =>
      client.query(
        `UPDATE rms_kitchen.kitchen_ticket SET aggregate_version=aggregate_version+1
         WHERE brand_id=$1 AND store_id=$2 RETURNING kitchen_ticket_id`,
        [otherScope.brand_id, otherScope.store_id],
      ),
    );
    assert.equal(hiddenUpdate.rowCount, 0);

    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_work_item
         SET station_id=$1 WHERE brand_id=$2 AND store_id=$3 AND kitchen_work_item_id=$4`,
        [id(31), first.brand_id, first.store_id, firstItem.kitchen_work_item_id],
      ),
      /kitchen work item immutable fields cannot be changed/u,
    );
    assert.equal(
      (
        await client.query(
          `SELECT station_id::text FROM rms_kitchen.kitchen_work_item
           WHERE brand_id=$1 AND store_id=$2 AND kitchen_work_item_id=$3`,
          [first.brand_id, first.store_id, firstItem.kitchen_work_item_id],
        )
      ).rows[0].station_id,
      firstItem.station_id,
    );
    await client.query(
      `UPDATE rms_kitchen.kitchen_work_item
       SET version=2,status='Held',completed_quantity=1,updated_by_actor_type='User',
         updated_by_actor_id=$1,updated_at=$2
       WHERE brand_id=$3 AND store_id=$4 AND kitchen_work_item_id=$5`,
      [
        id(310),
        "2026-08-08T14:03:00.000Z",
        first.brand_id,
        first.store_id,
        firstItem.kitchen_work_item_id,
      ],
    );
    const transitioned = await client.query(
      `SELECT version::text,status,completed_quantity FROM rms_kitchen.kitchen_work_item
       WHERE brand_id=$1 AND store_id=$2 AND kitchen_work_item_id=$3`,
      [first.brand_id, first.store_id, firstItem.kitchen_work_item_id],
    );
    assert.deepEqual(transitioned.rows, [{ version: "2", status: "Held", completed_quantity: 1 }]);
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_ticket
         SET work_plan_digest=$1
         WHERE brand_id=$2 AND store_id=$3 AND kitchen_ticket_id=$4`,
        [sha("9"), first.brand_id, first.store_id, first.kitchen_ticket_id],
      ),
      /kitchen ticket immutable fields cannot be changed/u,
    );
    await client.query(
      `UPDATE rms_kitchen.kitchen_ticket
       SET aggregate_version=2,updated_by_actor_type='Service',updated_by_actor_id=$1,updated_at=$2
       WHERE brand_id=$3 AND store_id=$4 AND kitchen_ticket_id=$5`,
      [
        id(311),
        "2026-08-08T14:03:00.000Z",
        first.brand_id,
        first.store_id,
        first.kitchen_ticket_id,
      ],
    );
    assert.equal(
      (
        await client.query(
          `SELECT aggregate_version::text FROM rms_kitchen.kitchen_ticket
           WHERE brand_id=$1 AND store_id=$2 AND kitchen_ticket_id=$3`,
          [first.brand_id, first.store_id, first.kitchen_ticket_id],
        )
      ).rows[0].aggregate_version,
      "2",
    );
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_action_record SET work_item_count=2
         WHERE brand_id=$1 AND store_id=$2 AND kitchen_action_record_id=$3`,
        [first.brand_id, first.store_id, firstAction.kitchen_action_record_id],
      ),
      /kitchen action record is append-only/u,
    );
    assert.equal(
      (
        await client.query(
          `SELECT work_item_count FROM rms_kitchen.kitchen_action_record
           WHERE brand_id=$1 AND store_id=$2 AND kitchen_action_record_id=$3`,
          [first.brand_id, first.store_id, firstAction.kitchen_action_record_id],
        )
      ).rows[0].work_item_count,
      1,
    );
    await client.query(
      `DELETE FROM rms_kitchen.kitchen_action_record
       WHERE brand_id=$1 AND store_id=$2 AND kitchen_action_record_id=$3`,
      [first.brand_id, first.store_id, firstAction.kitchen_action_record_id],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_action_record
           WHERE brand_id=$1 AND store_id=$2 AND kitchen_action_record_id=$3`,
          [first.brand_id, first.store_id, firstAction.kitchen_action_record_id],
        )
      ).rows[0].count,
      1,
    );
    await client.query(
      `DELETE FROM rms_kitchen.kitchen_work_item
       WHERE brand_id=$1 AND store_id=$2 AND kitchen_work_item_id=$3`,
      [first.brand_id, first.store_id, firstItem.kitchen_work_item_id],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_item
           WHERE brand_id=$1 AND store_id=$2 AND kitchen_work_item_id=$3`,
          [first.brand_id, first.store_id, firstItem.kitchen_work_item_id],
        )
      ).rows[0].count,
      1,
    );

    for (const [offset, note] of [
      [0, "x".repeat(240)],
      [1, "a\nb\nc\nd"],
    ]) {
      await client.query("BEGIN");
      await insertRow(
        client,
        "kitchen_work_item",
        workItem(first, {
          kitchen_work_item_id: id(40 + offset),
          order_item_id: id(50 + offset),
          source_item_ordinal: 2,
          customer_note: note,
        }),
      );
      const exactNote = await client.query(
        `SELECT customer_note FROM rms_kitchen.kitchen_work_item
         WHERE brand_id=$1 AND store_id=$2 AND kitchen_work_item_id=$3`,
        [first.brand_id, first.store_id, id(40 + offset)],
      );
      assert.equal(exactNote.rows[0].customer_note, note);
      await client.query("ROLLBACK");
    }
    for (const [offset, note] of [
      [0, "x".repeat(241)],
      [1, "a\nb\nc\nd\ne"],
      [2, "tab\tnote"],
      [3, "carriage\rreturn"],
      [4, `bidi${String.fromCodePoint(0x202e)}note`],
      [5, `c1${String.fromCodePoint(0x85)}note`],
    ])
      await assert.rejects(
        insertRow(
          client,
          "kitchen_work_item",
          workItem(first, {
            kitchen_work_item_id: id(60 + offset),
            order_item_id: id(70 + offset),
            source_item_ordinal: 2,
            customer_note: note,
          }),
        ),
        /kitchen_work_item_customer_note_check/u,
      );

    for (const [offset, override] of [
      [0, { station_id: null }],
      [1, { routing_rule_id: null }],
      [2, { routing_rule_version: 0 }],
      [3, { preparation_id: null }],
      [4, { preparation_version: 0 }],
      [5, { preparation_instructions_json: JSON.stringify([]) }],
      [6, { preparation_instructions_json: JSON.stringify(Array(33).fill("Synthetic")) }],
      [7, { localized_display_names_json: JSON.stringify({}) }],
      [8, { selected_options_json: JSON.stringify({}) }],
      [9, { required_quantity: 0 }],
      [10, { completed_quantity: 3 }],
      [11, { status: "Ready" }],
      [12, { updated_by_actor_type: "User", updated_by_actor_id: null }],
    ])
      await assert.rejects(
        insertRow(
          client,
          "kitchen_work_item",
          workItem(first, {
            kitchen_work_item_id: id(80 + offset),
            order_item_id: id(100 + offset),
            source_item_ordinal: 2,
            ...override,
          }),
        ),
        /violates (?:check|not-null) constraint/u,
      );

    await assert.rejects(
      insertRow(
        client,
        "kitchen_ticket",
        independentTicket(160, {
          source_evidence_captured_at: "2026-08-08T14:00:01.000Z",
        }),
      ),
      /kitchen_ticket_time_order_check/u,
    );

    for (const [offset, override] of [
      [0, { actor_type: "User" }],
      [1, { actor_id: id(170) }],
      [2, { source_channel: "HTTP" }],
      [3, { data_classification: "Internal" }],
    ])
      await assert.rejects(
        insertRow(
          client,
          "kitchen_action_record",
          action(first, {
            kitchen_action_record_id: id(171 + offset),
            ...override,
          }),
        ),
        /violates check constraint/u,
      );

    await assert.rejects(
      insertRow(
        client,
        "kitchen_work_item",
        workItem(first, {
          kitchen_work_item_id: id(120),
          order_item_id: id(121),
          source_item_ordinal: 2,
          order_id: id(122),
        }),
      ),
      /kitchen_work_item_ticket_fk/u,
    );

    const rolledBack = independentTicket(140);
    await client.query("BEGIN");
    try {
      await insertRow(client, "kitchen_ticket", rolledBack);
      await insertRow(
        client,
        "kitchen_work_item",
        workItem(rolledBack, {
          kitchen_work_item_id: id(148),
          order_item_id: id(149),
        }),
      );
      await insertRow(
        client,
        "kitchen_action_record",
        action(rolledBack, {
          kitchen_action_record_id: firstAction.kitchen_action_record_id,
        }),
      );
      assert.fail("synthetic duplicate action did not fail");
    } catch (error) {
      assert.match(String(error), /kitchen_action_record_pkey/u);
      await client.query("ROLLBACK");
    }
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_ticket WHERE kitchen_ticket_id=$1",
          [rolledBack.kitchen_ticket_id],
        )
      ).rows[0].count,
      0,
    );

    const prohibitedColumns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='rms_kitchen'
         AND column_name ~ '(amount|currency|price|tax|payment|provider|customer_id|guest|allergen)'
       ORDER BY column_name`,
    );
    assert.deepEqual(prohibitedColumns.rows, []);
  } finally {
    await client.query("RESET ROLE").catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("persists the scoped immutable Kitchen Ticket aggregate and exact execution snapshot", async () => {
  await withIsolatedDatabase({ caseId: "kitchen_ticket", root }, prove);
}, 180_000);
