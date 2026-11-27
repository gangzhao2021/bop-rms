import {
  parsePaymentProviderConfirmedRefundFact,
  PaymentCompensationError,
  type PaymentRefundCompositionReceipt,
} from "./paid-without-fulfillable-order.js";
import {
  createPaymentRefundedEnvelope,
  parsePaymentRefundedEnvelope,
} from "./payment-refunded-event.js";
import { exactPaymentObject } from "./payment-intent-creation.js";

const invalid = (): never => {
  throw new PaymentCompensationError("PAYMENT_COMPENSATION_INPUT_INVALID");
};
const stringify = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );

/** Validates storage shape and fact/Event identity; does not establish Provider truth. */
export function parsePaymentCompensationRefund(value: unknown): PaymentRefundCompositionReceipt {
  const raw = exactPaymentObject(value, ["fact", "event"]);
  const fact = parsePaymentProviderConfirmedRefundFact(raw.fact);
  if (fact.amount.amountMinor > 9223372036854775807n) return invalid();
  const event = parsePaymentRefundedEnvelope(raw.event);
  const expected = createPaymentRefundedEnvelope({ fact });
  // Both parsers return canonical field order, including nested payload fields.
  if (stringify(event) !== stringify(expected)) return invalid();
  return Object.freeze({ fact, event });
}

export function encodePaymentCompensationRefund(value: unknown): string {
  const encoded = stringify(parsePaymentCompensationRefund(value));
  if (Buffer.byteLength(encoded, "utf8") > 65536) return invalid();
  return encoded;
}

export function decodePaymentCompensationRefund(value: unknown): PaymentRefundCompositionReceipt {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 65536) return invalid();
  try {
    const raw: unknown = JSON.parse(value);
    const composition = exactPaymentObject(raw, ["fact", "event"]);
    // Revive only the fact amount; Event payload money remains a decimal string.
    const fact = composition.fact as Record<string, unknown>;
    const amount = fact.amount as Record<string, unknown>;
    if (typeof amount.amountMinor !== "string" || !/^[1-9][0-9]{0,18}$/u.test(amount.amountMinor))
      return invalid();
    const event = composition.event as Record<string, unknown>;
    if (event.aggregateVersion !== "1") return invalid();
    return parsePaymentCompensationRefund({
      fact: { ...fact, amount: { ...amount, amountMinor: BigInt(amount.amountMinor) } },
      event: { ...event, aggregateVersion: 1n },
    });
  } catch {
    return invalid();
  }
}
