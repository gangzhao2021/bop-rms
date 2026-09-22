import { expect, it } from "vitest";
import {
  encodePaymentCompensationRefund,
  decodePaymentCompensationRefund,
} from "../application/payment-compensation-refund-codec.js";
import { parsePaymentProviderConfirmedRefundFact } from "../application/paid-without-fulfillable-order.js";
import { createPaymentRefundedEnvelope } from "../application/payment-refunded-event.js";

const id = (n: number) => "0190ed20-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const fact = parsePaymentProviderConfirmedRefundFact({
  refundReference: id(1),
  eventReference: id(2),
  compensationCaseReference: id(3),
  paymentTransactionReference: id(4),
  paymentIntentReference: id(5),
  paymentAttemptReference: id(6),
  orderReference: id(7),
  brandReference: id(8),
  storeReference: id(9),
  originalPaymentMethod: "OnlineCard",
  amount: { amountMinor: 9223372036854775807n, currencyCode: "CAD" },
  source: "ProviderRetrieval",
  providerConfirmedAt: "2026-09-12T12:00:00.000Z",
  recordedAt: "2026-09-12T12:00:00.000Z",
  evidenceDigest: "sha256:" + "a".repeat(64),
  causationReference: id(10),
});
const receipt = { fact, event: createPaymentRefundedEnvelope({ fact }) };
it("round-trips int64 money and preserves decimal Event payload money", () => {
  const result = decodePaymentCompensationRefund(encodePaymentCompensationRefund(receipt));
  expect(result).toEqual(receipt);
  expect(result.event.payload.amountMinor).toBe("9223372036854775807");
  expect(result.event.aggregateVersion).toBe(1n);
});
it.each(["0", "01", "-1", "1e2", "9223372036854775808", 1, null])(
  "rejects invalid persisted money %s",
  (amountMinor) => {
    const raw = JSON.parse(encodePaymentCompensationRefund(receipt));
    raw.fact.amount.amountMinor = amountMinor;
    expect(() => decodePaymentCompensationRefund(JSON.stringify(raw))).toThrow();
  },
);
it.each(["tenantId", "storeId", "eventId", "causationId"])(
  "rejects independently valid Event with mismatched %s",
  (field) => {
    expect(() =>
      encodePaymentCompensationRefund({
        fact,
        event: { ...receipt.event, [field]: id(99) },
      }),
    ).toThrow();
  },
);
it("rejects changed Event money, extra fields and invalid version", () => {
  expect(() =>
    encodePaymentCompensationRefund({
      fact,
      event: { ...receipt.event, payload: { ...receipt.event.payload, amountMinor: "1" } },
    }),
  ).toThrow();
  expect(() => encodePaymentCompensationRefund({ ...receipt, extra: true })).toThrow();
  const raw = JSON.parse(encodePaymentCompensationRefund(receipt));
  raw.event.aggregateVersion = 1;
  expect(() => decodePaymentCompensationRefund(JSON.stringify(raw))).toThrow();
});
it.each([null, "null", "{}", " ".repeat(65537)])("rejects malformed storage", (value) => {
  expect(() => decodePaymentCompensationRefund(value)).toThrow();
});
