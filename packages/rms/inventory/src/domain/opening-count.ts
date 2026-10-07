import type { InventoryItemAggregate } from "./inventory-item.js";
import type { StorageLocation } from "./stock-place.js";

/**
 * WP-2423 / DEC-INV-OPENING: the Store's audited stock initialization. Counted quantities are entered
 * per Inventory Item, Storage Location and (when the item tracks lots) printed lot code and expiry.
 * Draft -> Submitted -> Posted, Submitted -> Draft (reopen), Draft|Submitted -> Cancelled. Posting
 * writes each line as the account's first ledger movement; quantities are never edited afterwards.
 */
export type OpeningCountLifecycle = "Draft" | "Submitted" | "Posted" | "Cancelled";
export interface OpeningCountLine {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly locationReference: string;
  readonly lotCode: string | null;
  readonly expiryDate: string | null;
  /** Decimal string in the item's base unit, at most the item's ledger precision. */
  readonly quantity: string;
  /** Optional unit cost in CAD minor units (cents) per base unit, for opening valuation. */
  readonly unitCostMinor: number | null;
}
export interface OpeningCount {
  readonly schemaVersion: 1;
  readonly countReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly lifecycle: OpeningCountLifecycle;
  readonly version: number;
  readonly lines: readonly OpeningCountLine[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly submittedBy: string | null;
  readonly postedBy: string | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}
export class OpeningCountError extends Error {
  constructor(
    readonly code:
      | "OPENING_COUNT_INVALID"
      | "OPENING_COUNT_LINE_INVALID"
      | "OPENING_COUNT_CONFLICT"
      | "OPENING_COUNT_NOT_FOUND"
      | "OPENING_COUNT_ALREADY_POSTED"
      | "OPENING_COUNT_STOCK_EXISTS"
      | "OPENING_COUNT_IDEMPOTENCY_CONFLICT",
    readonly lineReference: string | null = null,
  ) {
    super(code);
    this.name = "OpeningCountError";
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const decimal = /^(?:0|[1-9]\d{0,11})(?:\.(\d{1,6}))?$/u;
const lotPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const invalid = (line: string | null = null): never => {
  throw new OpeningCountError(
    line === null ? "OPENING_COUNT_INVALID" : "OPENING_COUNT_LINE_INVALID",
    line,
  );
};
function validDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(value + "T00:00:00.000Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Shape-level parsing of the lines a counter enters; reference rules come with the catalog. */
export function parseOpeningCountLines(value: unknown): readonly OpeningCountLine[] {
  if (!Array.isArray(value) || value.length > 5000) return invalid();
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
        Object.keys(r).sort().join(",") !==
          "expiryDate,itemReference,lineReference,locationReference,lotCode,quantity,unitCostMinor" ||
        seen.has(reference)
      )
        return invalid(reference);
      seen.add(reference);
      if (
        typeof r.itemReference !== "string" ||
        !uuid.test(r.itemReference) ||
        typeof r.locationReference !== "string" ||
        !uuid.test(r.locationReference) ||
        typeof r.quantity !== "string" ||
        !decimal.test(r.quantity) ||
        /^0(?:\.0+)?$/u.test(r.quantity) ||
        (r.lotCode !== null && (typeof r.lotCode !== "string" || !lotPattern.test(r.lotCode))) ||
        (r.expiryDate !== null && (typeof r.expiryDate !== "string" || !validDate(r.expiryDate))) ||
        (r.expiryDate !== null && r.lotCode === null) ||
        (r.unitCostMinor !== null &&
          (!Number.isSafeInteger(r.unitCostMinor) ||
            (r.unitCostMinor as number) < 0 ||
            (r.unitCostMinor as number) > 100_000_000))
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
        quantity: r.quantity,
        unitCostMinor: r.unitCostMinor as number | null,
      });
    }),
  );
}

/**
 * Line rules against the current catalog: the item is Active and stock-tracked, the quantity fits
 * its ledger precision, lots and expiry follow its tracking mode, and the location is Active.
 */
export function validateOpeningCountLines(
  lines: readonly OpeningCountLine[],
  items: ReadonlyMap<string, InventoryItemAggregate>,
  locations: ReadonlyMap<string, StorageLocation>,
): void {
  for (const line of lines) {
    const item = items.get(line.itemReference),
      location = locations.get(line.locationReference);
    const fraction = decimal.exec(line.quantity)?.[1] ?? "";
    if (
      !item ||
      item.lifecycle !== "Active" ||
      !item.trackingPolicy.stockTrackingEnabled ||
      fraction.length > item.baseUnit.ledgerPrecision ||
      !location ||
      location.lifecycle !== "Active"
    )
      invalid(line.lineReference);
    const mode = item?.trackingPolicy.lotTrackingMode;
    if (
      (mode === "NoLot" && (line.lotCode !== null || line.expiryDate !== null)) ||
      (mode === "LotRequired" && line.lotCode === null) ||
      (mode === "LotExpiryRequired" && (line.lotCode === null || line.expiryDate === null))
    )
      invalid(line.lineReference);
  }
}

export type OpeningCountChange =
  | { readonly action: "Create"; readonly countReference: string }
  | {
      readonly action: "SaveLines";
      readonly expectedVersion: number;
      readonly lines: readonly OpeningCountLine[];
    }
  | { readonly action: "Submit" | "Reopen" | "Cancel" | "Post"; readonly expectedVersion: number };

/** Pure candidate transition; persistence fences versions, the one posting per Store and the ledger. */
export function applyOpeningCountChange(
  current: OpeningCount | null,
  change: OpeningCountChange,
  context: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly occurredAt: string;
  },
): OpeningCount {
  if (change.action === "Create") {
    if (current !== null || !uuid.test(change.countReference)) return invalid();
    return Object.freeze({
      schemaVersion: 1,
      countReference: change.countReference,
      tenantReference: context.tenantReference,
      brandReference: context.brandReference,
      storeReference: context.storeReference,
      lifecycle: "Draft",
      version: 1,
      lines: Object.freeze([]),
      createdBy: context.actorReference,
      createdAt: context.occurredAt,
      submittedBy: null,
      postedBy: null,
      updatedBy: context.actorReference,
      updatedAt: context.occurredAt,
    });
  }
  if (current === null) throw new OpeningCountError("OPENING_COUNT_NOT_FOUND");
  if (current.version !== change.expectedVersion)
    throw new OpeningCountError("OPENING_COUNT_CONFLICT");
  const allowed: Record<
    Exclude<OpeningCountChange["action"], "Create">,
    readonly OpeningCountLifecycle[]
  > = {
    SaveLines: ["Draft"],
    Submit: ["Draft"],
    Reopen: ["Submitted"],
    Cancel: ["Draft", "Submitted"],
    Post: ["Submitted"],
  };
  if (!allowed[change.action].includes(current.lifecycle))
    throw new OpeningCountError(
      current.lifecycle === "Posted" ? "OPENING_COUNT_ALREADY_POSTED" : "OPENING_COUNT_CONFLICT",
    );
  if (change.action === "Submit" && current.lines.length === 0) return invalid();
  const base = {
    ...current,
    version: current.version + 1,
    updatedBy: context.actorReference,
    updatedAt: context.occurredAt,
  };
  switch (change.action) {
    case "SaveLines":
      return Object.freeze({ ...base, lines: change.lines });
    case "Submit":
      return Object.freeze({
        ...base,
        lifecycle: "Submitted",
        submittedBy: context.actorReference,
      });
    case "Reopen":
      return Object.freeze({ ...base, lifecycle: "Draft", submittedBy: null });
    case "Cancel":
      return Object.freeze({ ...base, lifecycle: "Cancelled" });
    case "Post":
      return Object.freeze({ ...base, lifecycle: "Posted", postedBy: context.actorReference });
  }
}
