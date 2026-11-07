import {
  parsePaymentCompensationActionReceipt,
  PaymentCompensationError,
  type PaymentCompensationActionReceipt,
} from "./paid-without-fulfillable-order.js";

const fail = (): never => {
  throw new PaymentCompensationError("PAYMENT_COMPENSATION_INPUT_INVALID");
};
export function encodePaymentCompensationAction(value: unknown): string {
  const parsed = parsePaymentCompensationActionReceipt(value);
  if (parsed.amount.amountMinor > 9223372036854775807n) return fail();
  const result = JSON.stringify(parsed, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  if (result.length > 65536) return fail();
  return result;
}
export function decodePaymentCompensationAction(value: unknown): PaymentCompensationActionReceipt {
  if (typeof value !== "string" || value.length > 65536) return fail();
  try {
    const raw: unknown = JSON.parse(value, (key, item: unknown) => {
      if (key !== "amountMinor") return item;
      if (typeof item !== "string" || !/^[1-9][0-9]{0,18}$/u.test(item)) return fail();
      const amount = BigInt(item);
      return amount <= 9223372036854775807n ? amount : fail();
    });
    return parsePaymentCompensationActionReceipt(raw);
  } catch {
    return fail();
  }
}
