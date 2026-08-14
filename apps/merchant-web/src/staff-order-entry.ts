export type StaffOrderEntryClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class StaffOrderEntryClientError extends Error {
  constructor(readonly code: StaffOrderEntryClientErrorCode) {
    super("Staff Order Entry is unavailable");
    this.name = "StaffOrderEntryClientError";
  }
}

interface MoneyView {
  readonly amountMinor: number;
  readonly currencyCode: "CAD";
}

export interface StaffOrderEntryMenuItem {
  readonly sellableReference: string;
  readonly code: string;
  readonly localizedName: string;
  readonly sectionCode: string;
  readonly availability: "AvailableNow" | "Unavailable";
  readonly configuredPrice: MoneyView;
  readonly allergenRequirement: "NoReviewRequired" | "ReviewRequired";
}

export interface StaffOrderEntryView {
  readonly screenId: "OPS-ORDER-ENTRY";
  readonly projectionVersion: "MERCHANT_STAFF_ORDER_ENTRY_V1";
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale";
  readonly partial: boolean;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly storeLabel: string;
  readonly serviceMode: "DineIn" | "Pickup";
  readonly actorReference: string;
  readonly actorLabel: string;
  readonly sourceChannel: "Pos";
  readonly menuSnapshotReference: string;
  readonly menuItems: readonly StaffOrderEntryMenuItem[];
  readonly cart: {
    readonly cartReference: string;
    readonly cartVersion: number;
    readonly lineCount: number;
    readonly quoteReference: string | null;
    readonly quoteStatus: "Missing" | "Current" | "Stale";
    readonly total: MoneyView | null;
  } | null;
  readonly diningSession: {
    readonly eligibility: "NotApplicable" | "Eligible" | "Ineligible";
    readonly sessionReference: string | null;
  };
  readonly customerReference: {
    readonly verified: boolean;
    readonly maskedReference: string | null;
  };
  readonly allergenReview: "NotRequired" | "Required" | "Current" | "Invalidated";
  readonly terminalStatus: "NotStarted" | "Pending" | "Unavailable";
}

export interface StaffOrderEntryProjectionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const code = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,100}$/u;

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new StaffOrderEntryClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new StaffOrderEntryClientError("Unavailable");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !safe.test(value) || value.trim() !== value)
    throw new StaffOrderEntryClientError("Unavailable");
  return value;
}

function controlled(value: unknown): string {
  if (typeof value !== "string" || !code.test(value))
    throw new StaffOrderEntryClientError("Unavailable");
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new StaffOrderEntryClientError("Unavailable");
  return value as number;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new StaffOrderEntryClientError("Unavailable");
  return value as T;
}

function money(value: unknown): MoneyView {
  const raw = object(value, ["amountMinor", "currencyCode"]);
  if (raw.currencyCode !== "CAD") throw new StaffOrderEntryClientError("Unavailable");
  return Object.freeze({ amountMinor: integer(raw.amountMinor), currencyCode: "CAD" });
}

function menuItem(value: unknown): StaffOrderEntryMenuItem {
  const raw = object(value, [
    "sellableReference",
    "code",
    "localizedName",
    "sectionCode",
    "availability",
    "configuredPrice",
    "allergenRequirement",
  ]);
  return Object.freeze({
    sellableReference: reference(raw.sellableReference),
    code: controlled(raw.code),
    localizedName: text(raw.localizedName),
    sectionCode: controlled(raw.sectionCode),
    availability: oneOf(raw.availability, ["AvailableNow", "Unavailable"]),
    configuredPrice: money(raw.configuredPrice),
    allergenRequirement: oneOf(raw.allergenRequirement, ["NoReviewRequired", "ReviewRequired"]),
  });
}

export function parseStaffOrderEntryView(value: unknown): StaffOrderEntryView {
  const raw = object(value, [
    "screenId",
    "projectionVersion",
    "asOfUtc",
    "freshness",
    "partial",
    "tenantReference",
    "brandReference",
    "storeReference",
    "storeLabel",
    "serviceMode",
    "actorReference",
    "actorLabel",
    "sourceChannel",
    "menuSnapshotReference",
    "menuItems",
    "cart",
    "diningSession",
    "customerReference",
    "allergenReview",
    "terminalStatus",
  ]);
  if (
    raw.screenId !== "OPS-ORDER-ENTRY" ||
    raw.projectionVersion !== "MERCHANT_STAFF_ORDER_ENTRY_V1" ||
    typeof raw.asOfUtc !== "string" ||
    !instant.test(raw.asOfUtc) ||
    new Date(Date.parse(raw.asOfUtc)).toISOString() !== raw.asOfUtc ||
    typeof raw.partial !== "boolean" ||
    raw.sourceChannel !== "Pos" ||
    !Array.isArray(raw.menuItems) ||
    raw.menuItems.length > 200
  )
    throw new StaffOrderEntryClientError("Unavailable");
  const items = Object.freeze(raw.menuItems.map(menuItem));
  if (new Set(items.map((item) => item.sellableReference)).size !== items.length)
    throw new StaffOrderEntryClientError("Unavailable");
  let cart: StaffOrderEntryView["cart"] = null;
  if (raw.cart !== null) {
    const value = object(raw.cart, [
      "cartReference",
      "cartVersion",
      "lineCount",
      "quoteReference",
      "quoteStatus",
      "total",
    ]);
    const quoteStatus = oneOf(value.quoteStatus, ["Missing", "Current", "Stale"]);
    if (
      (value.quoteReference === null) !== (quoteStatus === "Missing") ||
      (value.total === null) !== (quoteStatus === "Missing")
    )
      throw new StaffOrderEntryClientError("Unavailable");
    cart = Object.freeze({
      cartReference: reference(value.cartReference),
      cartVersion: integer(value.cartVersion, 1),
      lineCount: integer(value.lineCount),
      quoteReference: value.quoteReference === null ? null : reference(value.quoteReference),
      quoteStatus,
      total: value.total === null ? null : money(value.total),
    });
  }
  const dining = object(raw.diningSession, ["eligibility", "sessionReference"]);
  const eligibility = oneOf(dining.eligibility, ["NotApplicable", "Eligible", "Ineligible"]);
  if ((eligibility === "Eligible") !== (dining.sessionReference !== null))
    throw new StaffOrderEntryClientError("Unavailable");
  const customer = object(raw.customerReference, ["verified", "maskedReference"]);
  if (
    typeof customer.verified !== "boolean" ||
    customer.verified !== (customer.maskedReference !== null)
  )
    throw new StaffOrderEntryClientError("Unavailable");
  return Object.freeze({
    screenId: "OPS-ORDER-ENTRY",
    projectionVersion: "MERCHANT_STAFF_ORDER_ENTRY_V1",
    asOfUtc: raw.asOfUtc,
    freshness: oneOf(raw.freshness, ["Current", "Stale"]),
    partial: raw.partial,
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    storeLabel: text(raw.storeLabel),
    serviceMode: oneOf(raw.serviceMode, ["DineIn", "Pickup"]),
    actorReference: reference(raw.actorReference),
    actorLabel: text(raw.actorLabel),
    sourceChannel: "Pos",
    menuSnapshotReference: reference(raw.menuSnapshotReference),
    menuItems: items,
    cart,
    diningSession: Object.freeze({
      eligibility,
      sessionReference:
        dining.sessionReference === null ? null : reference(dining.sessionReference),
    }),
    customerReference: Object.freeze({
      verified: customer.verified,
      maskedReference: customer.maskedReference === null ? null : text(customer.maskedReference),
    }),
    allergenReview: oneOf(raw.allergenReview, [
      "NotRequired",
      "Required",
      "Current",
      "Invalidated",
    ]),
    terminalStatus: oneOf(raw.terminalStatus, ["NotStarted", "Pending", "Unavailable"]),
  });
}

export const unavailableStaffOrderEntryClient: StaffOrderEntryProjectionClient = Object.freeze({
  async load() {
    throw new StaffOrderEntryClientError("Unavailable");
  },
});
