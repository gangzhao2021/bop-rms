import {
  DigitalReceiptError,
  parseDigitalReceiptRecord,
  type DigitalReceiptRecord,
} from "./digital-receipt.js";

const maximumLength = 1024 * 1024;

function invalid(): never {
  throw new DigitalReceiptError("DIGITAL_RECEIPT_INPUT_INVALID");
}

/** Lossless persisted representation. This boundary supplies no issuance authority. */
export function encodeDigitalReceiptRecord(value: unknown): string {
  const record = parseDigitalReceiptRecord(value);
  const encoded = JSON.stringify(record, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  if (encoded.length > maximumLength) return invalid();
  return encoded;
}

export function decodeDigitalReceiptRecord(value: unknown): DigitalReceiptRecord {
  if (typeof value !== "string" || value.length > maximumLength) return invalid();
  try {
    const decoded: unknown = JSON.parse(value, (key, item: unknown) => {
      if (key !== "amountMinor") return item;
      if (
        typeof item !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/u.test(item) ||
        BigInt(item) > 9223372036854775807n
      )
        return invalid();
      return BigInt(item);
    });
    return parseDigitalReceiptRecord(decoded);
  } catch {
    return invalid();
  }
}
