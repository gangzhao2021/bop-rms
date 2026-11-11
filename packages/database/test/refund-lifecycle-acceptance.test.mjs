import { it } from "vitest";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";
import { createMerchantOrderStaffCancellation } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import {
  createPostgresOrdinaryRefundApprovalQueueRuntime,
  createPostgresOrdinaryRefundRequestRuntime,
} from "../../rms/payment/src/index.ts";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import { listStoreKitchenOrderItemStates } from "../../rms/kitchen/src/index.ts";
import { createMerchantOrdinaryRefundRequest } from "../../../apps/api/src/merchant-ordinary-refund-request.ts";
import { readRefundWithdrawnUnits } from "../../../apps/api/src/order-refund-withdrawal.ts";
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

/**
 * WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4). Under the restricted API role with the
 * rendered pilot ACL: a manager refunds one of two units of a paid pickup and answers "stop making
 * it too": the withdrawal is recorded with the refund request, in that transaction, in their name;
 * the kitchen, pickup and guest reads count it; someone who may not take dishes off an order is
 * refused before anything is written; the record never changes.
 */
it("a dish refunded with stop making it too is recorded with the refund and counted by the kitchen and pickup reads", async () => {
  await withAutoAcceptWorld(
    { caseId: "wp2423_rl_withdraw", orderType: "Pickup" },
    async (world) => {
      const { assert, paid, kitchenScreen, transactions, seedPaidPickup, query, fresh } = world;
      await kitchenScreen.seenNow();
      const order = await seedPaidPickup({ quantity: 2 });
      assert.equal(
        (await transactions().run((tx) => paid.consume(tx, order.event))).result.status,
        "AwaitingOrderAcceptance",
      );
      const line = (
        await query(
          "SELECT order_item_id::text AS item,quantity FROM rms_ordering.order_item WHERE order_batch_id=$1 ORDER BY order_item_id LIMIT 1",
          [order.orderBatchReference],
        )
      )[0];
      assert.equal(line.quantity, 2);
      const command = (staff, withdraw) =>
        createMerchantOrdinaryRefundRequest({
          persistence: { ...staff.persistence, now: world.now },
          authentication: staff.authentication,
          resolveConfiguration: async () => ({
            providerAccountReference: world.provider,
            environment: "Test",
            roleMapping: { Manager: [staff.roleCode], Owner: [], Finance: [] },
          }),
          newAuditReference: fresh,
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
          nextReference: fresh,
        })({
          sessionCookie: staff.sessionCookie,
          csrf: staff.csrf,
          command: {
            orderReference: order.orderReference,
            requestReference: withdraw.requestReference,
            operationReference: withdraw.operationReference,
            expectedClaimVersion: withdraw.claimVersion ?? 0,
            reasonCode: "QUALITY_ISSUE",
            items: [
              {
                orderBatchReference: order.orderBatchReference,
                orderItemReference: line.item,
                quantity: 1,
              },
            ],
            withdraw: [{ orderItemReference: line.item, quantity: withdraw.quantity }],
          },
        });
      const rows = () =>
        query(
          "SELECT withdrawn_quantity,actor_id::text AS actor,permission_code,refund_request_id::text AS request FROM rms_ordering.order_item_refund_withdrawal WHERE order_id=$1",
          [order.orderReference],
        );
      const requests = () =>
        query(
          "SELECT count(*)::int AS n FROM rms_payment.ordinary_refund_request WHERE order_id=$1",
          [order.orderReference],
        ).then((found) => found[0].n);
      // A manager without Ordering's cancel permission: refused before any request is recorded.
      const noCancel = await world.session(["payment.refund.request"], "01a6ab11");
      noCancel.roleCode = "synthetic_acceptance_01a6ab11";
      await assert.rejects(
        command(noCancel, { requestReference: fresh(), operationReference: fresh(), quantity: 1 }),
        { message: "ORDINARY_REFUND_WITHDRAW_DENIED" },
      );
      assert.equal(await requests(), 0);
      assert.deepEqual(await rows(), []);
      const manager = await world.session(
        ["payment.refund.request", "ordering.order.cancel"],
        "01a6ab12",
      );
      manager.roleCode = "synthetic_acceptance_01a6ab12";
      // More units withdrawn than this request refunds: refused, nothing written.
      await assert.rejects(
        command(manager, { requestReference: fresh(), operationReference: fresh(), quantity: 2 }),
        { message: "ORDINARY_REFUND_WITHDRAW_DENIED" },
      );
      assert.equal(await requests(), 0);
      // One of two units, "stop making it too": recorded with the request, in the manager's name.
      const first = { requestReference: fresh(), operationReference: fresh(), quantity: 1 };
      const recorded = await command(manager, first);
      assert.equal(recorded.status, "Created");
      assert.deepEqual(await rows(), [
        {
          withdrawn_quantity: 1,
          actor: manager.actor,
          permission_code: "ordering.order.cancel",
          request: first.requestReference,
        },
      ]);
      // The same request again (a retry) writes nothing more.
      await command(manager, first);
      assert.equal((await rows()).length, 1);
      // What the kitchen board, the pickup card and the guest's page read, as the API role.
      const units = await transactions().run((tx) =>
        readRefundWithdrawnUnits(tx, world.ownerScope, [order.orderReference]),
      );
      assert.deepEqual([...units], [[line.item, 1]]);
      // Not every unit is refunded, so the order still goes ahead: Accept is not refused.
      const staff = await world.session([], "01a6ab13");
      const accept = await world.acceptanceFor(staff);
      const accepted = await accept({
        sessionCookie: staff.sessionCookie,
        csrf: staff.csrf,
        command: {
          acceptanceReference: fresh(),
          operationReference: fresh(),
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          expectedOrderVersion: 1,
        },
      });
      assert.ok(accepted);
      // The kitchen has not started the dish: the refund page ticks "stop making it too".
      await world.seedKitchenTicket(order);
      const states = await transactions().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [world.ownerScope.brandReference, world.ownerScope.storeReference],
        );
        return listStoreKitchenOrderItemStates(tx, world.ownerScope, [order.orderBatchReference]);
      });
      assert.equal(states.get(line.item), "NotStarted");
      // History stays as recorded for the API role.
      for (const sql of [
        "UPDATE rms_ordering.order_item_refund_withdrawal SET withdrawn_quantity=2",
        "DELETE FROM rms_ordering.order_item_refund_withdrawal",
      ])
        await assert.rejects(
          transactions().run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [world.ownerScope.brandReference, world.ownerScope.storeReference],
            );
            await tx.query(sql);
          }),
        );
      assert.equal((await rows()).length, 1);
    },
  );
});

/**
 * WP-2423 M14 (DEC-OWNER-DEFAULTS-2026-11-06 item 2). Under the restricted API role: a cashier
 * (mapped as Staff, holding payment.refund.request only) records a refund request with a reason;
 * nothing is prepared or sent; once it has waited a minute the Store's approval queue lists it as
 * not sent, for a manager or the owner to send.
 */
it("a cashier's refund request is recorded, never sent by them, and listed for a manager to send", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_rl_staff", orderType: "Pickup" }, async (world) => {
    const { assert, paid, kitchenScreen, transactions, seedPaidPickup, query, fresh } = world;
    await kitchenScreen.seenNow();
    const order = await seedPaidPickup({ quantity: 2, paidMinutesAgo: 6 });
    assert.equal(
      (await transactions().run((tx) => paid.consume(tx, order.event))).result.status,
      "AwaitingOrderAcceptance",
    );
    const { businessDate } = await seedJourneyStorePublication({
      client: world.admin,
      scope: world.ownerScope,
      publishedAt: world.time(-world.minutes(24 * 60)),
      businessDayStart: "00:00:00",
      prefix: "01a6ab30",
      allWeek: true,
    });
    const line = (
      await query(
        "SELECT order_item_id::text AS item FROM rms_ordering.order_item WHERE order_batch_id=$1 ORDER BY order_item_id LIMIT 1",
        [order.orderBatchReference],
      )
    )[0];
    // The cashier signed in and asked two minutes ago (the clock of this process).
    world.clock.offset = -world.minutes(2);
    const cashier = await world.session(["payment.refund.request"], "01a6ab31");
    const mapping = {
      Manager: [],
      Owner: [],
      Finance: [],
      Staff: ["synthetic_acceptance_01a6ab31"],
    };
    const request = createMerchantOrdinaryRefundRequest({
      persistence: { ...cashier.persistence, now: world.now },
      authentication: cashier.authentication,
      resolveConfiguration: async () => ({
        providerAccountReference: world.provider,
        environment: "Test",
        roleMapping: mapping,
      }),
      newAuditReference: fresh,
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
      businessDate,
    });
    const command = {
      orderReference: order.orderReference,
      requestReference: fresh(),
      operationReference: fresh(),
      expectedClaimVersion: 0,
      reasonCode: "WRONG_ITEM",
      items: [
        {
          orderBatchReference: order.orderBatchReference,
          orderItemReference: line.item,
          quantity: 1,
        },
      ],
    };
    let recorded;
    try {
      recorded = await request({
        sessionCookie: cashier.sessionCookie,
        csrf: cashier.csrf,
        command,
      });
    } finally {
      world.clock.offset = 0;
    }
    assert.equal(recorded.status, "Created");
    assert.equal(recorded.approvalRequired, false);
    // Recorded in the cashier's name with the reason; nothing prepared.
    assert.deepEqual(
      await query(
        "SELECT r.actor_id::text AS actor,r.record_json->>'reasonCode' AS reason,(SELECT count(*)::int FROM rms_payment.ordinary_refund_operation o WHERE o.request_id=r.request_id) AS prepared FROM rms_payment.ordinary_refund_request r WHERE r.request_id=$1",
        [command.requestReference],
      ),
      [{ actor: cashier.actor, reason: "WRONG_ITEM", prepared: 0 }],
    );
    // Without the Staff group a cashier's request is refused.
    await assert.rejects(
      createMerchantOrdinaryRefundRequest({
        persistence: { ...cashier.persistence, now: world.now },
        authentication: cashier.authentication,
        resolveConfiguration: async () => ({
          providerAccountReference: world.provider,
          environment: "Test",
          roleMapping: { Manager: [], Owner: [], Finance: [] },
        }),
        newAuditReference: fresh,
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      })({
        sessionCookie: cashier.sessionCookie,
        csrf: cashier.csrf,
        command: { ...command, requestReference: fresh(), operationReference: fresh() },
      }),
    );
    // The Store's approval queue, as the API role: listed as not sent, for someone to send.
    const queue = await transactions().run((tx) =>
      createPostgresOrdinaryRefundApprovalQueueRuntime({
        scope: world.ownerScope,
        providerAccountReference: world.provider,
        environment: "Test",
        authorize: async () => true,
        businessDate,
      })(tx, { observedAt: world.now() }),
    );
    assert.deepEqual(
      queue.map((entry) => [entry.requestReference, entry.state, entry.requesterReference]),
      [[command.requestReference, "NotSent", cashier.actor]],
    );
  });
});
