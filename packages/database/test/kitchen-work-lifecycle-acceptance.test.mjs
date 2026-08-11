import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a404-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const createdAt = "2026-08-09T14:00:00.000Z";
const acceptedAt = "2026-08-09T14:03:00.000Z";
const startedAt = "2026-08-09T14:04:00.000Z";
const progressAt = "2026-08-09T14:05:00.000Z";
const completedAt = "2026-08-09T14:06:00.000Z";
const readyAt = "2026-08-09T14:07:00.000Z";

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

function source(seed, storeId = id(2)) {
  return {
    brandId: id(1),
    storeId,
    ticketId: id(seed),
    workItemId: id(seed + 1),
    orderId: id(seed + 2),
    orderBatchId: id(seed + 3),
    orderItemId: id(seed + 4),
    confirmationId: id(seed + 5),
    sourceEventId: id(seed + 6),
    correlationId: id(seed + 7),
    sourceEvidenceId: id(seed + 8),
    workPlanId: id(seed + 9),
  };
}

async function seedSource(client, value) {
  await insertRow(client, "kitchen_ticket", {
    kitchen_ticket_id: value.ticketId,
    brand_id: value.brandId,
    store_id: value.storeId,
    order_id: value.orderId,
    order_batch_id: value.orderBatchId,
    confirmation_id: value.confirmationId,
    consumer_name: "kitchen.confirmed-order:v1",
    consumer_version: 1,
    source_event_id: value.sourceEventId,
    source_aggregate_version: 1,
    source_snapshot_digest: sha("1"),
    confirmed_at: createdAt,
    correlation_id: value.correlationId,
    semantic_event_binding_digest: sha("2"),
    source_evidence_id: value.sourceEvidenceId,
    source_evidence_version: 1,
    source_evidence_digest: sha("3"),
    source_evidence_captured_at: createdAt,
    work_plan_id: value.workPlanId,
    work_plan_version: 1,
    work_plan_digest: sha("4"),
    work_plan_generated_at: createdAt,
    aggregate_version: 1,
    status: "Open",
    created_by_actor_type: "System",
    updated_by_actor_type: "System",
    created_at: createdAt,
    updated_at: createdAt,
  });
  await insertRow(client, "kitchen_work_item", {
    kitchen_work_item_id: value.workItemId,
    brand_id: value.brandId,
    store_id: value.storeId,
    kitchen_ticket_id: value.ticketId,
    order_id: value.orderId,
    order_batch_id: value.orderBatchId,
    order_item_id: value.orderItemId,
    source_evidence_id: value.sourceEvidenceId,
    work_plan_id: value.workPlanId,
    source_item_ordinal: 1,
    split_ordinal: 1,
    version: 1,
    status: "Queued",
    required_quantity: 2,
    completed_quantity: 0,
    product_id: id(700),
    product_version_id: id(701),
    sku_id: id(702),
    menu_version_id: id(703),
    localized_display_names_json: JSON.stringify({ "en-CA": "Synthetic lifecycle item" }),
    selected_options_json: JSON.stringify([]),
    source_line_digest: sha("5"),
    station_id: id(704),
    routing_rule_id: id(705),
    routing_rule_version: 1,
    routing_rule_digest: sha("6"),
    preparation_id: id(706),
    preparation_version: 1,
    preparation_digest: sha("7"),
    preparation_instructions_json: JSON.stringify(["Synthetic preparation"]),
    execution_snapshot_digest: sha("8"),
    created_by_actor_type: "System",
    updated_by_actor_type: "System",
    created_at: createdAt,
    updated_at: createdAt,
  });
}

function acceptOperation(value, operationId, key, overrides = {}) {
  return {
    kitchen_work_lifecycle_operation_id: operationId,
    brand_id: value.brandId,
    store_id: value.storeId,
    kitchen_ticket_id: value.ticketId,
    kitchen_work_item_id: value.workItemId,
    order_item_id: value.orderItemId,
    idempotency_key: key,
    action_code: "KITCHEN_WORK_ITEM_ACCEPTED",
    purpose: "KitchenWorkExecution",
    reason_code: "WORK_ITEM_ACCEPTED",
    outcome: "Accepted",
    actor_type: "User",
    actor_id: id(30),
    source_channel: "KDS_COMMAND",
    data_classification: "Confidential",
    intent_digest: sha("9"),
    effect_digest: sha("a"),
    expected_ticket_version: 1,
    result_ticket_version: 2,
    expected_work_item_version: 1,
    result_work_item_version: 2,
    before_work_item_status: "Queued",
    after_work_item_status: "Queued",
    completed_quantity: 0,
    required_quantity: 2,
    audit_id: id(31),
    audit_semantic_digest: sha("b"),
    outbox_event_id: id(32),
    event_semantic_digest: sha("c"),
    correlation_id: id(33),
    occurred_at: acceptedAt,
    replay_expires_at: "2026-09-08T14:03:00.000Z",
    ...overrides,
  };
}

function startOperation(value, accept, overrides = {}) {
  return acceptOperation(value, id(40), "start-operation-0001", {
    action_code: "KITCHEN_WORK_ITEM_STARTED",
    reason_code: "WORK_ITEM_STARTED",
    outcome: "Started",
    expected_ticket_version: 2,
    result_ticket_version: 3,
    expected_work_item_version: 2,
    result_work_item_version: 3,
    after_work_item_status: "In Progress",
    accepted_operation_id: accept.kitchen_work_lifecycle_operation_id,
    admission_decision_id: id(41),
    admission_decision_version: 1,
    admission_decision_digest: sha("d"),
    admission_producer_contract_version: 1,
    admission_outcome: "Allowed",
    admission_evaluated_at: acceptedAt,
    admission_valid_until: "2026-08-09T14:10:00.000Z",
    audit_id: id(42),
    audit_semantic_digest: sha("e"),
    outbox_event_id: id(43),
    event_semantic_digest: sha("f"),
    correlation_id: id(44),
    occurred_at: startedAt,
    replay_expires_at: "2026-09-08T14:04:00.000Z",
    ...overrides,
  });
}

function progressOperation(value, accept, start, overrides = {}) {
  return acceptOperation(value, id(50), "progress-operation-0001", {
    action_code: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED",
    reason_code: "COMPLETION_QUANTITY_RECORDED",
    outcome: "ProgressRecorded",
    expected_ticket_version: 3,
    result_ticket_version: 4,
    expected_work_item_version: 3,
    result_work_item_version: 4,
    before_work_item_status: "In Progress",
    after_work_item_status: "In Progress",
    quantity_delta: 1,
    completed_quantity: 1,
    accepted_operation_id: accept.kitchen_work_lifecycle_operation_id,
    started_operation_id: start.kitchen_work_lifecycle_operation_id,
    audit_id: id(51),
    audit_semantic_digest: sha("1"),
    outbox_event_id: id(52),
    event_semantic_digest: sha("2"),
    correlation_id: id(53),
    occurred_at: progressAt,
    replay_expires_at: "2026-09-08T14:05:00.000Z",
    ...overrides,
  });
}

function completeOperation(value, accept, start, overrides = {}) {
  const operationId = id(60);
  return acceptOperation(value, operationId, "complete-operation-0001", {
    action_code: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED",
    reason_code: "COMPLETION_QUANTITY_RECORDED",
    outcome: "Completed",
    expected_ticket_version: 4,
    result_ticket_version: 5,
    expected_work_item_version: 4,
    result_work_item_version: 5,
    before_work_item_status: "In Progress",
    after_work_item_status: "Completed",
    quantity_delta: 1,
    completed_quantity: 2,
    accepted_operation_id: accept.kitchen_work_lifecycle_operation_id,
    started_operation_id: start.kitchen_work_lifecycle_operation_id,
    expo_source_operation_id: operationId,
    expo_source_action_code: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED",
    expo_source_expected_ticket_version: 4,
    expo_source_result_ticket_version: 5,
    expo_source_expected_work_item_version: 4,
    expo_source_result_work_item_version: 5,
    expo_source_before_status: "In Progress",
    expo_source_after_status: "Completed",
    expo_source_completed_quantity: 2,
    expo_source_required_quantity: 2,
    expo_source_outcome: "Completed",
    expo_source_occurred_at: completedAt,
    captured_expo_binding_digest: sha("3"),
    expo_decision_id: id(61),
    expo_decision_version: 1,
    expo_decision_digest: sha("4"),
    expo_producer_contract_version: 1,
    expo_decision_purpose: "KitchenReadiness",
    expo_mode: "Enabled",
    expo_evaluated_at: progressAt,
    expo_valid_until: "2026-08-09T14:12:00.000Z",
    audit_id: id(62),
    audit_semantic_digest: sha("5"),
    outbox_event_id: id(63),
    event_semantic_digest: sha("6"),
    correlation_id: id(64),
    occurred_at: completedAt,
    replay_expires_at: "2026-09-08T14:06:00.000Z",
    ...overrides,
  });
}

function manualReadyOperation(value, complete, overrides = {}) {
  return acceptOperation(value, id(70), "manual-ready-operation-0001", {
    kitchen_work_item_id: null,
    action_code: "KITCHEN_ORDER_ITEM_READY",
    purpose: "KitchenExpoCoordination",
    reason_code: "EXPO_MARKED_READY",
    outcome: "OrderItemReady",
    expected_ticket_version: 5,
    result_ticket_version: 6,
    expected_work_item_version: 5,
    result_work_item_version: 5,
    before_work_item_status: "Completed",
    after_work_item_status: "Completed",
    completed_quantity: 2,
    ready_result_id: id(80),
    expo_source_operation_id: complete.kitchen_work_lifecycle_operation_id,
    expo_source_action_code: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED",
    expo_source_expected_ticket_version: 4,
    expo_source_result_ticket_version: 5,
    expo_source_expected_work_item_version: 4,
    expo_source_result_work_item_version: 5,
    expo_source_before_status: "In Progress",
    expo_source_after_status: "Completed",
    expo_source_completed_quantity: 2,
    expo_source_required_quantity: 2,
    expo_source_outcome: "Completed",
    expo_source_occurred_at: completedAt,
    captured_expo_binding_digest: sha("3"),
    expo_decision_id: id(61),
    expo_decision_version: 1,
    expo_decision_digest: sha("4"),
    expo_producer_contract_version: 1,
    expo_decision_purpose: "KitchenReadiness",
    expo_mode: "Enabled",
    expo_evaluated_at: progressAt,
    expo_valid_until: "2026-08-09T14:12:00.000Z",
    audit_id: id(71),
    audit_semantic_digest: sha("7"),
    outbox_event_id: null,
    event_semantic_digest: null,
    correlation_id: id(72),
    occurred_at: readyAt,
    replay_expires_at: "2026-09-08T14:07:00.000Z",
    ...overrides,
  });
}

function readyResult(value, ready, complete, overrides = {}) {
  return {
    ready_result_id: ready.ready_result_id,
    brand_id: value.brandId,
    store_id: value.storeId,
    kitchen_ticket_id: value.ticketId,
    order_item_id: value.orderItemId,
    causal_operation_id: ready.kitchen_work_lifecycle_operation_id,
    actor_type: ready.actor_type,
    actor_id: ready.actor_id,
    work_items_json: JSON.stringify([
      { workItemReference: value.workItemId, workItemVersion: "5" },
    ]),
    work_items_digest: sha("8"),
    ready_quantity: 2,
    required_quantity: 2,
    expo_source_operation_id: complete.kitchen_work_lifecycle_operation_id,
    expo_source_action_code: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED",
    expo_source_expected_ticket_version: 4,
    expo_source_result_ticket_version: 5,
    expo_source_expected_work_item_version: 4,
    expo_source_result_work_item_version: 5,
    expo_source_before_status: "In Progress",
    expo_source_after_status: "Completed",
    expo_source_completed_quantity: 2,
    expo_source_required_quantity: 2,
    expo_source_outcome: complete.outcome,
    expo_source_occurred_at: complete.occurred_at,
    captured_expo_binding_digest: complete.captured_expo_binding_digest,
    expo_decision_id: complete.expo_decision_id,
    expo_decision_version: complete.expo_decision_version,
    expo_decision_digest: complete.expo_decision_digest,
    expo_producer_contract_version: 1,
    expo_decision_purpose: "KitchenReadiness",
    expo_mode: complete.expo_mode,
    expo_evaluated_at: complete.expo_evaluated_at,
    expo_valid_until: complete.expo_valid_until,
    ready_at: ready.occurred_at,
    ...overrides,
  };
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  const role = `bop_wp1404_${context.runId}`;
  await client.connect();
  try {
    const tables = ["kitchen_order_item_ready_result", "kitchen_work_lifecycle_operation"];
    const inventory = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='rms_kitchen' AND table_name=ANY($1::text[])
       ORDER BY table_name`,
      [tables],
    );
    assert.deepEqual(
      inventory.rows.map((row) => row.table_name),
      tables,
    );
    const forced = await client.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_kitchen.kitchen_order_item_ready_result'::regclass,
         'rms_kitchen.kitchen_work_lifecycle_operation'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 2);
    assert.equal(
      forced.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      true,
    );
    const publicGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_kitchen' AND table_name=ANY($1::text[]) AND grantee='PUBLIC'`,
      [tables],
    );
    assert.equal(publicGrants.rows[0].count, 0);
    const columns = await client.query(
      `SELECT table_name,column_name FROM information_schema.columns
       WHERE table_schema='rms_kitchen' AND table_name=ANY($1::text[])
       ORDER BY table_name,ordinal_position`,
      [tables],
    );
    for (const required of [
      "idempotency_key",
      "intent_digest",
      "effect_digest",
      "replay_expires_at",
      "work_items_json",
      "work_items_digest",
      "ready_quantity",
      "required_quantity",
    ])
      assert.equal(
        columns.rows.some((row) => row.column_name === required),
        true,
      );
    assert.equal(
      columns.rows.some((row) =>
        /customer|note|allergen|health|payment|provider|display/u.test(row.column_name),
      ),
      false,
    );
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
         CASE WHEN constraint_row.contype='f' THEN ARRAY(
           SELECT attribute.attname::text
           FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum,position)
           JOIN pg_attribute AS attribute
             ON attribute.attrelid=constraint_row.confrelid
            AND attribute.attnum=key.attnum
           ORDER BY key.position
         ) ELSE ARRAY[]::text[] END AS referenced_columns,
         CASE WHEN constraint_row.contype='f'
           THEN constraint_row.confrelid::regclass::text ELSE NULL END AS target
       FROM pg_constraint AS constraint_row
       WHERE constraint_row.conrelid IN (
         'rms_kitchen.kitchen_order_item_ready_result'::regclass,
         'rms_kitchen.kitchen_work_lifecycle_operation'::regclass
       ) AND constraint_row.contype IN ('p','u','f')
       ORDER BY constraint_row.conname`,
    );
    assert.equal(
      scopedConstraints.rows.every(
        (row) => row.columns[0] === "brand_id" && row.columns[1] === "store_id",
      ),
      true,
    );
    assert.equal(
      scopedConstraints.rows.some(
        (row) => row.target === "rms_kitchen.kitchen_order_item_ready_result",
      ),
      false,
    );
    const constraintByName = new Map(scopedConstraints.rows.map((row) => [row.conname, row]));
    assert.deepEqual(constraintByName.get("kitchen_work_lifecycle_operation_work_item_fk"), {
      conname: "kitchen_work_lifecycle_operation_work_item_fk",
      contype: "f",
      columns: [
        "brand_id",
        "store_id",
        "kitchen_ticket_id",
        "kitchen_work_item_id",
        "order_item_id",
      ],
      referenced_columns: [
        "brand_id",
        "store_id",
        "kitchen_ticket_id",
        "kitchen_work_item_id",
        "order_item_id",
      ],
      target: "rms_kitchen.kitchen_work_item",
    });
    for (const constraintName of [
      "kitchen_order_item_ready_result_causal_operation_fk",
      "kitchen_order_item_ready_result_expo_source_fk",
      "kitchen_work_lifecycle_operation_expo_source_fk",
    ]) {
      const constraint = constraintByName.get(constraintName);
      assert.deepEqual(constraint?.columns, [
        "brand_id",
        "store_id",
        "kitchen_ticket_id",
        "order_item_id",
        constraintName === "kitchen_order_item_ready_result_causal_operation_fk"
          ? "causal_operation_id"
          : "expo_source_operation_id",
      ]);
      assert.deepEqual(constraint?.referenced_columns, [
        "brand_id",
        "store_id",
        "kitchen_ticket_id",
        "order_item_id",
        "kitchen_work_lifecycle_operation_id",
      ]);
    }
    assert.deepEqual(
      constraintByName.get("kitchen_work_lifecycle_operation_causation_fk")?.columns,
      [
        "brand_id",
        "store_id",
        "kitchen_ticket_id",
        "order_item_id",
        "causation_operation_id",
        "result_ticket_version",
      ],
    );
    assert.deepEqual(
      constraintByName.get("kitchen_work_lifecycle_operation_causation_fk")?.referenced_columns,
      [
        "brand_id",
        "store_id",
        "kitchen_ticket_id",
        "order_item_id",
        "kitchen_work_lifecycle_operation_id",
        "result_ticket_version",
      ],
    );
    const workItemTargetConstraint = await client.query(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid='rms_kitchen.kitchen_work_item'::regclass
         AND conname='kitchen_work_item_lifecycle_target_unique'`,
    );
    assert.deepEqual(workItemTargetConstraint.rows, [
      {
        definition:
          "UNIQUE (brand_id, store_id, kitchen_ticket_id, kitchen_work_item_id, order_item_id)",
      },
    ]);
    const indexes = await client.query(
      `SELECT indexname,indexdef FROM pg_indexes
       WHERE schemaname='rms_kitchen' AND tablename=ANY($1::text[]) ORDER BY indexname`,
      [tables],
    );
    assert.equal(
      indexes.rows.every((row) => row.indexdef.includes("(brand_id, store_id")),
      true,
    );
    for (const indexName of [
      "kitchen_work_lifecycle_operation_idempotency_unique",
      "kitchen_work_lifecycle_operation_accept_unique",
      "kitchen_work_lifecycle_operation_start_unique",
      "kitchen_work_lifecycle_operation_completion_version_unique",
    ])
      assert.equal(
        indexes.rows.some((row) => row.indexname === indexName),
        true,
      );

    const first = source(10);
    await seedSource(client, first);
    const storedWorkItem = (
      await client.query(
        `SELECT * FROM rms_kitchen.kitchen_work_item
         WHERE brand_id=$1 AND store_id=$2 AND kitchen_work_item_id=$3`,
        [first.brandId, first.storeId, first.workItemId],
      )
    ).rows[0];
    for (const malformed of [
      { status: "Queued", completed_quantity: 1 },
      { status: "In Progress", completed_quantity: 2 },
      { status: "Completed", completed_quantity: 1 },
    ])
      await assert.rejects(
        insertRow(client, "kitchen_work_item", {
          ...storedWorkItem,
          localized_display_names_json: JSON.stringify(storedWorkItem.localized_display_names_json),
          selected_options_json: JSON.stringify(storedWorkItem.selected_options_json),
          preparation_instructions_json: JSON.stringify(
            storedWorkItem.preparation_instructions_json,
          ),
          kitchen_work_item_id: id(900),
          order_item_id: id(901),
          source_item_ordinal: 2,
          ...malformed,
        }),
        /kitchen_work_item_lifecycle_quantity_check/u,
      );
    const accept = acceptOperation(first, id(20), "accept-operation-0001");
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(18),
        order_item_id: id(999),
      }),
      /kitchen_work_lifecycle_operation_work_item_fk/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(19),
        actor_id: null,
      }),
      /kitchen_work_lifecycle_operation_actor_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(21),
        actor_type: "System",
        actor_id: null,
        source_channel: "KITCHEN_AUTOMATION",
        idempotency_key: null,
        intent_digest: null,
        expected_ticket_version: null,
        replay_expires_at: null,
      }),
      /kitchen_work_lifecycle_operation_action_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(22),
        idempotency_key: "short",
      }),
      /kitchen_work_lifecycle_operation_idempotency_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(23),
        result_work_item_version: 1,
      }),
      /kitchen_work_lifecycle_operation_action_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(24),
        replay_expires_at: "2026-09-08T14:03:00.001Z",
      }),
      /kitchen_work_lifecycle_operation_idempotency_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(24),
        replay_expires_at: null,
      }),
      /kitchen_work_lifecycle_operation_idempotency_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(24),
        idempotency_key: id(24),
      }),
      /kitchen_work_lifecycle_operation_reference_distinct_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(24),
        outbox_event_id: null,
        event_semantic_digest: null,
      }),
      /kitchen_work_lifecycle_operation_event_shape_check/u,
    );
    await insertRow(client, "kitchen_work_lifecycle_operation", accept);
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...accept,
        kitchen_work_lifecycle_operation_id: id(25),
        audit_id: id(26),
        outbox_event_id: id(27),
      }),
      /kitchen_work_lifecycle_operation_(?:idempotency|accept)_unique/u,
    );

    const start = startOperation(first, accept);
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...start,
        kitchen_work_lifecycle_operation_id: id(45),
        admission_valid_until: startedAt,
      }),
      /kitchen_work_lifecycle_operation_admission_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...start,
        kitchen_work_lifecycle_operation_id: id(45),
        admission_outcome: null,
      }),
      /kitchen_work_lifecycle_operation_admission_shape_check/u,
    );
    await insertRow(client, "kitchen_work_lifecycle_operation", start);
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...start,
        kitchen_work_lifecycle_operation_id: id(46),
        idempotency_key: "duplicate-start-operation-0001",
        audit_id: id(47),
        outbox_event_id: id(48),
        correlation_id: id(49),
      }),
      /kitchen_work_lifecycle_operation_start_unique/u,
    );
    const progress = progressOperation(first, accept, start);
    await insertRow(client, "kitchen_work_lifecycle_operation", progress);
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...progress,
        kitchen_work_lifecycle_operation_id: id(54),
        idempotency_key: "duplicate-progress-version-0001",
        audit_id: id(55),
        outbox_event_id: id(56),
        correlation_id: id(57),
      }),
      /kitchen_work_lifecycle_operation_completion_version_unique/u,
    );
    const complete = completeOperation(first, accept, start);
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...complete,
        kitchen_work_lifecycle_operation_id: id(65),
        idempotency_key: "bad-completion-delta-0001",
        quantity_delta: 3,
      }),
      /kitchen_work_lifecycle_operation_action_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...complete,
        kitchen_work_lifecycle_operation_id: id(65),
        idempotency_key: "bad-expo-operation-0001",
        expo_source_operation_id: complete.kitchen_work_lifecycle_operation_id,
        expo_mode: "Disabled",
      }),
      /kitchen_work_lifecycle_operation_(?:expo|action)_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...complete,
        kitchen_work_lifecycle_operation_id: id(65),
        idempotency_key: "null-expo-field-operation-0001",
        expo_source_action_code: null,
      }),
      /kitchen_work_lifecycle_operation_(?:expo|action)_shape_check/u,
    );
    await insertRow(client, "kitchen_work_lifecycle_operation", complete);

    const ready = manualReadyOperation(first, complete);
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...ready,
        kitchen_work_lifecycle_operation_id: id(73),
        idempotency_key: "ready-with-work-item-0001",
        kitchen_work_item_id: first.workItemId,
      }),
      /kitchen_work_lifecycle_operation_action_shape_check/u,
    );
    await insertRow(client, "kitchen_work_lifecycle_operation", ready);
    const readyFact = readyResult(first, ready, complete);
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: id(81),
        work_items_json: JSON.stringify([
          { workItemReference: first.workItemId, workItemVersion: "5", extra: true },
        ]),
      }),
      /kitchen_order_item_ready_result_work_items_shape_check/u,
    );
    for (const [readyResultId, workItems] of [
      [id(88), { workItemReference: first.workItemId, workItemVersion: "5" }],
      [id(89), []],
      [
        id(90),
        [
          { workItemReference: first.workItemId, workItemVersion: "5" },
          { workItemReference: id(999), workItemVersion: "5" },
        ],
      ],
    ])
      await assert.rejects(
        insertRow(client, "kitchen_order_item_ready_result", {
          ...readyFact,
          ready_result_id: readyResultId,
          work_items_json: JSON.stringify(workItems),
        }),
        /kitchen_order_item_ready_result_work_items_shape_check/u,
      );
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: id(82),
        ready_quantity: 1,
      }),
      /kitchen_order_item_ready_result_quantity_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: id(83),
        causal_operation_id: id(999),
      }),
      /kitchen_order_item_ready_result_causal_operation_fk/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: id(85),
        work_items_json: JSON.stringify([
          {
            workItemReference: first.workItemId,
            workItemVersion: "9223372036854775808",
          },
        ]),
      }),
      /kitchen_order_item_ready_result_work_items_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: id(86),
        order_item_id: id(999),
      }),
      /kitchen_order_item_ready_result_(?:causal_operation|expo_source)_fk/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: id(87),
        actor_type: "System",
        actor_id: null,
      }),
      /kitchen_order_item_ready_result_actor_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: ready.kitchen_work_lifecycle_operation_id,
      }),
      /kitchen_order_item_ready_result_reference_distinct_check/u,
    );
    await insertRow(client, "kitchen_order_item_ready_result", readyFact);
    await assert.rejects(
      insertRow(client, "kitchen_order_item_ready_result", {
        ...readyFact,
        ready_result_id: id(84),
      }),
      /kitchen_order_item_ready_result_order_item_unique/u,
    );

    const second = source(110);
    await seedSource(client, second);
    const acceptTwo = acceptOperation(second, id(120), "accept-operation-0002", {
      audit_id: id(121),
      outbox_event_id: id(122),
      correlation_id: id(123),
    });
    const startTwo = startOperation(second, acceptTwo, {
      kitchen_work_lifecycle_operation_id: id(130),
      idempotency_key: "start-operation-0002",
      admission_decision_id: id(131),
      audit_id: id(132),
      outbox_event_id: id(133),
      correlation_id: id(134),
    });
    await insertRow(client, "kitchen_work_lifecycle_operation", acceptTwo);
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...startTwo,
        kitchen_work_lifecycle_operation_id: id(135),
        idempotency_key: "cross-target-start-0002",
        accepted_operation_id: accept.kitchen_work_lifecycle_operation_id,
        audit_id: id(136),
        outbox_event_id: id(137),
        correlation_id: id(138),
      }),
      /kitchen_work_lifecycle_operation_accepted_fk/u,
    );
    await insertRow(client, "kitchen_work_lifecycle_operation", startTwo);
    const automaticParent = completeOperation(second, acceptTwo, startTwo, {
      kitchen_work_lifecycle_operation_id: id(140),
      idempotency_key: "automatic-complete-0002",
      outcome: "CompletedAndOrderItemReady",
      expected_ticket_version: 3,
      result_ticket_version: 4,
      expected_work_item_version: 3,
      result_work_item_version: 4,
      quantity_delta: 2,
      automatic_child_operation_id: id(141),
      ready_result_id: id(142),
      expo_source_operation_id: id(140),
      expo_source_expected_ticket_version: 3,
      expo_source_result_ticket_version: 4,
      expo_source_expected_work_item_version: 3,
      expo_source_result_work_item_version: 4,
      expo_source_outcome: "CompletedAndOrderItemReady",
      expo_mode: "Disabled",
      audit_id: id(143),
      outbox_event_id: id(144),
      correlation_id: id(145),
    });
    await insertRow(client, "kitchen_work_lifecycle_operation", automaticParent);
    const automaticChild = {
      kitchen_work_lifecycle_operation_id: id(141),
      brand_id: second.brandId,
      store_id: second.storeId,
      kitchen_ticket_id: second.ticketId,
      order_item_id: second.orderItemId,
      action_code: "KITCHEN_ORDER_ITEM_READY",
      purpose: "KitchenExpoCoordination",
      reason_code: "ALL_WORK_ITEMS_COMPLETED",
      outcome: "OrderItemReady",
      actor_type: "System",
      source_channel: "KITCHEN_AUTOMATION",
      data_classification: "Confidential",
      effect_digest: sha("b"),
      result_ticket_version: 4,
      ready_result_id: id(142),
      audit_id: id(146),
      audit_semantic_digest: sha("c"),
      correlation_id: id(145),
      causation_operation_id: id(140),
      occurred_at: completedAt,
    };
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...automaticChild,
        kitchen_work_lifecycle_operation_id: id(147),
        ready_result_id: id(148),
        audit_id: id(149),
        result_ticket_version: 5,
      }),
      /kitchen_work_lifecycle_operation_causation_fk/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...automaticChild,
        kitchen_work_lifecycle_operation_id: id(147),
        ready_result_id: id(148),
        audit_id: id(149),
        actor_id: id(150),
      }),
      /kitchen_work_lifecycle_operation_actor_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...automaticChild,
        kitchen_work_lifecycle_operation_id: id(147),
        ready_result_id: id(148),
        audit_id: id(149),
        expected_ticket_version: 3,
      }),
      /kitchen_work_lifecycle_operation_(?:idempotency|action)_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...automaticChild,
        kitchen_work_lifecycle_operation_id: id(147),
        ready_result_id: id(148),
        audit_id: id(149),
        completed_quantity: 2,
        required_quantity: 2,
      }),
      /kitchen_work_lifecycle_operation_(?:quantity|action)_shape_check/u,
    );
    await assert.rejects(
      insertRow(client, "kitchen_work_lifecycle_operation", {
        ...automaticChild,
        kitchen_work_lifecycle_operation_id: id(147),
        ready_result_id: id(148),
        audit_id: id(149),
        result_work_item_version: 4,
      }),
      /kitchen_work_lifecycle_operation_action_shape_check/u,
    );
    await insertRow(client, "kitchen_work_lifecycle_operation", automaticChild);
    await insertRow(
      client,
      "kitchen_order_item_ready_result",
      readyResult(second, automaticChild, automaticParent, {
        ready_result_id: id(142),
        actor_type: "System",
        actor_id: null,
        work_items_json: JSON.stringify([
          { workItemReference: second.workItemId, workItemVersion: "4" },
        ]),
        causal_operation_id: id(141),
        expo_source_expected_ticket_version: 3,
        expo_source_result_ticket_version: 4,
        expo_source_expected_work_item_version: 3,
        expo_source_result_work_item_version: 4,
        ready_at: completedAt,
      }),
    );

    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_work_lifecycle_operation SET effect_digest=$1
         WHERE brand_id=$2 AND store_id=$3 AND kitchen_work_lifecycle_operation_id=$4`,
        [sha("d"), first.brandId, first.storeId, accept.kitchen_work_lifecycle_operation_id],
      ),
      /kitchen work lifecycle evidence is append-only/u,
    );
    await assert.rejects(
      client.query(
        `UPDATE rms_kitchen.kitchen_order_item_ready_result SET ready_at=$1
         WHERE brand_id=$2 AND store_id=$3 AND ready_result_id=$4`,
        ["2026-08-09T14:08:00.000Z", first.brandId, first.storeId, readyFact.ready_result_id],
      ),
      /kitchen work lifecycle evidence is append-only/u,
    );
    await client.query(
      `DELETE FROM rms_kitchen.kitchen_order_item_ready_result
       WHERE brand_id=$1 AND store_id=$2 AND ready_result_id=$3`,
      [first.brandId, first.storeId, readyFact.ready_result_id],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_order_item_ready_result
           WHERE brand_id=$1 AND store_id=$2 AND ready_result_id=$3`,
          [first.brandId, first.storeId, readyFact.ready_result_id],
        )
      ).rows[0].count,
      1,
    );

    const sibling = source(10, id(3));
    await seedSource(client, sibling);
    const siblingAccept = {
      ...acceptOperation(
        sibling,
        accept.kitchen_work_lifecycle_operation_id,
        accept.idempotency_key,
      ),
      audit_id: id(230),
      outbox_event_id: id(231),
      correlation_id: id(232),
    };
    await insertRow(client, "kitchen_work_lifecycle_operation", siblingAccept);
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
      `GRANT SELECT,INSERT,UPDATE,DELETE ON
         rms_kitchen.kitchen_work_lifecycle_operation,
         rms_kitchen.kitchen_order_item_ready_result TO ${role}`,
    );
    await client.query(`SET ROLE ${role}`);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_lifecycle_operation",
        )
      ).rows[0].count,
      0,
    );
    await client.query("RESET ROLE");
    await assert.rejects(
      withScope(client, role, "not-a-brand-uuid", first.storeId, () =>
        client.query(
          "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_lifecycle_operation",
        ),
      ),
      /invalid input syntax for type uuid/u,
    );
    const ownRows = await withScope(client, role, first.brandId, first.storeId, () =>
      client.query(
        "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_lifecycle_operation",
      ),
    );
    assert.equal(ownRows.rows[0].count > 1, true);
    const siblingRows = await withScope(client, role, sibling.brandId, sibling.storeId, () =>
      client.query(
        "SELECT count(*)::integer AS count FROM rms_kitchen.kitchen_work_lifecycle_operation",
      ),
    );
    assert.equal(siblingRows.rows[0].count, 1);
    await assert.rejects(
      withScope(client, role, first.brandId, first.storeId, () =>
        insertRow(client, "kitchen_work_lifecycle_operation", {
          ...siblingAccept,
          kitchen_work_lifecycle_operation_id: id(240),
          idempotency_key: "cross-store-operation-0001",
          audit_id: id(241),
          outbox_event_id: id(242),
        }),
      ),
      /row-level security/u,
    );
  } finally {
    await client.query(`RESET ROLE`).catch(() => undefined);
    await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

it("proves the append-only Store-scoped Kitchen work lifecycle schema", async () => {
  await withIsolatedDatabase({ caseId: "kitchen_lifecycle", root }, prove);
}, 180_000);
