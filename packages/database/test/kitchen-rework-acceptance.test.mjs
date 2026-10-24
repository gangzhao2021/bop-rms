import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import { consumeEventInTransaction, loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import {
  createInventoryReservation,
  createPostgresOrderLineConsumptionStore,
  createPostgresSubmissionReservationStore,
  createPostgresSubmissionStockPlanSource,
  postStoreWaste,
  recordKitchenReworkWaste,
  reviewStoreWaste,
  voidKitchenReworkWaste,
} from "../../rms/inventory/src/index.ts";
import {
  createPostgresKitchenReworkStore,
  KitchenReworkError,
  listOpenKitchenReworkByOrder,
  listOpenKitchenReworkItems,
  readKitchenReworkCancellation,
} from "../../rms/kitchen/src/index.ts";
import {
  createKitchenReworkCancelledWasteConsumption,
  createKitchenReworkWasteConsumption,
} from "../../../apps/api/src/kitchen-rework-waste.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedSyntheticInventoryItems } from "../test-support/recipe-inventory-observation.mjs";

const { Client } = pg;
const id = (n) => "01a0f026-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (character) => "sha256:" + character.repeat(64);
const canonicalSha = (value) =>
  "sha256:" + createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex");
const at = "2026-10-07T10:00:00.000Z";
const instant = (offsetMs) =>
  new Date(Math.floor((Date.now() + offsetMs) / 1000) * 1000).toISOString();

async function insertRow(client, table, row) {
  const columns = Object.keys(row);
  await client.query(
    `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map((_, i) => "$" + (i + 1)).join(",")})`,
    columns.map((column) => row[column]),
  );
}

/**
 * WP-2423 Q26 (Handoff Section 26.6, DEC-KITCHEN-REWORK): a finished dish is remade as a new
 * Rework work item; the original keeps its result. Kitchen owner persistence and the Inventory
 * waste consumer run as a restricted NOBYPASSRLS role holding exactly the rendered pilot API
 * grants (matrix + Owner-approved additions). Test-only stand-ins: synthetic Kitchen ticket and
 * work items inserted by the owner (creation is covered by the Kitchen ticket suites), synthetic
 * inventory items and reservations, and Ordering's Order item link (one line of quantity 2).
 */
it("remakes a finished dish once, keeps the original, records waste once, corrects a dish marked done too early, cancels open remakes and records a short-stock remake's waste", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_rework" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_rw_" + context.runId,
      worker = "wp2423_rw_w_" + context.runId,
      setup = "wp2423_rw_s_" + context.runId;
    try {
      for (const name of [api, worker, setup])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const scope = {
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        stockSiteReference: id(4),
      };
      const kitchenScope = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      };
      let sequence = 0x10000;
      const next = () => id(sequence++);

      /** One restricted-role transaction (pilot API grants), one query at a time. */
      const asApi = async (work, store = scope.storeReference) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [scope.tenantReference, scope.brandReference, store],
          );
          const result = await work({
            query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          await client.end();
        }
      };
      const rows = async (sql, values = []) => (await admin.query(sql, values)).rows;

      // ── Synthetic Kitchen facts: one Open ticket; A (qty 2) finished 30 s ago, B finished
      // 10 minutes ago, C still in progress.
      const ticket = id(10),
        order = id(11),
        batch = id(12),
        evidence = id(13),
        plan = id(14);
      await insertRow(admin, "rms_kitchen.kitchen_ticket", {
        kitchen_ticket_id: ticket,
        brand_id: scope.brandReference,
        store_id: scope.storeReference,
        order_id: order,
        order_batch_id: batch,
        confirmation_id: id(15),
        consumer_name: "kitchen.confirmed-order:v1",
        consumer_version: 1,
        source_event_id: id(16),
        source_aggregate_version: 1,
        source_snapshot_digest: sha("1"),
        confirmed_at: at,
        correlation_id: id(17),
        semantic_event_binding_digest: sha("2"),
        source_evidence_id: evidence,
        source_evidence_version: 1,
        source_evidence_digest: sha("3"),
        source_evidence_captured_at: at,
        work_plan_id: plan,
        work_plan_version: 1,
        work_plan_digest: sha("4"),
        work_plan_generated_at: at,
        aggregate_version: 1,
        status: "Open",
        created_by_actor_type: "System",
        updated_by_actor_type: "System",
        created_at: at,
        updated_at: at,
      });
      const workItem = (n, ordinal, status, required, completed, updatedAt) => ({
        kitchen_work_item_id: id(n),
        brand_id: scope.brandReference,
        store_id: scope.storeReference,
        kitchen_ticket_id: ticket,
        order_id: order,
        order_batch_id: batch,
        order_item_id: id(n + 1),
        source_evidence_id: evidence,
        work_plan_id: plan,
        source_item_ordinal: ordinal,
        split_ordinal: 1,
        version: 4,
        status,
        required_quantity: required,
        completed_quantity: completed,
        product_id: id(700),
        product_version_id: id(701),
        sku_id: id(702),
        menu_version_id: id(703),
        localized_display_names_json: JSON.stringify({
          "en-CA": "Synthetic noodle bowl " + ordinal,
        }),
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
        // Reached the kitchen 10 minutes before it last changed (fixed instants for old facts).
        created_at: updatedAt === at ? at : new Date(Date.parse(updatedAt) - 600_000).toISOString(),
        updated_at: updatedAt,
      });
      const A = id(0x20),
        B = id(0x30),
        C = id(0x40);
      await insertRow(
        admin,
        "rms_kitchen.kitchen_work_item",
        workItem(0x20, 1, "Completed", 2, 2, instant(-30_000)),
      );
      await insertRow(
        admin,
        "rms_kitchen.kitchen_work_item",
        workItem(0x30, 2, "Completed", 1, 1, instant(-600_000)),
      );
      await insertRow(
        admin,
        "rms_kitchen.kitchen_work_item",
        workItem(0x40, 3, "In Progress", 1, 0, at),
      );
      // An earlier day's dish left on the board and only finished now is never remade.
      await insertRow(admin, "rms_kitchen.kitchen_work_item", {
        ...workItem(0x50, 4, "Completed", 1, 1, instant(-60_000)),
        created_at: instant(-13 * 3_600_000),
      });
      const original = async (workItemId) =>
        (
          await rows(
            "SELECT status,version::int AS version,completed_quantity,updated_at FROM rms_kitchen.kitchen_work_item WHERE kitchen_work_item_id=$1",
            [workItemId],
          )
        )[0];
      const originalBefore = await original(A);

      const cook = id(50),
        other = id(51);
      const kitchen = createPostgresKitchenReworkStore({ ...kitchenScope, nextReference: next });
      const run = (command, actorReference = cook, occurredAt = instant(0)) =>
        asApi((tx) => kitchen.execute(tx, { command, actorReference, occurredAt }));
      const refused = async (promise, code) => {
        await assert.rejects(
          promise,
          (error) => error instanceof KitchenReworkError && error.code === code,
        );
      };
      const create = (overrides = {}) => ({
        action: "CreateKitchenRework",
        idempotencyKey: next(),
        originalWorkItemReference: A,
        reasonCode: "DROPPED",
        note: null,
        quantity: 1,
        correlationReference: next(),
        ...overrides,
      });

      // ── 1. Remake one dropped portion of A: a new Queued rework, A unchanged, one event.
      const dropped = create();
      const first = await run(dropped);
      assert.equal(first.status, "Applied");
      assert.deepEqual(
        {
          status: first.item.status,
          version: first.item.version,
          reason: first.item.reasonCode,
          quantity: first.item.quantity,
          waste: first.item.wasteApplies,
          original: first.item.originalWorkItemReference,
          orderItem: first.item.orderItemReference,
          ordinal: first.item.ordinal,
          createdBy: first.item.createdBy,
        },
        {
          status: "Queued",
          version: 1,
          reason: "DROPPED",
          quantity: 1,
          waste: true,
          original: A,
          orderItem: id(0x21),
          ordinal: 1,
          createdBy: cook,
        },
      );
      assert.deepEqual(await original(A), originalBefore, "the original keeps its result");
      const events = await rows(
        "SELECT event_id::text AS id,payload_json FROM platform_eventing.outbox_event WHERE event_type='KitchenReworkCreated' ORDER BY occurred_at",
      );
      assert.equal(events.length, 1);
      assert.deepEqual(Object.keys(events[0].payload_json).sort(), [
        "createdAt",
        "kitchenReworkItemReference",
        "kitchenTicketReference",
        "orderBatchReference",
        "orderItemReference",
        "orderReference",
        "originalKitchenWorkItemReference",
        "quantity",
        "reasonCode",
        "wasteApplies",
      ]);
      const audits = await rows(
        "SELECT action_code,actor_reference::text AS actor FROM platform_audit.audit_record WHERE target_id=$1",
        [first.item.reworkReference],
      );
      assert.deepEqual(audits, [{ action_code: "KITCHEN_REWORK_CREATED", actor: cook }]);

      // ── 2. The same request again is the same remake; a different body under the key is refused.
      const replay = await run(dropped);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.item.reworkReference, first.item.reworkReference);
      await refused(run({ ...dropped, quantity: 2 }), "KITCHEN_REWORK_CONFLICT");
      assert.equal(
        (await rows("SELECT count(*)::int AS n FROM rms_kitchen.kitchen_rework_item"))[0].n,
        1,
      );

      // ── 3. Not finished, too many portions, an OTHER without words: refused.
      await refused(
        run(create({ originalWorkItemReference: C })),
        "KITCHEN_REWORK_PRECONDITION_FAILED",
      );
      await refused(run(create({ quantity: 3 })), "KITCHEN_REWORK_INPUT_INVALID");
      await refused(run(create({ reasonCode: "OTHER" })), "KITCHEN_REWORK_INPUT_INVALID");
      await refused(
        run(create({ originalWorkItemReference: id(0x99) })),
        "KITCHEN_REWORK_NOT_FOUND",
      );
      await refused(
        run(create({ originalWorkItemReference: id(0x50) })),
        "KITCHEN_REWORK_WINDOW_CLOSED",
      );

      // ── 4. Marked done by mistake: A (30 s ago) goes back in progress, nothing wasted; B (10 min
      // ago) is past the two-minute window, also when written directly past the application.
      const notReady = await run(create({ reasonCode: "NOT_READY", quantity: 2 }));
      assert.deepEqual(
        [
          notReady.item.status,
          notReady.item.wasteApplies,
          notReady.item.startedBy,
          notReady.item.ordinal,
        ],
        ["In Progress", false, cook, 2],
      );
      await refused(
        run(create({ reasonCode: "NOT_READY", quantity: 2 })),
        "KITCHEN_REWORK_PRECONDITION_FAILED",
      );
      await refused(
        run(create({ originalWorkItemReference: B, reasonCode: "NOT_READY" })),
        "KITCHEN_REWORK_WINDOW_CLOSED",
      );
      const now = instant(0);
      await assert.rejects(
        asApi((tx) =>
          tx.query(
            "INSERT INTO rms_kitchen.kitchen_rework_item (kitchen_rework_item_id,brand_id,store_id,kitchen_ticket_id,original_kitchen_work_item_id," +
              "order_id,order_batch_id,order_item_id,rework_ordinal,reason_code,quantity,waste_applies,status,version,created_operation_id," +
              "created_by_actor_id,created_at,started_by_actor_id,started_at,event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'NOT_READY',1,false," +
              "'In Progress',1,$9,$10,$11,$10,$11,$12)",
            [
              next(),
              scope.brandReference,
              scope.storeReference,
              ticket,
              B,
              order,
              batch,
              id(0x31),
              next(),
              cook,
              now,
              next(),
            ],
          ),
        ),
        /two minutes/u,
      );
      // B may still be remade for a real reason (it is thrown away).
      const bQuality = await run(
        create({
          originalWorkItemReference: B,
          reasonCode: "QUALITY_ISSUE",
          note: "Broth too salty",
        }),
      );
      assert.equal(bQuality.item.note, "Broth too salty");

      // ── 5. The remake moves forward only, by version; any operator with the board may do it.
      await refused(
        run({
          action: "CompleteKitchenRework",
          idempotencyKey: next(),
          reworkReference: first.item.reworkReference,
          expectedVersion: 1,
          correlationReference: next(),
        }),
        "KITCHEN_REWORK_PRECONDITION_FAILED",
      );
      const started = await run(
        {
          action: "StartKitchenRework",
          idempotencyKey: next(),
          reworkReference: first.item.reworkReference,
          expectedVersion: 1,
          correlationReference: next(),
        },
        other,
      );
      assert.deepEqual(
        [started.item.status, started.item.version, started.item.startedBy],
        ["In Progress", 2, other],
      );
      await refused(
        run({
          action: "CompleteKitchenRework",
          idempotencyKey: next(),
          reworkReference: first.item.reworkReference,
          expectedVersion: 1,
          correlationReference: next(),
        }),
        "KITCHEN_REWORK_CONFLICT",
      );
      const done = await run({
        action: "CompleteKitchenRework",
        idempotencyKey: next(),
        reworkReference: first.item.reworkReference,
        expectedVersion: 2,
        correlationReference: next(),
      });
      assert.deepEqual(
        [done.item.status, done.item.version, done.item.completedBy],
        ["Completed", 3, cook],
      );
      assert.deepEqual(await original(A), originalBefore, "the original still keeps its result");

      // ── 6. History is append-only and explains every state; scope and grants hold.
      await assert.rejects(
        asApi((tx) =>
          tx.query("UPDATE rms_kitchen.kitchen_rework_operation SET actor_id=$1", [other]),
        ),
        /permission denied/u,
      );
      // Even the owner cannot rewrite or remove remake history.
      await assert.rejects(
        admin.query("UPDATE rms_kitchen.kitchen_rework_operation SET actor_id=$1", [other]),
        /append-only/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_kitchen.kitchen_rework_item"),
        /append-only/u,
      );
      await assert.rejects(
        asApi((tx) => tx.query("DELETE FROM rms_kitchen.kitchen_rework_item", [])),
        /permission denied|append-only/u,
      );
      await assert.rejects(
        asApi((tx) =>
          tx.query(
            "UPDATE rms_kitchen.kitchen_rework_item SET reason_code='OTHER',reason_note='x' WHERE kitchen_rework_item_id=$1",
            [notReady.item.reworkReference],
          ),
        ),
        /only moves forward/u,
      );
      assert.equal(
        (await asApi((tx) => tx.query("SELECT 1 FROM rms_kitchen.kitchen_rework_item", []), id(9)))
          .rows.length,
        0,
      );
      for (const sql of [
        "SELECT 1 FROM rms_kitchen.kitchen_rework_item",
        "SELECT 1 FROM rms_kitchen.kitchen_rework_operation",
      ]) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + worker);
          await assert.rejects(
            client.query(sql),
            /permission denied/u,
            "the worker role has no remake grant",
          );
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          await client.end();
        }
      }
      const operations = await rows(
        "SELECT action,result_version::int AS v FROM rms_kitchen.kitchen_rework_operation WHERE kitchen_rework_item_id=$1 ORDER BY result_version",
        [first.item.reworkReference],
      );
      assert.deepEqual(operations, [
        { action: "Create", v: 1 },
        { action: "Start", v: 2 },
        { action: "Complete", v: 3 },
      ]);

      // ── 7. Board and pickup reads: open remakes with the original dish's name; per-order counts.
      const board = await asApi((tx) => kitchen.listCurrent(tx, instant(0)));
      assert.equal(board.length, 3);
      assert.equal(
        board.find((row) => row.item.reasonCode === "NOT_READY")?.dish.localizedDisplayNames[
          "en-CA"
        ],
        "Synthetic noodle bowl 1",
      );
      const open = await asApi((tx) =>
        listOpenKitchenReworkByOrder(tx, kitchenScope, [order, id(0x77)]),
      );
      assert.deepEqual([...open.entries()], [[order, { openQuantity: 3 }]]);
      // Per Order item, matched by reference (pickup, order and table screens use this).
      const perItem = await asApi((tx) => listOpenKitchenReworkItems(tx, kitchenScope, [order]));
      assert.deepEqual(perItem, [
        { orderReference: order, orderItemReference: id(0x21), openQuantity: 2 },
        { orderReference: order, orderItemReference: id(0x31), openQuantity: 1 },
      ]);

      // ── 8. Inventory: Order line of A (quantity 2) reserved two ingredients and consumed them on
      // completion; the dropped portion is recorded as waste once per event.
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_inventory,platform_helpers,platform_audit TO " + setup,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + setup);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          setup,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item TO " + setup);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,platform_audit.audit_record TO " +
          setup,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + setup,
      );
      const itemRunner = {
        async run(work) {
          await admin.query("BEGIN");
          try {
            await admin.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)",
              [scope.tenantReference, scope.brandReference],
            );
            const value = await work({ query: (sql, values) => admin.query(sql, [...values]) });
            await admin.query("COMMIT");
            return value;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      };
      const rice = id(0x100),
        egg = id(0x101);
      const [{ accountReference: riceAccount }, { accountReference: eggAccount }] =
        await seedSyntheticInventoryItems({
          admin,
          role: setup,
          runner: itemRunner,
          id,
          at,
          scope,
          next,
          items: [
            { itemReference: rice, operationReference: id(0x102), onHand: "2" },
            { itemReference: egg, operationReference: id(0x103), onHand: "2" },
          ],
        });
      await admin.query("RESET ROLE");
      const line = id(0x110),
        submission = id(0x111);
      const owner = {
        async run(work) {
          await admin.query("BEGIN");
          try {
            await admin.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [scope.tenantReference, scope.brandReference, scope.storeReference],
            );
            const value = await work({ query: (sql, values) => admin.query(sql, [...values]) });
            await admin.query("COMMIT");
            return value;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        },
      };
      const sourceScope = {
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      };
      const contribution = (itemReference, configurationOperationReference, numerator) => ({
        itemReference,
        configurationOperationReference,
        unitDimension: "Mass",
        quantityNumerator: numerator,
        quantityDenominator: "1",
        cartItemReference: line,
      });
      const demand = {
        ...scope,
        submissionReference: submission,
        cartReference: id(0x112),
        cartVersion: 2,
        quoteReference: id(0x113),
        demandReference: next(),
        workflowReference: id(0x114),
        workflowVersion: 1,
        reserveTrigger: "OrderSubmission",
        sourceDigest: sha("c"),
        contributions: [
          contribution(rice, id(0x102), "500000"),
          contribution(egg, id(0x103), "250000"),
        ],
      };
      const noLot = {
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot fixture");
        },
      };
      const stockPlan = await owner.run(async (tx) =>
        createPostgresSubmissionStockPlanSource(
          { run: async (inner) => inner(tx) },
          sourceScope,
          noLot,
        ).resolve(demand, at),
      );
      const audit = (actionCode, targetType, targetId, correlationId) => ({
        auditId: next(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: cook },
        actionCode,
        targetType,
        targetId,
        reasonCode: "SYNTHETIC_TEST",
        correlationId,
        occurredAt: at,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Internal",
        retentionPolicyCode: "SYNTHETIC_AUDIT",
        retentionPolicyVersion: 1,
      });
      const writes = stockPlan.allocations.map((allocation) => {
        const reservationReference = next(),
          operationReference = next();
        return {
          operationReference,
          accountReference: allocation.accountReference,
          action: "Reserve",
          expectedLedgerVersion: allocation.expectedLedgerVersion,
          quantity: allocation.quantity,
          movementReference: next(),
          reservation: createInventoryReservation({
            reservationReference,
            unit: allocation.unit,
            quantity: allocation.quantity,
            occurredAt: at,
            binding: {
              ...scope,
              locationReference: allocation.locationReference,
              itemReference: allocation.itemReference,
              lotReference: allocation.lotReference,
              submissionReference: submission,
              cartReference: demand.cartReference,
              cartVersion: demand.cartVersion,
              quoteReference: demand.quoteReference,
              demandReference: demand.demandReference,
              demandDigest: canonicalSha(demand),
              cartItemReference: allocation.cartItemReference,
            },
          }),
          audit: audit(
            "INVENTORY_RESERVATION_RESERVE",
            "InventoryReservation",
            reservationReference,
            operationReference,
          ),
        };
      });
      const setReference = next(),
        setOperation = next();
      await owner.run(async (tx) =>
        createPostgresSubmissionReservationStore({ run: async (inner) => inner(tx) }, sourceScope, {
          authorize: async () => true,
          resolveDemand: async () => demand,
          ...noLot,
        }).commit({
          setReference,
          operationReference: setOperation,
          workflowReference: demand.workflowReference,
          workflowVersion: demand.workflowVersion,
          writes,
          audit: audit(
            "INVENTORY_RESERVATION_SET",
            "InventoryReservationSet",
            setReference,
            setOperation,
          ),
        }),
      );
      for (const [kitchenFact, minute] of [
        [{ kind: "Start" }, 1],
        [{ kind: "Progress", completedQuantity: 2, requiredQuantity: 2 }, 2],
      ])
        await asApi((tx) =>
          createPostgresOrderLineConsumptionStore(
            { run: async (inner) => inner(tx) },
            sourceScope,
            {
              nextReference: next,
            },
          ).apply({
            submissionReference: submission,
            cartItemReference: line,
            kitchen: kitchenFact,
            occurredAt: `2026-10-07T10:0${minute}:00.000Z`,
            actorReference: cook,
            correlationReference: next(),
            audit: {
              reasonCode: "KITCHEN_PROGRESS",
              sourceChannel: "KDS_COMMAND",
              retentionPolicyCode: "SYNTHETIC_AUDIT",
              retentionPolicyVersion: 1,
            },
          }),
        );
      const stock = async (account) =>
        (
          await rows(
            "SELECT on_hand::text AS h,reserved::text AS r FROM rms_inventory.stock_balance WHERE account_id=$1",
            [account],
          )
        )[0];
      const consumed = { rice: await stock(riceAccount), egg: await stock(eggAccount) };
      assert.equal(Number(consumed.rice.r), 0);

      // Ordering's Order item link (test-only stand-in): A's Order line, quantity 2.
      const links = {
        async load(_tx, orderItem) {
          return orderItem === id(0x21)
            ? { submissionReference: submission, cartItemReference: line, quantity: 2 }
            : null;
        },
      };
      const consume = createKitchenReworkWasteConsumption({
        scope: sourceScope,
        nextReference: next,
        authorize: async () => true,
        links,
      });
      const registration = Object.freeze({
        consumerName: "inventory.kitchen-rework-waste:v1",
        consumerVersion: 1,
        eventType: "KitchenReworkCreated",
        schemaVersions: [1],
        ownerModule: "@rms/inventory",
        tenantScope: "store",
        ordering: "none",
        sideEffect: "record_kitchen_rework_waste",
        replaySafe: true,
        handler: async ({ transaction, envelope }) => {
          await consume(transaction, envelope);
          return { status: "completed" };
        },
      });
      const deliver = (eventId) =>
        asApi(async (tx) => {
          const envelope = await loadOutboxEnvelope(tx, eventId);
          assert.ok(envelope);
          return consumeEventInTransaction(tx, registration, envelope);
        });
      const eventRows = await rows(
        "SELECT event_id::text AS id,payload_json->>'reasonCode' AS reason,payload_json->>'kitchenReworkItemReference' AS rework FROM platform_eventing.outbox_event WHERE event_type='KitchenReworkCreated' ORDER BY occurred_at,event_id",
      );
      const droppedEvent = eventRows.find((row) => row.rework === first.item.reworkReference);
      const notReadyEvent = eventRows.find((row) => row.reason === "NOT_READY");
      assert.deepEqual(await deliver(droppedEvent.id), { status: "processed" });
      const waste = await rows(
        "SELECT operation_id::text AS op,record_json,recorded_by_actor_id::text AS by FROM rms_inventory.store_waste",
      );
      assert.equal(waste.length, 1);
      assert.equal(waste[0].op, droppedEvent.id);
      assert.equal(waste[0].by, cook);
      assert.deepEqual(waste[0].record_json.source, {
        kind: "KitchenRework",
        reworkReference: first.item.reworkReference,
        reasonCode: "DROPPED",
      });
      // One of two portions: half of each ingredient's line demand.
      const wasted = Object.fromEntries(
        waste[0].record_json.lines.map((entry) => [
          entry.itemReference,
          [entry.quantity, entry.reasonCode],
        ]),
      );
      const reserved = Object.fromEntries(
        stockPlan.allocations.map((allocation) => [allocation.itemReference, allocation.quantity]),
      );
      const half = (value) => Number(value) / 2;
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(wasted).map(([item, [quantity, reason]]) => [
            item,
            [Number(quantity), reason],
          ]),
        ),
        {
          [rice]: [half(reserved[rice]), "DROPPED"],
          [egg]: [half(reserved[egg]), "DROPPED"],
        },
      );
      assert.equal(
        Number((await stock(riceAccount)).h),
        Number(consumed.rice.h) - half(reserved[rice]),
      );
      assert.equal(
        Number((await stock(eggAccount)).h),
        Number(consumed.egg.h) - half(reserved[egg]),
      );

      // Replays: the inbox dedupes the event; the event-keyed waste operation dedupes a direct retry.
      assert.deepEqual(await deliver(droppedEvent.id), { status: "duplicate_completed" });
      const direct = await asApi((tx) =>
        recordKitchenReworkWaste(tx, sourceScope, {
          eventReference: droppedEvent.id,
          reworkReference: first.item.reworkReference,
          kitchenReasonCode: "DROPPED",
          submissionReference: submission,
          cartItemReference: line,
          lineQuantity: 2,
          reworkQuantity: 1,
          actorReference: cook,
          occurredAt: instant(0),
          nextReference: next,
        }),
      );
      assert.equal(direct.status, "AlreadyApplied");
      // A dish marked done too early wastes nothing.
      assert.deepEqual(await deliver(notReadyEvent.id), { status: "processed" });
      assert.equal(
        (await rows("SELECT count(*)::int AS n FROM rms_inventory.store_waste"))[0].n,
        1,
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int AS n FROM rms_inventory.stock_movement WHERE movement_type='Waste'",
          )
        )[0].n,
        2,
      );

      // ── 9. DEC-KITCHEN-REWORK cancel (2026-10-18): an open remake is cancelled once, with a
      // reason, by version; append-only, audited, evented, and no longer open anywhere.
      const cancel = (rework, cancelReasonCode, expectedVersion) => ({
        action: "CancelKitchenRework",
        idempotencyKey: next(),
        reworkReference: rework,
        expectedVersion,
        cancelReasonCode,
        correlationReference: next(),
      });
      const declined = cancel(bQuality.item.reworkReference, "GUEST_DECLINED", 1);
      await refused(
        run({ ...declined, idempotencyKey: next(), expectedVersion: 2 }),
        "KITCHEN_REWORK_CONFLICT",
      );
      const cancelledB = await run(declined, other);
      assert.deepEqual(
        [
          cancelledB.status,
          cancelledB.item.status,
          cancelledB.item.version,
          cancelledB.item.cancelledBy,
          cancelledB.item.cancelReasonCode,
        ],
        ["Applied", "Cancelled", 2, other, "GUEST_DECLINED"],
      );
      const cancelReplay = await run(declined, other);
      assert.equal(cancelReplay.status, "AlreadyApplied");
      await refused(
        run({ ...declined, cancelReasonCode: "OPENED_BY_MISTAKE" }, other),
        "KITCHEN_REWORK_CONFLICT",
      );
      await refused(
        run(cancel(bQuality.item.reworkReference, "GUEST_DECLINED", 2)),
        "KITCHEN_REWORK_PRECONDITION_FAILED",
      );
      // A finished remake already went out: it cannot be cancelled.
      await refused(
        run(cancel(first.item.reworkReference, "GUEST_DECLINED", 3)),
        "KITCHEN_REWORK_INPUT_INVALID",
      );
      await refused(
        run(cancel(first.item.reworkReference, "GUEST_DECLINED", 2)),
        "KITCHEN_REWORK_CONFLICT",
      );
      // "Not ready yet" opened on the wrong dish: cancelled straight from In Progress.
      const notReadyCancelled = await run(
        cancel(notReady.item.reworkReference, "OPENED_BY_MISTAKE", 1),
      );
      assert.deepEqual(
        [notReadyCancelled.item.status, notReadyCancelled.item.version],
        ["Cancelled", 2],
      );
      assert.deepEqual(
        await rows(
          "SELECT action,before_status,after_status,result_version::int AS v FROM rms_kitchen.kitchen_rework_operation WHERE kitchen_rework_item_id=$1 ORDER BY result_version",
          [bQuality.item.reworkReference],
        ),
        [
          { action: "Create", before_status: null, after_status: "Queued", v: 1 },
          { action: "Cancel", before_status: "Queued", after_status: "Cancelled", v: 2 },
        ],
      );
      assert.deepEqual(
        await rows(
          "SELECT action_code,actor_reference::text AS actor,reason_code FROM platform_audit.audit_record WHERE target_id=$1 ORDER BY occurred_at,action_code DESC",
          [bQuality.item.reworkReference],
        ),
        [
          {
            action_code: "KITCHEN_REWORK_CREATED",
            actor: cook,
            reason_code: "KITCHEN_REWORK_QUALITY_ISSUE",
          },
          {
            action_code: "KITCHEN_REWORK_CANCELLED",
            actor: other,
            reason_code: "KITCHEN_REWORK_CANCEL_GUEST_DECLINED",
          },
        ],
      );
      const cancelEvents = await rows(
        "SELECT event_id::text AS id,aggregate_version::int AS v,payload_json FROM platform_eventing.outbox_event WHERE event_type='KitchenReworkCancelled' ORDER BY occurred_at,event_id",
      );
      assert.equal(cancelEvents.length, 2);
      const declinedEvent = cancelEvents.find(
        (row) => row.payload_json.kitchenReworkItemReference === bQuality.item.reworkReference,
      );
      assert.equal(declinedEvent.v, 2);
      assert.deepEqual(Object.keys(declinedEvent.payload_json).sort(), [
        "cancelReasonCode",
        "cancelledAt",
        "createdEventReference",
        "kitchenReworkItemReference",
        "kitchenTicketReference",
        "orderBatchReference",
        "orderItemReference",
        "orderReference",
        "originalKitchenWorkItemReference",
        "quantity",
        "reasonCode",
        "wasteApplies",
      ]);
      assert.equal(declinedEvent.payload_json.createdEventReference, bQuality.item.eventReference);
      // No longer open: the board, pickup, order and table reads drop it.
      assert.deepEqual(
        await asApi((tx) => listOpenKitchenReworkItems(tx, kitchenScope, [order])),
        [],
      );
      assert.equal(
        (await asApi((tx) => kitchen.listCurrent(tx, instant(0)))).some(
          (row) => row.item.status === "Cancelled",
        ),
        false,
      );
      assert.deepEqual(
        await asApi((tx) =>
          readKitchenReworkCancellation(tx, kitchenScope, notReady.item.reworkReference),
        ).then((value) => value?.cancelReasonCode),
        "OPENED_BY_MISTAKE",
      );
      // Past the application: a cancelled remake never comes back, and a cancel needs its
      // operation row.
      await assert.rejects(
        asApi((tx) =>
          tx.query(
            "UPDATE rms_kitchen.kitchen_rework_item SET status='In Progress',version=3,started_by_actor_id=$2,started_at=$3," +
              "cancelled_by_actor_id=NULL,cancelled_at=NULL,cancel_reason_code=NULL,cancel_event_id=NULL WHERE kitchen_rework_item_id=$1",
            [bQuality.item.reworkReference, cook, instant(0)],
          ),
        ),
        /only moves forward/u,
      );
      const loose = await run(create({ originalWorkItemReference: B, reasonCode: "WRONG_ITEM" }));
      await assert.rejects(
        asApi((tx) =>
          tx.query(
            "UPDATE rms_kitchen.kitchen_rework_item SET status='Cancelled',version=2,cancelled_by_actor_id=$2,cancelled_at=$3," +
              "cancel_reason_code='GUEST_DECLINED',cancel_event_id=$4 WHERE kitchen_rework_item_id=$1",
            [loose.item.reworkReference, cook, instant(0), next()],
          ),
        ),
        /operation record/u,
      );

      // ── 10. Inventory: a remake cancelled as opened by mistake threw nothing away, so its waste is
      // voided (stock back) by whoever cancelled it — even the cook who opened it; a remake the guest
      // no longer wants keeps its waste. Either order of the two events gives the same result.
      const cancelRegistration = Object.freeze({
        consumerName: "inventory.kitchen-rework-cancelled-waste:v1",
        consumerVersion: 1,
        eventType: "KitchenReworkCancelled",
        schemaVersions: [1],
        ownerModule: "@rms/inventory",
        tenantScope: "store",
        ordering: "none",
        sideEffect: "void_kitchen_rework_waste",
        replaySafe: true,
        handler: async ({ transaction, envelope }) => {
          await createKitchenReworkCancelledWasteConsumption({
            scope: sourceScope,
            nextReference: next,
          })(transaction, envelope);
          return { status: "completed" };
        },
      });
      const deliverCancel = (eventId) =>
        asApi(async (tx) => {
          const envelope = await loadOutboxEnvelope(tx, eventId);
          assert.ok(envelope);
          return consumeEventInTransaction(tx, cancelRegistration, envelope);
        });
      const cancelEventOf = async (reworkReference) =>
        (
          await rows(
            "SELECT event_id::text AS id FROM platform_eventing.outbox_event WHERE event_type='KitchenReworkCancelled' AND payload_json->>'kitchenReworkItemReference'=$1",
            [reworkReference],
          )
        )[0].id;
      const wasteCount = async () =>
        (await rows("SELECT count(*)::int AS n FROM rms_inventory.store_waste"))[0].n;
      // The guest no longer wants B's remake: B's line holds no stock here, and the waste stands.
      assert.deepEqual(await deliverCancel(declinedEvent.id), { status: "processed" });

      const beforeMistake = { rice: await stock(riceAccount), egg: await stock(eggAccount) };
      const mistaken = await run(create({ reasonCode: "WRONG_ITEM" }));
      assert.deepEqual(await deliver(mistaken.item.eventReference), { status: "processed" });
      const mistakenWaste = (
        await rows(
          "SELECT waste_id::text AS id FROM rms_inventory.store_waste WHERE operation_id=$1",
          [mistaken.item.eventReference],
        )
      )[0];
      assert.ok(mistakenWaste, "the remake's waste was recorded first");
      assert.equal(
        Number((await stock(riceAccount)).h),
        Number(beforeMistake.rice.h) - half(reserved[rice]),
      );
      const mistakeCancel = await run(
        cancel(mistaken.item.reworkReference, "OPENED_BY_MISTAKE", 1),
      );
      const mistakeEvent = await cancelEventOf(mistaken.item.reworkReference);
      assert.deepEqual(await deliverCancel(mistakeEvent), { status: "processed" });
      assert.deepEqual(
        await rows(
          "SELECT decision,reason_code,reviewed_by_actor_id::text AS by,recorded_by_actor_id::text AS recorder,operation_id::text AS op FROM rms_inventory.store_waste_review WHERE waste_id=$1",
          [mistakenWaste.id],
        ),
        [
          {
            decision: "Voided",
            reason_code: "KITCHEN_REMAKE_OPENED_BY_MISTAKE",
            by: cook,
            recorder: cook,
            op: mistakeEvent,
          },
        ],
      );
      assert.deepEqual(
        { rice: await stock(riceAccount), egg: await stock(eggAccount) },
        beforeMistake,
        "the ingredients are back in stock",
      );
      assert.equal(mistakeCancel.item.status, "Cancelled");
      // Replays: the inbox dedupes; a direct retry is keyed by the cancel event.
      assert.deepEqual(await deliverCancel(mistakeEvent), { status: "duplicate_completed" });
      assert.equal(
        (
          await asApi((tx) =>
            voidKitchenReworkWaste(tx, sourceScope, {
              createdEventReference: mistaken.item.eventReference,
              cancelEventReference: mistakeEvent,
              actorReference: cook,
              occurredAt: instant(0),
              nextReference: next,
            }),
          )
        ).status,
        "AlreadyApplied",
      );
      // The waste page cannot use the kitchen's reason, and the recorder still cannot review
      // their own waste for any other reason (application and database).
      const pageWaste = await asApi((tx) =>
        postStoreWaste(tx, sourceScope, {
          operationReference: next(),
          wasteReference: next(),
          lines: [
            {
              lineReference: next(),
              itemReference: rice,
              locationReference: stockPlan.allocations.find((a) => a.itemReference === rice)
                .locationReference,
              lotReference: null,
              quantity: "0.0001",
              reasonCode: "SPOILED",
              note: null,
            },
          ],
          actorReference: cook,
          occurredAt: new Date().toISOString(),
          auditReference: next(),
          nextReference: next,
        }),
      );
      await assert.rejects(
        asApi((tx) =>
          reviewStoreWaste(tx, sourceScope, {
            operationReference: next(),
            wasteReference: pageWaste.record.wasteReference,
            decision: "Voided",
            reasonCode: "KITCHEN_REMAKE_OPENED_BY_MISTAKE",
            actorReference: other,
            occurredAt: instant(0),
            auditReference: next(),
            nextReference: next,
          }),
        ),
        (error) => error?.code === "STORE_WASTE_INVALID",
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_inventory.store_waste_review (tenant_id,brand_id,store_id,waste_id,operation_id,decision,reason_code," +
            "reviewed_by_actor_id,recorded_by_actor_id,reviewed_at,audit_id) VALUES ($1,$2,$3,$4,$5,'Accepted','REVIEWED_OK',$6,$6,$7,$8)",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            pageWaste.record.wasteReference,
            next(),
            cook,
            instant(0),
            next(),
          ],
        ),
        /store_waste_review_independent/u,
      );
      // Cancelled before Inventory saw the remake (or a dead-lettered first attempt retried later):
      // nothing to void, and the waste is then never recorded.
      const wastesBefore = await wasteCount();
      const early = await run(create({ reasonCode: "DROPPED" }));
      await run(cancel(early.item.reworkReference, "OPENED_BY_MISTAKE", 1));
      assert.deepEqual(await deliverCancel(await cancelEventOf(early.item.reworkReference)), {
        status: "processed",
      });
      assert.deepEqual(await deliver(early.item.eventReference), { status: "processed" });
      assert.equal(await wasteCount(), wastesBefore);

      // ── 11. Short stock: a whole-line remake needs more than is available (the count is behind).
      // Real store: the food is gone. The available part leaves stock, the rest stays on the record
      // as a shortfall for a manager to review and count; never refused, dead-lettered or taken
      // from other orders' reservations.
      const units = (value) => Math.round(Number(value) * 10_000);
      const text = (value) => (value / 10_000).toFixed(4).replace(/\.?0+$/u, "");
      const allocation = (item) => stockPlan.allocations.find((a) => a.itemReference === item);
      const available = async (account) => {
        const { h, r } = await stock(account);
        return units(h) - units(r);
      };
      // Leave half a portion's rice and no egg available (synthetic spoilage entered on the page).
      const leaveRice = units(reserved[rice]) / 2;
      for (const [item, account, keep] of [
        [rice, riceAccount, leaveRice],
        [egg, eggAccount, 0],
      ]) {
        const take = (await available(account)) - keep;
        if (take > 0)
          await asApi((tx) =>
            postStoreWaste(tx, sourceScope, {
              operationReference: next(),
              wasteReference: next(),
              lines: [
                {
                  lineReference: next(),
                  itemReference: item,
                  locationReference: allocation(item).locationReference,
                  lotReference: null,
                  quantity: text(take),
                  reasonCode: "SPOILED",
                  note: null,
                },
              ],
              actorReference: other,
              occurredAt: new Date().toISOString(),
              auditReference: next(),
              nextReference: next,
            }),
          );
      }
      assert.equal(await available(riceAccount), leaveRice);
      assert.equal(await available(eggAccount), 0);
      // Before this change the remake's waste went through the same strict path and failed.
      await assert.rejects(
        asApi((tx) =>
          postStoreWaste(tx, sourceScope, {
            operationReference: next(),
            wasteReference: next(),
            lines: [
              {
                lineReference: next(),
                itemReference: rice,
                locationReference: allocation(rice).locationReference,
                lotReference: null,
                quantity: reserved[rice],
                reasonCode: "DROPPED",
                note: null,
              },
            ],
            actorReference: cook,
            occurredAt: new Date().toISOString(),
            auditReference: next(),
            nextReference: next,
          }),
        ),
        (error) => error?.code === "STORE_WASTE_NOT_ENOUGH_STOCK",
      );
      const short = await run(create({ reasonCode: "DROPPED", quantity: 2 }));
      assert.deepEqual(await deliver(short.item.eventReference), { status: "processed" });
      const shortWaste = (
        await rows(
          "SELECT record_json,needs_review FROM rms_inventory.store_waste WHERE operation_id=$1",
          [short.item.eventReference],
        )
      )[0];
      assert.ok(shortWaste, "the waste record is never lost");
      assert.equal(shortWaste.needs_review, true);
      assert.deepEqual(
        shortWaste.record_json.lines.map((line) => [line.itemReference, units(line.quantity)]),
        [[rice, leaveRice]],
      );
      assert.deepEqual(
        Object.fromEntries(
          shortWaste.record_json.shortfalls.map((entry) => [
            entry.itemReference,
            [
              units(entry.wastedQuantity),
              units(entry.recordedQuantity),
              units(entry.missingQuantity),
            ],
          ]),
        ),
        {
          [rice]: [units(reserved[rice]), leaveRice, units(reserved[rice]) - leaveRice],
          [egg]: [units(reserved[egg]), 0, units(reserved[egg])],
        },
      );
      assert.equal(await available(riceAccount), 0);
      assert.equal(await available(eggAccount), 0);
      for (const account of [riceAccount, eggAccount])
        assert.ok(units((await stock(account)).h) >= units((await stock(account)).r));
      assert.deepEqual(await deliver(short.item.eventReference), { status: "duplicate_completed" });

      // ── 12. DEC-PICKUP-NOT-COLLECTED-REMAKE (2026-10-19): the Order is given up (a pickup closed
      // as not collected), so every remake still to be made for it is cancelled as the guest no
      // longer wanting it, through the same audited, evented cancel; nothing else is touched.
      const openBefore = await rows(
        "SELECT kitchen_rework_item_id::text AS id,quantity FROM rms_kitchen.kitchen_rework_item WHERE order_id=$1 AND status IN ('Queued','In Progress') ORDER BY kitchen_rework_item_id",
        [order],
      );
      assert.ok(openBefore.length >= 2, "loose and short are still open");
      const finishedBefore = (
        await rows(
          "SELECT count(*)::int AS n FROM rms_kitchen.kitchen_rework_item WHERE order_id=$1 AND status='Completed'",
          [order],
        )
      )[0].n;
      const manager = id(52),
        closure = next();
      const given = await asApi((tx) =>
        kitchen.cancelOpenForOrder(tx, {
          orderReference: order,
          actorReference: manager,
          occurredAt: instant(0),
          correlationReference: closure,
        }),
      );
      assert.equal(
        given.cancelledQuantity,
        openBefore.reduce((sum, row) => sum + Number(row.quantity), 0),
      );
      assert.deepEqual(
        await asApi((tx) => listOpenKitchenReworkItems(tx, kitchenScope, [order])),
        [],
      );
      assert.deepEqual(
        await rows(
          "SELECT kitchen_rework_item_id::text AS id,status,cancel_reason_code,cancelled_by_actor_id::text AS actor FROM rms_kitchen.kitchen_rework_item WHERE kitchen_rework_item_id=ANY($1::uuid[]) ORDER BY kitchen_rework_item_id",
          [openBefore.map((row) => row.id)],
        ),
        openBefore.map((row) => ({
          id: row.id,
          status: "Cancelled",
          cancel_reason_code: "GUEST_DECLINED",
          actor: manager,
        })),
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int AS n FROM rms_kitchen.kitchen_rework_item WHERE order_id=$1 AND status='Completed'",
            [order],
          )
        )[0].n,
        finishedBefore,
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE action_code='KITCHEN_REWORK_CANCELLED' AND correlation_id=$1",
            [closure],
          )
        )[0].n,
        openBefore.length,
      );
      assert.equal(
        (
          await rows(
            "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE event_type='KitchenReworkCancelled' AND correlation_id=$1",
            [closure],
          )
        )[0].n,
        openBefore.length,
      );
      // Nothing left to cancel: a second call changes nothing.
      assert.deepEqual(
        await asApi((tx) =>
          kitchen.cancelOpenForOrder(tx, {
            orderReference: order,
            actorReference: manager,
            occurredAt: instant(0),
            correlationReference: next(),
          }),
        ),
        { cancelledQuantity: 0 },
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker, setup]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  });
});
