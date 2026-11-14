import { expect, it } from "vitest";
import { DiningCheckoutServiceError, DiningCheckoutStoreError } from "@rms/dining";
import { OrderCreationError } from "@rms/ordering";
import { createTableMovedLatch, refuseRoundOfMovedTable } from "./customer-dining-table-moved.js";

/** WP-2423 (table-move-payment review): a round prepared before staff moved its party. */
it("tells Ordering the table moved, so the guest starts checkout again", async () => {
  await expect(
    refuseRoundOfMovedTable(async () => {
      throw new DiningCheckoutStoreError("DINING_CHECKOUT_STORE_TABLE_MOVED");
    }),
  ).rejects.toMatchObject({ name: "OrderCreationError", code: "ORDER_CREATE_TABLE_MOVED" });
});

it("passes every other Dining answer on unchanged", async () => {
  const busy = new DiningCheckoutStoreError("DINING_CHECKOUT_STORE_CONFLICT");
  await expect(
    refuseRoundOfMovedTable(async () => {
      throw busy;
    }),
  ).rejects.toBe(busy);
  await expect(refuseRoundOfMovedTable(async () => true)).resolves.toBe(true);
  expect(new OrderCreationError("ORDER_CREATE_TABLE_MOVED").code).toBe("ORDER_CREATE_TABLE_MOVED");
});

it("WP-2423 table-move-send: Dining's service refusal of a moved round reads as table moved too", async () => {
  await expect(
    refuseRoundOfMovedTable(async () => {
      throw new DiningCheckoutServiceError("DINING_CHECKOUT_TABLE_MOVED");
    }),
  ).rejects.toMatchObject({ name: "OrderCreationError", code: "ORDER_CREATE_TABLE_MOVED" });
});

/** WP-2423 table-move-send: a foreign owner's port turns Dining's refusal into its own failure. */
it("a latch that saw the table move answers table moved for the owner's own failure", async () => {
  const latch = createTableMovedLatch();
  await expect(
    latch.watchOrNull(async () => {
      throw new DiningCheckoutServiceError("DINING_CHECKOUT_TABLE_MOVED");
    }),
  ).resolves.toBeNull();
  // Payment then fails with its own "unavailable"; the composition's catch says why.
  expect(() => latch.rethrow(new Error("payment tip unavailable"))).toThrow(
    expect.objectContaining({ name: "OrderCreationError", code: "ORDER_CREATE_TABLE_MOVED" }),
  );
  const ordering = createTableMovedLatch();
  await expect(
    ordering.watch(async () => {
      throw new DiningCheckoutStoreError("DINING_CHECKOUT_STORE_TABLE_MOVED");
    }),
  ).rejects.toMatchObject({ code: "DINING_CHECKOUT_STORE_TABLE_MOVED" });
  expect(ordering.classify(new Error("checkout dependency unavailable"))).toMatchObject({
    code: "ORDER_CREATE_TABLE_MOVED",
  });
});

it("a latch that saw no move keeps every other failure as it was", async () => {
  const latch = createTableMovedLatch();
  const busy = new DiningCheckoutServiceError("DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE");
  await expect(
    latch.watchOrNull(async () => {
      throw busy;
    }),
  ).rejects.toBe(busy);
  await expect(latch.watchOrNull(async () => "prepared")).resolves.toBe("prepared");
  const other = new Error("lock wait");
  expect(() => latch.rethrow(other)).toThrow(other);
});

it("one guest's table-moved refusal never relabels another request's failure", async () => {
  // Each request makes its own latch: the first latched, the second fails for another reason.
  const first = createTableMovedLatch(),
    second = createTableMovedLatch();
  await first.watchOrNull(async () => {
    throw new DiningCheckoutServiceError("DINING_CHECKOUT_TABLE_MOVED");
  });
  const other = new Error("lock wait");
  expect(second.classify(other)).toBe(other);
  expect(first.classify(other)).toMatchObject({ code: "ORDER_CREATE_TABLE_MOVED" });
});
