import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "vitest";
import { withAutoAcceptWorld, hashText } from "../test-support/auto-accept-world.mjs";
import {
  changeOrderAutoAcceptanceSetting,
  createPostgresStaffOrderCancellationReader,
  createPostgresStaffOrderCancellationStore,
  createPostgresStoreSalesOrderSource,
  listStoreOpenAutoAcceptedBatches,
  loadOrderAutoAcceptanceSetting,
  OrderAutoAcceptanceSettingConflictError,
} from "../../rms/ordering/src/index.ts";
import { recordStorePresence } from "../../rms/store/src/index.ts";
import {
  listStoreKitchenBatchTouches,
  loadStoreLastKitchenStepAt,
} from "../../rms/kitchen/src/index.ts";
import { createMerchantOrderStaffCancellation } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import { createMerchantPaidOrderAutoAcceptOff } from "../../../apps/api/src/merchant-paid-order-watch.ts";
import { createMerchantStoreFeatures } from "../../../apps/api/src/merchant-store-features.ts";
import { createMerchantStorePublicProfile } from "../../../apps/api/src/merchant-store-public-profile.ts";
import { createOrderAutoAcceptedPickupExpiry } from "../../../apps/api/src/order-auto-accepted-pickup-expiry.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";

const acceptanceOf = (world, batch) =>
  world.query(
    "SELECT actor_type,actor_id,reason_code,permission_code,expected_order_version::int AS expected,accepted_order_version::int AS accepted FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1",
    [batch],
  );
const waitsOf = (world, batch) =>
  world.query("SELECT 1 FROM rms_ordering.order_payment_acceptance_wait WHERE order_batch_id=$1", [
    batch,
  ]);
const dispositionOf = async (world, batch) =>
  (
    await world.query(
      "SELECT disposition,reason FROM rms_ordering.order_payment_disposition_record WHERE order_batch_id=$1",
      [batch],
    )
  )[0];
const reasonsOf = async (world, batch) =>
  (
    await world.query(
      "SELECT coalesce(reason_code,outcome) AS reason,setting_version::int AS version FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1 ORDER BY decided_at,decision_id",
      [batch],
    )
  ).map((row) => row.reason);

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT. Under the restricted NOBYPASSRLS role with the rendered pilot
 * ACL, real Orders paid online, and the worker's paid outcome as the pilot composes it.
 */
it("a paid pickup at a Store with the switch on reaches the kitchen without anyone pressing Accept", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_pickup", orderType: "Pickup" }, async (world) => {
    const { assert, paid, query, setting, kitchenScreen, transactions, seedPaidPickup } = world;
    await setting.change({ pickup: true, dineIn: false, at: world.time(-world.minutes(60)) });
    await kitchenScreen.seenNow();
    const order = await seedPaidPickup();
    const consumed = await transactions().run((tx) => paid.consume(tx, order.event));
    assert.equal(consumed.consumerOutcome.status, "processed");
    assert.equal(consumed.result.status, "OrderConfirmed");
    assert.deepEqual(await acceptanceOf(world, order.orderBatchReference), [
      {
        actor_type: "System",
        actor_id: null,
        reason_code: "STORE_AUTO_ACCEPT_PAID",
        permission_code: "order.accept",
        expected: 1,
        accepted: 2,
      },
    ]);
    assert.deepEqual(await waitsOf(world, order.orderBatchReference), []);
    assert.equal((await dispositionOf(world, order.orderBatchReference)).disposition, "Confirmed");
    const confirmed = await query(
      "SELECT 1 FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed' AND aggregate_id=$1",
      [order.orderReference],
    );
    assert.equal(confirmed.length, 1);
    assert.deepEqual(
      (
        await query(
          "SELECT state,version::int AS version FROM rms_fulfillment.capacity_asap_commitment WHERE order_id=$1 ORDER BY version",
          [order.orderReference],
        )
      ).map((row) => [row.state, row.version]),
      [
        ["Prepared", 1],
        ["PaymentPending", 2],
        ["Consumed", 3],
      ],
    );
    assert.deepEqual(
      await query(
        "SELECT actor_type,reason_code,source_channel,after_summary_json AS after_summary,retention_policy_code FROM platform_audit.audit_record WHERE action_code='ORDER_ACCEPTED' AND target_id=$1",
        [order.orderReference],
      ),
      [
        {
          actor_type: "System",
          reason_code: "STORE_AUTO_ACCEPT_PAID",
          source_channel: "EVENT_CONSUMER",
          after_summary: { phase: "Accepted" },
          retention_policy_code: "FINANCIAL_COMPLIANCE",
        },
      ],
    );
    assert.deepEqual(
      await query(
        "SELECT actor_type,source_channel FROM platform_audit.audit_record WHERE action_code='FULFILLMENT_ASAP_CAPACITY_CONSUMED' AND target_id::text IN (SELECT allocation_id::text FROM rms_fulfillment.capacity_asap_commitment WHERE order_id=$1)",
        [order.orderReference],
      ),
      [{ actor_type: "System", source_channel: "EVENT_CONSUMER" }],
    );
    assert.deepEqual(await reasonsOf(world, order.orderBatchReference), ["Accepted"]);
  });
});

it("a paid first round and a paid later round at a pay-first table go straight through", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_table", orderType: "DineIn" }, async (world) => {
    const { assert, paid, query, setting, kitchenScreen, transactions } = world;
    await setting.change({ pickup: false, dineIn: true, at: world.time(-world.minutes(60)) });
    await kitchenScreen.seenNow();
    const first = await world.seedPaidTableRound();
    const consumed = await transactions().run((tx) => paid.consume(tx, first.event));
    assert.equal(consumed.result.status, "OrderConfirmed");
    assert.deepEqual(await waitsOf(world, first.orderBatchReference), []);
    const accepted = await acceptanceOf(world, first.orderBatchReference);
    assert.equal(accepted[0].actor_type, "System");
    assert.equal(accepted[0].reason_code, "STORE_AUTO_ACCEPT_PAID");
    const later = await world.seedPaidLaterRound({
      ...first,
      currentVersion: accepted[0].accepted,
    });
    const second = await transactions().run((tx) => paid.consume(tx, later.event));
    assert.equal(second.result.status, "OrderConfirmed");
    assert.deepEqual(await waitsOf(world, later.orderBatchReference), []);
    const acceptedLater = await acceptanceOf(world, later.orderBatchReference);
    assert.equal(acceptedLater[0].actor_type, "System");
    assert.equal(acceptedLater[0].actor_id, null);
    assert.equal(
      (
        await query(
          "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed' AND aggregate_id=$1",
          [first.orderReference],
        )
      )[0].n,
      2,
    );
    assert.deepEqual(await reasonsOf(world, later.orderBatchReference), ["Accepted"]);
    // A table round is never refunded automatically: the guest is in the room.
    assert.deepEqual(
      await world.worker().run((tx) =>
        listStoreOpenAutoAcceptedBatches(tx, world.scope, {
          since: world.time(-world.minutes(60)),
          limit: 10,
          onlyPickup: true,
        }),
      ),
      [],
    );
    // Whoever can accept gives one round back; the table's order carries on.
    const server = await world.session([], "01a6aa07");
    const cantMake = createMerchantOrderStaffCancellation({
      persistence: { ...server.persistence, now: world.now },
      authentication: server.authentication,
      nextReference: world.fresh,
      autoAcceptedOnly: true,
      installContext: async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [selected.tenantReference, selected.brandReference, selected.storeReference],
        );
      },
      resolveRefundConfiguration: async () => ({
        providerAccountReference: world.provider,
        environment: "Test",
      }),
    });
    const given = await cantMake({
      sessionCookie: server.sessionCookie,
      csrf: server.csrf,
      command: {
        orderReference: later.orderReference,
        orderBatchReference: later.orderBatchReference,
        expectedOrderVersion: acceptedLater[0].accepted,
        operationReference: world.fresh(),
        reasonCode: "GUEST_LEFT",
      },
    });
    assert.equal(given.status, "Cancelled");
    assert.deepEqual(
      await query(
        "SELECT permission_code,actor_id FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
        [later.orderBatchReference],
      ),
      [{ permission_code: "ordering.order.accept", actor_id: server.actor }],
    );
    assert.deepEqual(
      await query("SELECT 1 FROM rms_ordering.order_termination_record WHERE order_id=$1", [
        first.orderReference,
      ]),
      [],
    );
  });
});

const staffAcceptor = async (world, prefix, permissions = []) => {
  const staff = await world.session(permissions, prefix);
  const accept = await world.acceptanceFor(staff);
  return {
    ...staff,
    accept: (order, expectedOrderVersion = 1) =>
      accept({
        sessionCookie: staff.sessionCookie,
        csrf: staff.csrf,
        command: {
          acceptanceReference: world.fresh(),
          operationReference: world.fresh(),
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          expectedOrderVersion,
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

it("with the switch off, or never set, nothing changes: a wait, Accept, and the kitchen gets it", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_off", orderType: "Pickup" }, async (world) => {
    const { assert, paid, setting, kitchenScreen, transactions, seedPaidPickup, query } = world;
    await kitchenScreen.seenNow();
    const staff = await staffAcceptor(world, "01a6aa01");
    const list = queueFor(world, staff);
    // Never set: no row reads as off, and nothing about it reaches a tablet.
    const never = await seedPaidPickup();
    const first = await transactions().run((tx) => paid.consume(tx, never.event));
    assert.equal(first.result.status, "AwaitingOrderAcceptance");
    assert.deepEqual(await acceptanceOf(world, never.orderBatchReference), []);
    assert.equal((await waitsOf(world, never.orderBatchReference)).length, 1);
    assert.deepEqual(await reasonsOf(world, never.orderBatchReference), []);
    const before = await list();
    assert.equal(Object.hasOwn(before, "paidOrderWatch"), false);
    const row = before.items.find((item) => item.orderReference === never.orderReference);
    assert.equal(row.batches[0].canRequestAcceptance, true);
    for (const key of ["acceptedAutomaticallyAt", "canCantMake", "notSentAutomatically"])
      assert.equal(Object.hasOwn(row.batches[0], key), false, key);
    // A person presses Accept; the wait workload then confirms it. As today.
    assert.deepEqual(await staff.accept(never), { status: "Created", acceptedOrderVersion: 2 });
    const resumed = await world.worker().run((tx) => paid.resume(tx, never.event.eventId));
    assert.equal(resumed.status, "OrderConfirmed");
    assert.equal((await acceptanceOf(world, never.orderBatchReference))[0].actor_type, "User");
    // Turned on, then off: off again, and a payment now takes the ordinary path.
    await setting.change({ pickup: true, dineIn: true, at: world.time(-world.minutes(60)) });
    await setting.change({ pickup: false, dineIn: false, at: world.time(-world.minutes(30)) });
    const off = await seedPaidPickup();
    const second = await transactions().run((tx) => paid.consume(tx, off.event));
    assert.equal(second.result.status, "AwaitingOrderAcceptance");
    assert.deepEqual(await acceptanceOf(world, off.orderBatchReference), []);
    assert.deepEqual(await reasonsOf(world, off.orderBatchReference), []);
    assert.equal(
      (
        await query(
          "SELECT count(*)::int AS n FROM rms_ordering.order_acceptance_record WHERE reason_code='STORE_AUTO_ACCEPT_PAID'",
        )
      )[0].n,
      0,
    );
  });
});

it("an order it does not accept waits for a person, says why, and goes once the reason clears", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_wait", orderType: "Pickup" }, async (world) => {
    const { assert, paid, setting, kitchenScreen, transactions, seedPaidPickup, operating } = world;
    await setting.change({ pickup: true, dineIn: false, at: world.time(-world.minutes(60)) });
    await kitchenScreen.seenNow();
    // Oldest first: the stock ledger reads forward in time.
    const held = await seedPaidPickup({ paidMinutesAgo: 31 });
    const late = await seedPaidPickup({ paidMinutesAgo: 31 });
    const order = await seedPaidPickup();
    const batch = order.orderBatchReference;
    const resume = () => world.worker().run((tx) => paid.resume(tx, order.event.eventId));
    const stillWaiting = async () => {
      assert.deepEqual(await acceptanceOf(world, batch), []);
      assert.equal((await waitsOf(world, batch)).length, 1);
    };
    // Paused: a wait, and the reason.
    operating.current = { state: "Paused", availableServiceModes: [] };
    const consumed = await transactions().run((tx) => paid.consume(tx, order.event));
    assert.equal(consumed.result.status, "AwaitingOrderAcceptance");
    await stillWaiting();
    assert.deepEqual(await reasonsOf(world, batch), ["StoreNotOpen"]);
    // Still not open, for other reasons: no new row for the same reason.
    assert.equal((await resume()).status, "AwaitingOrderAcceptance");
    operating.current = { state: "Open", availableServiceModes: ["DineIn"] };
    assert.equal((await resume()).status, "AwaitingOrderAcceptance");
    operating.current = {
      state: "Open",
      availableServiceModes: ["Pickup"],
      notReadyForOrders: true,
    };
    assert.equal((await resume()).status, "AwaitingOrderAcceptance");
    // An unreadable status, even one that aborts the transaction, counts as not open and never
    // fails the payment outcome.
    operating.read = async () => {
      throw new Error("unreadable");
    };
    assert.equal((await resume()).status, "AwaitingOrderAcceptance");
    operating.read = async (tx) => tx.query("SELECT 1/0");
    assert.equal((await resume()).status, "AwaitingOrderAcceptance");
    // A Store configuration being published holds its table: the wait is short and nothing fails.
    const holder = new pg.Client(world.clientConfig);
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "LOCK TABLE rms_store.store_configuration_operation IN ROW EXCLUSIVE MODE",
      );
      operating.read = async (tx) => {
        await tx.query("LOCK TABLE rms_store.store_configuration_operation IN SHARE MODE");
        return operating.current;
      };
      const startedAt = Date.now();
      assert.equal((await resume()).status, "AwaitingOrderAcceptance");
      assert.ok(Date.now() - startedAt < 5_000, "the worker does not sit on the lock");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
    }
    await stillWaiting();
    assert.deepEqual(await reasonsOf(world, batch), ["StoreNotOpen"]);
    operating.read = null;
    operating.current = { state: "Open", availableServiceModes: ["Pickup", "DineIn"] };
    // Open, but only an Orders page is open at the till: no kitchen board in the last 3 minutes.
    await transactions().run((tx) =>
      recordStorePresence(tx, world.scope, {
        observedAt: world.now(),
        newPeriodReference: world.fresh,
      }),
    );
    await world.admin.query("UPDATE rms_kitchen.kitchen_screen_presence SET last_seen_at=$1", [
      new Date(Date.now() - world.minutes(4)).toISOString(),
    ]);
    assert.equal((await resume()).status, "AwaitingOrderAcceptance");
    assert.deepEqual(await reasonsOf(world, batch), ["StoreNotOpen", "KitchenScreenOff"]);
    await kitchenScreen.seenNow();
    // Changing the table switch does not stop a waiting pickup: each type has its own cut-off.
    await setting.change({ pickup: true, dineIn: true });
    // Everything clear: it goes by itself, from the wait, with no person.
    const went = await resume();
    assert.equal(went.status, "OrderConfirmed");
    assert.deepEqual(await reasonsOf(world, batch), [
      "StoreNotOpen",
      "KitchenScreenOff",
      "Accepted",
    ]);
    assert.equal((await acceptanceOf(world, batch))[0].actor_type, "System");
    assert.equal(
      (await transactions().run((tx) => paid.listUnresolved(tx, 100))).includes(
        order.event.eventId,
      ),
      false,
    );

    // Held through an outage: paid over half an hour ago, with no staff screen at its deadline, so
    // it stays a manager's decision. Nothing is recorded by the System.
    await world.admin.query(
      "SET session_replication_role = replica; DELETE FROM rms_store.store_presence_session; SET session_replication_role = origin",
    );
    await kitchenScreen.seenNow();
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, held.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    assert.deepEqual(await acceptanceOf(world, held.orderBatchReference), []);
    assert.equal(
      (
        await world.query(
          "SELECT 1 FROM rms_ordering.order_acceptance_hold WHERE order_batch_id=$1",
          [held.orderBatchReference],
        )
      ).length,
      1,
    );
    assert.deepEqual(await reasonsOf(world, held.orderBatchReference), []);
    // Paid over 30 minutes ago with staff online: skipped, and today's refund still closes it.
    await transactions().run((tx) =>
      recordStorePresence(tx, world.scope, {
        observedAt: new Date(Date.parse(late.requestedAt) + world.minutes(30) - 1000).toISOString(),
        newPeriodReference: world.fresh,
      }),
    );
    const closed = await transactions().run((tx) => paid.consume(tx, late.event));
    assert.equal(closed.result.status, "CompensationRequired");
    assert.deepEqual(await acceptanceOf(world, late.orderBatchReference), []);
    assert.deepEqual(await reasonsOf(world, late.orderBatchReference), ["PaidTooLongAgo"]);
    assert.deepEqual(await dispositionOf(world, late.orderBatchReference), {
      disposition: "PaidWithoutFulfillableOrder",
      reason: "CapacityExpired",
    });

    // Paid before the switch was turned on (this type's switch): left to a person, for good.
    await setting.change({ pickup: false, dineIn: true });
    const early = await seedPaidPickup();
    await setting.change({ pickup: true, dineIn: true });
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, early.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    assert.deepEqual(await reasonsOf(world, early.orderBatchReference), ["PaidBeforeSwitch"]);
    await kitchenScreen.seenNow();

    // The Store is off the switch for good measure: the batch that had a reason is read by staff.
    const staff = await staffAcceptor(world, "01a6aa02");
    const row = (await queueFor(world, staff)()).items.find(
      (item) => item.orderReference === early.orderReference,
    );
    assert.deepEqual(row.batches[0].notSentAutomatically, {
      reason: "PaidBeforeSwitch",
      itemCount: early.items.reduce((sum, item) => sum + item.quantity, 0),
    });
    assert.equal(row.batches[0].canRequestAcceptance, true);
    // And staff can still Accept it, as the System never did.
    assert.equal((await staff.accept(early)).status, "Created");
  });
});

it("staff pressing Accept while the System accepts: one acceptance, one confirmation, never 403 or 503", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_race", orderType: "Pickup" }, async (world) => {
    const { assert, paid, setting, kitchenScreen, transactions, seedPaidPickup, scope } = world;
    await setting.change({ pickup: true, dineIn: false, at: world.time(-world.minutes(60)) });
    await kitchenScreen.seenNow();
    const staff = await staffAcceptor(world, "01a6aa03");
    const order = await seedPaidPickup();
    const holder = new pg.Client(world.clientConfig);
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          order.orderReference,
      ]);
      const outcomes = [
        transactions()
          .run((tx) => paid.consume(tx, order.event))
          .then((value) => value.result.status),
        staff.accept(order).then(
          () => "Accepted",
          (error) => error.code,
        ),
      ];
      // Both are at the Order's fence before it opens.
      for (let tries = 0; tries < 200; tries += 1) {
        const waiting = await world.query(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        );
        if (waiting[0].n >= 2) break;
        await delay(50);
      }
      await holder.query("COMMIT");
      const [system, person] = await Promise.all(outcomes);
      assert.ok(
        [
          "ORDER_ACCEPTANCE_ALREADY_ACCEPTED",
          "ORDER_ACCEPTANCE_VERSION_CONFLICT",
          "Accepted",
        ].includes(person),
        String(person),
      );
      assert.ok(["OrderConfirmed", "AwaitingOrderAcceptance"].includes(system), String(system));
    } finally {
      await holder.end();
    }
    assert.equal((await acceptanceOf(world, order.orderBatchReference)).length, 1);
    // Whoever won, the worker confirms it once.
    await world
      .worker()
      .run((tx) => paid.resume(tx, order.event.eventId))
      .catch(() => undefined);
    assert.equal((await dispositionOf(world, order.orderBatchReference)).disposition, "Confirmed");
    assert.equal(
      (
        await world.query(
          "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed' AND aggregate_id=$1",
          [order.orderReference],
        )
      )[0].n,
      1,
    );
  });
});

it("the database refuses an automatic acceptance while the switch is off, and the switch is append-only", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_guard", orderType: "Pickup" }, async (world) => {
    const { assert, setting, transactions, seedPaidPickup, scope, ownerScope, fresh, now } = world;
    const order = await seedPaidPickup();
    const insertAcceptance = (actorType, actorId) =>
      transactions().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        await tx.query(
          "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,1,2,$7,$8,'OrderFulfillment','order.accept','STORE_AUTO_ACCEPT_PAID',$9,$10,$11,$12)",
          [
            fresh(),
            fresh(),
            scope.brandReference,
            scope.storeReference,
            order.orderReference,
            order.orderBatchReference,
            actorType,
            actorId,
            fresh(),
            fresh(),
            hashText("guard"),
            now(),
          ],
        );
      });
    // Never set, then off: refused. Named as a person: refused, whatever the switch says.
    await assert.rejects(insertAcceptance("System", null), { code: "23514" });
    await setting.change({ pickup: false, dineIn: true });
    await assert.rejects(insertAcceptance("System", null), { code: "23514" });
    await setting.change({ pickup: true, dineIn: true });
    await assert.rejects(insertAcceptance("User", fresh()), { code: "23514" });

    const read = () => transactions().run((tx) => loadOrderAutoAcceptanceSetting(tx, scope));
    const current = await read();
    assert.equal(current.version, 2);
    assert.equal(current.pickup.on, true);
    // A stale version is a conflict; the same operation again returns what it made.
    await assert.rejects(
      transactions().run((tx) =>
        changeOrderAutoAcceptanceSetting(tx, ownerScope, {
          operationReference: fresh(),
          expectedVersion: 1,
          pickup: false,
          dineIn: false,
          actorReference: fresh(),
          observedAt: now(),
        }),
      ),
      OrderAutoAcceptanceSettingConflictError,
    );
    const operationReference = fresh();
    const change = () =>
      transactions().run((tx) =>
        changeOrderAutoAcceptanceSetting(tx, ownerScope, {
          operationReference,
          expectedVersion: 2,
          pickup: false,
          dineIn: false,
          actorReference: fresh(),
          observedAt: now(),
        }),
      );
    assert.equal((await change()).version, 3);
    assert.equal((await change()).version, 3);
    // History stays: versions in order, nothing rewritten.
    const asRole = (sql) =>
      transactions().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        await tx.query(sql);
      });
    for (const sql of [
      "UPDATE rms_ordering.order_auto_acceptance_setting SET pickup=true",
      "DELETE FROM rms_ordering.order_auto_acceptance_setting",
      "UPDATE rms_ordering.order_auto_acceptance_decision SET item_count=1",
      "INSERT INTO rms_ordering.order_auto_acceptance_setting (tenant_id,brand_id,store_id,version,operation_id,pickup,dine_in,actor_id,occurred_at) SELECT tenant_id,brand_id,store_id,99,brand_id,true,true,actor_id,occurred_at FROM rms_ordering.order_auto_acceptance_setting LIMIT 1",
    ])
      await assert.rejects(asRole(sql));
    // Another Store of the Brand reads off, and can't see this one's versions.
    const other = {
      brandReference: scope.brandReference,
      storeReference: "01a60000-0000-7000-8000-00000000eeee",
    };
    const elsewhere = await transactions().run((tx) => loadOrderAutoAcceptanceSetting(tx, other));
    assert.equal(elsewhere.version, 0);
    assert.equal(elsewhere.pickup.on, false);
  });
});

it("staff give back an automatically accepted order, and a pickup nobody touched refunds itself", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_refund", orderType: "Pickup" }, async (world) => {
    const { assert, paid, setting, kitchenScreen, transactions, seedPaidPickup, query, fresh } =
      world;
    const { scope, ownerScope, provider, systemActor } = world;
    await setting.change({ pickup: true, dineIn: false, at: world.time(-world.minutes(120)) });
    await kitchenScreen.seenNow();
    const frontOfHouse = await staffAcceptor(world, "01a6aa04");
    const list = queueFor(world, frontOfHouse);
    const cantMake = createMerchantOrderStaffCancellation({
      persistence: { ...frontOfHouse.persistence, now: world.now },
      authentication: frontOfHouse.authentication,
      nextReference: fresh,
      autoAcceptedOnly: true,
      installContext: async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [selected.tenantReference, selected.brandReference, selected.storeReference],
        );
      },
      resolveRefundConfiguration: async () => ({
        providerAccountReference: provider,
        environment: "Test",
      }),
    });
    const refuse = (order, reasonCode = "SOLD_OUT", version = 2) =>
      cantMake({
        sessionCookie: frontOfHouse.sessionCookie,
        csrf: frontOfHouse.csrf,
        command: {
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          expectedOrderVersion: version,
          operationReference: fresh(),
          reasonCode,
        },
      });
    // Oldest first, and before anything returns stock: the ledger reads forward in time.
    // A pickup nobody touched, and one the kitchen did: both sent half an hour ago, on the worker's
    // clock of the time.
    const untouched = await seedPaidPickup({ paidMinutesAgo: 32 });
    const started = await seedPaidPickup({ paidMinutesAgo: 32 });
    await kitchenScreen.seenNow(new Date(Date.now() - world.minutes(31.5)).toISOString());
    world.clock.offset = -world.minutes(31);
    try {
      for (const sent of [untouched, started])
        assert.equal(
          (await transactions().run((tx) => paid.consume(tx, sent.event))).result.status,
          "OrderConfirmed",
        );
    } finally {
      world.clock.offset = 0;
    }
    await kitchenScreen.seenNow();
    // Accepted by the System and never given a ticket: its kitchen delivery failed.
    const order = await seedPaidPickup();
    const accepted = await seedPaidPickup();
    const recent = await seedPaidPickup();
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, order.event))).result.status,
      "OrderConfirmed",
    );
    const beforeView = await list();
    const before = beforeView.items.find((item) => item.orderReference === order.orderReference);
    assert.equal(before.batches[0].canCantMake, true);
    assert.match(before.batches[0].acceptedAutomaticallyAt, /Z$/u);
    assert.equal(before.batches[0].canCancel, false, "the general cancel stays with managers");
    // The watch names it, and that it never reached the kitchen.
    const watching = beforeView.paidOrderWatch.waiting.find(
      (item) => item.orderNumber === before.orderNumber,
    );
    assert.equal(watching.reachedKitchen, false);
    assert.match(watching.refundAt, /Z$/u);
    assert.equal(beforeView.paidOrderWatch.on, true);
    assert.equal(beforeView.paidOrderWatch.canTurnOff, false);
    // It can be given back, through the branch for a batch with no kitchen work.
    const given = await refuse(order);
    assert.equal(given.status, "Cancelled");
    assert.equal(given.refundMethod, "Online");
    const record = await query(
      "SELECT permission_code,actor_id,reason_code,refund_disposition,previous_phase FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
      [order.orderBatchReference],
    );
    assert.deepEqual(record, [
      {
        permission_code: "ordering.order.accept",
        actor_id: frontOfHouse.actor,
        reason_code: "SOLD_OUT",
        refund_disposition: "Refund",
        previous_phase: "Accepted",
      },
    ]);
    assert.deepEqual(
      await query(
        "SELECT phase,actor_type,permission_code FROM rms_ordering.order_termination_record WHERE order_id=$1",
        [order.orderReference],
      ),
      [{ phase: "Cancelled", actor_type: "User", permission_code: "ordering.order.accept" }],
    );
    // The refund is owed: Payment's compensation opens it from this record, tip included.
    const owed = await transactions().run((transaction) =>
      createPostgresStaffOrderCancellationReader(scope).loadCompensationByPaymentEvent({
        transaction,
        paymentEventReference: order.event.eventId,
      }),
    );
    assert.equal(owed.disposition, "PaidWithoutFulfillableOrder");
    assert.equal(owed.reason, "CancelledByStaff");
    assert.equal(
      (
        await query(
          "SELECT actor_type,reason_code,source_channel FROM platform_audit.audit_record WHERE action_code='ORDER_CANCELLED_BY_STAFF' AND target_id=$1",
          [order.orderReference],
        )
      )[0].actor_type,
      "User",
    );
    assert.equal((await list()).paidOrderWatch.cantMakeRefunds, 1);
    // Only for an automatically accepted batch: one a person accepted stays with the managers.
    await frontOfHouse.accept(accepted);
    await transactions().run((tx) => paid.consume(tx, accepted.event));
    await assert.rejects(refuse(accepted), { code: "ORDER_CANCELLATION_NOT_CANCELLABLE" });
    // The database holds the same line, whatever a caller asks of the store.
    await assert.rejects(
      transactions().run(async (tx) => {
        const direct = createPostgresStaffOrderCancellationStore({
          ...scope,
          authorize: async () => true,
        });
        const prepared = await direct.prepare(tx, {
          orderReference: accepted.orderReference,
          orderBatchReference: accepted.orderBatchReference,
          expectedOrderVersion: 2,
          actorReference: frontOfHouse.actor,
        });
        assert.equal(prepared.status, "Ready");
        return direct.commit(tx, {
          plan: prepared.plan,
          cancellationReference: fresh(),
          operationReference: fresh(),
          actorReference: frontOfHouse.actor,
          reasonCode: "SOLD_OUT",
          kitchenEvidenceDigest: hashText("no kitchen work"),
          auditReference: fresh(),
          terminationAuditReference: fresh(),
          cancelledAt: world.now(),
          permissionCode: "ordering.order.accept",
        });
      }),
      { code: "STAFF_ORDER_CANCELLATION_CONFLICT" },
    );

    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, recent.event))).result.status,
      "OrderConfirmed",
    );
    const expiry = createOrderAutoAcceptedPickupExpiry({
      scope: ownerScope,
      systemActorReference: systemActor,
      transactions: world.worker(),
      now: world.now,
      newReference: fresh,
      authorize: async () => true,
      resolveRefundConfiguration: async () => ({
        providerAccountReference: provider,
        environment: "Test",
      }),
    });
    // A kitchen step on this ticket stops it, and steps on it never hold back a pickup with no ticket
    // (the kitchen can't be working on that one). Staff screens were on when it came due.
    await world.staffSeen(new Date(Date.now() - world.minutes(2)).toISOString());
    await world.kitchenStep(await world.seedKitchenTicket(started), "AcceptKitchenWorkItem");
    const touches = await world
      .worker()
      .run((tx) =>
        listStoreKitchenBatchTouches(tx, scope, [
          untouched.orderBatchReference,
          started.orderBatchReference,
        ]),
      );
    assert.equal(touches.get(started.orderBatchReference), "Touched");
    assert.equal(touches.has(untouched.orderBatchReference), false);
    assert.match(
      await world.worker().run((tx) => loadStoreLastKitchenStepAt(tx, scope, world.now())),
      /Z$/u,
    );
    const { due } = await expiry.listDue(10);
    assert.deepEqual(
      due.map((batch) => batch.orderBatchReference),
      [untouched.orderBatchReference],
    );
    assert.equal(await expiry.close(due[0]), "Closed");
    assert.deepEqual((await expiry.listDue(10)).due, []);
    // Closed by the System: the audit says so, the actor column is the reserved one, never a person.
    const closed = await query(
      "SELECT permission_code,actor_id,reason_code,previous_phase FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
      [untouched.orderBatchReference],
    );
    assert.deepEqual(closed, [
      {
        permission_code: "ordering.order.cancel",
        actor_id: systemActor,
        reason_code: "STORE_ERROR",
        previous_phase: "Accepted",
      },
    ]);
    assert.deepEqual(
      await query(
        "SELECT actor_type,source_channel FROM platform_audit.audit_record WHERE action_code IN ('ORDER_CANCELLED_BY_STAFF','ORDER_TERMINATED') AND target_id=$1 ORDER BY action_code",
        [untouched.orderReference],
      ),
      [
        { actor_type: "System", source_channel: "EVENT_CONSUMER" },
        { actor_type: "System", source_channel: "EVENT_CONSUMER" },
      ],
    );
    const refund = await transactions().run((transaction) =>
      createPostgresStaffOrderCancellationReader(scope).loadCompensationByPaymentEvent({
        transaction,
        paymentEventReference: untouched.event.eventId,
      }),
    );
    assert.equal(refund.reason, "CancelledByStaff");
    // Reports read what was sold, never who accepted it: the same order, by either route, is the
    // same sale; one given back is cancelled, whoever gave it back.
    const sales = createPostgresStoreSalesOrderSource({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      locale: "en-CA",
      authorize: async () => true,
    });
    const sold = await world
      .worker()
      .run((tx) =>
        sales(tx, [
          accepted.orderReference,
          recent.orderReference,
          order.orderReference,
          untouched.orderReference,
        ]),
      );
    const saleOf = (reference) => {
      const row = sold.find((entry) => entry.orderReference === reference);
      assert.ok(row);
      return JSON.parse(
        JSON.stringify(row, (key, value) =>
          /Reference$|Number$|At$/u.test(key)
            ? undefined
            : typeof value === "bigint"
              ? value.toString()
              : value,
        ),
      );
    };
    assert.deepEqual(saleOf(recent.orderReference), saleOf(accepted.orderReference));
    assert.notEqual(
      saleOf(order.orderReference).cancelled,
      saleOf(recent.orderReference).cancelled,
    );
    assert.deepEqual(saleOf(untouched.orderReference), saleOf(order.orderReference));
    // The one the kitchen touched, and the one just sent, stay open.
    for (const open of [started, recent])
      assert.deepEqual(
        await query("SELECT 1 FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1", [
          open.orderBatchReference,
        ]),
        [],
      );
  });
});

it("a manager can turn automatic sending off from the floor and can't turn it on", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_perm", orderType: "Pickup" }, async (world) => {
    const { assert, setting, fresh, transactions, scope, query } = world;
    await setting.change({ pickup: true, dineIn: true });
    const manager = await world.session(["store.service.pause"], "01a6aa05");
    const frontOfHouse = await world.session([], "01a6aa06");
    const features = createMerchantStoreFeatures({
      persistence: { ...manager.persistence, now: world.now },
      authentication: manager.authentication,
      now: world.now,
    });
    const off = createMerchantPaidOrderAutoAcceptOff({
      persistence: { ...manager.persistence, now: world.now },
      authentication: manager.authentication,
      now: world.now,
    });
    const offWithout = createMerchantPaidOrderAutoAcceptOff({
      persistence: { ...frontOfHouse.persistence, now: world.now },
      authentication: frontOfHouse.authentication,
      now: world.now,
    });
    // Turning on is the owner's: Store features refuses whoever holds only the pause.
    await assert.rejects(
      features({
        sessionCookie: manager.sessionCookie,
        csrf: manager.csrf,
        command: {
          action: "ChangeAutoAccept",
          operationReference: fresh(),
          expectedVersion: 1,
          pickup: true,
          dineIn: true,
        },
      }),
      { code: "STORE_FEATURES_PERMISSION_DENIED" },
    );
    // Without the pause: refused.
    await assert.rejects(
      offWithout({
        sessionCookie: frontOfHouse.sessionCookie,
        csrf: frontOfHouse.csrf,
        command: { operationReference: fresh(), expectedVersion: 1 },
      }),
      { code: "PAID_ORDER_AUTO_ACCEPT_DENIED" },
    );
    // A stale screen is told to look again.
    await assert.rejects(
      off({
        sessionCookie: manager.sessionCookie,
        csrf: manager.csrf,
        command: { operationReference: fresh(), expectedVersion: 7 },
      }),
      { code: "PAID_ORDER_AUTO_ACCEPT_CHANGED" },
    );
    assert.deepEqual(
      await off({
        sessionCookie: manager.sessionCookie,
        csrf: manager.csrf,
        command: { operationReference: fresh(), expectedVersion: 1 },
      }),
      { version: 2 },
    );
    const current = await transactions().run((tx) => loadOrderAutoAcceptanceSetting(tx, scope));
    assert.equal(current.pickup.on, false);
    assert.equal(current.dineIn.on, false);
    // The same versions record who.
    assert.deepEqual(
      await query(
        "SELECT version::int AS version,actor_id FROM rms_ordering.order_auto_acceptance_setting WHERE version=2",
      ),
      [{ version: 2, actor_id: manager.actor }],
    );
  });
});

// M109: pickup guests order from away from the counter and reach the Store by phone. Under the
// restricted role with the rendered pilot ACL: pickup is turned on only once the published profile
// has a phone, and a profile with no phone can't be published while pickup is on.
it("M109: pickup turns on only with a store phone, and the phone can't be cleared while it is on", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_phone", orderType: "Pickup" }, async (world) => {
    const { assert, admin, fresh, ownerScope, query } = world;
    const owner = await world.session(
      ["organization.manage", "organization.store.read", "organization.store.publish"],
      "01a6aa07",
    );
    const features = createMerchantStoreFeatures({
      persistence: { ...owner.persistence, now: world.now },
      authentication: owner.authentication,
      now: world.now,
    });
    const profile = createMerchantStorePublicProfile({
      persistence: { ...owner.persistence, now: world.now },
      authentication: owner.authentication,
    });
    // The Store took pickup off earlier (owner record), and has published no phone.
    await admin.query(
      "INSERT INTO rms_store.store_feature_setting (tenant_id,brand_id,store_id,version,operation_id,template_code,counter_order,pickup,inventory,loyalty,compliance_documents,actor_id,occurred_at) VALUES ($1,$2,$3,1,$4,'Custom',true,false,true,true,true,$5,date_trunc('milliseconds',now()))",
      [
        ownerScope.tenantReference,
        ownerScope.brandReference,
        ownerScope.storeReference,
        fresh(),
        owner.actor,
      ],
    );
    const turnOn = () =>
      features({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        command: {
          action: "Change",
          operationReference: fresh(),
          expectedVersion: 1,
          modules: {
            counterOrder: true,
            pickup: true,
            inventory: true,
            loyalty: true,
            alcohol: false,
          },
        },
      });
    await assert.rejects(turnOn(), { code: "STORE_FEATURES_PHONE_REQUIRED" });
    assert.deepEqual(
      await query(
        "SELECT version::int AS version,pickup FROM rms_store.store_feature_setting ORDER BY version",
      ),
      [{ version: 1, pickup: false }],
    );
    // With pickup on, a profile with no phone is refused before anything is published.
    await admin.query(
      "INSERT INTO rms_store.store_feature_setting (tenant_id,brand_id,store_id,version,operation_id,template_code,counter_order,pickup,inventory,loyalty,compliance_documents,actor_id,occurred_at) VALUES ($1,$2,$3,2,$4,'Custom',true,true,true,true,true,$5,date_trunc('milliseconds',now()))",
      [
        ownerScope.tenantReference,
        ownerScope.brandReference,
        ownerScope.storeReference,
        fresh(),
        owner.actor,
      ],
    );
    const before = await query("SELECT count(*)::int AS n FROM platform_audit.audit_record");
    await assert.rejects(
      profile({
        sessionCookie: owner.sessionCookie,
        csrf: owner.csrf,
        command: {
          expectedVersion: 0,
          operationReference: fresh(),
          details: {
            storeDisplayNames: { "en-CA": "Synthetic Store" },
            address: {
              addressLines: ["1 Synthetic Street"],
              locality: "Ottawa",
              regionCode: "ON",
              postalCode: "K1A 0A1",
              countryCode: "CA",
            },
            businessPhone: "",
          },
        },
      }),
      { code: "PhoneRequired" },
    );
    assert.deepEqual(
      await query("SELECT count(*)::int AS n FROM platform_audit.audit_record"),
      before,
    );
  });
});
