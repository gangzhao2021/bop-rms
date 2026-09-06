import {
  copyQuoteSnapshotValue,
  parsePriceQuoteSnapshot,
  PriceQuoteSnapshotError,
} from "../domain/price-quote-snapshot.js";
import type { PriceQuoteSnapshot } from "../domain/price-quote.js";

export type QuoteSnapshotJson =
  | null
  | boolean
  | number
  | string
  | readonly QuoteSnapshotJson[]
  | { readonly [key: string]: QuoteSnapshotJson };
export interface StoredPriceQuoteSnapshotV1 {
  readonly version: 1;
  readonly snapshot: QuoteSnapshotJson;
}
function encode(value: unknown): QuoteSnapshotJson {
  if (typeof value === "bigint") return value.toString();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Array.isArray(value)) return Object.freeze(value.map(encode));
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, encode(entry)]),
    ),
  );
}
export function encodePriceQuoteSnapshot(value: PriceQuoteSnapshot): StoredPriceQuoteSnapshotV1 {
  return Object.freeze({ version: 1, snapshot: encode(parsePriceQuoteSnapshot(value)) });
}
function decode(value: unknown, field = ""): unknown {
  if (field === "amountMinor") {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(value))
      throw new PriceQuoteSnapshotError();
    return BigInt(value);
  }
  if (typeof value === "bigint") throw new PriceQuoteSnapshotError();
  if (Array.isArray(value)) return value.map((entry) => decode(entry));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decode(entry, key)]),
    );
  return value;
}
export function decodePriceQuoteSnapshot(value: unknown): PriceQuoteSnapshot {
  try {
    const envelope = copyQuoteSnapshotValue(value) as Record<string, unknown>;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      Object.keys(envelope).length !== 2 ||
      envelope.version !== 1 ||
      !Object.hasOwn(envelope, "snapshot")
    )
      throw new PriceQuoteSnapshotError();
    return parsePriceQuoteSnapshot(decode(envelope.snapshot));
  } catch {
    throw new PriceQuoteSnapshotError();
  }
}
