import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import {
  loadOutboxEnvelope,
  recordConsumerFailureDecision,
  resolveRetry,
} from "../../bop/eventing/src/index.ts";
import { createInternalBatchCancellation } from "../../../tooling/environment/pilot-batch-cancellation.mjs";
import { resolveCompletedDeadLetters } from "../../../tooling/environment/dead-letter-operations.mjs";
import { createInternalOrderStatus } from "../../../tooling/environment/pilot-order-status.mjs";
import { createInternalOrderSubmitted } from "../../../tooling/environment/pilot-order-submitted.mjs";
import { uuidV7 } from "../../../tooling/environment/permission-catalog-install.mjs";
import { applyWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const id = (n) => "01a0fd00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const consumerName = "ordering.order-status-projection:v1";
// TEST-ONLY platform support identity (the operator the dead-letter tool records).
const operator = "0190fa30-0000-7000-8000-000000000901";

/**
 * v15 b14 order-status-cancelled-round (DEC-ORDER-STATUS-CANCELLED-ROUND). At DEMO Store 2 the
 * pilot worker's order status update failed forever on a dine-in table's 21st round: by the time
 * its OrderSubmitted was taken, every round of the table had been cancelled unpaid (the System's
 * payment window, then staff for the last three), so the round no longer resolved as preparable
 * and the freshness check threw ORDER_SUBMITTED_EXECUTION_UNAVAILABLE. Every later update of that
 * Order was held behind it.
 *
 * The table orders 21 rounds through the pilot's real staff round composition (pay-first, none
 * paid) under the restricted NOBYPASSRLS API role with the rendered pilot ACL. The pilot's own order
 * status consumers take rounds 2 to 20 as they are sent; then every round is cancelled unpaid
 * before round 21's OrderSubmitted is taken. That event is projected as superseded (Stale) and every
 * later OrderCancelled advances the status. Synthetic TEST references.
 */
it("a 21st round cancelled with every other round before its status was taken is projected stale, and the table's later updates go on", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_cancel_round" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_ocr");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, reference } = store;
      const cancellation = await unpaidCancellation(admin, context, store);
      const server = await store.staff(id(0x710), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const table = await guestTable(admin, store, server);
      const submitted = createInternalOrderSubmitted(store.resources);
      const status = await statusConsumers(store);
      const asWorker = store.restricted;
      const consume = (consumer, eventId) =>
        asWorker.run(async (tx) => consumer.consume(tx, await loadOutboxEnvelope(tx, eventId)));
      const events = (orderReference, type) =>
        orderEvents(admin, orderReference).then((rows) => rows.filter((row) => row.type === type));

      let orderReference = null;
      const batches = [];
      for (let round = 1; round <= 21; round += 1) {
        // Each round from another phone at the table (one guest's unpaid round holds their cart).
        const placed = await table.sendRound(await table.phone(), soup.skuReference);
        orderReference ??= placed.orderReference;
        assert.equal(placed.orderReference, orderReference, "round " + round);
        batches.push(placed.orderBatchReference);
        if (round >= 2 && round <= 20) {
          const [event] = (await events(orderReference, "OrderSubmitted")).slice(-1);
          assert.deepEqual(await consume(submitted, event.event), { status: "processed" });
        }
      }
      // Every round of the table is cancelled unpaid before round 21's update is taken.
      for (const batch of batches)
        assert.equal(
          (
            await store.asApi((tx) =>
              cancellation.cancelUnpaidForStaff(tx, {
                operationReference: reference(),
                orderReference,
                orderBatchReference: batch,
                actorReference: id(0x710),
                authorize: async () => true,
              }),
            )
          ).status,
          "Created",
        );
      const [round21] = (await events(orderReference, "OrderSubmitted")).slice(-1);
      assert.equal(round21.round, 21);

      // A dependency outage while the freshness is checked still fails and is retried: nothing is
      // recorded for the event, the status stays where it was.
      await assert.rejects(
        asWorker.run(async (tx) =>
          submitted.consume(
            failingOn(tx, /FROM rms_ordering\.order_revision r LEFT JOIN/u),
            await loadOutboxEnvelope(tx, round21.event),
          ),
        ),
        (error) => error.code === "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(await inboxStatus(admin, round21.event), null);

      // The round's update itself: projected as superseded, never refused.
      assert.deepEqual(await consume(submitted, round21.event), { status: "processed" });
      assert.deepEqual(await projected(admin, orderReference), {
        version: round21.version,
        freshness: "Stale",
        shown: 21,
      });
      // The table's later updates (each round's cancellation) go on in order.
      const cancelled = (await events(orderReference, "OrderCancelled")).filter(
        (event) => event.version > round21.version,
      );
      assert.equal(cancelled.length, 21);
      for (const event of cancelled)
        assert.deepEqual(await consume(status.cancelled, event.event), { status: "processed" });
      const last = (await orderEvents(admin, orderReference)).at(-1);
      assert.deepEqual(await projected(admin, orderReference), {
        version: last.version,
        freshness: "Fresh",
        shown: 21,
      });
      await assertRestricted(store);
    } finally {
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      await admin.query("DROP OWNED BY " + api).catch(() => undefined);
      await admin.query("DROP ROLE " + api).catch(() => undefined);
      await admin.end();
    }
  });
});

/**
 * One round cancelled before its update is taken while the table's other rounds stay: its update
 * is projected stale, the next round's fresh. And the dead-letter tool's
 * `resolve` closes a consumer dead letter once that consumer has completed its event (as for order
 * 01a1d4b2 on v15, whose event was recovered by the Outbox path while its consumer dead letter and
 * retry stayed dead-lettered), recording the operator; one whose event is not completed stays open.
 */
it("a round cancelled before its update is taken is projected stale, and resolve closes the consumer dead letter once its event is consumed", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_cancel_one" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_oc1");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, reference, scope } = store;
      const cancellation = await unpaidCancellation(admin, context, store);
      const server = await store.staff(id(0x810), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const table = await guestTable(admin, store, server);
      const submitted = createInternalOrderSubmitted(store.resources);
      const asWorker = store.restricted;
      const consume = (eventId) =>
        asWorker.run(async (tx) => submitted.consume(tx, await loadOutboxEnvelope(tx, eventId)));
      // Each round from its own phone at the table, sent unpaid.
      const place = async () => table.sendRound(await table.phone(), soup.skuReference);
      const first = await place();
      const orderReference = first.orderReference;
      const second = await place();
      const cancelled = await store.asApi((tx) =>
        cancellation.cancelUnpaidForStaff(tx, {
          operationReference: reference(),
          orderReference,
          orderBatchReference: second.orderBatchReference,
          actorReference: id(0x810),
          authorize: async () => true,
        }),
      );
      assert.equal(cancelled.status, "Created");
      await place();
      const [round2, round3] = (await orderEvents(admin, orderReference)).filter(
        (event) => event.type === "OrderSubmitted",
      );

      // Round 2's update failed earlier and its consumer dead letter is open (TEST history, as the
      // delivery path records it after its last attempt). Round 3's too, still not consumed.
      const letters = {};
      for (const event of [round2, round3])
        letters[event.round] = await deadLetterConsumer(admin, scope, event.event);

      assert.deepEqual(await consume(round2.event), { status: "processed" });
      assert.equal((await projected(admin, orderReference)).freshness, "Stale");

      // resolve: round 2's consumer completed the event, so its dead letter closes; round 3's stays.
      const results = await resolveCompletedDeadLetters(admin, operator);
      assert.deepEqual(
        results.map((result) => [result.id, result.outcome]),
        [[letters[2], "applied"]],
      );
      assert.deepEqual(await letter(admin, letters[2]), {
        status: "resolved",
        resolution: "retry_completed",
        schedule: "completed",
        actions: [{ action: "resolve_retry", actor: operator, reason: "DEPENDENCY_RECOVERED" }],
      });
      assert.deepEqual(await letter(admin, letters[3]), {
        status: "open",
        resolution: null,
        schedule: "dead_lettered",
        actions: [],
      });
      // Run again: nothing more to close.
      assert.deepEqual(await resolveCompletedDeadLetters(admin, operator), []);

      assert.deepEqual(await consume(round3.event), { status: "processed" });
      assert.deepEqual(await projected(admin, orderReference), {
        version: round3.version,
        freshness: "Fresh",
        shown: 3,
      });
      assert.deepEqual(
        (await resolveCompletedDeadLetters(admin, operator)).map((result) => result.outcome),
        ["applied"],
      );
      assert.equal((await letter(admin, letters[3])).status, "resolved");
      await assertRestricted(store);
    } finally {
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      await admin.query("DROP OWNED BY " + api).catch(() => undefined);
      await admin.query("DROP ROLE " + api).catch(() => undefined);
      await admin.end();
    }
  });
});

/**
 * The table opened by staff, a guest's phone joined to it, and a round the guest sends unpaid
 * ("Continue to payment" at a pay-first table), as the pilot's guest pipeline composes it.
 */
async function guestTable(admin, store, server) {
  const { tableReference, reference, now } = store;
  const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
  let pipeline = null;
  await store.counterFor(server, { decorateStaffRoundPipeline: (real) => (pipeline = real) });
  assert.equal((await pipeline.openTable(as, { tableReference })).status, "Opened");
  return {
    async phone() {
      const entered = await pipeline.enter({ tableReference, requestedAt: now() });
      assert.equal(entered.status, "Established");
      const issued = await pipeline.openTable(as, { tableReference });
      const joined = await pipeline.join(entered.credentials, {
        joinCredential: issued.joinCredential,
        operationReference: reference(),
      });
      return (
        await pipeline.bind(entered.credentials, {
          operationReference: reference(),
          admissionReference: joined.admissionReference,
        })
      ).credentials;
    },
    async sendRound(who, sellableReference) {
      const cart = await pipeline.selectCart(who, {
        operationReference: reference(),
        requestedAt: now(),
      });
      const added = await pipeline.addItem(who, {
        operationReference: reference(),
        cartReference: cart.cartReference,
        expectedCartVersion: cart.cartVersion,
        sellableReference,
        quantity: 1,
        optionSelections: [],
        customerNote: null,
        requestedAt: now(),
      });
      assert.equal(added.status, "Applied");
      const current = await pipeline.selectCart(who, {
        operationReference: reference(),
        requestedAt: now(),
      });
      const quoted = await pipeline.quote(who, {
        operationReference: reference(),
        cartReference: current.cartReference,
        cartVersion: current.cartVersion,
        requestedAt: now(),
      });
      assert.equal(quoted.status, "Quoted");
      await pipeline.saveDetails(who, {
        operationReference: reference(),
        detailsReference: reference(),
        cartReference: current.cartReference,
        cartVersion: current.cartVersion,
        quoteReference: quoted.quoteReference,
      });
      const checkout = await pipeline.startCheckout(who, {
        createOperationReference: reference(),
        cartReference: current.cartReference,
        cartVersion: current.cartVersion,
        quoteReference: quoted.quoteReference,
      });
      assert.equal(checkout.status, "Started");
      await pipeline.preparePayment(who, {
        checkoutSessionReference: checkout.checkoutSessionReference,
        selectionReference: reference(),
        tip: { amountMinor: 0n, currencyCode: "CAD" },
        recordedAfterOutage: false,
      });
      const [batch] = (
        await admin.query(
          `SELECT b.order_id::text AS "orderReference", b.order_batch_id::text AS "orderBatchReference"
           FROM rms_ordering.order_batch b JOIN rms_ordering.order_submission_record s
             ON s.submission_id=b.submission_id AND s.order_id=b.order_id
           ORDER BY b.submitted_at DESC, b.order_batch_id DESC LIMIT 1`,
        )
      ).rows;
      return batch;
    },
  };
}

/** The released unpaid round cancellation Workflow, installed by its operator tool, as on v15. */
async function unpaidCancellation(admin, context, store) {
  const label = (n) => "01a0fd10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const hex = (Date.now() - 600_000).toString(16).padStart(12, "0");
  await admin.query("BEGIN");
  const release = await applyWorkflowRelease(
    admin,
    {
      release: "UnpaidDineInBatchCancellation",
      tenantReference: store.tenantReference,
      brandReference: store.ownerScope.brandReference,
      operatorReference: label(0x10),
      approvedByReference: label(0x11),
      approvalEvidenceReference: label(0x12),
      operationReference: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000001`,
    },
    () => Date.now() - 600_000 + 1000,
  );
  await admin.query("COMMIT");
  assert.equal(release.status, "Applied");
  return createInternalBatchCancellation(store.resources, {
    loadWorkflow: async () => ({
      environment: "InternalTest",
      database: context.clientConfig.database,
      scope: { tenantReference: store.tenantReference, ...store.ownerScope },
      definition: release.plan.published,
    }),
    expectedDatabaseName: context.clientConfig.database,
    systemActorReference: label(0x20),
    providerAccountReference: label(0x21),
  });
}

/** The pilot's order status consumers as the business worker composes them (OrderCancelled here). */
function statusConsumers(store) {
  return createInternalOrderStatus(store.resources, {
    createCompletion: async () => ({
      consume: async () => {
        throw new Error("NOT_IN_THIS_TEST");
      },
    }),
  });
}

async function orderEvents(admin, orderReference) {
  return (
    await admin.query(
      `SELECT event_id::text AS event, event_type AS type, aggregate_version::int AS version,
         (payload_json->>'batchSequence')::int AS round
       FROM platform_eventing.outbox_event WHERE aggregate_id=$1 ORDER BY aggregate_version`,
      [orderReference],
    )
  ).rows;
}

async function projected(admin, orderReference) {
  const [row] = (
    await admin.query(
      `SELECT p.source_version::int AS version, g.freshness_status AS freshness,
         jsonb_array_length(g.projection_snapshot_json->'batches') AS shown
       FROM rms_ordering.order_status_projection p
       JOIN rms_ordering.order_status_projection_generation g ON g.generation_id=p.generation_id
       WHERE p.order_id=$1`,
      [orderReference],
    )
  ).rows;
  return row;
}

async function inboxStatus(admin, eventId) {
  const rows = (
    await admin.query(
      "SELECT status FROM platform_eventing.consumer_inbox WHERE consumer_name=$1 AND event_id=$2",
      [consumerName, eventId],
    )
  ).rows;
  return rows[0]?.status ?? null;
}

/** A transaction whose one matching statement fails as a lost connection would. */
function failingOn(tx, pattern) {
  return {
    ...tx,
    query: (text, values) =>
      pattern.test(text)
        ? Promise.reject(Object.assign(new Error("connection lost"), { code: "57P01" }))
        : tx.query(text, values),
  };
}

/** The delivery path's record of a consumer's eighth failed attempt: its dead letter (TEST history). */
async function deadLetterConsumer(admin, scope, eventId) {
  await admin.query("BEGIN");
  try {
    await admin.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [scope.brandReference, scope.storeReference],
    );
    const now = new Date();
    const result = await recordConsumerFailureDecision(admin, {
      attemptId: uuidV7(),
      attemptNumber: 8,
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      eventId,
      consumerName,
      idempotencyKey: uuidV7(),
      safeCode: "CONSUMER_TEMPORARY_FAILURE",
      resolution: resolveRetry({
        actualAttemptNumber: 8,
        firstAttemptAt: new Date(now.getTime() - 60_000).toISOString(),
        now: now.toISOString(),
        path: "consumer",
        random: 0,
        safeCode: "CONSUMER_TEMPORARY_FAILURE",
      }),
      deadLetterId: uuidV7(),
      scheduleId: uuidV7(),
    });
    await admin.query("COMMIT");
    assert.equal(result.status, "applied");
    return result.deadLetterId;
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function letter(admin, deadLetterId) {
  const [item] = (
    await admin.query(
      `SELECT d.status, d.resolution_kind AS resolution, s.state AS schedule
       FROM platform_eventing.dead_letter_item d
       LEFT JOIN platform_eventing.consumer_retry_schedule s
         ON s.event_id=d.event_id AND s.consumer_name=d.consumer_name
       WHERE d.dead_letter_id=$1`,
      [deadLetterId],
    )
  ).rows;
  const actions = (
    await admin.query(
      `SELECT action, actor_id::text AS actor, reason_code AS reason
       FROM platform_eventing.dead_letter_action WHERE dead_letter_id=$1 ORDER BY recorded_at`,
      [deadLetterId],
    )
  ).rows;
  return { ...item, actions };
}

async function assertRestricted(store) {
  for (const run of [(work) => store.asApi(work), (work) => store.restricted.run(work)])
    assert.equal(
      (
        await run((tx) =>
          tx.query(
            "SELECT (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass",
            [],
          ),
        )
      ).rows[0].bypass,
      false,
    );
}
