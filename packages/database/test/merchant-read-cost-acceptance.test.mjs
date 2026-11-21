import { it } from "vitest";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { merchantFailureKind } from "../../../apps/api/src/merchant-failure.ts";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { seedOrdinaryRefundSession } from "../test-support/ordinary-refund-session.mjs";

/**
 * Batch 37 (v15 b36: Home waited for GET /merchant/orders, ~1,600 statements and 1.4–2.1 s at
 * TM2). Under the restricted NOBYPASSRLS api role with the rendered pilot ACL, real paid pickups
 * (some sent to the kitchen, one being made, some waiting): in the read-only snapshot the Orders
 * list answers each listed Order's owner point reads from one read each, with exactly the answer
 * the readers give when every point read is sent, and its statements no longer grow ~17 per
 * listed Order. A Session whose ordering permission ended is still refused on the same path.
 *
 * Batch 37 review: on that same path (the snapshot, its point reads, and the permission evaluation
 * a read reuses), another Store's and another Tenant's staff see none of this Store's Orders, and a
 * Session pointed at this Store without its own Membership or Store assignment is refused, each
 * read right after this Store's staff read it.
 */
const on = async (world) => {
  await world.setting.change({ pickup: true, dineIn: false, at: world.time(-world.minutes(240)) });
  await world.kitchenScreen.seenNow();
};
const sentAgo = async (world, minutesAgo) => {
  const order = await world.seedPaidPickup({ paidMinutesAgo: minutesAgo + 1 });
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
/**
 * The same persistence counting its reads of owner tables (scope settings, advisory locks and
 * savepoints are answered by the pilot runner without a round trip, so they are not counted);
 * `snapshot: false` leaves its snapshot runner out.
 */
const local =
  /^\s*(?:SELECT\s+(?:set_config|pg_advisory|current_setting)|SAVEPOINT|RELEASE|ROLLBACK TO)/iu;
const counted = (persistence, { snapshot }) => {
  const counter = { statements: 0 };
  const count = (tx) => ({
    query: (sql, values) => {
      if (!local.test(String(sql))) counter.statements++;
      return tx.query(sql, values);
    },
  });
  const transactions = {
    run: (unit) => persistence.transactions.run((tx) => unit(count(tx))),
    ...(snapshot
      ? { runSnapshot: (unit) => persistence.transactions.runSnapshot((tx) => unit(count(tx))) }
      : {}),
  };
  return { counter, persistence: { ...persistence, transactions } };
};
/** The answer without the instant each read was observed at. */
const comparable = (view) =>
  JSON.parse(JSON.stringify(view, (key, value) => (key === "observedAt" ? "<read at>" : value)));

it("batch 37: the Orders list reads the listed Orders' point reads once for all, with the same answer", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_b37_orders", orderType: "Pickup" }, async (world) => {
    const { assert } = world;
    await on(world);
    const staff = await world.session([], "01a6ab37");
    const list = (persistence) =>
      createPersistentMerchantOrderQueue({
        persistence: { ...persistence, now: world.now },
        quoteVersion: 1,
        acceptanceConfigured: true,
      })({ sessionCookie: staff.sessionCookie, afterOrderReference: null });
    const read = async (snapshot) => {
      const run = counted(staff.persistence, { snapshot });
      const view = await list(run.persistence);
      return { view, statements: run.counter.statements };
    };

    // Seeded oldest first (the stock ledger reads forward in time). Two Orders: one sent to the
    // kitchen and being made, one paid and waiting.
    const making = await sentAgo(world, 40);
    const ticket = await world.seedKitchenTicket(making);
    await world.kitchenStep(ticket, "AcceptKitchenWorkItem");
    await world.kitchenStep(ticket, "StartKitchenWorkItem");
    await world.seedPaidPickup({ paidMinutesAgo: 38 });
    const small = await read(true);
    const smallAll = await read(false);
    assert.equal(small.view.items.length, 2);
    assert.deepEqual(comparable(small.view), comparable(smallAll.view));

    // Six more: four sent to the kitchen (two with a ticket), two waiting.
    for (const minutesAgo of [20, 19, 18, 17]) {
      const sent = await sentAgo(world, minutesAgo);
      if (minutesAgo % 2 === 0) await world.seedKitchenTicket(sent);
    }
    await world.seedPaidPickup({ paidMinutesAgo: 4 });
    await world.seedPaidPickup({ paidMinutesAgo: 3 });
    const large = await read(true);
    const largeAll = await read(false);
    assert.equal(large.view.items.length, 8);
    // Exactly what the readers answer when every point read is sent (the kitchen's own state of
    // the Order being made among it).
    assert.deepEqual(comparable(large.view), comparable(largeAll.view));
    assert.ok(large.view.items.some((item) => item.kitchenPhase === "InProgress"));
    // Every point read sent: ~11 more reads per listed pickup (~17 on v15 with tables). Read once
    // for all: one or two.
    const perOrderAll = (largeAll.statements - smallAll.statements) / 6;
    const perOrder = (large.statements - small.statements) / 6;
    assert.ok(perOrderAll >= 8, "every point read sent: " + perOrderAll + " per Order");
    assert.ok(perOrder <= perOrderAll / 4, "read once for all: " + perOrder + " per Order");

    // Another Store of the same Brand and Tenant, and another Tenant: staff of each, with the same
    // permissions at their own Store. As the pilot composition, the association accepts every
    // Store of a Tenant's Brand; the Session's own Membership and Store assignment decide.
    const otherStoreScope = {
      ...world.ownerScope,
      storeReference: "01a6b370-0000-7000-8000-000000000002",
    };
    const otherTenantScope = {
      tenantReference: "01a6b371-0000-7000-8000-000000000900",
      brandReference: "01a6b371-0000-7000-8000-000000000001",
      storeReference: "01a6b371-0000-7000-8000-000000000002",
    };
    const installation = [world.ownerScope, otherStoreScope, otherTenantScope];
    const seedOther = async (otherScope, prefix) => {
      const actor = world.fresh();
      const seeded = await seedMerchantAcceptanceSession({
        admin: world.admin,
        runner: world.transactions(),
        scope: otherScope,
        actor,
        at: world.now(),
        referencePrefix: prefix,
        sessionReferencePrefix: "01a9" + prefix.slice(4),
      });
      return {
        actor,
        sessionCookie: seeded.sessionCookie,
        persistence: {
          ...seeded.persistence,
          validateAssociation: async (_tx, session, selected) =>
            session.actor.actorReference === actor &&
            installation.some(
              (known) =>
                known.tenantReference === selected.tenantReference &&
                known.brandReference === selected.brandReference &&
                known.storeReference === selected.storeReference,
            ),
        },
      };
    };
    // The Brand's second Store, under a code of its own (the seed names every Store alike).
    await world.admin.query(
      "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_OTHER_STORE','Synthetic Other Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
      [
        otherStoreScope.storeReference,
        otherStoreScope.brandReference,
        new Date(Date.now() - world.minutes(5)).toISOString(),
      ],
    );
    // The other Tenant's Brand and Store, under codes of their own.
    await world.admin.query(
      "INSERT INTO bop_tenant.brand VALUES ($1,'SYNTHETIC_OTHER_BRAND','Synthetic Other Brand','en-CA','CAD','Active',1,$2,$2)",
      [otherTenantScope.brandReference, new Date(Date.now() - world.minutes(5)).toISOString()],
    );
    await world.admin.query(
      "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_OTHER_TENANT_STORE','Synthetic Other Tenant Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
      [
        otherTenantScope.storeReference,
        otherTenantScope.brandReference,
        new Date(Date.now() - world.minutes(5)).toISOString(),
      ],
    );
    const otherStore = await seedOther(otherStoreScope, "01a6b372");
    const otherTenant = await seedOther(otherTenantScope, "01a6b373");
    const listAs = (staffMember) =>
      createPersistentMerchantOrderQueue({
        persistence: { ...staffMember.persistence, now: world.now },
        quoteVersion: 1,
        acceptanceConfigured: true,
      })({ sessionCookie: staffMember.sessionCookie, afterOrderReference: null });
    const refusal = (promise) =>
      promise.then(
        () => null,
        (error) => error,
      );
    for (const staffMember of [otherStore, otherTenant]) {
      assert.equal((await read(true)).view.items.length, 8);
      const theirs = await listAs(staffMember);
      assert.deepEqual(theirs.items, []);
    }
    // A Session of each of them selecting this Store (a selection is never changed in place; a
    // new Session is): refused, not answered with this Store's Orders.
    for (const [n, staffMember] of [otherStore, otherTenant].entries()) {
      const pointed = await seedOrdinaryRefundSession({
        client: world.admin,
        runner: () => world.transactions(),
        scope: world.ownerScope,
        requester: staffMember.actor,
        at: world.now(),
        policyCode: "WorkforceStandard",
        referencePrefix: "01a9b37" + String(4 + n),
      });
      assert.equal((await read(true)).view.items.length, 8);
      const refused = await refusal(
        listAs({ ...staffMember, sessionCookie: pointed.sessionCookie }),
      );
      assert.notEqual(refused, null);
      assert.equal(merchantFailureKind(refused), "Refused");
    }

    // A Session whose ordering permission ended is refused on the same path, before any Order.
    const revoked = await world.admin.query(
      "UPDATE bop_permission.permission_grant g SET lifecycle='Revoked',version=g.version+1 FROM bop_permission.role_assignment a,bop_permission.permission_definition d WHERE a.actor_id=$1 AND a.lifecycle='Active' AND g.role_id=a.role_id AND g.lifecycle='Active' AND d.permission_id=g.permission_id AND d.action_code='ordering.operate'",
      [staff.actor],
    );
    assert.ok(revoked.rowCount >= 1);
    const refused = await read(true).then(
      () => null,
      (error) => error,
    );
    assert.notEqual(refused, null);
    assert.equal(merchantFailureKind(refused), "Refused");
    assert.equal(refused.message, "MERCHANT_ORDER_QUEUE_DENIED");
  });
});
