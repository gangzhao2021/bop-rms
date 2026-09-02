export type AmendmentReference = string & { readonly __amendmentReference: unique symbol };
export type AmendmentDigest = string & { readonly __amendmentDigest: unique symbol };
export type AmendmentCode = string & { readonly __amendmentCode: unique symbol };
export type AmendmentKind =
  "AddItem" | "ReduceItem" | "VoidItem" | "ReplaceItemConfiguration" | "UpdateNote";
export type AmendmentStatus =
  "PendingKitchen" | "PendingApproval" | "Applied" | "Rejected" | "Aborted";

export interface AmendmentChange {
  readonly kind: AmendmentKind;
  readonly targetOrderItemReference: AmendmentReference | null;
  readonly replacementSnapshotDigest: AmendmentDigest | null;
  readonly quantityDelta: number;
  readonly noteCode: AmendmentCode | null;
}
export interface OrderAmendment {
  readonly amendmentReference: AmendmentReference;
  readonly orderReference: AmendmentReference;
  readonly tenantReference: AmendmentReference;
  readonly brandReference: AmendmentReference;
  readonly storeReference: AmendmentReference;
  readonly requestedByActorReference: AmendmentReference;
  readonly reasonCode: AmendmentCode;
  readonly change: AmendmentChange;
  readonly expectedOrderVersion: number;
  readonly quoteReference: AmendmentReference;
  readonly quoteVersion: number;
  readonly quoteInputDigest: AmendmentDigest;
  readonly currencyCode: string;
  readonly originalTotalMinor: string;
  readonly revisedTotalMinor: string;
  readonly deltaMinor: string;
  readonly kitchenStatus: "NotStarted" | "InProgress" | "Completed";
  readonly fulfillmentStatus: "NotStarted" | "InProgress" | "Fulfilled";
  readonly approvalRequired: boolean;
  readonly customerNoticeCode: AmendmentCode;
  readonly status: AmendmentStatus;
  readonly aggregateVersion: number;
  readonly decidedByActorReference: AmendmentReference | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

export type OrderAmendmentErrorCode =
  | "ORDER_AMENDMENT_INPUT_INVALID"
  | "ORDER_AMENDMENT_ORDER_INELIGIBLE"
  | "ORDER_AMENDMENT_KITCHEN_REJECTED"
  | "ORDER_AMENDMENT_TRANSITION_INVALID"
  | "ORDER_AMENDMENT_SEPARATION_REQUIRED";
export class OrderAmendmentError extends Error {
  constructor(readonly code: OrderAmendmentErrorCode) {
    super("Order Amendment is unavailable");
    this.name = "OrderAmendmentError";
  }
}
const fail = (code: OrderAmendmentErrorCode): never => {
  throw new OrderAmendmentError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export function parseAmendmentReference(value: unknown): AmendmentReference {
  if (typeof value !== "string" || !uuid.test(value)) return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return value as AmendmentReference;
}
export function parseAmendmentDigest(value: unknown): AmendmentDigest {
  if (typeof value !== "string" || !digest.test(value))
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return value as AmendmentDigest;
}
export function parseAmendmentCode(value: unknown): AmendmentCode {
  if (typeof value !== "string" || !code.test(value)) return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return value as AmendmentCode;
}
function at(value: unknown) {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return value;
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return value as number;
}
function money(value: unknown) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]{0,29})$/u.test(value))
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return BigInt(value);
}
function plain(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return value as Record<string, unknown>;
}
export function createAmendmentChange(value: unknown): AmendmentChange {
  const raw = plain(value, [
    "kind",
    "targetOrderItemReference",
    "replacementSnapshotDigest",
    "quantityDelta",
    "noteCode",
  ]);
  const kinds: AmendmentKind[] = [
    "AddItem",
    "ReduceItem",
    "VoidItem",
    "ReplaceItemConfiguration",
    "UpdateNote",
  ];
  if (!kinds.includes(raw.kind as AmendmentKind) || !Number.isSafeInteger(raw.quantityDelta))
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  const kind = raw.kind as AmendmentKind;
  const target =
    raw.targetOrderItemReference === null
      ? null
      : parseAmendmentReference(raw.targetOrderItemReference);
  const replacement =
    raw.replacementSnapshotDigest === null
      ? null
      : parseAmendmentDigest(raw.replacementSnapshotDigest);
  const note = raw.noteCode === null ? null : parseAmendmentCode(raw.noteCode);
  const quantity = raw.quantityDelta as number;
  const valid =
    (kind === "AddItem" &&
      target === null &&
      replacement !== null &&
      quantity > 0 &&
      note === null) ||
    (kind === "ReduceItem" &&
      target !== null &&
      replacement === null &&
      quantity < 0 &&
      note === null) ||
    (kind === "VoidItem" &&
      target !== null &&
      replacement === null &&
      quantity < 0 &&
      note === null) ||
    (kind === "ReplaceItemConfiguration" &&
      target !== null &&
      replacement !== null &&
      quantity === 0 &&
      note === null) ||
    (kind === "UpdateNote" &&
      target !== null &&
      replacement === null &&
      quantity === 0 &&
      note !== null);
  if (!valid || Math.abs(quantity) > 999) return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return Object.freeze({
    kind,
    targetOrderItemReference: target,
    replacementSnapshotDigest: replacement,
    quantityDelta: quantity,
    noteCode: note,
  });
}
const destructive = (kind: AmendmentKind) =>
  kind === "ReduceItem" || kind === "VoidItem" || kind === "ReplaceItemConfiguration";

export function createOrderAmendment(value: unknown): OrderAmendment {
  const keys = [
    "amendmentReference",
    "orderReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "requestedByActorReference",
    "reasonCode",
    "change",
    "expectedOrderVersion",
    "quoteReference",
    "quoteVersion",
    "quoteInputDigest",
    "currencyCode",
    "originalTotalMinor",
    "revisedTotalMinor",
    "deltaMinor",
    "kitchenStatus",
    "fulfillmentStatus",
    "approvalRequired",
    "customerNoticeCode",
    "status",
    "aggregateVersion",
    "decidedByActorReference",
    "requestedAt",
    "decidedAt",
  ] as const;
  const raw = plain(value, keys);
  const change = createAmendmentChange(raw.change);
  if (
    !["NotStarted", "InProgress", "Completed"].includes(raw.kitchenStatus as string) ||
    !["NotStarted", "InProgress", "Fulfilled"].includes(raw.fulfillmentStatus as string) ||
    typeof raw.approvalRequired !== "boolean" ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode) ||
    !["PendingKitchen", "PendingApproval", "Applied", "Rejected", "Aborted"].includes(
      raw.status as string,
    )
  )
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  const original = money(raw.originalTotalMinor);
  const revised = money(raw.revisedTotalMinor);
  const delta = money(raw.deltaMinor);
  if (revised - original !== delta || revised < 0n) return fail("ORDER_AMENDMENT_INPUT_INVALID");
  if (raw.fulfillmentStatus === "Fulfilled") return fail("ORDER_AMENDMENT_ORDER_INELIGIBLE");
  if (destructive(change.kind) && raw.kitchenStatus === "Completed")
    return fail("ORDER_AMENDMENT_KITCHEN_REJECTED");
  const requestedBy = parseAmendmentReference(raw.requestedByActorReference);
  const decidedBy =
    raw.decidedByActorReference === null
      ? null
      : parseAmendmentReference(raw.decidedByActorReference);
  const requestedAt = at(raw.requestedAt);
  const decidedAt = raw.decidedAt === null ? null : at(raw.decidedAt);
  const status = raw.status as AmendmentStatus;
  if (
    (status.startsWith("Pending") && (decidedBy !== null || decidedAt !== null)) ||
    (!status.startsWith("Pending") && (decidedBy === null || decidedAt === null))
  )
    return fail("ORDER_AMENDMENT_INPUT_INVALID");
  return Object.freeze({
    amendmentReference: parseAmendmentReference(raw.amendmentReference),
    orderReference: parseAmendmentReference(raw.orderReference),
    tenantReference: parseAmendmentReference(raw.tenantReference),
    brandReference: parseAmendmentReference(raw.brandReference),
    storeReference: parseAmendmentReference(raw.storeReference),
    requestedByActorReference: requestedBy,
    reasonCode: parseAmendmentCode(raw.reasonCode),
    change,
    expectedOrderVersion: version(raw.expectedOrderVersion),
    quoteReference: parseAmendmentReference(raw.quoteReference),
    quoteVersion: version(raw.quoteVersion),
    quoteInputDigest: parseAmendmentDigest(raw.quoteInputDigest),
    currencyCode: raw.currencyCode,
    originalTotalMinor: original.toString(),
    revisedTotalMinor: revised.toString(),
    deltaMinor: delta.toString(),
    kitchenStatus: raw.kitchenStatus as OrderAmendment["kitchenStatus"],
    fulfillmentStatus: raw.fulfillmentStatus as OrderAmendment["fulfillmentStatus"],
    approvalRequired: raw.approvalRequired,
    customerNoticeCode: parseAmendmentCode(raw.customerNoticeCode),
    status,
    aggregateVersion: version(raw.aggregateVersion),
    decidedByActorReference: decidedBy,
    requestedAt,
    decidedAt,
  });
}

export function initialAmendmentStatus(input: {
  readonly kind: AmendmentKind;
  readonly kitchenStatus: OrderAmendment["kitchenStatus"];
  readonly approvalRequired: boolean;
}): AmendmentStatus {
  if (destructive(input.kind) && input.kitchenStatus === "Completed")
    return fail("ORDER_AMENDMENT_KITCHEN_REJECTED");
  if (destructive(input.kind) && input.kitchenStatus === "InProgress") return "PendingKitchen";
  return input.approvalRequired ? "PendingApproval" : "Applied";
}

export function transitionOrderAmendment(
  current: OrderAmendment,
  action: "ConfirmKitchen" | "RejectKitchen" | "Approve" | "Abort",
  actorReference: AmendmentReference,
  occurredAt: string,
): OrderAmendment {
  const atValue = at(occurredAt);
  let status: AmendmentStatus;
  if (action === "ConfirmKitchen" && current.status === "PendingKitchen")
    status = current.approvalRequired ? "PendingApproval" : "Applied";
  else if (action === "RejectKitchen" && current.status === "PendingKitchen") status = "Rejected";
  else if (action === "Approve" && current.status === "PendingApproval") {
    if (actorReference === current.requestedByActorReference)
      return fail("ORDER_AMENDMENT_SEPARATION_REQUIRED");
    status = "Applied";
  } else if (action === "Abort" && current.status.startsWith("Pending")) status = "Aborted";
  else return fail("ORDER_AMENDMENT_TRANSITION_INVALID");
  return createOrderAmendment({
    ...current,
    status,
    aggregateVersion: current.aggregateVersion + 1,
    decidedByActorReference: status === "PendingApproval" ? null : actorReference,
    decidedAt: status === "PendingApproval" ? null : atValue,
  });
}
