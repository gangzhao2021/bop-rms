export type OrderAmendmentClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class OrderAmendmentClientError extends Error {
  constructor(readonly code: OrderAmendmentClientErrorCode) {
    super("Order Amendment view is unavailable");
    this.name = "OrderAmendmentClientError";
  }
}
export interface OrderAmendmentView {
  readonly screenId: "OPS-ORDER-AMEND";
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly expectedOrderVersion: number;
  readonly asOfUtc: string;
  readonly reasonOptions: readonly string[];
  readonly eligibleItems: readonly {
    readonly orderItemReference: string;
    readonly label: string;
    readonly quantity: number;
    readonly configurationSummary: string;
  }[];
  readonly currencyCode: string;
  readonly originalTotalMinor: string;
  readonly revisedTotalMinor: string;
  readonly taxDeltaMinor: string;
  readonly kitchenImpact: string;
  readonly fulfillmentImpact: string;
  readonly paymentRefundConsequence: string;
  readonly customerNotice: string;
  readonly approvalStatus: "NotRequired" | "Required" | "Pending" | "Approved";
}
export interface OrderAmendmentClient {
  load(orderReference: string): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const money = /^-?(?:0|[1-9][0-9]{0,29})$/u;
function object(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new OrderAmendmentClientError("Unavailable");
  return value as Record<string, unknown>;
}
function reference(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value))
    throw new OrderAmendmentClientError("Unavailable");
  return value;
}
export const parseOrderAmendmentRouteReference = reference;
function text(value: unknown, max = 180) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[<>{}]|https?:\/\//iu.test(value)
  )
    throw new OrderAmendmentClientError("Unavailable");
  return value.trim();
}
function positive(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new OrderAmendmentClientError("Unavailable");
  return value as number;
}
function minor(value: unknown) {
  if (typeof value !== "string" || !money.test(value))
    throw new OrderAmendmentClientError("Unavailable");
  return value;
}
export function parseOrderAmendmentView(value: unknown): OrderAmendmentView {
  const raw = object(value, [
    "screenId",
    "orderReference",
    "orderNumber",
    "expectedOrderVersion",
    "asOfUtc",
    "reasonOptions",
    "eligibleItems",
    "currencyCode",
    "originalTotalMinor",
    "revisedTotalMinor",
    "taxDeltaMinor",
    "kitchenImpact",
    "fulfillmentImpact",
    "paymentRefundConsequence",
    "customerNotice",
    "approvalStatus",
  ]);
  if (
    raw.screenId !== "OPS-ORDER-AMEND" ||
    typeof raw.asOfUtc !== "string" ||
    !instant.test(raw.asOfUtc) ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode) ||
    !Array.isArray(raw.reasonOptions) ||
    raw.reasonOptions.length === 0 ||
    !Array.isArray(raw.eligibleItems) ||
    !["NotRequired", "Required", "Pending", "Approved"].includes(raw.approvalStatus as string)
  )
    throw new OrderAmendmentClientError("Unavailable");
  const reasons = raw.reasonOptions.map((item) => text(item, 64));
  if (new Set(reasons).size !== reasons.length) throw new OrderAmendmentClientError("Unavailable");
  const items = raw.eligibleItems.map((value) => {
    const item = object(value, ["orderItemReference", "label", "quantity", "configurationSummary"]);
    return Object.freeze({
      orderItemReference: reference(item.orderItemReference),
      label: text(item.label),
      quantity: positive(item.quantity),
      configurationSummary: text(item.configurationSummary),
    });
  });
  if (new Set(items.map((item) => item.orderItemReference)).size !== items.length)
    throw new OrderAmendmentClientError("Unavailable");
  return Object.freeze({
    screenId: "OPS-ORDER-AMEND",
    orderReference: reference(raw.orderReference),
    orderNumber: text(raw.orderNumber, 40),
    expectedOrderVersion: positive(raw.expectedOrderVersion),
    asOfUtc: raw.asOfUtc,
    reasonOptions: Object.freeze(reasons),
    eligibleItems: Object.freeze(items),
    currencyCode: raw.currencyCode,
    originalTotalMinor: minor(raw.originalTotalMinor),
    revisedTotalMinor: minor(raw.revisedTotalMinor),
    taxDeltaMinor: minor(raw.taxDeltaMinor),
    kitchenImpact: text(raw.kitchenImpact),
    fulfillmentImpact: text(raw.fulfillmentImpact),
    paymentRefundConsequence: text(raw.paymentRefundConsequence),
    customerNotice: text(raw.customerNotice),
    approvalStatus: raw.approvalStatus as OrderAmendmentView["approvalStatus"],
  });
}
export const unavailableOrderAmendmentClient: OrderAmendmentClient = Object.freeze({
  async load() {
    throw new OrderAmendmentClientError(navigator.onLine ? "Unavailable" : "Offline");
  },
});
