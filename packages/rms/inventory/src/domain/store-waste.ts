/**
 * WP-2423 / DEC-INV-WASTE: Store waste records. What was thrown away leaves stock at once (a Waste
 * movement per line) so that stock never shows food that is gone. A record whose value reaches the
 * review threshold, or whose cost is unknown, needs an independent review: accepted, or voided with a
 * Correction movement that puts the quantity back (for entries made in error).
 */
export const storeWasteReasons = [
  "EXPIRED",
  "SPOILED",
  "DAMAGED",
  "DROPPED",
  "PREPARATION_ERROR",
  "QUALITY",
  "CUSTOMER_RETURN",
  "OTHER",
] as const;
export type StoreWasteReason = (typeof storeWasteReasons)[number];
export const storeWasteVoidReasons = [
  "ENTERED_IN_ERROR",
  "DUPLICATE_ENTRY",
  "NOT_ACTUALLY_WASTED",
] as const;
export const storeWasteAcceptReasons = ["REVIEWED_OK"] as const;
/** CAD 25.00: a record of this value or more is reviewed by someone other than its recorder. */
export const storeWasteReviewThresholdMinor = 2500;

export interface StoreWasteLine {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotReference: string | null;
  /** Base unit of the Item. */
  readonly quantity: string;
  readonly reasonCode: StoreWasteReason;
  /** Required for OTHER. */
  readonly note: string | null;
}
export interface PostedStoreWasteLine extends StoreWasteLine {
  readonly unitCode: string;
  /** Latest Store unit cost in CAD cents per base unit; null when the Store has none yet. */
  readonly unitCostMinor: number | null;
  readonly valueMinor: number;
  readonly movementReference: string;
}
export interface StoreWasteRecord {
  readonly schemaVersion: 1;
  readonly wasteReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly lines: readonly PostedStoreWasteLine[];
  readonly valueMinor: number;
  readonly costUnknown: boolean;
  readonly needsReview: boolean;
  readonly recordedBy: string;
  readonly recordedAt: string;
}
export class StoreWasteError extends Error {
  constructor(
    readonly code:
      | "STORE_WASTE_INVALID"
      | "STORE_WASTE_LINE_INVALID"
      | "STORE_WASTE_NOT_ENOUGH_STOCK"
      | "STORE_WASTE_NOT_FOUND"
      | "STORE_WASTE_ALREADY_REVIEWED"
      | "STORE_WASTE_REVIEWER_NOT_INDEPENDENT"
      | "STORE_WASTE_IDEMPOTENCY_CONFLICT",
    readonly lineReference: string | null = null,
  ) {
    super(code);
    this.name = "StoreWasteError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const decimal = /^(?:0|[1-9]\d{0,11})(?:\.(\d{1,6}))?$/u;
const line = (reference: string | null): never => {
  throw new StoreWasteError(
    reference === null ? "STORE_WASTE_INVALID" : "STORE_WASTE_LINE_INVALID",
    reference,
  );
};

export function parseStoreWasteLines(value: unknown): readonly StoreWasteLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return line(null);
  const seen = new Set<string>(),
    coordinates = new Set<string>();
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
          "itemReference,lineReference,locationReference,lotReference,note,quantity,reasonCode"
      )
        return line(reference);
      seen.add(reference);
      const note =
        r.note === null
          ? null
          : typeof r.note === "string" &&
              r.note === r.note.trim() &&
              r.note.length >= 1 &&
              r.note.length <= 200 &&
              !/[\p{Cc}\p{Cf}]/u.test(r.note)
            ? r.note
            : line(reference);
      if (
        typeof r.itemReference !== "string" ||
        !uuid.test(r.itemReference) ||
        typeof r.locationReference !== "string" ||
        !uuid.test(r.locationReference) ||
        (r.lotReference !== null &&
          (typeof r.lotReference !== "string" || !uuid.test(r.lotReference))) ||
        typeof r.quantity !== "string" ||
        !decimal.test(r.quantity) ||
        /^0(?:\.0+)?$/u.test(r.quantity) ||
        !storeWasteReasons.includes(r.reasonCode as StoreWasteReason) ||
        (r.reasonCode === "OTHER" && note === null)
      )
        return line(reference);
      const coordinate = `${r.itemReference}|${r.locationReference}|${r.lotReference ?? ""}`;
      if (coordinates.has(coordinate)) return line(reference);
      coordinates.add(coordinate);
      return Object.freeze({
        lineReference: reference,
        itemReference: r.itemReference,
        locationReference: r.locationReference,
        lotReference: r.lotReference as string | null,
        quantity: r.quantity,
        reasonCode: r.reasonCode as StoreWasteReason,
        note,
      });
    }),
  );
}
/** Value in cents of a quantity at a unit cost, rounding half to even on the exact product. */
export function storeWasteValueMinor(quantity: string, unitCostMinor: number): number {
  const [whole = "0", fraction = ""] = quantity.split(".");
  const scaled = BigInt(whole + fraction) * BigInt(unitCostMinor);
  const divisor = 10n ** BigInt(fraction.length);
  const quotient = scaled / divisor,
    twice = (scaled % divisor) * 2n;
  return Number(
    twice > divisor || (twice === divisor && quotient % 2n === 1n) ? quotient + 1n : quotient,
  );
}
