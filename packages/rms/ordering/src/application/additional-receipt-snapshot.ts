import { canonicalizeRfc8785 } from "@bop/audit";
import {
  DigitalReceiptError,
  parseDigitalReceiptRecord,
  parseDigitalReceiptSnapshot,
} from "../domain/digital-receipt.js";
const encode = (value: unknown) =>
  canonicalizeRfc8785(
    JSON.parse(
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );
/** Current complete, paid Order facts may extend a receipt; never replace prior item facts. */
export function createAdditionalReceiptSnapshot(previousValue: unknown, currentValue: unknown) {
  const previous = parseDigitalReceiptRecord(previousValue),
    old = previous.snapshot;
  const current = parseDigitalReceiptSnapshot(currentValue);
  const fail = (): never => {
    throw new DigitalReceiptError("DIGITAL_RECEIPT_CHAIN_CONFLICT");
  };
  if (previous.kind === "Void") return fail();
  for (const field of [
    "receiptReference",
    "orderReference",
    "guestSessionReference",
    "operatingEntityReference",
    "brandReference",
    "storeReference",
    "orderNumber",
  ] as const)
    if (current[field] !== old[field]) return fail();
  if (
    current.issuedAt < previous.recordedAt ||
    current.total.currencyCode !== old.total.currencyCode ||
    current.refundedTotal.amountMinor < old.refundedTotal.amountMinor
  )
    return fail();
  const lines = new Map(current.lines.map((line) => [line.lineReference, line]));
  for (const line of old.lines)
    if (encode(lines.get(line.lineReference) ?? null) !== encode(line)) return fail();
  if (current.lines.length === old.lines.length) {
    for (const field of [
      "subtotal",
      "adjustments",
      "tax",
      "tip",
      "total",
      "paymentStatus",
      "refundedTotal",
    ] as const)
      if (encode(current[field] ?? null) !== encode(old[field] ?? null)) return fail();
    return null;
  }
  if (
    current.lines.length < old.lines.length ||
    current.total.amountMinor < old.total.amountMinor ||
    current.tip.amountMinor < old.tip.amountMinor
  )
    return fail();
  return current;
}
