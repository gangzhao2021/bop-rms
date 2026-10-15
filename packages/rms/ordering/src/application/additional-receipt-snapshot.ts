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
  // WP-2423 D5: a version issued before item prices were frozen compares without them; the new
  // version adds each item's pre-tax price but never changes an item fact the old one printed.
  const comparable = (line: (typeof current.lines)[number] | undefined, withSubtotal: boolean) => {
    if (line === undefined) return null;
    if (withSubtotal) return line;
    return Object.fromEntries(Object.entries(line).filter(([key]) => key !== "lineSubtotal"));
  };
  for (const line of old.lines)
    if (
      encode(comparable(lines.get(line.lineReference), line.lineSubtotal !== undefined)) !==
      encode(line)
    )
      return fail();
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
