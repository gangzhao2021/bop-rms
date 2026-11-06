import { expect, it } from "vitest";
import { reportOrderPaymentOutcomes } from "./customer-order-payment-outcomes.js";

const intent = "01a0f020-0000-7000-8000-000000000101";
const other = "01a0f020-0000-7000-8000-000000000102";
const paid = { amountMinor: 2260n, currencyCode: "CAD" };
const declined = {
  paymentIntentReference: intent,
  status: "Failed" as const,
  occurredAt: "2026-08-03T15:02:00.000Z",
  amount: null,
  freshnessStatus: "Fresh" as const,
};

it("WP-2423 M118: another card that went through replaces the projected decline of the same payment", () => {
  expect(
    reportOrderPaymentOutcomes(
      [declined],
      [
        {
          paymentIntentReference: intent,
          outcome: "Succeeded",
          occurredAt: "2026-08-03T15:04:00.000Z",
          amount: paid,
        },
      ],
    ),
  ).toEqual([
    {
      status: "Succeeded",
      occurredAt: "2026-08-03T15:04:00.000Z",
      amount: paid,
      freshnessStatus: "Fresh",
    },
  ]);
});

it("WP-2423 M118: a fact recorded at the same instant as the decline still replaces it", () => {
  expect(
    reportOrderPaymentOutcomes(
      [declined],
      [
        {
          paymentIntentReference: intent,
          outcome: "Succeeded",
          occurredAt: declined.occurredAt,
          amount: paid,
        },
      ],
    )[0]?.status,
  ).toBe("Succeeded");
});

it("WP-2423 M118: a projected success is never downgraded, and an older fact never replaces", () => {
  const success = { ...declined, status: "Succeeded" as const, amount: paid };
  expect(
    reportOrderPaymentOutcomes(
      [success],
      [
        {
          paymentIntentReference: intent,
          outcome: "Failed",
          occurredAt: "2026-08-03T15:09:00.000Z",
          amount: null,
        },
      ],
    )[0]?.status,
  ).toBe("Succeeded");
  expect(
    reportOrderPaymentOutcomes(
      [declined],
      [
        {
          paymentIntentReference: intent,
          outcome: "Succeeded",
          occurredAt: "2026-08-03T15:01:00.000Z",
          amount: paid,
        },
      ],
    )[0]?.status,
  ).toBe("Failed");
});

it("WP-2423 Q10: a payment not projected yet is reported from its fact", () => {
  expect(
    reportOrderPaymentOutcomes(
      [declined],
      [
        {
          paymentIntentReference: other,
          outcome: "Succeeded",
          occurredAt: "2026-08-03T15:05:00.000Z",
          amount: paid,
        },
      ],
    ).map((payment) => payment.status),
  ).toEqual(["Failed", "Succeeded"]);
});
