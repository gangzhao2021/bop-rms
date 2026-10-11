import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  createKitchenWorkLifecycleService,
  createPostgresKitchenBatchCancellation,
  createPostgresKitchenCustomerStatusReader,
  createPostgresKitchenQueueSourceReader,
  createPostgresKitchenWorkLifecycleStore,
  listStoreKitchenOrderItemStates,
  listStoreStartedKitchenBatches,
} from "../../rms/kitchen/src/index.ts";

const { Client } = pg;

/**
 * WP-2423 Q6 Kitchen half of the staff cancellation, on real owner persistence under a restricted
 * NOBYPASSRLS role. Ordering eligibility, operator authority and Start admission are synthetic.
 * `seed(base, itemCount)` inserts an Open ticket with Queued work items (Kitchen creation facts).
 */
export async function exerciseKitchenWorkCancellation({ admin, context, role, id, seed }) {
  const hash = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
  await admin.query(
    `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await admin.query(
    `GRANT USAGE ON SCHEMA rms_kitchen,platform_helpers,platform_audit,platform_eventing TO ${role}`,
  );
  await admin.query(
    `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),
       platform_helpers.is_uuid_v7(uuid) TO ${role}`,
  );
  await admin.query(
    `GRANT SELECT,UPDATE ON rms_kitchen.kitchen_ticket,rms_kitchen.kitchen_work_item TO ${role}`,
  );
  await admin.query(
    `GRANT SELECT,INSERT ON rms_kitchen.kitchen_work_lifecycle_operation,rms_kitchen.kitchen_work_cancellation,
       rms_kitchen.kitchen_order_item_ready_result,rms_kitchen.kitchen_ready_publication,
       platform_audit.audit_record,platform_eventing.outbox_event TO ${role}`,
  );
  await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
  await admin.query(`GRANT SELECT ON rms_kitchen.kitchen_creation_record TO ${role}`);

  const connection = new Client(context.clientConfig);
  await connection.connect();
  let sequence = 80000;
  const next = () => id(sequence++);
  const references = {
    next,
    derive(purpose, identity) {
      const digest = createHash("sha256")
        .update(purpose + identity)
        .digest("hex");
      return (
        "0198cafe-" +
        digest.slice(0, 4) +
        "-7" +
        digest.slice(4, 7) +
        "-8" +
        digest.slice(7, 10) +
        "-" +
        digest.slice(10, 22)
      );
    },
  };
  const scoped = async (value, work) => {
    await connection.query("BEGIN");
    try {
      await connection.query(`SET LOCAL ROLE ${role}`);
      await connection.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [value.brandId, value.storeId],
      );
      const result = await work({ query: (sql, values) => connection.query(sql, values) });
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }
  };
  const lifecycle = (value, actorReference) => {
    let now;
    const repository = createPostgresKitchenWorkLifecycleStore({
      brandReference: value.brandId,
      storeReference: value.storeId,
      references,
      digests: { sha256: hash },
      authorize: async () => true,
      validateCurrentSource: async () => true,
    });
    const service = createKitchenWorkLifecycleService({
      trustedContext: {
        resolveAuthority: async () => ({
          actorReference,
          brandReference: value.brandId,
          storeReference: value.storeId,
          observedAt: now,
        }),
      },
      correlationContext: { resolve: async () => ({ correlationReference: value.correlationId }) },
      authorization: { authorize: async () => true },
      transactions: { withTransaction: (work) => scoped(value, work) },
      tenantContext: { install: async () => undefined },
      idempotency: {
        acquireFence: async ({ transaction, idempotencyKey }) => {
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            value.brandId + ":" + value.storeId + ":" + idempotencyKey,
          ]);
        },
      },
      repository,
      references,
      digests: { sha256: hash },
      clock: { now: () => now },
      admission: {
        resolve: async ({ command, acceptedOperationReference }) => ({
          decisionReference: next(),
          decisionVersion: 1,
          decisionDigest: hash("synthetic admission"),
          producerContractVersion: 1,
          actorReference: command.actorReference,
          brandReference: value.brandId,
          storeReference: value.storeId,
          ticketReference: value.ticketId,
          workItemReference: command.workItemReference,
          acceptedOperationReference,
          ticketVersion: BigInt(command.expectedTicketVersion),
          workItemVersion: BigInt(command.expectedWorkItemVersion),
          action: "StartKitchenWorkItem",
          purpose: "KitchenWorkExecution",
          outcome: "Allowed",
          evaluatedAt: now,
          validUntil: "2026-08-09T16:00:00.000Z",
        }),
      },
      // Item cancellation cases complete the remaining line with Expo disabled (ready on completion).
      expo: {
        resolve: async () =>
          value.expoDisabled
            ? {
                decisionReference: next(),
                decisionVersion: 1,
                decisionDigest: hash("synthetic Expo disabled"),
                producerContractVersion: 1,
                brandReference: value.brandId,
                storeReference: value.storeId,
                purpose: "KitchenReadiness",
                mode: "Disabled",
                evaluatedAt: now,
                validUntil: new Date(Date.parse(now) + 60000).toISOString(),
              }
            : assert.fail("Expo is not part of cancellation"),
      },
    });
    return (action, version, at, ticketVersion = version, extra = {}) => {
      now = at;
      return service.execute({
        action,
        idempotencyKey: "cancel-lifecycle-" + value.workItemId + "-" + action + "-" + version,
        actorReference,
        brandReference: value.brandId,
        storeReference: value.storeId,
        ticketReference: value.ticketId,
        workItemReference: value.workItemId,
        orderItemReference: value.orderItemId,
        expectedTicketVersion: String(ticketVersion),
        expectedWorkItemVersion: String(version),
        correlationReference: value.correlationId,
        ...extra,
      });
    };
  };
  const operator = id(81000);
  const manager = id(81001);
  const command = (value, overrides = {}) => ({
    orderReference: value.orderId,
    orderBatchReference: value.orderBatchId,
    operationReference: next(),
    orderCancellationReference: next(),
    actorReference: manager,
    cancelledAt: "2026-08-09T14:10:00.000Z",
    auditReference: next(),
    eventReference: next(),
    nextReference: next,
    ...overrides,
  });
  const cancellation = (value) =>
    createPostgresKitchenBatchCancellation({
      brandReference: value.brandId,
      storeReference: value.storeId,
      tenantReference: value.brandId,
      authorize: async (_tx, input) =>
        input.orderReference === value.orderId &&
        input.orderBatchReference === value.orderBatchId &&
        input.actorReference === manager,
    });
  const count = async (sql, values) => (await admin.query(sql, values)).rows[0].count;

  try {
    // 1. A queued two-item batch: every item becomes Cancelled with one row each, one Audit and
    // one outbox Event, and the ticket advances one version per item.
    const queued = await seed(82000, 2);
    const queuedCommand = command(queued);
    const created = await scoped(queued, (tx) => cancellation(queued).cancel(tx, queuedCommand));
    assert.equal(created.status, "Cancelled");
    assert.equal(created.workItemCount, 2);
    assert.match(created.evidenceDigest, /^sha256:[0-9a-f]{64}$/u);
    const queuedState = await admin.query(
      `SELECT t.aggregate_version::text AS ticket_version,array_agg(w.status ORDER BY w.order_item_id) AS statuses,
         array_agg(w.version::text ORDER BY w.order_item_id) AS versions
       FROM rms_kitchen.kitchen_ticket t JOIN rms_kitchen.kitchen_work_item w
         ON w.brand_id=t.brand_id AND w.store_id=t.store_id AND w.kitchen_ticket_id=t.kitchen_ticket_id
       WHERE t.kitchen_ticket_id=$1 GROUP BY t.aggregate_version`,
      [queued.ticketId],
    );
    assert.deepEqual(queuedState.rows[0], {
      ticket_version: "3",
      statuses: ["Cancelled", "Cancelled"],
      versions: ["2", "2"],
    });
    const rows = await admin.query(
      `SELECT before_status,expected_ticket_version::text AS e,result_ticket_version::text AS r,
         operation_id,order_cancellation_id,evidence_digest,event_id,audit_id
       FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1 ORDER BY result_ticket_version`,
      [queued.ticketId],
    );
    assert.deepEqual(
      rows.rows.map((row) => [row.before_status, row.e, row.r]),
      [
        ["Queued", "1", "2"],
        ["Queued", "2", "3"],
      ],
    );
    assert.ok(
      rows.rows.every(
        (row) =>
          row.operation_id === queuedCommand.operationReference &&
          row.order_cancellation_id === queuedCommand.orderCancellationReference &&
          row.evidence_digest === created.evidenceDigest &&
          row.event_id === queuedCommand.eventReference &&
          row.audit_id === queuedCommand.auditReference,
      ),
    );
    const audit = await admin.query(
      "SELECT action_code,actor_type,actor_reference,reason_code,source_channel,target_id FROM platform_audit.audit_record WHERE audit_id=$1",
      [queuedCommand.auditReference],
    );
    assert.deepEqual(audit.rows[0], {
      action_code: "KITCHEN_WORK_CANCELLED",
      actor_type: "User",
      actor_reference: manager,
      reason_code: "ORDER_CANCELLED_BEFORE_PREPARATION",
      source_channel: "MERCHANT_WEB",
      target_id: queued.ticketId,
    });
    const event = await admin.query(
      "SELECT event_type,aggregate_id,aggregate_version::text AS version,payload_json FROM platform_eventing.outbox_event WHERE event_id=$1",
      [queuedCommand.eventReference],
    );
    assert.equal(event.rows[0].event_type, "KitchenWorkCancelled");
    assert.equal(event.rows[0].aggregate_id, queued.ticketId);
    assert.equal(event.rows[0].version, "3");
    assert.equal(event.rows[0].payload_json.workItems.length, 2);
    assert.equal(
      await count(
        "SELECT count(*)::int AS count FROM platform_eventing.outbox_event WHERE aggregate_id=$1 AND event_type='KitchenWorkCancelled'",
        [queued.ticketId],
      ),
      1,
    );
    // Same operation replays without writes; a different staff command is refused.
    assert.deepEqual(await scoped(queued, (tx) => cancellation(queued).cancel(tx, queuedCommand)), {
      ...created,
      status: "AlreadyCancelled",
    });
    await assert.rejects(
      scoped(queued, (tx) => cancellation(queued).cancel(tx, command(queued))),
      { code: "KITCHEN_CANCELLATION_UNAVAILABLE" },
    );
    assert.equal(
      await count(
        "SELECT count(*)::int AS count FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1",
        [queued.ticketId],
      ),
      2,
    );
    const customer = await scoped(queued, (transaction) =>
      createPostgresKitchenCustomerStatusReader({
        brandReference: queued.brandId,
        storeReference: queued.storeId,
        authorize: async () => true,
      }).loadByOrder({ transaction, orderReference: queued.orderId }),
    );
    assert.equal(customer.batches[0].status, "Cancelled");
    assert.ok(customer.batches[0].items.every((item) => item.status === "Cancelled"));
    // The queue snapshot statement reads the cancellation rows with the ticket. These synthetic
    // tickets have no creation record, so decoding then fails closed after the SQL ran.
    let snapshot;
    await scoped(queued, (tx) =>
      assert.rejects(
        createPostgresKitchenQueueSourceReader({
          brandReference: queued.brandId,
          storeReference: queued.storeId,
          maxTickets: 100,
          maxItemsPerTicket: 100,
          maxOperationsPerTicket: 1000,
          creationValidation: { references, digests: { sha256: hash } },
          lifecycleValidation: { references, digests: { sha256: hash } },
          nextSnapshotReference: next,
          authorize: async () => true,
        }).read({
          query: async (sql, values) => {
            const result = await tx.query(sql, values);
            snapshot = result.rows[0];
            return result;
          },
        }),
        { code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" },
      ),
    );
    const snapshotTicket = snapshot.tickets.find(
      (value) => value.kitchen_ticket_id === queued.ticketId,
    );
    assert.deepEqual(
      snapshotTicket.cancellations.map((value) => [
        value.before_status,
        value.result_ticket_version,
        value.operation_id,
      ]),
      [
        ["Queued", "2", queuedCommand.operationReference],
        ["Queued", "3", queuedCommand.operationReference],
      ],
    );
    // The lifecycle owner explains Cancelled from the cancellation rows: Accept is refused.
    await assert.rejects(
      lifecycle(queued, operator)("AcceptKitchenWorkItem", 2, "2026-08-09T14:11:00.000Z"),
      (error) =>
        ["KITCHEN_WORK_PRECONDITION_FAILED", "KITCHEN_WORK_VERSION_CONFLICT"].includes(error.code),
    );

    // 2. Accepted but not started still counts as not started.
    const accepted = await seed(83000, 1);
    const run = lifecycle(accepted, operator);
    assert.equal(
      (await run("AcceptKitchenWorkItem", 1, "2026-08-09T14:03:00.000Z")).outcome,
      "Accepted",
    );
    const acceptedCommand = command(accepted);
    assert.equal(
      (await scoped(accepted, (tx) => cancellation(accepted).cancel(tx, acceptedCommand))).status,
      "Cancelled",
    );
    const acceptedRow = await admin.query(
      "SELECT before_status,expected_work_item_version::text AS e,result_work_item_version::text AS r FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1",
      [accepted.ticketId],
    );
    assert.deepEqual(acceptedRow.rows[0], { before_status: "Queued", e: "2", r: "3" });
    // Start after the cancellation is refused before anything is written.
    await assert.rejects(run("StartKitchenWorkItem", 3, "2026-08-09T14:12:00.000Z"), {
      code: "KITCHEN_WORK_PRECONDITION_FAILED",
    });
    assert.equal(
      await count(
        "SELECT count(*)::int AS count FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1",
        [accepted.ticketId],
      ),
      1,
    );

    // 3. Started work refuses the whole command and writes nothing.
    const started = await seed(84000, 1);
    const startRun = lifecycle(started, operator);
    await startRun("AcceptKitchenWorkItem", 1, "2026-08-09T14:03:00.000Z");
    await startRun("StartKitchenWorkItem", 2, "2026-08-09T14:04:00.000Z");
    const startedBefore = await count(
      "SELECT count(*)::int AS count FROM platform_audit.audit_record WHERE brand_id=$1",
      [started.brandId],
    );
    await assert.rejects(
      scoped(started, (tx) => cancellation(started).cancel(tx, command(started))),
      { code: "KITCHEN_WORK_STARTED" },
    );
    assert.equal(
      await count(
        "SELECT count(*)::int AS count FROM platform_audit.audit_record WHERE brand_id=$1",
        [started.brandId],
      ),
      startedBefore,
    );
    assert.equal(
      await count(
        "SELECT count(*)::int AS count FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1",
        [started.ticketId],
      ),
      0,
    );
    const startedBatches = await scoped(started, (tx) =>
      listStoreStartedKitchenBatches(
        tx,
        { brandReference: started.brandId, storeReference: started.storeId },
        [started.orderBatchId, accepted.orderBatchId, queued.orderBatchId],
      ),
    );
    assert.deepEqual([...startedBatches], [started.orderBatchId]);

    // 4. No kitchen ticket yet: allowed without writes.
    const empty = { ...accepted, orderBatchId: id(85000) };
    assert.equal(
      (await scoped(empty, (tx) => cancellation(empty).cancel(tx, command(empty)))).status,
      "NoKitchenWork",
    );

    // 6. WP-2423 Q6 step 2: staff cancel one line; the rest of the ticket stays active and the
    // remaining line can still be prepared through ready. Order ready then counts only that line.
    const lineOf = (value, ordinal) =>
      ordinal === 1
        ? { workItemId: value.workItemId, orderItemId: value.orderItemId }
        : {
            workItemId: id(value.base + ordinal * 10 + 1),
            orderItemId: id(value.base + ordinal * 10 + 4),
          };
    const itemCommand = (value, lines, overrides = {}) => ({
      ...command(value, overrides),
      orderItemReferences: lines,
    });
    const outbox = (ticketId, type) =>
      admin.query(
        "SELECT event_id,aggregate_version::text AS version,causation_id,payload_json FROM platform_eventing.outbox_event " +
          "WHERE aggregate_id=$1 AND event_type=$2 ORDER BY aggregate_version",
        [ticketId, type],
      );
    const mixed = { ...(await seed(88000, 2)), base: 88000, expoDisabled: true };
    const mixedA = lineOf(mixed, 1);
    const mixedB = lineOf(mixed, 2);
    const mixedCommand = itemCommand(mixed, [mixedA.orderItemId]);
    const partial = await scoped(mixed, (tx) => cancellation(mixed).cancelItems(tx, mixedCommand));
    assert.equal(partial.status, "Cancelled");
    assert.equal(partial.workItemCount, 1);
    assert.deepEqual(
      await scoped(mixed, (tx) => cancellation(mixed).cancelItems(tx, mixedCommand)),
      { ...partial, status: "AlreadyCancelled" },
    );
    const mixedState = await admin.query(
      "SELECT kitchen_work_item_id,status,version::text AS version FROM rms_kitchen.kitchen_work_item " +
        "WHERE kitchen_ticket_id=$1 ORDER BY order_item_id",
      [mixed.ticketId],
    );
    assert.deepEqual(
      mixedState.rows.map((row) => [row.kitchen_work_item_id, row.status, row.version]),
      [
        [mixedA.workItemId, "Cancelled", "2"],
        [mixedB.workItemId, "Queued", "1"],
      ],
    );
    // The cancelled line refuses lifecycle commands; the other line runs to ready.
    await assert.rejects(
      lifecycle({ ...mixed, ...mixedA }, operator)(
        "AcceptKitchenWorkItem",
        2,
        "2026-08-09T14:11:00.000Z",
        2,
      ),
      { code: "KITCHEN_WORK_PRECONDITION_FAILED" },
    );
    const runB = lifecycle({ ...mixed, ...mixedB }, operator);
    assert.equal(
      (await runB("AcceptKitchenWorkItem", 1, "2026-08-09T14:11:00.000Z", 2)).outcome,
      "Accepted",
    );
    assert.equal(
      (await runB("StartKitchenWorkItem", 2, "2026-08-09T14:12:00.000Z", 3)).outcome,
      "Started",
    );
    assert.equal(
      (
        await runB("CompleteKitchenWorkItem", 3, "2026-08-09T14:13:00.000Z", 4, {
          quantityDelta: 2,
        })
      ).outcome,
      "CompletedAndOrderItemReady",
    );
    const mixedReady = await outbox(mixed.ticketId, "KitchenOrderReady");
    assert.equal(mixedReady.rows.length, 1);
    assert.equal(mixedReady.rows[0].payload_json.itemCount, 1);
    assert.equal(mixedReady.rows[0].payload_json.readyItemCount, 1);
    const mixedCustomer = await scoped(mixed, (transaction) =>
      createPostgresKitchenCustomerStatusReader({
        brandReference: mixed.brandId,
        storeReference: mixed.storeId,
        authorize: async () => true,
      }).loadByOrder({ transaction, orderReference: mixed.orderId }),
    );
    assert.equal(mixedCustomer.batches[0].status, "Ready");
    assert.deepEqual(mixedCustomer.batches[0].items, [
      { orderItemReference: mixedA.orderItemId, status: "Cancelled" },
      { orderItemReference: mixedB.orderItemId, status: "Ready" },
    ]);

    // 7. The remaining line is already ready when staff cancel the last unfinished line: the
    // cancellation itself publishes KitchenOrderReady in the same transaction.
    const late = { ...(await seed(89000, 2)), base: 89000, expoDisabled: true };
    const lateA = lineOf(late, 1);
    const lateB = lineOf(late, 2);
    const runLateB = lifecycle({ ...late, ...lateB }, operator);
    await runLateB("AcceptKitchenWorkItem", 1, "2026-08-09T14:03:00.000Z", 1);
    await runLateB("StartKitchenWorkItem", 2, "2026-08-09T14:04:00.000Z", 2);
    await runLateB("CompleteKitchenWorkItem", 3, "2026-08-09T14:05:00.000Z", 3, {
      quantityDelta: 2,
    });
    assert.equal((await outbox(late.ticketId, "KitchenOrderReady")).rows.length, 0);
    const lateCommand = itemCommand(late, [lateA.orderItemId]);
    assert.equal(
      (await scoped(late, (tx) => cancellation(late).cancelItems(tx, lateCommand))).status,
      "Cancelled",
    );
    const lateReady = await outbox(late.ticketId, "KitchenOrderReady");
    assert.equal(lateReady.rows.length, 1);
    assert.equal(lateReady.rows[0].causation_id, lateCommand.operationReference);
    assert.equal(lateReady.rows[0].version, "5");
    assert.deepEqual(lateReady.rows[0].payload_json, {
      kitchenTicketReference: late.ticketId,
      orderReference: late.orderId,
      orderBatchReference: late.orderBatchId,
      readyItemCount: 1,
      itemCount: 1,
      readyAt: lateCommand.cancelledAt,
    });

    // 8. Started is judged per line; the whole batch then refuses because a line started.
    const busy = { ...(await seed(90000, 2)), base: 90000 };
    const busyA = lineOf(busy, 1);
    const busyB = lineOf(busy, 2);
    const runBusyB = lifecycle({ ...busy, ...busyB }, operator);
    await runBusyB("AcceptKitchenWorkItem", 1, "2026-08-09T14:03:00.000Z", 1);
    await runBusyB("StartKitchenWorkItem", 2, "2026-08-09T14:04:00.000Z", 2);
    await assert.rejects(
      scoped(busy, (tx) =>
        cancellation(busy).cancelItems(tx, itemCommand(busy, [busyB.orderItemId])),
      ),
      { code: "KITCHEN_WORK_STARTED" },
    );
    assert.equal(
      (
        await scoped(busy, (tx) =>
          cancellation(busy).cancelItems(tx, itemCommand(busy, [busyA.orderItemId])),
        )
      ).status,
      "Cancelled",
    );
    await assert.rejects(
      scoped(busy, (tx) => cancellation(busy).cancel(tx, command(busy))),
      { code: "KITCHEN_WORK_STARTED" },
    );
    assert.equal(
      await scoped(busy, (tx) =>
        cancellation(busy).cancelItems(tx, itemCommand(busy, [busyA.orderItemId])),
      ).catch((error) => error.code),
      "KITCHEN_CANCELLATION_UNAVAILABLE",
    );

    // 9. Whole-batch cancellation after a line was cancelled cancels only the remaining lines.
    const rest = { ...(await seed(91000, 3)), base: 91000 };
    await scoped(rest, (tx) =>
      cancellation(rest).cancelItems(tx, itemCommand(rest, [lineOf(rest, 2).orderItemId])),
    );
    const restCommand = command(rest, { cancelledAt: "2026-08-09T14:20:00.000Z" });
    const whole = await scoped(rest, (tx) => cancellation(rest).cancel(tx, restCommand));
    assert.equal(whole.status, "Cancelled");
    assert.equal(whole.workItemCount, 2);
    assert.deepEqual(await scoped(rest, (tx) => cancellation(rest).cancel(tx, restCommand)), {
      ...whole,
      status: "AlreadyCancelled",
    });
    const restRows = await admin.query(
      "SELECT operation_id,result_ticket_version::text AS version FROM rms_kitchen.kitchen_work_cancellation " +
        "WHERE kitchen_ticket_id=$1 ORDER BY result_ticket_version",
      [rest.ticketId],
    );
    assert.deepEqual(
      restRows.rows.map((row) => [
        row.operation_id === restCommand.operationReference,
        row.version,
      ]),
      [
        [false, "2"],
        [true, "3"],
        [true, "4"],
      ],
    );
    await assert.rejects(
      scoped(rest, (tx) =>
        cancellation(rest).cancel(tx, command(rest, { cancelledAt: "2026-08-09T14:21:00.000Z" })),
      ),
      { code: "KITCHEN_CANCELLATION_UNAVAILABLE" },
    );
    const restCustomer = await scoped(rest, (transaction) =>
      createPostgresKitchenCustomerStatusReader({
        brandReference: rest.brandId,
        storeReference: rest.storeId,
        authorize: async () => true,
      }).loadByOrder({ transaction, orderReference: rest.orderId }),
    );
    assert.equal(restCustomer.batches[0].status, "Cancelled");
    const lineStates = await scoped(rest, (tx) =>
      listStoreKitchenOrderItemStates(
        tx,
        { brandReference: rest.brandId, storeReference: rest.storeId },
        [mixed.orderBatchId, busy.orderBatchId, rest.orderBatchId],
      ),
    );
    assert.equal(lineStates.get(mixedA.orderItemId), "Cancelled");
    assert.equal(lineStates.get(mixedB.orderItemId), "Started");
    assert.equal(lineStates.get(busyA.orderItemId), "Cancelled");
    assert.equal(lineStates.get(busyB.orderItemId), "Started");
    assert.ok(
      [1, 2, 3].every(
        (ordinal) => lineStates.get(lineOf(rest, ordinal).orderItemId) === "Cancelled",
      ),
    );
    const fresh = { ...(await seed(92000, 1)), base: 92000 };
    assert.equal(
      (
        await scoped(fresh, (tx) =>
          listStoreKitchenOrderItemStates(
            tx,
            { brandReference: fresh.brandId, storeReference: fresh.storeId },
            [fresh.orderBatchId],
          ),
        )
      ).get(fresh.orderItemId),
      "NotStarted",
    );

    // 5. Database guards: append-only rows, terminal Cancelled items, no lifecycle facts after
    // cancellation, and no Cancelled item without its row.
    await assert.rejects(
      admin.query(
        "UPDATE rms_kitchen.kitchen_work_cancellation SET reason_code=reason_code WHERE kitchen_ticket_id=$1",
        [queued.ticketId],
      ),
      /append-only kitchen work cancellation/u,
    );
    await assert.rejects(
      admin.query("DELETE FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1", [
        queued.ticketId,
      ]),
      /append-only kitchen work cancellation/u,
    );
    await assert.rejects(
      admin.query(
        "UPDATE rms_kitchen.kitchen_work_item SET status='Queued',version=version+1 WHERE kitchen_ticket_id=$1",
        [queued.ticketId],
      ),
      /cancelled kitchen work is terminal/u,
    );
    const acceptedOperation = await admin.query(
      "SELECT * FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1",
      [accepted.ticketId],
    );
    const copy = { ...acceptedOperation.rows[0] };
    for (const [key, value] of Object.entries(copy))
      if (value !== null && typeof value === "object" && !(value instanceof Date))
        copy[key] = JSON.stringify(value);
    Object.assign(copy, {
      kitchen_work_lifecycle_operation_id: next(),
      idempotency_key: "cancelled-work-guard-0001",
      audit_id: next(),
      outbox_event_id: next(),
    });
    const columns = Object.keys(copy);
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_kitchen.kitchen_work_lifecycle_operation (${columns.join(",")}) VALUES (${columns
          .map((_, index) => "$" + (index + 1))
          .join(",")})`,
        columns.map((column) => copy[column]),
      ),
      /cancelled kitchen work cannot change/u,
    );
    const orphan = await seed(86000, 1);
    await admin.query("BEGIN");
    try {
      await admin.query(
        "UPDATE rms_kitchen.kitchen_work_item SET status='Cancelled',version=2 WHERE kitchen_ticket_id=$1",
        [orphan.ticketId],
      );
      await assert.rejects(admin.query("COMMIT"), /needs its cancellation record/u);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
    }
    await assert.rejects(
      admin.query(
        "UPDATE rms_kitchen.kitchen_work_item SET status='Cancelled',version=version+1 WHERE kitchen_ticket_id=$1",
        [started.ticketId],
      ),
      /only kitchen work that has not started can be cancelled/u,
    );
    // Row-level security: another Store sees nothing.
    const otherStore = { ...queued, storeId: id(87000) };
    assert.equal(
      (
        await scoped(otherStore, (tx) =>
          tx.query("SELECT count(*)::int AS count FROM rms_kitchen.kitchen_work_cancellation", []),
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await connection.end();
  }
}
