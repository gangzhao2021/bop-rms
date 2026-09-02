export type DeliveryTrackingErrorCode =
  "InvalidReference" | "PermissionDenied" | "NotFound" | "FeatureDisabled" | "Unavailable";
export class DeliveryTrackingError extends Error {
  constructor(readonly code: DeliveryTrackingErrorCode) {
    super("Delivery tracking unavailable");
    this.name = "DeliveryTrackingError";
  }
}
export interface CustomerDeliveryTrackingView {
  readonly projectionName: "customer_delivery_tracking_v1";
  readonly projectionVersion: 1;
  readonly screenId: "CUST-DELIVERY-STATUS";
  readonly publicOrderReference: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly status:
    | "Planning"
    | "CourierAssigned"
    | "PreparingPickup"
    | "OnTheWay"
    | "Delivered"
    | "AttentionNeeded"
    | "Cancelled";
  readonly eta: { readonly earliestUtc: string; readonly latestUtc: string } | null;
  readonly handoffSummary:
    "NotStarted" | "StorePreparing" | "WithCourier" | "Complete" | "Exception";
  readonly proofSummary: "NotAvailable" | "Reviewing" | "Confirmed";
  readonly supportPath: string;
  readonly instructionUpdateAllowed: boolean;
  readonly instructionCutoffUtc: string | null;
}
export interface CustomerDeliveryTrackingClient {
  load(orderReference: string): Promise<unknown>;
}
const fail = (): never => {
    throw new DeliveryTrackingError("Unavailable");
  },
  reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
};
const ref = (value: unknown) =>
    typeof value === "string" && reference.test(value) ? value : fail(),
  instant = (value: unknown) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
      ? value
      : fail(),
  safePath = (value: unknown) =>
    typeof value === "string" && /^\/support(?:\?[A-Za-z0-9_=&-]{1,120})?$/u.test(value)
      ? value
      : fail();
export function parseCustomerDeliveryTracking(value: unknown): CustomerDeliveryTrackingView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "publicOrderReference",
    "asOfUtc",
    "freshness",
    "partial",
    "status",
    "eta",
    "handoffSummary",
    "proofSummary",
    "supportPath",
    "instructionUpdateAllowed",
    "instructionCutoffUtc",
  ]);
  if (
    raw.projectionName !== "customer_delivery_tracking_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "CUST-DELIVERY-STATUS" ||
    !["Current", "Stale", "Rebuilding"].includes(raw.freshness as string) ||
    typeof raw.partial !== "boolean" ||
    ![
      "Planning",
      "CourierAssigned",
      "PreparingPickup",
      "OnTheWay",
      "Delivered",
      "AttentionNeeded",
      "Cancelled",
    ].includes(raw.status as string) ||
    !["NotStarted", "StorePreparing", "WithCourier", "Complete", "Exception"].includes(
      raw.handoffSummary as string,
    ) ||
    !["NotAvailable", "Reviewing", "Confirmed"].includes(raw.proofSummary as string) ||
    typeof raw.instructionUpdateAllowed !== "boolean"
  )
    fail();
  let eta: CustomerDeliveryTrackingView["eta"] = null;
  if (raw.eta !== null) {
    const parsed = object(raw.eta, ["earliestUtc", "latestUtc"]),
      earliestUtc = instant(parsed.earliestUtc),
      latestUtc = instant(parsed.latestUtc);
    if (earliestUtc >= latestUtc) fail();
    eta = Object.freeze({ earliestUtc, latestUtc });
  }
  return Object.freeze({
    projectionName: "customer_delivery_tracking_v1",
    projectionVersion: 1,
    screenId: "CUST-DELIVERY-STATUS",
    publicOrderReference: ref(raw.publicOrderReference),
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as CustomerDeliveryTrackingView["freshness"],
    partial: raw.partial as boolean,
    status: raw.status as CustomerDeliveryTrackingView["status"],
    eta,
    handoffSummary: raw.handoffSummary as CustomerDeliveryTrackingView["handoffSummary"],
    proofSummary: raw.proofSummary as CustomerDeliveryTrackingView["proofSummary"],
    supportPath: safePath(raw.supportPath),
    instructionUpdateAllowed: raw.instructionUpdateAllowed as boolean,
    instructionCutoffUtc:
      raw.instructionCutoffUtc === null ? null : instant(raw.instructionCutoffUtc),
  });
}
export const unavailableCustomerDeliveryTrackingClient: CustomerDeliveryTrackingClient =
  Object.freeze({
    async load() {
      throw new DeliveryTrackingError("FeatureDisabled");
    },
  });
