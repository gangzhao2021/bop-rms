import type { InventoryItemAggregate } from "./inventory-item.js";
import type { StorageLocation } from "./stock-place.js";

/**
 * WP-2423 / DEC-INV-DIRECT-RECEIPT: a Store direct receipt (no purchase order). One submission is an
 * immutable fact; only accepted quantities enter stock, rejected and damaged quantities are kept
 * with a reason. Unit cost is CAD cents per base unit.
 */
export const storeReceiptDiscrepancyReasons = [
  "DAMAGED_IN_TRANSIT",
  "WRONG_ITEM",
  "EXPIRED",
  "SHORT_DATED",
  "QUALITY",
  "TEMPERATURE",
  "OVER_DELIVERED",
  "OTHER",
] as const;
export type StoreReceiptDiscrepancyReason = (typeof storeReceiptDiscrepancyReasons)[number];
export const storeReceiptVoidReasons = [
  "ENTERED_IN_ERROR",
  "DUPLICATE_ENTRY",
  "RETURNED_TO_SUPPLIER",
] as const;
export interface StoreReceiptLine {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotCode: string | null;
  readonly expiryDate: string | null;
  readonly acceptedQuantity: string;
  readonly rejectedQuantity: string;
  readonly damagedQuantity: string;
  readonly discrepancyReason: StoreReceiptDiscrepancyReason | null;
  readonly unitCostMinor: number;
  /** Optional delivery temperature in degrees Celsius, one decimal. */
  readonly temperatureCelsius: string | null;
}
export interface StoreReceipt {
  readonly schemaVersion: 1;
  readonly receiptReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly supplierName: string;
  readonly supplierDocument: string | null;
  readonly currencyCode: "CAD";
  readonly lines: readonly StoreReceiptLine[];
  readonly receivedBy: string;
  readonly receivedAt: string;
}
export class StoreReceiptError extends Error {
  constructor(
    readonly code:
      | "STORE_RECEIPT_INVALID"
      | "STORE_RECEIPT_LINE_INVALID"
      | "STORE_RECEIPT_NOT_FOUND"
      | "STORE_RECEIPT_ALREADY_VOIDED"
      | "STORE_RECEIPT_STOCK_USED"
      | "STORE_RECEIPT_IDEMPOTENCY_CONFLICT",
    readonly lineReference: string | null = null,
  ) {
    super(code);
    this.name = "StoreReceiptError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const decimal = /^(?:0|[1-9]\d{0,11})(?:\.(\d{1,6}))?$/u;
const lotPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
const temperature = /^-?(?:[0-9]|[1-5][0-9]|60)(?:\.\d)?$/u;
const zero = (value: string) => /^0(?:\.0+)?$/u.test(value);
const invalid = (line: string | null = null): never => {
  throw new StoreReceiptError(
    line === null ? "STORE_RECEIPT_INVALID" : "STORE_RECEIPT_LINE_INVALID",
    line,
  );
};
function validDate(value: string): boolean {
  const parsed = new Date(value + "T00:00:00.000Z");
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
const text = (value: unknown, maximum: number) =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length >= 1 &&
  value.length <= maximum &&
  !/\p{Cc}/u.test(value)
    ? value
    : invalid();

export function parseStoreReceiptLines(value: unknown): readonly StoreReceiptLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) return invalid();
  const seen = new Set<string>(),
    identities = new Set<string>();
  return Object.freeze(
    value.map((raw: unknown) => {
      const r = raw as Record<string, unknown> | null;
      const reference =
        typeof r?.lineReference === "string" && uuid.test(r.lineReference) ? r.lineReference : null;
      if (
        r === null ||
        typeof r !== "object" ||
        reference === null ||
        seen.has(reference) ||
        Object.keys(r).sort().join(",") !==
          "acceptedQuantity,damagedQuantity,discrepancyReason,expiryDate,itemReference,lineReference,locationReference,lotCode,rejectedQuantity,temperatureCelsius,unitCostMinor"
      )
        return invalid(reference);
      seen.add(reference);
      const quantities = [r.acceptedQuantity, r.rejectedQuantity, r.damagedQuantity];
      if (
        typeof r.itemReference !== "string" ||
        !uuid.test(r.itemReference) ||
        typeof r.locationReference !== "string" ||
        !uuid.test(r.locationReference) ||
        quantities.some((q) => typeof q !== "string" || !decimal.test(q)) ||
        quantities.every((q) => zero(q as string)) ||
        (!zero(r.rejectedQuantity as string) || !zero(r.damagedQuantity as string)) !==
          (r.discrepancyReason !== null) ||
        (r.discrepancyReason !== null &&
          !storeReceiptDiscrepancyReasons.includes(
            r.discrepancyReason as StoreReceiptDiscrepancyReason,
          )) ||
        (r.lotCode !== null && (typeof r.lotCode !== "string" || !lotPattern.test(r.lotCode))) ||
        (r.expiryDate !== null && (typeof r.expiryDate !== "string" || !validDate(r.expiryDate))) ||
        (r.expiryDate !== null && r.lotCode === null) ||
        !Number.isSafeInteger(r.unitCostMinor) ||
        (r.unitCostMinor as number) < 0 ||
        (r.unitCostMinor as number) > 100_000_000 ||
        (r.temperatureCelsius !== null &&
          (typeof r.temperatureCelsius !== "string" || !temperature.test(r.temperatureCelsius)))
      )
        return invalid(reference);
      const identity = `${r.itemReference}|${r.locationReference}|${r.lotCode ?? ""}`;
      if (identities.has(identity)) return invalid(reference);
      identities.add(identity);
      return Object.freeze({
        lineReference: reference,
        itemReference: r.itemReference,
        locationReference: r.locationReference,
        lotCode: r.lotCode as string | null,
        expiryDate: r.expiryDate as string | null,
        acceptedQuantity: r.acceptedQuantity as string,
        rejectedQuantity: r.rejectedQuantity as string,
        damagedQuantity: r.damagedQuantity as string,
        discrepancyReason: r.discrepancyReason as StoreReceiptDiscrepancyReason | null,
        unitCostMinor: r.unitCostMinor as number,
        temperatureCelsius: r.temperatureCelsius as string | null,
      });
    }),
  );
}

export function createStoreReceipt(input: {
  readonly receiptReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly supplierName: unknown;
  readonly supplierDocument: unknown;
  readonly lines: readonly StoreReceiptLine[];
  readonly receivedBy: string;
  readonly receivedAt: string;
}): StoreReceipt {
  if (!uuid.test(input.receiptReference)) return invalid();
  return Object.freeze({
    schemaVersion: 1,
    receiptReference: input.receiptReference,
    tenantReference: input.tenantReference,
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    supplierName: text(input.supplierName, 120),
    supplierDocument: input.supplierDocument === null ? null : text(input.supplierDocument, 64),
    currencyCode: "CAD",
    lines: input.lines,
    receivedBy: input.receivedBy,
    receivedAt: input.receivedAt,
  });
}

/** Catalog rules: Active stock-tracked items, quantities within ledger precision, lots per tracking. */
export function validateStoreReceiptLines(
  lines: readonly StoreReceiptLine[],
  items: ReadonlyMap<string, InventoryItemAggregate>,
  locations: ReadonlyMap<string, StorageLocation>,
): void {
  for (const line of lines) {
    const item = items.get(line.itemReference),
      location = locations.get(line.locationReference);
    const precision = item?.baseUnit.ledgerPrecision ?? 0;
    const tooFine = [line.acceptedQuantity, line.rejectedQuantity, line.damagedQuantity].some(
      (q) => (decimal.exec(q)?.[1] ?? "").length > precision,
    );
    if (
      !item ||
      item.lifecycle !== "Active" ||
      !item.trackingPolicy.stockTrackingEnabled ||
      tooFine ||
      !location ||
      location.lifecycle !== "Active"
    )
      invalid(line.lineReference);
    const mode = item?.trackingPolicy.lotTrackingMode;
    const stocked = !zero(line.acceptedQuantity);
    if (
      (mode === "NoLot" && (line.lotCode !== null || line.expiryDate !== null)) ||
      (stocked && mode === "LotRequired" && line.lotCode === null) ||
      (stocked &&
        mode === "LotExpiryRequired" &&
        (line.lotCode === null || line.expiryDate === null))
    )
      invalid(line.lineReference);
  }
}
