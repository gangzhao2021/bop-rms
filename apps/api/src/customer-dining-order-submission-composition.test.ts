import { expect, it } from "vitest";
import { orderSubmissionFixture } from "../test-support/dining-order-submission-fixture.js";

/**
 * WP-2423 table-move-send (v15 fabf0261, 2026-11-06): staff moved the party after the guest's
 * first round was prepared and before Ordering placed it. Ordering's checkout validation turned
 * Dining's refusal into its own "unavailable" (503, retried until the checkout lapsed); the order
 * is now refused as table moved, with no Order written, and the phone checks out again.
 */
it("WP-2423 table-move-send: a first round whose party was moved before it was placed answers table moved", async () => {
  const f = orderSubmissionFixture();
  const loadCart = f.options.checkout.repository.loadCart;
  let moved = false;
  f.options.checkout.repository.loadCart = async (...args) => {
    // Ordering's checkout validation reads the Cart after Dining prepared the round: staff move
    // the party now.
    if (!moved && f.writes() === 1) {
      moved = true;
      f.moveParty();
    }
    return loadCart(...args);
  };
  await expect(f.orderService().create(f.orderInput)).rejects.toMatchObject({
    name: "OrderCreationError",
    code: "ORDER_CREATE_TABLE_MOVED",
  });
  expect(moved).toBe(true);
  expect(f.orderWrites()).toBe(0);
  // Dining kept the round's history; it was prepared once and never sent.
  expect(f.writes()).toBe(1);
});

it("WP-2423 table-move-send: with no move, an unavailable dependency keeps its old answer", async () => {
  const f = orderSubmissionFixture();
  f.options.checkout.repository.loadCart = async () => {
    throw new Error("synthetic lock wait");
  };
  await expect(f.orderService().create(f.orderInput)).rejects.not.toMatchObject({
    code: "ORDER_CREATE_TABLE_MOVED",
  });
  expect(f.orderWrites()).toBe(0);
});
