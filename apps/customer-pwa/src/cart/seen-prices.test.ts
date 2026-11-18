import { afterEach, expect, it } from "vitest";
import {
  acceptSeenPrices,
  clearSeenPrices,
  recordFirstSeenPrices,
  recordHeldFirstPrices,
  recordStoreFirstPrices,
  seenPriceChanges,
} from "./seen-prices.js";

const cart = "018f7a00-0000-7000-8000-000000000001";
const tea = "018f7a00-0000-7000-8000-000000000002";
const line = (amountMinor: bigint, quantity = 1) => ({
  cartItemReference: tea,
  quantity,
  amountMinor,
  currency: "CAD",
});
afterEach(clearSeenPrices);

it("WP-2423 M74: a rise, then the cart showing the new price, then checkout still lists the change", () => {
  recordFirstSeenPrices(cart, [line(549n)]); // added at $5.49
  // The price rose; the cart shows the new price — that is not the guest accepting it.
  recordFirstSeenPrices(cart, [line(599n)]);
  expect(seenPriceChanges(cart, [line(599n)])).toEqual([
    {
      cartItemReference: tea,
      beforeMinor: 549n,
      afterMinor: 599n,
      currency: "CAD",
      direction: "up",
    },
  ]);
  // Accepting it at checkout makes it the price the guest saw.
  acceptSeenPrices(cart, [line(599n)]);
  expect(seenPriceChanges(cart, [line(599n)])).toEqual([]);
});

it("WP-2423 M74: compares per unit, so a quantity changed in the cart is still compared", () => {
  recordFirstSeenPrices(cart, [line(549n)]);
  // Two teas at the old price: no change.
  expect(seenPriceChanges(cart, [line(1098n, 2)])).toEqual([]);
  // Three teas at the new price: the change is stated at today's quantity.
  expect(seenPriceChanges(cart, [line(1797n, 3)])).toMatchObject([
    { beforeMinor: 1647n, afterMinor: 1797n, direction: "up" },
  ]);
});

it("WP-2423 M74: a decrease is listed too; a line never seen, another cart or currency is not", () => {
  recordFirstSeenPrices(cart, [line(549n)]);
  expect(seenPriceChanges(cart, [line(499n)])).toMatchObject([{ direction: "down" }]);
  expect(seenPriceChanges("018f7a00-0000-7000-8000-000000000009", [line(499n)])).toEqual([]);
  expect(seenPriceChanges(cart, [{ ...line(499n), currency: "USD" }])).toEqual([]);
  expect(
    seenPriceChanges(cart, [
      { ...line(100n), cartItemReference: "018f7a00-0000-7000-8000-00000000000a" },
    ]),
  ).toEqual([]);
});

it("WP-2423 batch 30: the price a table's cart was first given replaces a menu price shown meanwhile, never a priced or accepted one", () => {
  // Phone B showed the menu's $13.00 while the Store priced the cart; it holds $12.50 (phone A).
  recordFirstSeenPrices(cart, [line(1300n)]);
  recordHeldFirstPrices(cart, [line(1250n)]);
  expect(seenPriceChanges(cart, [line(1250n)])).toEqual([]);
  // Once given, a later first-price answer does not move it: a real rise is still said.
  recordHeldFirstPrices(cart, [line(1300n)]);
  expect(seenPriceChanges(cart, [line(1300n)])).toMatchObject([
    { beforeMinor: 1250n, afterMinor: 1300n, direction: "up" },
  ]);
  // The Store's record of an earlier first price is kept too.
  clearSeenPrices();
  recordStoreFirstPrices(cart, [line(1000n)]);
  recordHeldFirstPrices(cart, [line(1050n)]);
  expect(seenPriceChanges(cart, [line(1050n)])).toMatchObject([{ direction: "up" }]);
  // A price the guest accepted here stays what they saw.
  clearSeenPrices();
  acceptSeenPrices(cart, [line(1100n)]);
  recordHeldFirstPrices(cart, [line(1050n)]);
  expect(seenPriceChanges(cart, [line(1050n)])).toMatchObject([{ direction: "down" }]);
});
