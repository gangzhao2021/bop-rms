import { expect, it, vi } from "vitest";
import type { CustomerMenuQueryPorts } from "@rms/catalog";
import type { CustomerCartPort } from "./customer-cart.js";
import { guestCartWithoutTea, guestMenuWithoutTea } from "./customer-cart-tea-guard.js";

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

it("v15 2026-10-29: the guest menu leaves out the Store's tea, which stays offered for staff", async () => {
  const offered = {
    availability: "Available" as const,
    price: { amount: "1.50", currency: "CAD" },
  };
  type Facts = NonNullable<CustomerMenuQueryPorts["storeFacts"]>;
  const facts: Facts = {
    load: async () =>
      new Map([
        [tea, offered],
        [dish, offered],
      ]) as never,
  };
  const input = {} as unknown as Parameters<Facts["load"]>[0];
  const shown = (await guestMenuWithoutTea(facts, async () => tea).load(input)) as unknown as Map<
    string,
    { availability: string }
  >;
  expect(shown.get(tea)?.availability).toBe("NotOffered");
  expect(shown.get(dish)?.availability).toBe("Available");
  // No tea charge, or the setting unreadable: the menu as it is (the cart still guards the tea).
  for (const reading of [async () => null, async () => Promise.reject(new Error("down"))])
    expect(
      (
        (await guestMenuWithoutTea(facts, reading).load(input)) as unknown as Map<string, unknown>
      ).get(tea),
    ).toEqual(offered);
});
