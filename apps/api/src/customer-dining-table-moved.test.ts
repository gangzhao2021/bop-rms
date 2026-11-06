import { expect, it } from "vitest";
import { DiningCheckoutStoreError } from "@rms/dining";
import { OrderCreationError } from "@rms/ordering";
import { refuseRoundOfMovedTable } from "./customer-dining-table-moved.js";

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
