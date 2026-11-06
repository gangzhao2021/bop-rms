import { expect, it } from "vitest";
import { canFinishPaymentHere } from "./FinishPickupPayment.js";

const order = "018f7a00-0000-7000-8000-000000000001";
const intent = "018f7a00-0000-7000-8000-000000000009";

it("WP-2423 M18: only this phone's checkout of this order, with its payment open, offers Finish paying", () => {
  expect(
    canFinishPaymentHere(
      { status: "Pending", paymentIntentReference: intent, orderReference: order },
      order,
    ),
  ).toBe(true);
  // Another order's checkout, a checkout that never started paying, or a settled payment: no.
  expect(
    canFinishPaymentHere(
      {
        status: "Pending",
        paymentIntentReference: intent,
        orderReference: "018f7a00-0000-7000-8000-000000000002",
      },
      order,
    ),
  ).toBe(false);
  expect(
    canFinishPaymentHere(
      { status: "Pending", paymentIntentReference: null, orderReference: null },
      order,
    ),
  ).toBe(false);
  expect(
    canFinishPaymentHere(
      { status: "Succeeded", paymentIntentReference: intent, orderReference: order },
      order,
    ),
  ).toBe(false);
});
