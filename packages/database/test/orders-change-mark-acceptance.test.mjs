import { it } from "vitest";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";
import { createPersistentMerchantOrderChanges } from "../../../apps/api/src/merchant-order-changes.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";

/**
 * WP-2423 (reads-under-burst, v15 2026-11-13): a freshly paid pickup reached the Orders screen
 * 30-70 s late, because the screen read its whole (heavy) list only every 10 s. Orders now asks
 * every few seconds whether anything changed among the Store's Orders, and reads the list at once
 * when it did. Under the restricted NOBYPASSRLS api role with the rendered pilot ACL, on real
 * Orders paid online and the worker's paid outcome as the pilot composes it:
 *  - the mark changes when a pickup is placed and paid, and again when its payment reaches the
 *    Store (the paid order now waits for staff), and stays the same while nothing changes;
 *  - the list read at the moment the mark changed already holds the new order;
 *  - it needs a staff sign-in like the list, and names no Order.
 */
it("the Orders change mark moves with a new paid pickup and its payment, and only then", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_ocm", orderType: "Pickup" }, async (world) => {
    const { assert } = world;
    const staff = await world.session([], "01a6ab31");
    const persistence = { ...staff.persistence, now: world.now };
    const changes = createPersistentMerchantOrderChanges({ persistence });
    const list = createPersistentMerchantOrderQueue({
      persistence,
      quoteVersion: 1,
      acceptanceConfigured: true,
    });
    const mark = async () => (await changes({ sessionCookie: staff.sessionCookie })).mark;

    const empty = await mark();
    assert.match(empty, /^[0-9a-f]{32}$/u);
    assert.equal(await mark(), empty, "nothing changed: the same mark");

    // A guest places and pays a pickup (the Order, its round, the payment taken).
    const order = await world.seedPaidPickup({ paidMinutesAgo: 0 });
    const placed = await mark();
    assert.notEqual(placed, empty, "a new paid pickup changes the mark");
    // The list read when the mark changed already holds it.
    const listed = await list({ sessionCookie: staff.sessionCookie, afterOrderReference: null });
    assert.ok(
      listed.items.some((item) => item.orderReference === order.orderReference),
      "the Orders list holds the new pickup",
    );
    // Its payment reaches the Store's Orders (the worker's paid outcome): it waits for staff.
    await world.transactions().run((tx) => world.paid.consume(tx, order.event));
    const waiting = await mark();
    assert.notEqual(waiting, placed, "the payment reaching the Store changes the mark");
    assert.equal(await mark(), waiting);
    // Nothing about any Order is in it.
    assert.ok(!waiting.includes(order.orderReference.slice(0, 8)));

    // Without a staff sign-in there is no answer, as for the list.
    await assert.rejects(changes({ sessionCookie: "not-a-session" }));
  });
});
