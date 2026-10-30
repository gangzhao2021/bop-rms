import { expect, it, vi } from "vitest";
import type { CustomerCartPort } from "./customer-cart.js";
import { guestCartWithoutTea } from "./customer-cart-tea-guard.js";

const tea = "0190aaaa-0000-7000-8000-000000000001";
const dish = "0190aaaa-0000-7000-8000-000000000002";
const add = (sellableReference: string) =>
  ({ sellableReference, quantity: 1 }) as unknown as Parameters<CustomerCartPort["addItem"]>[0];

it("WP-2423 item 8 ⑦ 4b-3: a guest's phone can't add the Store's tea; other items go on", async () => {
  const addItem = vi.fn<CustomerCartPort["addItem"]>(async () => ({ status: "Added" }) as never);
  const guarded = guestCartWithoutTea({ addItem }, async () => tea);
  expect(await guarded.addItem(add(tea))).toEqual({
    status: "SelectionInvalid",
    issueCodes: ["TEA_CHARGED_BY_STAFF"],
  });
  expect(addItem).not.toHaveBeenCalled();
  await guarded.addItem(add(dish));
  expect(addItem).toHaveBeenCalledTimes(1);
  // No tea charge: everything goes on; the setting unreadable: nothing is added.
  expect(await guestCartWithoutTea({ addItem }, async () => null).addItem(add(tea))).toEqual({
    status: "Added",
  });
  expect(
    await guestCartWithoutTea({ addItem }, async () => {
      throw new Error("down");
    }).addItem(add(dish)),
  ).toEqual({ status: "Unavailable" });
});
