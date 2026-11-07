import { it } from "vitest";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";
import { createMerchantOrderStaffCancellation } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { createPostgresOrdinaryRefundRequestRuntime } from "../../rms/payment/src/index.ts";
import { measureDatabaseClockOffset } from "../../../tooling/environment/pilot-database-clock.mjs";
import { refundAuthorityCurrent } from "../../../tooling/environment/pilot-refund-workforce.mjs";

/**
 * WP-2423 M10/M14 (DEC-OWNER-DEFAULTS-2026-11-06 item 2). Under the restricted NOBYPASSRLS role
 * with the rendered pilot ACL, at a Store that accepts orders by hand: whoever may accept a paid
 * pickup may decline it before accepting ("Can't make it"), refunded in full in their name, and the
 * acceptance deadline never refunds it a second time (nor the other way round).
 */
const frontOfHouse = async (world, prefix) => {
  const staff = await world.session([], prefix);
  const queue = createPersistentMerchantOrderQueue({
    persistence: { ...staff.persistence, now: world.now },
    quoteVersion: 1,
    acceptanceConfigured: true,
  });
  const cantMake = createMerchantOrderStaffCancellation({
    persistence: { ...staff.persistence, now: world.now },
    authentication: staff.authentication,
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
  return {
    ...staff,
    list: () => queue({ sessionCookie: staff.sessionCookie, afterOrderReference: null }),
    refuse: (order, version = 1) =>
      cantMake({
        sessionCookie: staff.sessionCookie,
        csrf: staff.csrf,
        command: {
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          expectedOrderVersion: version,
          operationReference: world.fresh(),
          reasonCode: "SOLD_OUT",
        },
      }),
  };
};
/**
 * What Ordering recorded about the batch's payment: its dispositions and any staff cancellation.
 * Payment opens one compensation case per payment attempt (1400_009), from the staff
 * cancellation or from a deadline disposition; an acknowledgement that a refused order's payment
 * has no order (OrderNoLongerFulfillable) opens nothing new for an attempt already compensated.
 */
const compensationsOf = (world, order) =>
  world.query(
    "SELECT d.disposition,d.reason FROM rms_ordering.order_payment_disposition_record d WHERE d.order_batch_id=$1 AND d.disposition<>'Confirmed' UNION ALL SELECT 'StaffCancellation',refund_disposition FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1 ORDER BY 1,2",
    [order.orderBatchReference],
  );

it("a cashier declines a paid order not accepted yet: refunded once, the deadline never refunds it again", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_rl_cant", orderType: "Pickup" }, async (world) => {
    const { assert, paid, kitchenScreen, transactions, seedPaidPickup, query } = world;
    await kitchenScreen.seenNow();
    // Staff were on all along, so a deadline that passes is the Store's, not an outage's.
    await world.staffOnSince(34);
    const cashier = await frontOfHouse(world, "01a6ab01");
    // Two pickups paid 32 minutes ago, still waiting for a person when the worker first saw them;
    // their acceptance deadline (30 minutes) has just passed. Oldest first, before anything else
    // moves stock: the stock ledger reads forward in time.
    const declined = await seedPaidPickup({ paidMinutesAgo: 32 });
    const expired = await seedPaidPickup({ paidMinutesAgo: 32 });
    await kitchenScreen.seenNow(new Date(Date.now() - world.minutes(31.5)).toISOString());
    world.clock.offset = -world.minutes(31);
    try {
      for (const order of [declined, expired])
        assert.equal(
          (await transactions().run((tx) => paid.consume(tx, order.event))).result.status,
          "AwaitingOrderAcceptance",
        );
    } finally {
      world.clock.offset = 0;
    }
    await kitchenScreen.seenNow();
    const open = await seedPaidPickup();
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, open.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    // The cashier (Front of House: accept, not cancel) is offered Can't make it while it waits.
    const view = await cashier.list();
    const row = view.items.find((item) => item.orderReference === open.orderReference);
    assert.equal(row.batches[0].canRequestAcceptance, true);
    assert.equal(row.batches[0].canCancel, false);
    assert.equal(row.batches[0].canCantMake, true);
    assert.equal(Object.hasOwn(row.batches[0], "acceptedAutomaticallyAt"), false);
    // Declined before anyone accepted it: refused, with the cashier's name and permission.
    const given = await cashier.refuse(open);
    assert.equal(given.status, "Cancelled");
    assert.equal(given.refundMethod, "Online");
    assert.deepEqual(
      await query(
        "SELECT permission_code,actor_id,previous_phase,refund_disposition FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
        [open.orderBatchReference],
      ),
      [
        {
          permission_code: "ordering.order.accept",
          actor_id: cashier.actor,
          previous_phase: "Submitted",
          refund_disposition: "Refund",
        },
      ],
    );
    assert.deepEqual(
      await query(
        "SELECT phase,actor_type,permission_code FROM rms_ordering.order_termination_record WHERE order_id=$1",
        [open.orderReference],
      ),
      [{ phase: "Rejected", actor_type: "User", permission_code: "ordering.order.accept" }],
    );
    // A second press finds it closed: nothing more is refunded.
    await assert.rejects(cashier.refuse(open), { code: "ORDER_CANCELLATION_NOT_CANCELLABLE" });
    // Declined just as its deadline passed, then the deadline worker runs: one refund, the cashier's.
    assert.equal((await cashier.refuse(declined)).status, "Cancelled");
    await world
      .worker()
      .run((tx) => paid.resume(tx, declined.event.eventId))
      .catch(() => null);
    // The worker records that the refused order's payment has no order to fulfil (not the
    // deadline's own refund): the cashier's refusal is the one compensation reason.
    assert.deepEqual(await compensationsOf(world, declined), [
      { disposition: "PaidWithoutFulfillableOrder", reason: "OrderNoLongerFulfillable" },
      { disposition: "StaffCancellation", reason: "Refund" },
    ]);
    // The deadline worker first: it refunds the order, and the cashier's Can't make it then can't.
    await world.staffSeen(world.now());
    const resumed = await world
      .worker()
      .run((tx) => paid.resume(tx, expired.event.eventId))
      .catch((error) => error);
    assert.equal(resumed?.status, "CompensationRequired", String(resumed?.code ?? resumed));
    const closed = await compensationsOf(world, expired);
    assert.equal(closed.length, 1, JSON.stringify(closed));
    assert.equal(closed[0].disposition, "PaidWithoutFulfillableOrder");
    await assert.rejects(cashier.refuse(expired));
    assert.deepEqual(await compensationsOf(world, expired), closed);
    // Payment's own line: one compensation case per payment attempt, whoever asks first.
    assert.deepEqual(
      await query(
        "SELECT indexdef FROM pg_indexes WHERE indexname='payment_compensation_case_history_attempt_idx'",
      ).then((rows) => rows.length),
      1,
    );
  });
});

it("an order refunded dish by dish before anyone accepted it is never accepted, and closes with nothing more refunded", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_rl_full", orderType: "Pickup" }, async (world) => {
    const { assert, paid, kitchenScreen, transactions, seedPaidPickup, query, fresh } = world;
    await kitchenScreen.seenNow();
    const cashier = await frontOfHouse(world, "01a6ab02");
    const accept = await world.acceptanceFor(cashier);
    const order = await seedPaidPickup();
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, order.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    // Recorded as an earlier server let it be: an ordinary refund of every dish (the tip stays
    // captured), made before anyone accepted the order.
    const lines = await query(
      "SELECT order_item_id::text AS item,quantity FROM rms_ordering.order_item WHERE order_batch_id=$1",
      [order.orderBatchReference],
    );
    await transactions().run((tx) =>
      createPostgresOrdinaryRefundRequestRuntime({
        scope: {
          ...world.ownerScope,
          providerAccountReference: world.provider,
          environment: "Test",
        },
        authorize: async () => true,
        now: world.now,
        newAuditReference: fresh,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      })(tx, {
        orderReference: order.orderReference,
        requestReference: fresh(),
        operationReference: fresh(),
        actorReference: cashier.actor,
        expectedClaimVersion: 0,
        reasonCode: "CUSTOMER_REQUEST",
        items: lines.map((line) => ({
          orderBatchReference: order.orderBatchReference,
          orderItemReference: line.item,
          quantity: line.quantity,
        })),
      }),
    );
    // Accept is refused: every dish was refunded, so the kitchen never makes it.
    await assert.rejects(
      accept({
        sessionCookie: cashier.sessionCookie,
        csrf: cashier.csrf,
        command: {
          acceptanceReference: fresh(),
          operationReference: fresh(),
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          expectedOrderVersion: 1,
        },
      }),
      { code: "ORDER_ACCEPTANCE_NOT_ACCEPTABLE", reason: "FullyRefunded" },
    );
    assert.deepEqual(
      await query("SELECT 1 FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1", [
        order.orderBatchReference,
      ]),
      [],
    );
    // Can't make it closes it, refunding nothing more than the earlier refund already returns.
    const closed = await cashier.refuse(order);
    assert.equal(closed.status, "Cancelled");
    assert.deepEqual(
      await query(
        "SELECT previous_phase,refund_disposition FROM rms_ordering.order_staff_cancellation WHERE order_batch_id=$1",
        [order.orderBatchReference],
      ),
      [{ previous_phase: "Submitted", refund_disposition: "AlreadyRefunded" }],
    );
  });
});

/**
 * WP-2423 M15. The pilot application clock is a lower bound of the database's, so an instant a
 * Payment store just stamped with clock_timestamp() can be after the application's own now. On
 * v15 that refused approvals at random ("Your session has ended"). Run as the restricted API role,
 * with this process's clock set behind the database's, the refund authority check compares on the
 * database clock and lets the approval through; the old application-clock comparison refused it.
 */
it("refund authority is never refused because the application clock trails the database's", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_rl_clock", orderType: "Pickup" }, async (world) => {
    const { assert, transactions } = world;
    const SystemDate = globalThis.Date;
    const offset = await transactions().run((tx) =>
      measureDatabaseClockOffset((sql) => tx.query(sql)),
    );
    // 250 ms behind the database: wider than the 1-2 ms seen live, so a slow round trip on this
    // host cannot hide the gap, and well inside the pilot's 2 s allowance.
    const shiftMs = offset - 250;
    globalThis.Date = new Proxy(SystemDate, {
      construct: (target, args, newTarget) =>
        Reflect.construct(
          target,
          args.length === 0 ? [SystemDate.now() + shiftMs] : args,
          newTarget,
        ),
      get: (target, key) =>
        key === "now" ? () => SystemDate.now() + shiftMs : Reflect.get(target, key),
    });
    try {
      const answers = await transactions().run(async (tx) => {
        const role = (
          await tx.query("SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user")
        ).rows[0];
        // As a Payment store stamps an approval or a send: the database's own now.
        const at = (
          await tx.query(
            `SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`,
          )
        ).rows[0].at;
        let authorized = 0;
        const current = refundAuthorityCurrent(tx, async () => {
          authorized += 1;
          return true;
        });
        return {
          bypassesRls: role.rolbypassrls,
          applicationClockSaysLater: at > new Date().toISOString(),
          approved: await current(tx, at),
          authorized,
          // Another transaction, or an instant really after the database's now, is still refused.
          otherTransaction: await current({ query: (...args) => tx.query(...args) }, at),
          future: await current(tx, new SystemDate(Date.parse(at) + 60_000).toISOString()),
        };
      });
      assert.deepEqual(answers, {
        bypassesRls: false,
        applicationClockSaysLater: true,
        approved: true,
        authorized: 1,
        otherTransaction: false,
        future: false,
      });
    } finally {
      globalThis.Date = SystemDate;
    }
  });
});
