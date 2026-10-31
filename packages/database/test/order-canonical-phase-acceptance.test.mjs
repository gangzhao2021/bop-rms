import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { afterEach, it, vi } from "vitest";
import {
  createPostgresOrderKitchenProgressFactStore,
  createPostgresOrderPickupNotCollectedFactStore,
  loadOrderCanonicalPhase,
  parseOrderKitchenProgressEnvelope,
} from "../../rms/ordering/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createInternalOrderProgressConsumers } from "../../../tooling/environment/pilot-order-progress-consumers.mjs";
import { catchUpOrderKitchenProgress } from "../../../tooling/environment/pilot-order-progress-catch-up.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190fa37-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = (character) => "sha256:" + character.repeat(64);

afterEach(() => vi.unstubAllEnvs());

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01 (defect 2026-10-17): Ordering merges the Order phase from its
 * own records and the Kitchen facts it consumes into its own inbox record. Persistence runs as a
 * restricted NOBYPASSRLS role holding exactly the rendered pilot API grants (matrix + Owner-approved
 * additions). Test-only stand-ins: synthetic Ordering orders/items and owner records (acceptance,
 * cancellation, termination, pickup completion) inserted by the owner with triggers off, and
 * synthetic published Kitchen outbox events (their creation is covered by the Kitchen suites).
 */
it("advances pickup and multi-round dine-in phases from consumed Kitchen facts, ends a pickup closed as not collected, ignores replays and out-of-order delivery, and catches up published events idempotently", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_phase" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_ph_" + context.runId,
      worker = "wp2423_ph_w_" + context.runId;
    try {
      for (const name of [api, worker])
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
      const tenant = id(1),
        brand = id(2),
        store = id(3),
        otherStore = id(4);
      const scope = { brandReference: brand, storeReference: store };
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const time = (minutes) => new Date(base + minutes * 60_000).toISOString();

      /** One restricted-role transaction (pilot API grants). */
      const run = async (work, scopeStore = store) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, scopeStore],
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
      const phaseOf = async (order, scopeStore = store) =>
        (
          await run(
            (tx) =>
              loadOrderCanonicalPhase(
                tx,
                { brandReference: brand, storeReference: scopeStore },
                order,
              ),
            scopeStore,
          )
        )?.canonicalPhase ?? null;

      // ── Owner seed (test-only stand-ins).
      let next = 0x1000;
      const fresh = () => id(next++);
      async function order(orderType, batches) {
        // Header number allocation and quote/cart owners are outside this case (triggers/FKs off).
        await admin.query("SET session_replication_role = replica");
        try {
          return await seedOrder(orderType, batches);
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
      }
      async function seedOrder(orderType, batches) {
        const orderId = fresh(),
          guest = fresh();
        await admin.query(
          "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,'2026-10-17',$4,$5,$6,$7,$8,$8,1,'Submitted','Open','NotReported',$9)",
          [
            orderId,
            brand,
            store,
            String(next),
            orderType,
            orderType === "DineIn" ? "Qr" : "Web",
            orderType === "DineIn" ? fresh() : null,
            guest,
            time(0),
          ],
        );
        const result = { order: orderId, batches: [] };
        for (const [index, itemCount] of batches.entries()) {
          const submission = fresh(),
            batch = fresh(),
            cart = fresh(),
            quote = fresh();
          await admin.query(
            "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)",
            [
              submission,
              brand,
              store,
              orderId,
              guest,
              sha("1"),
              cart,
              quote,
              time(index),
              index === 0 ? "Initial" : "Additional",
            ],
          );
          await admin.query(
            "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
            [batch, brand, store, orderId, submission, cart, fresh(), quote, guest, time(index)],
          );
          const items = [];
          for (let item = 0; item < itemCount; item += 1) {
            const itemId = fresh();
            items.push(itemId);
            await admin.query(
              "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7,$8,$9)",
              [
                itemId,
                brand,
                store,
                orderId,
                batch,
                fresh(),
                sha("2"),
                { catalog: {}, pricing: {} },
                time(index),
              ],
            );
          }
          result.batches.push({ batch, submission, items });
        }
        return result;
      }
      const ownerRecord = async (sql, values) => {
        await admin.query("SET session_replication_role = replica");
        try {
          await admin.query(sql, values);
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
      };
      const accept = (o, batch, version, minute) =>
        ownerRecord(
          "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'User',$9,'OrderAcceptance','ordering.order.accept','ACCEPTED',$10,$11,$12,$13)",
          [
            fresh(),
            fresh(),
            brand,
            store,
            o,
            batch,
            version,
            version + 1,
            fresh(),
            fresh(),
            fresh(),
            sha("3"),
            time(minute),
          ],
        );
      const terminate = (o, batch, previous, phase) =>
        ownerRecord(
          "INSERT INTO rms_ordering.order_termination_record (termination_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,terminated_order_version,expected_source_checkpoint,previous_phase,phase,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,terminated_at) VALUES ($1,$2,$3,$4,$5,$6,1,2,$7,$8,$9,'System',NULL,'OrderTermination','ordering.order.terminate','ACCEPTANCE_WINDOW_EXPIRED',$10,$11,$12,$13)",
          [
            fresh(),
            fresh(),
            brand,
            store,
            o,
            batch,
            fresh(),
            previous,
            phase,
            fresh(),
            fresh(),
            sha("4"),
            time(30),
          ],
        );
      const cancelUnpaidBatch = (o, b, minute) =>
        ownerRecord(
          "INSERT INTO rms_ordering.order_batch_checkout_cancellation (cancellation_id,operation_id,tenant_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_operation_id,expiry_record_id,expiry_evidence_digest,expected_order_version,cancelled_order_version,expected_source_checkpoint,workflow_version_id,transition_id,order_item_ids,cancelled_at,phase,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,3,4,$12,$13,$14,$15,$16,'Cancelled','PAYMENT_NOT_STARTED')",
          [
            fresh(),
            fresh(),
            tenant,
            brand,
            store,
            o,
            b.batch,
            b.submission,
            fresh(),
            fresh(),
            sha("5"),
            fresh(),
            fresh(),
            fresh(),
            b.items,
            time(minute),
          ],
        );
      const complete = async (o, batch) => {
        const completion = fresh(),
          operation = fresh(),
          audit = fresh(),
          checkpoint = fresh(),
          event = fresh(),
          workflow = fresh(),
          transition = fresh(),
          completedAt = time(20),
          recordedAt = time(20);
        const record = {
          orderType: "Pickup",
          actorType: "System",
          actorReference: null,
          completionReference: completion,
          operationReference: operation,
          auditReference: audit,
          brandReference: brand,
          storeReference: store,
          orderReference: o,
          orderBatchReference: batch,
          expectedSourceCheckpoint: checkpoint,
          expectedOrderVersion: 2,
          fulfilledOrderVersion: 3,
          phaseBefore: "Accepted",
          phase: "Fulfilled",
          closureStatus: "Open",
          workflowVersionReference: workflow,
          transitionReference: transition,
          sourceDigest: sha("6"),
          sourceEvent: {
            eventId: event,
            tenantId: brand,
            storeId: store,
            occurredAt: completedAt,
            payload: { orderReference: o },
          },
          completedAt,
          recordedAt,
        };
        await ownerRecord(
          "INSERT INTO rms_ordering.order_fulfillment_completion_record (completion_id,operation_id,audit_id,brand_id,store_id,order_id,order_batch_id,source_event_id,expected_source_checkpoint,expected_order_version,fulfilled_order_version,previous_phase,phase,closure_status,workflow_version_id,transition_id,source_digest,completed_at,recorded_at,completion_record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,2,3,'Accepted','Fulfilled','Open',$10,$11,$12,$13,$14,$15)",
          [
            completion,
            operation,
            audit,
            brand,
            store,
            o,
            batch,
            event,
            checkpoint,
            workflow,
            transition,
            sha("6"),
            completedAt,
            recordedAt,
            { recordVersion: 1, record },
          ],
        );
      };

      // ── Kitchen envelopes as the Kitchen owner publishes them (synthetic payloads).
      const envelope = (eventType, payload, occurredAt) => ({
        eventId: fresh(),
        eventType,
        schemaVersion: 1,
        occurredAt,
        producerModule: "@rms/kitchen",
        tenantId: brand,
        storeId: store,
        aggregateType:
          eventType === "KitchenItemReady" ? "KitchenOrderItemReadyResult" : "KitchenTicket",
        aggregateId: fresh(),
        aggregateVersion: 3n,
        correlationId: fresh(),
        actor: { type: "System" },
        payload,
        redactionClassification: "indirect_identifier",
        replayMetadata: { replaySafe: true },
      });
      const startedEvent = (item, minute) =>
        envelope(
          "KitchenWorkStarted",
          {
            kitchenTicketReference: fresh(),
            kitchenWorkItemReference: fresh(),
            orderItemReference: item,
            ticketVersion: "3",
            workItemVersion: "3",
            fromStatus: "Queued",
            toStatus: "In Progress",
            startedAt: time(minute),
          },
          time(minute),
        );
      const itemReadyEvent = (o, batch, item, minute) =>
        envelope(
          "KitchenItemReady",
          {
            kitchenTicketReference: fresh(),
            orderReference: o,
            orderBatchReference: batch,
            orderItemReference: item,
            readyResultReference: fresh(),
            readyQuantity: 1,
            requiredQuantity: 1,
            readyAt: time(minute),
          },
          time(minute),
        );
      const orderReadyEvent = (o, batch, count, minute) =>
        envelope(
          "KitchenOrderReady",
          {
            kitchenTicketReference: fresh(),
            orderReference: o,
            orderBatchReference: batch,
            readyItemCount: count,
            itemCount: count,
            readyAt: time(minute),
          },
          time(minute),
        );

      const resources = {
        scope,
        now: () => new Date().toISOString(),
        publicProfile: { binding: { validUntil: "2999-01-01T00:00:00.000Z" } },
        transactions: { run: (work) => run(work) },
        credentials: { reference: () => fresh() },
      };
      const consumers = createInternalOrderProgressConsumers(resources);
      const consume = (event) =>
        run((tx) =>
          consumers.find((c) => c.registration.eventType === event.eventType).consume(tx, event),
        );
      const factCount = async () =>
        Number(
          (await admin.query("SELECT count(*) FROM rms_ordering.order_kitchen_progress_fact"))
            .rows[0].count,
        );

      // ── Pickup: Submitted → Accepted → In Progress → Ready → Fulfilled.
      const pickup = await order("Pickup", [2]);
      const [p1, p2] = pickup.batches[0].items;
      assert.equal(await phaseOf(pickup.order), "Submitted");
      await accept(pickup.order, pickup.batches[0].batch, 1, 2);
      assert.equal(await phaseOf(pickup.order), "Accepted");
      const started1 = startedEvent(p1, 3);
      assert.deepEqual(await consume(started1), { status: "processed" });
      assert.equal(await phaseOf(pickup.order), "In Progress");
      // Replay: the inbox completes it once; Ordering's record is unchanged.
      const before = await factCount();
      assert.deepEqual(await consume(started1), { status: "duplicate_completed" });
      assert.equal(await factCount(), before);
      // A changed payload under a recorded event id is refused by Ordering's record.
      const factStore = createPostgresOrderKitchenProgressFactStore(scope);
      await assert.rejects(
        run((tx) =>
          factStore.record(
            tx,
            parseOrderKitchenProgressEnvelope({
              ...started1,
              payload: { ...started1.payload, orderItemReference: p2 },
            }),
          ),
        ),
        /ORDER_KITCHEN_PROGRESS_CONFLICT/u,
      );
      // Out of order: dish 2 ready before its start is delivered, then the ticket ready.
      await consume(itemReadyEvent(pickup.order, pickup.batches[0].batch, p2, 5));
      assert.equal(await phaseOf(pickup.order), "In Progress");
      await consume(orderReadyEvent(pickup.order, pickup.batches[0].batch, 2, 6));
      assert.equal(await phaseOf(pickup.order), "Ready");
      await consume(startedEvent(p2, 4)); // late Started never moves the phase back
      assert.equal(await phaseOf(pickup.order), "Ready");
      await complete(pickup.order, pickup.batches[0].batch);
      assert.equal(await phaseOf(pickup.order), "Fulfilled");

      // An event for an item this Store does not have is retried, not recorded.
      const unknown = startedEvent(id(0xfffff), 3);
      await assert.rejects(consume(unknown));
      assert.equal(
        (
          await admin.query(
            "SELECT count(*) FROM rms_ordering.order_kitchen_progress_fact WHERE source_event_id=$1",
            [unknown.eventId],
          )
        ).rows[0].count,
        "0",
      );
      // Append-only and Store-scoped for the API role.
      const recorded = await factCount();
      await run((tx) => tx.query("DELETE FROM rms_ordering.order_kitchen_progress_fact", []));
      await admin.query("DELETE FROM rms_ordering.order_kitchen_progress_fact");
      await admin.query("UPDATE rms_ordering.order_kitchen_progress_fact SET fact_kind='Ready'");
      assert.equal(await factCount(), recorded);
      assert.equal(await phaseOf(pickup.order), "Fulfilled");
      assert.equal(await phaseOf(pickup.order, otherStore), null);
      assert.equal(
        (
          await run(
            (tx) => tx.query("SELECT count(*) FROM rms_ordering.order_kitchen_progress_fact", []),
            otherStore,
          )
        ).rows[0].count,
        "0",
      );

      // ── Terminations.
      const expired = await order("Pickup", [1]);
      await terminate(expired.order, expired.batches[0].batch, "Submitted", "Cancelled");
      assert.equal(await phaseOf(expired.order), "Cancelled");
      const rejected = await order("Pickup", [1]);
      await terminate(rejected.order, rejected.batches[0].batch, "Submitted", "Rejected");
      assert.equal(await phaseOf(rejected.order), "Rejected");

      // ── Dine-in, several rounds; Kitchen events already published before the consumer existed.
      const dine = await order("DineIn", [1, 1, 1]);
      const [r1, r2, r3] = dine.batches;
      assert.equal(await phaseOf(dine.order), "Submitted");
      await accept(dine.order, r1.batch, 1, 2);
      assert.equal(await phaseOf(dine.order), "Accepted");
      const published = [
        startedEvent(r1.items[0], 3),
        itemReadyEvent(dine.order, r1.batch, r1.items[0], 4),
        orderReadyEvent(dine.order, r1.batch, 1, 4),
      ];
      for (const event of published)
        await admin.query(
          "INSERT INTO platform_eventing.outbox_event (event_id,event_type,schema_version,producer_module,brand_id,store_id,aggregate_type,aggregate_id,aggregate_version,correlation_id,actor_type,payload_json,redaction_classification,replay_metadata_json,occurred_at,available_at,published_at) VALUES ($1,$2,1,'@rms/kitchen',$3,$4,$5,$6,3,$7,'System',$8,'indirect_identifier','{\"replaySafe\":true}',$9,$9,statement_timestamp())",
          [
            event.eventId,
            event.eventType,
            brand,
            store,
            event.aggregateType,
            event.aggregateId,
            event.correlationId,
            event.payload,
            event.occurredAt,
          ],
        );
      const dryRun = await catchUpOrderKitchenProgress({ resources, dryRun: true, consumers });
      assert.equal(dryRun.pendingEvents, 3);
      assert.deepEqual(dryRun.outcomes, { processed: 3 });
      assert.equal(dryRun.ordersChangedByCatchUp, 1);
      assert.equal(await phaseOf(dine.order), "Accepted"); // dry run wrote nothing
      const applied = await catchUpOrderKitchenProgress({ resources, dryRun: false, consumers });
      assert.equal(applied.pendingEvents, 3);
      assert.deepEqual(applied.outcomes, { processed: 3 });
      // Round 1 ready while rounds 2 and 3 are not yet accepted → In Progress (rule 4).
      assert.equal(await phaseOf(dine.order), "In Progress");
      const again = await catchUpOrderKitchenProgress({ resources, dryRun: false, consumers });
      assert.equal(again.pendingEvents, 0);
      assert.equal(again.ordersChangedByCatchUp, 0);
      // Round 2 accepted and preparing; round 3's unpaid round cancelled.
      await accept(dine.order, r2.batch, 2, 7);
      await consume(startedEvent(r2.items[0], 8));
      await cancelUnpaidBatch(dine.order, r3, 9);
      assert.equal(await phaseOf(dine.order), "In Progress");
      await consume(itemReadyEvent(dine.order, r2.batch, r2.items[0], 10));
      assert.equal(await phaseOf(dine.order), "Ready");

      // ── Pickup closed as not collected (Fulfillment's PickupNotCollected → terminal phase).
      // Test-only stand-in: the Fulfillment row and its closure record seeded by the owner (their
      // creation and the closure rules are covered by the pickup-proof suite); the closure predates
      // the event, as the v15 closures do, so the catch-up publishes it through Fulfillment.
      const uncollected = await order("Pickup", [1]);
      await accept(uncollected.order, uncollected.batches[0].batch, 1, 2);
      await consume(orderReadyEvent(uncollected.order, uncollected.batches[0].batch, 1, 5));
      assert.equal(await phaseOf(uncollected.order), "Ready");
      const fulfillment = fresh(),
        closure = fresh();
      await ownerRecord(
        "INSERT INTO rms_fulfillment.fulfillment (fulfillment_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,source_event_id,source_aggregate_version,source_snapshot_digest,source_evidence_id,source_evidence_version,source_evidence_digest,fulfillment_type,canonical_phase,aggregate_version,created_at,correlation_id,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,1,$8,'Pickup','Pending',1,$10,$11,'IndirectIdentifier')",
        [
          fulfillment,
          brand,
          store,
          uncollected.order,
          uncollected.batches[0].batch,
          fresh(),
          fresh(),
          sha("7"),
          fresh(),
          time(2),
          fresh(),
        ],
      );
      await ownerRecord(
        "INSERT INTO rms_fulfillment.pickup_not_collected_record (pickup_not_collected_id,brand_id,store_id,fulfillment_id,actor_id,reason,ready_at,closed_at,idempotency_id,correlation_id,aggregate_version_before,data_classification) VALUES ($1,$2,$3,$4,$5,'NotCollected',$6,$7,$8,$9,3,'IndirectIdentifier')",
        [closure, brand, store, fulfillment, fresh(), time(5), time(70), fresh(), fresh()],
      );
      const outboxCount = async () =>
        Number(
          (
            await admin.query(
              "SELECT count(*) FROM platform_eventing.outbox_event WHERE event_type='PickupNotCollected'",
            )
          ).rows[0].count,
        );
      const ncDry = await catchUpOrderKitchenProgress({ resources, dryRun: true, consumers });
      assert.equal(ncDry.notCollectedPublished, 1);
      assert.equal(ncDry.pendingEvents, 1);
      assert.deepEqual(ncDry.outcomes, { processed: 1 });
      assert.equal(ncDry.ordersChangedByCatchUp, 1);
      assert.equal(await outboxCount(), 0); // dry run wrote nothing
      assert.equal(await phaseOf(uncollected.order), "Ready");
      const ncApplied = await catchUpOrderKitchenProgress({ resources, dryRun: false, consumers });
      assert.equal(ncApplied.notCollectedPublished, 1);
      assert.deepEqual(ncApplied.outcomes, { processed: 1 });
      assert.equal(await phaseOf(uncollected.order), "Cancelled");
      assert.equal(await outboxCount(), 1);
      const outboxEvent = (
        await admin.query(
          "SELECT event_id::text,aggregate_id::text,payload_json FROM platform_eventing.outbox_event WHERE event_type='PickupNotCollected'",
        )
      ).rows[0];
      assert.equal(outboxEvent.aggregate_id, fulfillment);
      assert.deepEqual(outboxEvent.payload_json, {
        fulfillmentReference: fulfillment,
        orderReference: uncollected.order,
        notCollectedReference: closure,
        storeReference: store,
        readyAt: time(5),
        closedAt: time(70),
      });
      // Exactly once: a second run publishes and consumes nothing; the relay's later delivery of
      // the same event is a duplicate in the inbox.
      const ncAgain = await catchUpOrderKitchenProgress({ resources, dryRun: false, consumers });
      assert.equal(ncAgain.notCollectedPublished, 0);
      assert.equal(ncAgain.pendingEvents, 0);
      const delivered = {
        eventId: outboxEvent.event_id,
        eventType: "PickupNotCollected",
        schemaVersion: 1,
        occurredAt: time(70),
        producerModule: "@rms/fulfillment",
        tenantId: brand,
        storeId: store,
        aggregateType: "Fulfillment",
        aggregateId: fulfillment,
        aggregateVersion: 4n,
        correlationId: fresh(),
        causationId: closure,
        actor: { type: "System" },
        payload: outboxEvent.payload_json,
        redactionClassification: "indirect_identifier",
        replayMetadata: { replaySafe: true },
      };
      assert.deepEqual(await consume(delivered), { status: "duplicate_completed" });
      // A different closure for the recorded Order is refused by Ordering's record.
      const notCollectedStore = createPostgresOrderPickupNotCollectedFactStore(scope);
      await assert.rejects(
        run((tx) =>
          notCollectedStore.record(tx, {
            eventId: fresh(),
            brandReference: brand,
            storeReference: store,
            orderReference: uncollected.order,
            fulfillmentReference: fulfillment,
            notCollectedReference: fresh(),
            closedAt: time(70),
          }),
        ),
        /ORDER_PICKUP_NOT_COLLECTED_CONFLICT/u,
      );
      // A closure for a dine-in Order is not a pickup outcome.
      await assert.rejects(
        run((tx) =>
          notCollectedStore.record(tx, {
            eventId: fresh(),
            brandReference: brand,
            storeReference: store,
            orderReference: dine.order,
            fulfillmentReference: fresh(),
            notCollectedReference: fresh(),
            closedAt: time(70),
          }),
        ),
        /ORDER_PICKUP_NOT_COLLECTED_INVALID/u,
      );
      // Append-only and Store-scoped for the API role; the collected pickup stays Fulfilled.
      await run((tx) => tx.query("DELETE FROM rms_ordering.order_pickup_not_collected_fact", []));
      await run((tx) =>
        tx.query("DELETE FROM rms_fulfillment.pickup_not_collected_publication", []),
      );
      assert.equal(
        (await admin.query("SELECT count(*) FROM rms_ordering.order_pickup_not_collected_fact"))
          .rows[0].count,
        "1",
      );
      assert.equal(
        (await admin.query("SELECT count(*) FROM rms_fulfillment.pickup_not_collected_publication"))
          .rows[0].count,
        "1",
      );
      assert.equal(
        (
          await run(
            (tx) =>
              tx.query("SELECT count(*) FROM rms_ordering.order_pickup_not_collected_fact", []),
            otherStore,
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(await phaseOf(uncollected.order), "Cancelled");
      assert.equal(await phaseOf(pickup.order), "Fulfilled");
    } finally {
      await admin.end();
    }
  });
});
