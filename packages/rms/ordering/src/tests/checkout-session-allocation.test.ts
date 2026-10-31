import { expect, it } from "vitest";
import {
  parseCheckoutSessionAllocation,
  CheckoutSessionAllocationError,
} from "../domain/checkout-session-allocation.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const value = {
  brandReference: id(1),
  storeReference: id(2),
  guestSessionReference: id(3),
  createOperationReference: id(4),
  cartReference: id(5),
  cartVersion: 1,
  quoteReference: id(6),
  quoteVersion: 2,
  checkoutSessionReference: id(7),
  submissionReference: id(8),
  paymentOperationReference: id(9),
  allocatedAt: "2026-09-11T12:00:00.000Z",
};
it("retains an immutable complete allocation", () => {
  const record = parseCheckoutSessionAllocation(value);
  expect(record).toEqual(value);
  expect(Object.isFrozen(record)).toBe(true);
});
it.each([
  { cartVersion: 0 },
  { quoteVersion: 3 },
  { quoteVersion: "2" },
  { submissionReference: id(7) },
  { allocatedAt: "not-an-instant" },
  { extra: "unknown" },
])("rejects malformed allocation %j", (overrides) => {
  expect(() => parseCheckoutSessionAllocation({ ...value, ...overrides })).toThrow(
    CheckoutSessionAllocationError,
  );
});
it("does not execute input accessors", () => {
  let read = false;
  const raw = { ...value };
  Object.defineProperty(raw, "submissionReference", {
    enumerable: true,
    get() {
      read = true;
      return id(8);
    },
  });
  expect(() => parseCheckoutSessionAllocation(raw)).toThrow(CheckoutSessionAllocationError);
  expect(read).toBe(false);
});
