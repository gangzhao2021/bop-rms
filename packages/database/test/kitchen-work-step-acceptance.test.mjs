import assert from "node:assert/strict";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { it } from "vitest";
import { createKitchenStepFixture } from "../test-support/kitchen-work-step-fixture.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const withFixture = (caseId, work) =>
  withIsolatedDatabase({ caseId }, async (context) => {
    const fixture = await createKitchenStepFixture(context, "01a14f00");
    try {
      await work(fixture);
    } finally {
      await fixture.close();
    }
  });

/**
 * DEC-KITCHEN-ONE-TAP (WP-1404's named-operator claim was a data rule, not a store workflow): a
 * second named cook (shift handover, a second tablet) finishes what the first started. Today's
 * lifecycle route, so a tablet on the previous bundle benefits too.
 */
it("a second named operator finishes what the first started, and the queue still refreshes", async () => {
  await withFixture("wp2423_ks_second", async (f) => {
    const first = f.id(0x700);
    const second = f.id(0x701);
    const { ticket, items } = await f.createTicket({ lines: 1 });
    const [item] = items;
    const command = (action, ticketVersion, itemVersion, actorReference, extra = {}) => ({
      action,
      idempotencyKey: f.next(),
      actorReference,
      ...f.scope,
      ticketReference: ticket,
      workItemReference: item.workItem,
      orderItemReference: item.orderItem,
      expectedTicketVersion: ticketVersion,
      expectedWorkItemVersion: itemVersion,
      correlationReference: f.next(),
      ...extra,
    });
    const board = f.board();
    assert.equal(await board.refresh(), 1);
    await f.lifecycleCommand(command("AcceptKitchenWorkItem", "1", "1", first));
    await f.lifecycleCommand(command("StartKitchenWorkItem", "2", "2", first));
    const done = await f.lifecycleCommand(
      command("CompleteKitchenWorkItem", "3", "3", second, { quantityDelta: 1 }),
    );
    assert.equal(done.outcome, "CompletedAndOrderItemReady");
    // Who did what stays per operation.
    assert.deepEqual(
      await f.rows(
        "SELECT action_code,actor_id::text AS actor FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1 AND actor_type='User' ORDER BY result_ticket_version",
        [ticket],
      ),
      [
        { action_code: "KITCHEN_WORK_ITEM_ACCEPTED", actor: first },
        { action_code: "KITCHEN_WORK_ITEM_STARTED", actor: first },
        { action_code: "KITCHEN_WORK_ITEM_COMPLETION_RECORDED", actor: second },
      ],
    );
    assert.equal(await board.refresh(), 1);
    assert.deepEqual(
      await f.rows(
        "SELECT p.status FROM rms_kitchen.kitchen_work_queue_projection p JOIN rms_kitchen.kitchen_work_queue_projection_generation g ON g.projection_generation_id=p.projection_generation_id WHERE g.generation_status='Active' AND p.kitchen_ticket_id=$1",
        [ticket],
      ),
      [{ status: "Completed" }],
    );
  });
});

const linesOf = ({ ticket, items }, count = items.length) =>
  items.slice(0, count).map((item) => ({ ticket, ...item }));
const operations = (f, ticket) =>
  f.rows(
    "SELECT action_code,actor_type,actor_id::text AS actor,correlation_id::text AS correlation,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at,kitchen_work_item_id::text AS item,order_item_id::text AS line FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1 ORDER BY result_ticket_version,actor_type DESC",
    [ticket],
  );

it("one tap Finish on a new dish records accept, start, complete and ready under the operator", async () => {
  await withFixture("wp2423_ks_finish", async (f) => {
    const cook = f.id(0x700);
    const round = await f.createTicket({ lines: 1, quantity: 2 });
    const correlation = f.next();
    const reply = await f.tap({
      step: "Finish",
      actor: cook,
      lines: linesOf(round),
      correlationReference: correlation,
    });
    assert.deepEqual(
      reply.lines.map((line) => [line.outcome, line.workItemStatus, line.completedQuantity]),
      [["Finished", "Completed", 2]],
    );
    assert.equal(reply.lines[0].acceptedAt, reply.occurredAt);
    assert.equal(reply.lines[0].readyAt, reply.occurredAt);
    const rows = await operations(f, round.ticket);
    assert.deepEqual(
      rows.map((row) => [row.action_code, row.actor_type, row.actor]),
      [
        ["KITCHEN_WORK_ITEM_ACCEPTED", "User", cook],
        ["KITCHEN_WORK_ITEM_STARTED", "User", cook],
        ["KITCHEN_WORK_ITEM_COMPLETION_RECORDED", "User", cook],
        ["KITCHEN_ORDER_ITEM_READY", "System", null],
      ],
    );
    // One tap: one correlation, one instant. An implied Start is one sharing its correlation and
    // instant with a Complete, so any preparation-time figure can leave it out.
    assert.deepEqual([...new Set(rows.map((row) => row.at))], [reply.occurredAt]);
    assert.deepEqual([...new Set(rows.map((row) => row.correlation))], [correlation]);
    // The same facts as three taps: an audit row per operation, the lifecycle events in order.
    const audits = await f.rows(
      "SELECT action_code,actor_reference::text AS actor FROM platform_audit.audit_record WHERE correlation_id=$1 ORDER BY chain_sequence",
      [correlation],
    );
    assert.deepEqual(
      audits.map((row) => row.action_code),
      [
        "KITCHEN_WORK_ITEM_ACCEPTED",
        "KITCHEN_WORK_ITEM_STARTED",
        "KITCHEN_WORK_ITEM_COMPLETION_RECORDED",
        "KITCHEN_ORDER_ITEM_READY",
      ],
    );
    const events = await f.rows(
      "SELECT event_type FROM platform_eventing.outbox_event WHERE correlation_id=$1 ORDER BY aggregate_version,event_id",
      [correlation],
    );
    assert.deepEqual(
      events.map((row) => row.event_type).filter((type) => !type.endsWith("Ready")),
      ["KitchenWorkAccepted", "KitchenWorkStarted", "KitchenItemCompleted"],
    );
    assert.deepEqual(
      events
        .map((row) => row.event_type)
        .filter((type) => type.endsWith("Ready"))
        .sort(),
      ["KitchenItemReady", "KitchenOrderReady"],
    );
    // The board reads what was recorded.
    const board = f.board();
    assert.equal(await board.refresh(), 1);
  });
});

it("an explicit Start stays distinguishable from a Start implied by a one-tap finish", async () => {
  await withFixture("wp2423_ks_start", async (f) => {
    const cook = f.id(0x700);
    const round = await f.createTicket({ lines: 2 });
    const [wok, drink] = linesOf(round);
    const started = await f.tap({ step: "Start", actor: cook, lines: [wok] });
    assert.equal(started.lines[0].outcome, "Started");
    assert.equal(started.lines[0].workItemStatus, "In Progress");
    assert.equal(
      (await f.tap({ step: "Start", actor: cook, lines: [wok] })).lines[0].outcome,
      "AlreadyStarted",
    );
    await f.tap({ step: "Finish", actor: cook, lines: [wok, drink] });
    const implied = await f.rows(
      "SELECT s.kitchen_work_item_id::text AS item FROM rms_kitchen.kitchen_work_lifecycle_operation s WHERE s.kitchen_ticket_id=$1 AND s.action_code='KITCHEN_WORK_ITEM_STARTED' AND EXISTS (SELECT 1 FROM rms_kitchen.kitchen_work_lifecycle_operation c WHERE c.kitchen_work_item_id=s.kitchen_work_item_id AND c.action_code='KITCHEN_WORK_ITEM_COMPLETION_RECORDED' AND c.correlation_id=s.correlation_id AND c.occurred_at=s.occurred_at)",
      [round.ticket],
    );
    assert.deepEqual(
      implied.map((row) => row.item),
      [drink.workItem],
    );
  });
});

it("a replay of the same tap changes nothing", async () => {
  await withFixture("wp2423_ks_replay", async (f) => {
    const cook = f.id(0x700);
    const round = await f.createTicket({ lines: 2 });
    const lines = linesOf(round).map((line) => ({ ...line, key: f.next() }));
    const correlation = f.next();
    const tap = () =>
      f.tap({ step: "Finish", actor: cook, lines, correlationReference: correlation });
    const first = await tap();
    assert.deepEqual(
      first.lines.map((line) => line.outcome),
      ["Finished", "Finished"],
    );
    const counted = () =>
      f.rows(
        "SELECT (SELECT count(*)::int FROM rms_kitchen.kitchen_work_lifecycle_operation WHERE kitchen_ticket_id=$1) AS operations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE correlation_id=$2) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE correlation_id=$2) AS events",
        [round.ticket, correlation],
      );
    const before = await counted();
    const replay = await tap();
    assert.deepEqual(
      replay.lines.map((line) => line.outcome),
      ["AlreadyFinished", "AlreadyFinished"],
    );
    assert.deepEqual(await counted(), before);
  });
});

/**
 * The browser used to send the versions it read, so any step on a ticket gave another screen on it a
 * conflict until its next read (up to 10 s). Two taps now serialize on the ticket's row lock.
 */
it("two section screens finish their own dishes of one ticket without a refresh", async () => {
  await withFixture("wp2423_ks_screens", async (f) => {
    const round = await f.createTicket({ lines: 2 });
    const [drink, snack] = linesOf(round);
    // Today's route, with the versions both screens read: the second is refused.
    const stale = (line, actorReference) => ({
      action: "AcceptKitchenWorkItem",
      idempotencyKey: f.next(),
      actorReference,
      ...f.scope,
      ticketReference: round.ticket,
      workItemReference: line.workItem,
      orderItemReference: line.orderItem,
      expectedTicketVersion: "1",
      expectedWorkItemVersion: "1",
      correlationReference: f.next(),
    });
    await f.lifecycleCommand(stale(drink, f.id(0x700)));
    await assert.rejects(f.lifecycleCommand(stale(snack, f.id(0x701))), {
      code: "KITCHEN_WORK_VERSION_CONFLICT",
    });
    // Both tablets tap together while something else holds the ticket: both wait, both record.
    const holder = await f.connect();
    await holder.query("BEGIN");
    await holder.query(
      "SELECT 1 FROM rms_kitchen.kitchen_ticket WHERE kitchen_ticket_id=$1 FOR NO KEY UPDATE",
      [round.ticket],
    );
    const taps = [
      f.tap({ step: "Finish", actor: f.id(0x700), lines: [drink] }),
      f.tap({ step: "Finish", actor: f.id(0x701), lines: [snack] }),
    ];
    assert.equal(await f.someoneWaits(), true);
    await holder.query("COMMIT");
    await holder.end();
    const [first, second] = await Promise.all(taps);
    assert.equal(first.lines[0].outcome, "Finished");
    assert.equal(second.lines[0].outcome, "Finished");
    const rows = await operations(f, round.ticket);
    const actorsOf = (line) =>
      rows.filter((row) => row.item === line.workItem && row.actor).map((row) => row.actor);
    assert.deepEqual(actorsOf(drink), [f.id(0x700), f.id(0x700), f.id(0x700)]);
    assert.deepEqual(actorsOf(snack), [f.id(0x701), f.id(0x701), f.id(0x701)]);
  });
});

it("a dish cancelled after the screen read is left out and the rest of the tap commits", async () => {
  await withFixture("wp2423_ks_cancelled", async (f) => {
    const { createPostgresKitchenBatchCancellation } =
      await import("../../rms/kitchen/src/index.ts");
    const round = await f.createTicket({ lines: 2 });
    const [gone, kept] = linesOf(round);
    const manager = f.id(0x702);
    const cancellation = createPostgresKitchenBatchCancellation({
      ...f.scope,
      tenantReference: f.tenant,
      authorize: async () => true,
    });
    await f.as((transaction) =>
      cancellation.cancelItems(transaction, {
        orderReference: round.order,
        orderBatchReference: round.batch,
        orderItemReferences: [gone.orderItem],
        operationReference: f.next(),
        orderCancellationReference: f.next(),
        actorReference: manager,
        cancelledAt: new Date(Date.now() - 60_000).toISOString(),
        auditReference: f.next(),
        eventReference: f.next(),
        nextReference: f.next,
      }),
    );
    const reply = await f.tap({ step: "Finish", actor: f.id(0x700), lines: [gone, kept] });
    assert.deepEqual(
      reply.lines.map((line) => [line.outcome, line.refusedReason]),
      [
        ["Refused", "Cancelled"],
        ["Finished", null],
      ],
    );
    assert.equal(
      (await operations(f, round.ticket)).filter((row) => row.item === gone.workItem).length,
      0,
    );
  });
});

it("a closed ticket is refused, and a line that does not match its ticket names no work", async () => {
  await withFixture("wp2423_ks_closed", async (f) => {
    const { createPostgresKitchenStaleTicketStore } =
      await import("../../rms/kitchen/src/index.ts");
    const round = await f.createTicket({ lines: 1, createdAgoMs: 2 * 86_400_000 });
    const other = await f.createTicket({ lines: 1, order: round.order });
    const [line] = linesOf(round);
    assert.deepEqual(
      (
        await f.tap({
          step: "Finish",
          actor: f.id(0x700),
          lines: [{ ...line, orderItem: linesOf(other)[0].orderItem }],
        })
      ).lines.map((entry) => [entry.outcome, entry.refusedReason]),
      [["Refused", "NotFound"]],
    );
    const stale = createPostgresKitchenStaleTicketStore({ ...f.scope, nextReference: f.next });
    await f.as((transaction) =>
      stale.close(transaction, {
        command: {
          idempotencyKey: f.next(),
          ticketReference: round.ticket,
          expectedTicketVersion: "1",
          reasonCode: "NOT_MADE_ABANDONED",
          correlationReference: f.next(),
        },
        actorReference: f.id(0x702),
        occurredAt: new Date().toISOString(),
        businessDays: async () => ({
          orderBusinessDate: "2026-10-09",
          currentBusinessDate: "2026-10-14",
        }),
      }),
    );
    const reply = await f.tap({ step: "Finish", actor: f.id(0x700), lines: [line] });
    assert.deepEqual(
      reply.lines.map((entry) => [entry.outcome, entry.refusedReason]),
      [["Refused", "Closed"]],
    );
    // A stale source reads as a refusal staff can act on, and an impossible body is a 400.
    const moved = await f.tap({
      step: "Finish",
      actor: f.id(0x700),
      lines: linesOf(other),
      validateTicketSource: async () => false,
    });
    assert.deepEqual(
      moved.lines.map((entry) => [entry.outcome, entry.refusedReason]),
      [["Refused", "OrderChanged"]],
    );
    const otherOrder = await f.createTicket({ lines: 1 });
    await assert.rejects(
      f.tap({
        step: "Finish",
        actor: f.id(0x700),
        lines: [...linesOf(other), ...linesOf(otherOrder)],
      }),
      { code: "KITCHEN_WORK_INPUT_INVALID" },
    );
  });
});

/**
 * Repository lock order is Ordering, then Kitchen. A step holding its ticket while it waited for the
 * Order's fence would deadlock a staff item cancellation holding the fence and waiting for the ticket.
 */
it("a kitchen step and a staff item cancellation on one Order do not deadlock", async () => {
  await withFixture("wp2423_ks_lockorder", async (f) => {
    const { createPostgresKitchenBatchCancellation } =
      await import("../../rms/kitchen/src/index.ts");
    const { acquireOrderDispositionFence } = await import("../../rms/ordering/src/index.ts");
    const round = await f.createTicket({ lines: 2 });
    const [gone, kept] = linesOf(round);
    const fence = (transaction) =>
      acquireOrderDispositionFence(transaction, { ...f.scope, orderReference: round.order });
    let cancelHoldsFence;
    const holdsFence = new Promise((resolve) => {
      cancelHoldsFence = resolve;
    });
    let stepWaits;
    const proceed = new Promise((resolve) => {
      stepWaits = resolve;
    });
    const cancellation = createPostgresKitchenBatchCancellation({
      ...f.scope,
      tenantReference: f.tenant,
      authorize: async () => true,
    });
    const cancelled = f.as(async (transaction) => {
      await fence(transaction);
      cancelHoldsFence();
      await proceed;
      return cancellation.cancelItems(transaction, {
        orderReference: round.order,
        orderBatchReference: round.batch,
        orderItemReferences: [gone.orderItem],
        operationReference: f.next(),
        orderCancellationReference: f.next(),
        actorReference: f.id(0x702),
        cancelledAt: new Date().toISOString(),
        auditReference: f.next(),
        eventReference: f.next(),
        nextReference: f.next,
      });
    });
    await holdsFence;
    const stepped = f.tap({
      step: "Finish",
      actor: f.id(0x700),
      lines: [gone, kept],
      validateTicketSource: async (transaction) => {
        await fence(transaction);
        return true;
      },
    });
    // The step waits for the fence, holding no Kitchen lock, while the cancellation takes the ticket.
    assert.equal(await f.someoneWaits(), true);
    stepWaits();
    assert.equal((await cancelled).status, "Cancelled");
    const reply = await stepped;
    assert.deepEqual(
      reply.lines.map((line) => [line.outcome, line.refusedReason]),
      [
        ["Refused", "Cancelled"],
        ["Finished", null],
      ],
    );
  });
});

/**
 * The real serialization point is the Store-wide audit head: from a chunk's first recorded fact to
 * its commit, payments, acceptance, serving and the other tablets wait behind it (lock timeout 2 s).
 * A big tap runs in chunks, so another Store command gets through between them.
 */
it("a 20-dish finish lets another Store command through", async () => {
  await withFixture("wp2423_ks_auditlock", async (f) => {
    const { appendAuditRecordInTransaction } = await import("../../bop/audit/src/index.ts");
    const round = await f.createTicket({ lines: 20 });
    const chunks = [];
    let tapping = true;
    const waits = [];
    const other = (async () => {
      // Another Store command appending to the same audit chain, again and again.
      while (tapping) {
        const startedAt = performance.now();
        await f.as((transaction) =>
          appendAuditRecordInTransaction(transaction, {
            auditId: f.next(),
            brandId: f.brand,
            storeId: f.store,
            actor: { type: "System" },
            actionCode: "KITCHEN_ORDER_ITEM_READY",
            targetType: "KitchenOrderItem",
            targetId: f.next(),
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "ALL_WORK_ITEMS_COMPLETED",
            correlationId: f.next(),
            occurredAt: new Date().toISOString(),
            sourceChannel: "KITCHEN_AUTOMATION",
            dataClassification: "Confidential",
            retentionPolicyCode: "KITCHEN_WORK_LIFECYCLE",
            retentionPolicyVersion: 1,
          }),
        );
        waits.push(performance.now() - startedAt);
      }
    })();
    const reply = await f.tap({
      step: "Finish",
      actor: f.id(0x700),
      lines: linesOf(round),
      onChunk: (chunk) => chunks.push(chunk),
    });
    tapping = false;
    await other;
    assert.equal(reply.lines.filter((line) => line.outcome === "Finished").length, 20);
    assert.deepEqual(
      chunks.map((chunk) => chunk.lines),
      [8, 8, 4],
    );
    const hold = Math.max(...chunks.map((chunk) => chunk.auditHeadHeldMs));
    console.info(
      "kitchen step audit head hold per chunk (ms): " +
        chunks.map((chunk) => Math.round(chunk.auditHeadHeldMs)).join(", ") +
        "; another Store command waited at most " +
        Math.round(Math.max(...waits)) +
        " ms over " +
        waits.length +
        " runs",
    );
    // The lock timeout other Store commands live with.
    assert.ok(hold < 2_000, "audit head held " + hold + " ms");
    assert.ok(waits.length > chunks.length);
  });
});
