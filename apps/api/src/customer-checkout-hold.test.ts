import { CheckoutSessionServiceError } from "@rms/ordering";
import { DiningCheckoutHeldError } from "@rms/dining";
import { expect, it } from "vitest";
import { checkoutHoldRetrySeconds, rethrowCheckoutHeld } from "./customer-checkout-hold.js";

const at = "2026-08-02T16:00:00.000Z";
it("bounds the wait between one second and an hour", () => {
  expect(checkoutHoldRetrySeconds("2026-08-02T16:00:00.200Z", at)).toBe(1);
  expect(checkoutHoldRetrySeconds("2026-08-02T15:59:00.000Z", at)).toBe(1);
  expect(checkoutHoldRetrySeconds("2026-08-02T16:04:00.001Z", at)).toBe(241);
  expect(checkoutHoldRetrySeconds("2026-08-02T19:00:00.000Z", at)).toBe(3600);
});
it("turns a Dining hold refusal into the checkout-session refusal and rethrows anything else", () => {
  const held = new DiningCheckoutHeldError("2026-08-02T16:10:00.000Z" as never);
  expect(() => rethrowCheckoutHeld(held)).toThrow(
    expect.objectContaining({
      constructor: CheckoutSessionServiceError,
      code: "CHECKOUT_IN_PROGRESS",
      heldUntil: "2026-08-02T16:10:00.000Z",
    }),
  );
  const other = new Error("synthetic");
  expect(() => rethrowCheckoutHeld(other)).toThrow(other);
});
