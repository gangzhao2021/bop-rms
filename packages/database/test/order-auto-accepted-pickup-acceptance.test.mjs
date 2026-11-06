import nodeConsole from "node:console";
import { it, vi } from "vitest";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";
import {
  createPostgresStaffOrderCancellationReader,
  listStoreOpenAutoAcceptedBatches,
  listStoreOrderAutoAcceptanceSkipsByOrder,
} from "../../rms/ordering/src/index.ts";
import { loadKitchenScreenSeenAt } from "../../rms/kitchen/src/index.ts";
import {
  createMerchantOrderStaffCancellation,
  createMerchantOrderStaffCancellationPreview,
} from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import {
  createMerchantPaidOrderKeep,
  readPaidOrderRefundTimes,
  readPaidOrderWatch,
} from "../../../apps/api/src/merchant-paid-order-watch.ts";
import { createMerchantKitchenScreenPresence } from "../../../apps/api/src/merchant-store-presence.ts";
import { readTonightFacts } from "../../../apps/api/src/merchant-tonight-summary.ts";
import {
  createOrderAutoAcceptedPickupExpiry,
  createOrderAutoAcceptedPickupSweep,
} from "../../../apps/api/src/order-auto-accepted-pickup-expiry.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT, the backstop and everything a Store does about it. Under the
 * restricted NOBYPASSRLS role with the rendered pilot ACL, real Orders paid online, the worker's paid
 * outcome as the pilot composes it, and kitchen tickets with every CHECK and trigger in force.
 */
const on = async (world) => {
  await world.setting.change({
    pickup: true,
    dineIn: false,
    at: world.time(-world.minutes(240)),
  });
  await world.kitchenScreen.seenNow();
};
/** A pickup the System sent this long ago, on the worker's clock of the time. */
const sentAgo = async (world, minutesAgo, input = {}) => {
  const order = await world.seedPaidPickup({ paidMinutesAgo: minutesAgo + 1, ...input });
  world.clock.offset = -world.minutes(minutesAgo);
  try {
    world.assert.equal(
      (await world.transactions().run((tx) => world.paid.consume(tx, order.event))).result.status,
      "OrderConfirmed",
    );
  } finally {
    world.clock.offset = 0;
  }
  return order;
};
const expiryOf = (world) =>
  createOrderAutoAcceptedPickupExpiry({
    scope: world.ownerScope,
    systemActorReference: world.systemActor,
    transactions: world.worker(),
    now: world.now,
    newReference: world.fresh,
    authorize: async () => true,
    resolveRefundConfiguration: async () => ({
      providerAccountReference: world.provider,
      environment: "Test",
    }),
  });
const openBatch = async (world, order) =>
  (
    await world.worker().run((tx) =>
      listStoreOpenAutoAcceptedBatches(tx, world.scope, {
        since: world.time(-world.minutes(600)),
        limit: 200,
        onlyPickup: true,
      }),
    )
  ).find((batch) => batch.orderBatchReference === order.orderBatchReference);
const cancellationOf = (world, order) =>
  world.query(
    "SELECT permission_code,actor_id,reason_code,refund_disposition,expected_order_version::int AS expected FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
    [order.orderBatchReference],
  );
const installContext = async (tx, selected) => {
  await tx.query(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
    [selected.tenantReference, selected.brandReference, selected.storeReference],
  );
};
const cantMakeFor = (world, staff) => {
  const options = {
    persistence: { ...staff.persistence, now: world.now },
    authentication: staff.authentication,
    nextReference: world.fresh,
    autoAcceptedOnly: true,
    installContext,
    resolveRefundConfiguration: async () => ({
      providerAccountReference: world.provider,
      environment: "Test",
    }),
  };
  const refuse = createMerchantOrderStaffCancellation(options);
  const preview = createMerchantOrderStaffCancellationPreview(options);
  const session = { sessionCookie: staff.sessionCookie, csrf: staff.csrf };
  return {
    refuse: (order, version = 2, reasonCode = "SOLD_OUT") =>
      refuse({
        ...session,
        command: {
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          expectedOrderVersion: version,
          operationReference: world.fresh(),
          reasonCode,
        },
      }),
    preview: (order, version = 2) =>
      preview({
        ...session,
        command: {
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          expectedOrderVersion: version,
        },
      }),
  };
};
const queueFor = (world, staff) => {
  const queue = createPersistentMerchantOrderQueue({
    persistence: { ...staff.persistence, now: world.now },
    quoteVersion: 1,
    acceptanceConfigured: true,
  });
  return () => queue({ sessionCookie: staff.sessionCookie, afterOrderReference: null });
};

it("the Store offline at a pickup's refund time: no refund, and a host back after an hour refunds nothing until staff are back", async () => {
  await withAutoAcceptWorld(
    { caseId: "wp2423_aap_offline", orderType: "Pickup" },
    async (world) => {
      const { assert, scope } = world;
      await on(world);
      // Sent over an hour ago, when the screens were on, and untouched since: the network dropped,
      // or the host went down, before their time came (last seen at 66 minutes ago).
      const first = await sentAgo(world, 70);
      const second = await sentAgo(world, 65);
      await world.staffSeen(new Date(Date.now() - world.minutes(66)).toISOString());
      const expiry = expiryOf(world);
      // The first sweep after the host comes back finds nothing, before any screen has reconnected.
      assert.deepEqual((await expiry.listDue(10)).due, []);
      // Not even when it is asked directly, as a sweep that listed it a moment earlier would.
      assert.equal(await expiry.close(await openBatch(world, first)), "NotDue");
      assert.deepEqual(await cancellationOf(world, first), []);
      // No countdown either while no screen can see it.
      const watching = await world.worker().run((tx) => readPaidOrderWatch(tx, scope, world.now()));
      assert.deepEqual(
        watching.waiting.map((item) => item.refundAt),
        [null, null],
      );
      // The first screen back, 16 minutes ago: a new time for each, 15 minutes after it.
      const backAt = new Date(Date.now() - world.minutes(16)).toISOString();
      await world.staffSeen(backAt);
      await world.staffOnSince(12);
      const refundAt = new Date(Date.parse(backAt) + world.minutes(15)).toISOString();
      // A minute after they came back: warnings on every screen, and nothing refunded yet.
      const justBack = new Date(Date.parse(backAt) + world.minutes(1)).toISOString();
      assert.deepEqual(
        (await world.worker().run((tx) => readPaidOrderRefundTimes(tx, scope, justBack))).map(
          (item) => item.acceptBy,
        ),
        [refundAt, refundAt],
      );
      const expiryThen = createOrderAutoAcceptedPickupExpiry({
        scope: world.ownerScope,
        systemActorReference: world.systemActor,
        transactions: world.worker(),
        now: () => justBack,
        newReference: world.fresh,
        authorize: async () => true,
      });
      assert.deepEqual((await expiryThen.listDue(10)).due, []);
      // Staff still on when the window ended: now it refunds, and the guest is not left waiting.
      const { due } = await expiry.listDue(10);
      assert.deepEqual(
        due.map((batch) => batch.orderBatchReference),
        [first.orderBatchReference, second.orderBatchReference],
      );
      assert.equal(await expiry.close(due[0]), "Closed");
      assert.equal((await cancellationOf(world, first)).length, 1);
    },
  );
});

it("a line cancelled since it was accepted leaves it closable, and refusals are said by code without holding the rest back", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_moved", orderType: "Pickup" }, async (world) => {
    const { assert } = world;
    await on(world);
    const moved = await sentAgo(world, 34);
    const stuck = await sentAgo(world, 33);
    const third = await sentAgo(world, 32);
    await world.staffOnSince(8);
    const expiry = expiryOf(world);
    // A manager took a line off at minute 10: the Order moved past the version the System accepted.
    await world.moveOrderVersion(moved);
    const listed = await openBatch(world, moved);
    assert.equal(listed.acceptedOrderVersion, 2);
    assert.equal(await expiry.close(listed), "Closed");
    const [record] = await cancellationOf(world, moved);
    assert.equal(record.expected, 3);
    assert.equal(record.refund_disposition, "Refund");
    // A state nothing explains: a real refusal, reported by its code, never a quiet "not due".
    await world.moveOrderVersion(stuck, { recordless: true });
    await assert.rejects(expiry.close(await openBatch(world, stuck)), {
      code: "STAFF_ORDER_CANCELLATION_CONFLICT",
    });
    // A pickup that can't close does not hold the page: the next pass carries on past it.
    const failures = [];
    const sweep = createOrderAutoAcceptedPickupSweep({
      expiry,
      now: world.now,
      pageSize: 1,
      onFailure: (code) => failures.push(code),
    });
    assert.equal(await sweep.runOnce(), 0);
    assert.deepEqual(failures, ["STAFF_ORDER_CANCELLATION_CONFLICT"]);
    assert.equal(await sweep.runOnce(), 1);
    assert.equal((await cancellationOf(world, third)).length, 1);
    // Back round to it: it waits longer each time, and is not asked again every 15 seconds.
    assert.equal(await sweep.runOnce(), 0);
    assert.deepEqual(failures, ["STAFF_ORDER_CANCELLATION_CONFLICT"]);
  });
});

it("on a real ticket: the System close says System, Can't make it says who, and a kitchen step stops both", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_ticket", orderType: "Pickup" }, async (world) => {
    const { assert, query, seedKitchenTicket, kitchenStep, systemActor } = world;
    await on(world);
    const closing = await sentAgo(world, 45);
    const working = await sentAgo(world, 44);
    // Before anything returns stock: the ledger reads forward in time.
    const given = await sentAgo(world, 1);
    const started = await sentAgo(world, 1);
    await world.staffOnSince(20);
    const closingTicket = await seedKitchenTicket(closing);
    const workingTicket = await seedKitchenTicket(working);
    const expiry = expiryOf(world);
    // A kitchen with Done as its only step (Accept, Start and Complete recorded by one tap), 11
    // minutes ago: the ticket it finished stops, and one it hasn't reached waits while it works.
    world.clock.offset = -world.minutes(11);
    await kitchenStep(workingTicket, "AcceptKitchenWorkItem");
    await kitchenStep(workingTicket, "StartKitchenWorkItem");
    await kitchenStep(workingTicket, "CompleteKitchenWorkItem", { extra: { quantityDelta: 1 } });
    world.clock.offset = 0;
    const whileWorking = new Date(Date.now() - world.minutes(8)).toISOString();
    const expiryThen = createOrderAutoAcceptedPickupExpiry({
      scope: world.ownerScope,
      systemActorReference: systemActor,
      transactions: world.worker(),
      now: () => whileWorking,
      newReference: world.fresh,
      authorize: async () => true,
    });
    assert.deepEqual((await expiryThen.listDue(10)).due, []);
    assert.equal(await expiryThen.close(await openBatch(world, closing)), "NotDue");
    // Ten minutes of silence after that last step: nobody is coming to it.
    const { due } = await expiry.listDue(10);
    assert.deepEqual(
      due.map((batch) => batch.orderBatchReference),
      [closing.orderBatchReference],
    );
    assert.equal(await expiry.close(due[0]), "Closed");
    // Every kitchen item cancelled, in the same transaction as the record the refund reads.
    assert.deepEqual(
      await query("SELECT status FROM rms_kitchen.kitchen_work_item WHERE kitchen_ticket_id=$1", [
        closingTicket.ticket,
      ]),
      [{ status: "Cancelled" }],
    );
    assert.equal((await cancellationOf(world, closing))[0].actor_id, systemActor);
    // Its history says what happened: nobody on the merchant web, no person's name.
    assert.deepEqual(
      await query(
        "SELECT actor_type,actor_reference,source_channel FROM platform_audit.audit_record WHERE action_code='KITCHEN_WORK_CANCELLED' AND target_id=$1",
        [closingTicket.ticket],
      ),
      [{ actor_type: "System", actor_reference: null, source_channel: "EVENT_CONSUMER" }],
    );
    assert.deepEqual(
      await query(
        "SELECT actor_type,actor_id FROM platform_eventing.outbox_event WHERE event_type='KitchenWorkCancelled' AND aggregate_id=$1",
        [closingTicket.ticket],
      ),
      [{ actor_type: "System", actor_id: null }],
    );
    // The one row that requires a person holds the reserved System actor (2000_024's constraints).
    assert.deepEqual(
      await query(
        "SELECT actor_type,actor_id FROM rms_kitchen.kitchen_work_cancellation WHERE kitchen_ticket_id=$1",
        [closingTicket.ticket],
      ),
      [{ actor_type: "User", actor_id: systemActor }],
    );

    // A person's Can't make it on a real ticket says who, from where.
    const staff = await world.session([], "01a6aa21");
    const { refuse } = cantMakeFor(world, staff);
    const givenTicket = await seedKitchenTicket(given);
    assert.equal((await refuse(given)).status, "Cancelled");
    assert.deepEqual(
      await query(
        "SELECT actor_type,actor_reference,source_channel FROM platform_audit.audit_record WHERE action_code='KITCHEN_WORK_CANCELLED' AND target_id=$1",
        [givenTicket.ticket],
      ),
      [{ actor_type: "User", actor_reference: staff.actor, source_channel: "MERCHANT_WEB" }],
    );
    assert.deepEqual(
      await query(
        "SELECT actor_type,actor_id FROM platform_eventing.outbox_event WHERE event_type='KitchenWorkCancelled' AND aggregate_id=$1",
        [givenTicket.ticket],
      ),
      [{ actor_type: "Actor", actor_id: staff.actor }],
    );
    // Marked started: Can't make it stops there.
    const startedTicket = await seedKitchenTicket(started);
    await kitchenStep(startedTicket, "AcceptKitchenWorkItem");
    await kitchenStep(startedTicket, "StartKitchenWorkItem");
    await world.assert.rejects(refuse(started), { code: "ORDER_CANCELLATION_PREPARATION_STARTED" });
  });
});

it("nothing left to refund: Can't make it and the System close still end it, and owe nothing", async () => {
  await withAutoAcceptWorld(
    { caseId: "wp2423_aap_refunded", orderType: "Pickup" },
    async (world) => {
      const { assert, scope, transactions } = world;
      await on(world);
      const closing = await sentAgo(world, 33);
      await world.staffOnSince(8);
      const handGiven = await sentAgo(world, 1);
      const partly = await sentAgo(world, 1);
      // TEST-ONLY money fixture: what Payment reads as already given back in full, or in part.
      await world.seedCardMachinePayment(closing, { refundedMinor: "All" });
      const { total } = await world.seedCardMachinePayment(handGiven, { refundedMinor: "All" });
      await world.seedCardMachinePayment(partly, { refundedMinor: 500n });
      const staff = await world.session([], "01a6aa22");
      const { refuse, preview } = cantMakeFor(world, staff);
      // The dialog is told what is true before anyone taps.
      assert.deepEqual(await preview(handGiven), {
        orderReference: handGiven.orderReference,
        orderBatchReference: handGiven.orderBatchReference,
        refundMethod: "CardMachine",
        paidMinor: total.toString(),
        refundMinor: "0",
        currencyCode: "CAD",
      });
      assert.equal((await preview(partly)).refundMinor, (total - 500n).toString());
      // Offered, because the ticket stays live and the stock reserved until someone ends it.
      const row = (await queueFor(world, staff)()).items.find(
        (item) => item.orderReference === handGiven.orderReference,
      );
      assert.equal(row.batches[0].canCantMake, true);
      assert.equal((await refuse(handGiven)).status, "Cancelled");
      assert.equal(
        (await cancellationOf(world, handGiven))[0].refund_disposition,
        "AlreadyRefunded",
      );
      assert.equal(
        await transactions().run((transaction) =>
          createPostgresStaffOrderCancellationReader(scope).loadCompensationByPaymentEvent({
            transaction,
            paymentEventReference: handGiven.event.eventId,
          }),
        ),
        null,
      );
      // The System close ends the same state instead of repeating "not due" for a day.
      const expiry = expiryOf(world);
      const { due } = await expiry.listDue(10);
      assert.deepEqual(
        due.map((batch) => batch.orderBatchReference),
        [closing.orderBatchReference],
      );
      assert.equal(await expiry.close(due[0]), "Closed");
      assert.equal((await cancellationOf(world, closing))[0].refund_disposition, "AlreadyRefunded");
      assert.deepEqual((await expiry.listDue(10)).due, []);
    },
  );
});

it("a round the kitchen does not make is not Can't make it's, and a person's preview refuses what isn't automatic", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_served", orderType: "Pickup" }, async (world) => {
    const { assert } = world;
    await on(world);
    const staff = await world.session([], "01a6aa23");
    const { refuse, preview } = cantMakeFor(world, staff);
    // Bottled drinks: no ticket, counted as served once ordered, in the guest's hand.
    const bottled = await sentAgo(world, 1);
    await world.seedNotPrepared(bottled);
    await assert.rejects(refuse(bottled), { code: "ORDER_CANCELLATION_NOT_CANCELLABLE" });
    await assert.rejects(preview(bottled), { code: "ORDER_CANCELLATION_NOT_CANCELLABLE" });
    assert.deepEqual(await cancellationOf(world, bottled), []);
    const view = await queueFor(world, staff)();
    const row = view.items.find((item) => item.orderReference === bottled.orderReference);
    assert.equal(row.batches[0].canCantMake, false);
    assert.equal(row.batches[0].canKeep, false);
    assert.equal(row.batches[0].reachedKitchen, true);
    // It is not waiting for anyone, so nothing warns about it.
    assert.deepEqual(view.paidOrderWatch.waiting, []);
  });
});

it("Making it by hand stops the automatic refund: recorded, in a name, and only for what it applies to", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_keep", orderType: "Pickup" }, async (world) => {
    const { assert, query, fresh, scope } = world;
    await on(world);
    // A ticket that never arrived, and a dead board: nothing on the kitchen side can stop it.
    const noTicket = await sentAgo(world, 33);
    const deadBoard = await sentAgo(world, 32);
    // Before anything returns stock: the ledger reads forward in time.
    const ordinary = await world.seedPaidPickup();
    await world.staffOnSince(8);
    await world.seedKitchenTicket(deadBoard);
    const staff = await world.session([], "01a6aa24");
    const list = queueFor(world, staff);
    const keep = createMerchantPaidOrderKeep({
      persistence: { ...staff.persistence, now: world.now },
      authentication: staff.authentication,
      now: world.now,
      nextReference: fresh,
    });
    const say = (order) =>
      keep({
        sessionCookie: staff.sessionCookie,
        csrf: staff.csrf,
        command: {
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
        },
      });
    const expiry = expiryOf(world);
    assert.equal((await expiry.listDue(10)).due.length, 2);
    const before = (await list()).items.find(
      (item) => item.orderReference === noTicket.orderReference,
    );
    assert.equal(before.batches[0].canKeep, true);
    assert.equal(before.batches[0].kept, false);
    assert.equal(before.batches[0].reachedKitchen, false);
    assert.deepEqual(await say(noTicket), { status: "Kept" });
    // Twice is once, and the first name stays.
    assert.deepEqual(await say(noTicket), { status: "AlreadyKept" });
    assert.deepEqual(
      await query(
        "SELECT actor_id FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1 AND outcome='Kept'",
        [noTicket.orderBatchReference],
      ),
      [{ actor_id: staff.actor }],
    );
    assert.deepEqual(
      await query(
        "SELECT actor_type,actor_reference,reason_code,source_channel,retention_policy_code FROM platform_audit.audit_record WHERE action_code='ORDER_AUTOMATIC_REFUND_STOPPED' AND target_id=$1",
        [noTicket.orderReference],
      ),
      [
        {
          actor_type: "User",
          actor_reference: staff.actor,
          reason_code: "STAFF_MAKING_BY_HAND",
          source_channel: "MERCHANT_WEB",
          retention_policy_code: "FINANCIAL_COMPLIANCE",
        },
      ],
    );
    // The System leaves it alone, even if it already had it in hand when the person tapped.
    const kept = await openBatch(world, noTicket);
    assert.equal(kept.kept, true);
    assert.deepEqual(
      (await expiry.listDue(10)).due.map((batch) => batch.orderBatchReference),
      [deadBoard.orderBatchReference],
    );
    assert.equal(await expiry.close(kept), "NotDue");
    assert.deepEqual(await cancellationOf(world, noTicket), []);
    // No countdown and no alarm for it any more; the row says so.
    const view = await list();
    const item = view.paidOrderWatch.waiting.find(
      (entry) => entry.orderNumber === before.orderNumber,
    );
    assert.equal(item.kept, true);
    assert.equal(item.refundAt, null);
    const row = view.items.find((entry) => entry.orderReference === noTicket.orderReference);
    assert.equal(row.batches[0].kept, true);
    assert.equal(row.batches[0].canKeep, false);
    // A person can still give it back: they found they can't make it after all.
    assert.equal(row.batches[0].canCantMake, true);
    assert.equal((await cantMakeFor(world, staff).refuse(noTicket)).status, "Cancelled");
    // Gone, nothing to keep: said as such, nothing written.
    await assert.rejects(say(noTicket), { code: "PAID_ORDER_KEEP_NOT_KEEPABLE" });
    // Not for one a person accepted: there is no automatic refund of this kind to stop.
    await world.setting.change({ pickup: false, dineIn: false });
    await world.transactions().run((tx) => world.paid.consume(tx, ordinary.event));
    await assert.rejects(say(ordinary), { code: "PAID_ORDER_KEEP_NOT_KEEPABLE" });
    // The database holds the same line, whatever a caller asks of it.
    await assert.rejects(
      world
        .worker()
        .run((tx) =>
          tx.query(
            "INSERT INTO rms_ordering.order_auto_acceptance_decision (decision_id,brand_id,store_id,order_id,order_batch_id,outcome,setting_version,acceptance_id,actor_id,decided_at) VALUES ($1,$2,$3,$4,$5,'Kept',1,NULL,$6,$7)",
            [
              fresh(),
              scope.brandReference,
              scope.storeReference,
              ordinary.orderReference,
              ordinary.orderBatchReference,
              staff.actor,
              world.now(),
            ],
          ),
        ),
      { code: "23514" },
    );
  });
});

it("a table round made on paper is said Making it by hand too, and leaves the kitchen warnings", async () => {
  await withAutoAcceptWorld(
    { caseId: "wp2423_aap_keeptab", orderType: "DineIn" },
    async (world) => {
      const { assert, query, fresh } = world;
      await world.setting.change({
        pickup: false,
        dineIn: true,
        at: world.time(-world.minutes(60)),
      });
      await world.kitchenScreen.seenNow();
      const round = await world.seedPaidTableRound({ paidMinutesAgo: 12 });
      assert.equal(
        (await world.transactions().run((tx) => world.paid.consume(tx, round.event))).result.status,
        "OrderConfirmed",
      );
      await world.staffOnSince(8);
      const staff = await world.session([], "01a6aa25");
      const list = queueFor(world, staff);
      const keep = createMerchantPaidOrderKeep({
        persistence: { ...staff.persistence, now: world.now },
        authentication: staff.authentication,
        now: world.now,
        nextReference: fresh,
      });
      const before = (await list()).items.find(
        (item) => item.orderReference === round.orderReference,
      );
      // The kitchen tablet died: staff make it from paper, and there is a button for that.
      assert.equal(before.batches[0].canKeep, true);
      const watching = (await list()).paidOrderWatch.waiting.find(
        (entry) => entry.orderNumber === before.orderNumber,
      );
      assert.equal(watching.kept, undefined);
      assert.equal(watching.refundAt, null);
      assert.deepEqual(
        await keep({
          sessionCookie: staff.sessionCookie,
          csrf: staff.csrf,
          command: {
            orderReference: round.orderReference,
            orderBatchReference: round.orderBatchReference,
          },
        }),
        { status: "Kept" },
      );
      assert.deepEqual(
        await query(
          "SELECT actor_id FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1 AND outcome='Kept'",
          [round.orderBatchReference],
        ),
        [{ actor_id: staff.actor }],
      );
      // Out of the Store-level alarm: the screens read it as being made by hand.
      const after = await list();
      const item = after.paidOrderWatch.waiting.find(
        (entry) => entry.orderNumber === before.orderNumber,
      );
      assert.equal(item.kept, true);
      const row = after.items.find((entry) => entry.orderReference === round.orderReference);
      assert.equal(row.batches[0].kept, true);
      assert.equal(row.batches[0].canKeep, false);
      // Money never moves for it.
      assert.deepEqual(await cancellationOf(world, round), []);
    },
  );
});

it("a marked dish waits for a person with a Store selected, and goes once the mark is cleared", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_beer", orderType: "Pickup" }, async (world) => {
    const { assert, paid, scope, query } = world;
    await on(world);
    const beer = await world.seedPaidPickup();
    await world.markAlcohol(beer);
    // The worker's transaction: the Store selected, where Catalog hides dishes unless asked right.
    const consumed = await world.worker().run((tx) => paid.consume(tx, beer.event));
    assert.equal(consumed.result.status, "AwaitingOrderAcceptance");
    assert.deepEqual(
      await query("SELECT 1 FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1", [
        beer.orderBatchReference,
      ]),
      [],
    );
    assert.equal(
      (
        await query(
          "SELECT 1 FROM rms_ordering.order_payment_acceptance_wait WHERE order_batch_id=$1",
          [beer.orderBatchReference],
        )
      ).length,
      1,
    );
    // The same line goes to Orders and the kitchen banner.
    const skips = await world
      .worker()
      .run((tx) => listStoreOrderAutoAcceptanceSkipsByOrder(tx, scope, [beer.orderReference]));
    assert.equal(skips.get(beer.orderReference).reason, "HasAlcohol");
    // Unmarked: it goes on the next pass of the wait, with nobody pressing anything.
    await world.markAlcohol(beer, false, 1);
    const went = await world.worker().run((tx) => paid.resume(tx, beer.event.eventId));
    assert.equal(went.status, "OrderConfirmed");
  });
});

it("the card machine, changed stock and a large order each leave it to a person, for their own reason", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_people", orderType: "Pickup" }, async (world) => {
    const { assert, paid, query, transactions, seedPaidPickup, releaseStock } = world;
    await on(world);
    const reasons = async (order) =>
      (
        await query(
          "SELECT coalesce(reason_code,outcome) AS reason FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1 ORDER BY decided_at,decision_id",
          [order.orderBatchReference],
        )
      ).map((row) => row.reason);
    const acceptances = (order) =>
      query("SELECT actor_type FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1", [
        order.orderBatchReference,
      ]);
    // Oldest first, and before anything returns stock: the ledger reads forward in time.
    const machine = await seedPaidPickup();
    const moved = await seedPaidPickup();
    const large = await seedPaidPickup({ quantity: 16 });
    const fifteen = await seedPaidPickup({ quantity: 15 });
    // Recorded on the card machine: staff accept it themselves, and no reason is said.
    await world.seedCardMachinePayment(machine);
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, machine.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    assert.deepEqual(await acceptances(machine), []);
    assert.deepEqual(await reasons(machine), []);
    // Sixteen portions: someone sees it before a two-person kitchen does.
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, large.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    assert.deepEqual(await acceptances(large), []);
    assert.deepEqual(await reasons(large), ["LargeOrder"]);
    assert.deepEqual(
      await query(
        "SELECT item_count::int AS n FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1",
        [large.orderBatchReference],
      ),
      [{ n: 16 }],
    );
    // Fifteen is still fine.
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, fifteen.event))).result.status,
      "OrderConfirmed",
    );
    // Its stock moved after it was reserved.
    await releaseStock(moved);
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, moved.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    assert.deepEqual(await acceptances(moved), []);
    assert.deepEqual(await reasons(moved), ["StockChanged"]);
  });
});

it("the pilot's own operating reader, in the worker's transaction: open sends, paused waits, resumed sends", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_real", orderType: "Pickup" }, async (world) => {
    const { assert, paid, query, seedPaidPickup, worker } = world;
    await on(world);
    await world.useRealOperatingReader();
    const open = await seedPaidPickup();
    const consumed = await worker().run((tx) => paid.consume(tx, open.event));
    assert.equal(consumed.result.status, "OrderConfirmed");
    // A pause, as Pause ordering records it, and the next payment waits and says why.
    const pause = await world.pauseStore();
    const paused = await seedPaidPickup();
    assert.equal(
      (await worker().run((tx) => paid.consume(tx, paused.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    assert.deepEqual(
      await query(
        "SELECT reason_code FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1",
        [paused.orderBatchReference],
      ),
      [{ reason_code: "StoreNotOpen" }],
    );
    // Resumed: the wait workload's next pass sends it, with nobody pressing anything.
    await world.resumeStore(pause);
    assert.equal(
      (await worker().run((tx) => paid.resume(tx, paused.event.eventId))).status,
      "OrderConfirmed",
    );
  });
});

it("a reader that can't say reads as not open, and is reported once per payment", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_null", orderType: "Pickup" }, async (world) => {
    const { assert, paid, operating, query, seedPaidPickup, worker } = world;
    await on(world);
    const said = vi.spyOn(nodeConsole, "error").mockImplementation(() => undefined);
    try {
      const order = await seedPaidPickup();
      operating.read = async () => null;
      const consumed = await worker().run((tx) => paid.consume(tx, order.event));
      assert.equal(consumed.result.status, "AwaitingOrderAcceptance");
      await worker().run((tx) => paid.resume(tx, order.event.eventId));
      await worker().run((tx) => paid.resume(tx, order.event.eventId));
      const reported = said.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("ORDER_AUTO_ACCEPT_STORE_STATUS_UNREADABLE"));
      assert.equal(reported.length, 1);
      // Nothing about the order in what it logs.
      assert.equal(reported[0].includes(order.orderReference), false);
      assert.deepEqual(
        await query(
          "SELECT reason_code FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1",
          [order.orderBatchReference],
        ),
        [{ reason_code: "StoreNotOpen" }],
      );
    } finally {
      said.mockRestore();
    }
  });
});

it("only the board's own read says a kitchen screen is open: the watch alone leaves paid orders waiting", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aap_board", orderType: "Pickup" }, async (world) => {
    const { assert, paid, query, scope, seedPaidPickup, setting, transactions, worker } = world;
    await setting.change({ pickup: true, dineIn: false, at: world.time(-world.minutes(240)) });
    const presence = createMerchantKitchenScreenPresence({
      transactions: transactions(),
      now: world.now,
    });
    const read = presence.wrap(scope, async () => "read");
    // A kitchen sign-in on the sold-out page, its screen-wide warnings reading away.
    assert.equal(await read({ query: { kind: "Watch" } }), "read");
    assert.equal(await worker().run((tx) => loadKitchenScreenSeenAt(tx, scope)), null);
    const order = await seedPaidPickup();
    assert.equal(
      (await worker().run((tx) => paid.consume(tx, order.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    assert.deepEqual(
      await query(
        "SELECT reason_code FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1",
        [order.orderBatchReference],
      ),
      [{ reason_code: "KitchenScreenOff" }],
    );
    // The board itself: it goes.
    await read({ query: { kind: "List" } });
    assert.match(await worker().run((tx) => loadKitchenScreenSeenAt(tx, scope)), /Z$/u);
    assert.equal(
      (await worker().run((tx) => paid.resume(tx, order.event.eventId))).status,
      "OrderConfirmed",
    );
  });
});

it("what the manager sees: every refund and keep named on tonight's summary, the count surviving the switch", async () => {
  await withAutoAcceptWorld(
    { caseId: "wp2423_aap_tonight", orderType: "Pickup" },
    async (world) => {
      const { assert, admin, fresh, scope, ownerScope, worker } = world;
      await on(world);
      const automatic = await sentAgo(world, 33);
      await world.staffOnSince(8);
      const refunded = await sentAgo(world, 1);
      const kept = await sentAgo(world, 1);
      const staff = await world.session([], "01a6aa26");
      // TEST-ONLY profile: the name staff have in the Store's directory.
      await admin.query(
        "INSERT INTO bop_membership.member_profile_version (membership_id,version,brand_id,actor_id,display_name,operation_id,changed_by,changed_at,data_classification) SELECT membership_id,1,brand_id,actor_id,'Anna',$2,actor_id,$3,'PersonalData' FROM bop_membership.membership WHERE actor_id=$1",
        [staff.actor, fresh(), world.now()],
      );
      const { refuse } = cantMakeFor(world, staff);
      assert.equal((await refuse(refunded)).status, "Cancelled");
      assert.equal(await expiryOf(world).close(await openBatch(world, automatic)), "Closed");
      await createMerchantPaidOrderKeep({
        persistence: { ...staff.persistence, now: world.now },
        authentication: staff.authentication,
        now: world.now,
        nextReference: fresh,
      })({
        sessionCookie: staff.sessionCookie,
        csrf: staff.csrf,
        command: {
          orderReference: kept.orderReference,
          orderBatchReference: kept.orderBatchReference,
        },
      });
      const facts = await worker().run((tx) =>
        readTonightFacts(tx, {
          scope: ownerScope,
          window: {
            startsAt: world.time(-world.minutes(600)),
            endsAt: world.time(world.minutes(600)),
          },
          observedAt: world.now(),
          authorize: async () => true,
        }),
      );
      assert.deepEqual(
        facts.paidOrderEvents.map((event) => [event.kind, event.staffName, event.reasonCode]),
        [
          ["CantMake", "Anna", "SOLD_OUT"],
          ["AutomaticRefund", null, "STORE_ERROR"],
          ["KeptByHand", "Anna", null],
        ],
      );
      assert.match(facts.paidOrderEvents[0].orderNumber, /\d/u);
      // Turned off because of this: the count stays, and the board keeps saying what waits.
      await world.setting.change({ pickup: false, dineIn: false });
      const watch = await worker().run((tx) => readPaidOrderWatch(tx, scope, world.now()));
      assert.equal(watch.on, false);
      assert.equal(watch.recentlyOn, true);
      assert.equal(watch.cantMakeRefunds, 1);
      assert.equal(watch.waiting.length, 1);
      // A day later it is only the count of what happened in that day: no more banner.
      const later = await worker().run((tx) =>
        readPaidOrderWatch(tx, scope, new Date(Date.now() + world.minutes(25 * 60)).toISOString()),
      );
      assert.equal(later.recentlyOn, false);
      assert.equal(later.cantMakeRefunds, 0);
    },
  );
});
