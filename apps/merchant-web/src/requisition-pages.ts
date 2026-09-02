export type RequisitionClientErrorCode =
  | "Empty"
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "ValidationFailed"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class RequisitionClientError extends Error {
  constructor(readonly code: RequisitionClientErrorCode) {
    super("Requisition view is unavailable");
    this.name = "RequisitionClientError";
  }
}
export interface RequisitionRow {
  readonly requisitionReference: string;
  readonly requisitionVersion: number;
  readonly requestingScopeLabel: string;
  readonly workflow: "Draft" | "Submitted" | "InReview" | "Approved" | "Rejected" | "Cancelled";
  readonly allocationStatus: "NotAllocated" | "PartiallyAllocated" | "FullyAllocated";
  readonly closureStatus: "Open" | "Closed";
  readonly urgency: "Routine" | "Urgent" | "Emergency";
  readonly lineCount: number;
  readonly amountEstimate: string | null;
  readonly currency: string | null;
  readonly requesterReference: string;
  readonly approverReference: string | null;
  readonly requiredByUtc: string;
}
export interface RequisitionView {
  readonly screenId: "PROC-REQUISITION-LIST" | "PROC-REQUISITION-DETAIL";
  readonly projectionName: "procurement_requisition_v1";
  readonly projectionVersion: 1;
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayReview: boolean;
    readonly mayApprove: boolean;
    readonly mayAllocate: boolean;
    readonly mayViewAmount: boolean;
    readonly mayViewApprovalIdentity: boolean;
    readonly mayViewAllocationReferences: boolean;
  };
  readonly rows: readonly RequisitionRow[];
  readonly detail: null | {
    readonly requisitionReference: string;
    readonly requisitionVersion: number;
    readonly needSourceReferences: readonly string[];
    readonly lines: readonly {
      readonly lineReference: string;
      readonly inventoryItemReference: string;
      readonly itemName: string;
      readonly requestedQuantity: string;
      readonly requestedUnit: string;
      readonly requiredByUtc: string;
      readonly candidateSupplierSummaries: readonly string[];
      readonly allocationReferences: readonly string[] | null;
    }[];
    readonly approvalReference: string | null;
    readonly approverReference: string | null;
    readonly timeline: readonly { readonly action: string; readonly occurredAt: string }[];
  };
  readonly nextCursor: string | null;
}
export interface RequisitionProjectionClient {
  load(input: { requisitionReference: string | null }): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,160}$/u;
const cursor = /^[A-Za-z0-9_-]{1,200}$/u;
function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new RequisitionClientError("Unavailable");
  return value as Record<string, unknown>;
}
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail());
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const fail = (): never => {
  throw new RequisitionClientError("Unavailable");
};
const text = (value: unknown) =>
  typeof value === "string" && value.trim() === value && safe.test(value) ? value : fail();
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const integer = (value: unknown, minimum = 0) =>
  Number.isSafeInteger(value) && (value as number) >= minimum ? (value as number) : fail();
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const decimal = (value: unknown) =>
  typeof value === "string" && decimalPattern.test(value) ? value : fail();
function permissions(value: unknown) {
  const raw = object(value, [
    "mayManage",
    "mayReview",
    "mayApprove",
    "mayAllocate",
    "mayViewAmount",
    "mayViewApprovalIdentity",
    "mayViewAllocationReferences",
  ]);
  if (Object.values(raw).some((entry) => typeof entry !== "boolean")) fail();
  return raw as unknown as RequisitionView["permissions"];
}
function row(value: unknown, access: RequisitionView["permissions"]): RequisitionRow {
  const raw = object(value, [
    "requisitionReference",
    "requisitionVersion",
    "requestingScopeLabel",
    "workflow",
    "allocationStatus",
    "closureStatus",
    "urgency",
    "lineCount",
    "amountEstimate",
    "currency",
    "requesterReference",
    "approverReference",
    "requiredByUtc",
  ]);
  const amount = raw.amountEstimate === null ? null : decimal(raw.amountEstimate);
  const currency =
    raw.currency === null
      ? null
      : oneOf(raw.currency, [
          typeof raw.currency === "string" && /^[A-Z]{3}$/u.test(raw.currency)
            ? raw.currency
            : "__INVALID__",
        ]);
  const approver = nullableRef(raw.approverReference);
  if (
    (!access.mayViewAmount && (amount !== null || currency !== null)) ||
    (amount === null) !== (currency === null) ||
    (!access.mayViewApprovalIdentity && approver !== null)
  )
    fail();
  return Object.freeze({
    requisitionReference: ref(raw.requisitionReference),
    requisitionVersion: integer(raw.requisitionVersion, 1),
    requestingScopeLabel: text(raw.requestingScopeLabel),
    workflow: oneOf(raw.workflow, [
      "Draft",
      "Submitted",
      "InReview",
      "Approved",
      "Rejected",
      "Cancelled",
    ]),
    allocationStatus: oneOf(raw.allocationStatus, [
      "NotAllocated",
      "PartiallyAllocated",
      "FullyAllocated",
    ]),
    closureStatus: oneOf(raw.closureStatus, ["Open", "Closed"]),
    urgency: oneOf(raw.urgency, ["Routine", "Urgent", "Emergency"]),
    lineCount: integer(raw.lineCount, 1),
    amountEstimate: amount,
    currency,
    requesterReference: ref(raw.requesterReference),
    approverReference: approver,
    requiredByUtc: instant(raw.requiredByUtc),
  });
}
export function parseRequisitionView(value: unknown): RequisitionView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "brandLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
    "detail",
    "nextCursor",
  ]);
  if (
    raw.projectionName !== "procurement_requisition_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 100 ||
    (raw.nextCursor !== null &&
      (typeof raw.nextCursor !== "string" || !cursor.test(raw.nextCursor)))
  )
    fail();
  const access = permissions(raw.permissions);
  const screenId = oneOf(raw.screenId, ["PROC-REQUISITION-LIST", "PROC-REQUISITION-DETAIL"]);
  const rawRows = raw.rows as unknown[];
  const rows = Object.freeze(rawRows.map((entry) => row(entry, access)));
  let detail: RequisitionView["detail"] = null;
  if (raw.detail !== null) {
    const item = object(raw.detail, [
      "requisitionReference",
      "requisitionVersion",
      "needSourceReferences",
      "lines",
      "approvalReference",
      "approverReference",
      "timeline",
    ]);
    if (
      !Array.isArray(item.needSourceReferences) ||
      !Array.isArray(item.lines) ||
      !Array.isArray(item.timeline) ||
      item.lines.length > 200 ||
      item.timeline.length > 500
    )
      fail();
    const needSourceReferences = item.needSourceReferences as unknown[];
    const rawLines = item.lines as unknown[];
    const rawTimeline = item.timeline as unknown[];
    const approvalReference = nullableRef(item.approvalReference);
    const approverReference = nullableRef(item.approverReference);
    if (
      !access.mayViewApprovalIdentity &&
      (approvalReference !== null || approverReference !== null)
    )
      fail();
    detail = Object.freeze({
      requisitionReference: ref(item.requisitionReference),
      requisitionVersion: integer(item.requisitionVersion, 1),
      needSourceReferences: Object.freeze(needSourceReferences.map(ref)),
      lines: Object.freeze(
        rawLines.map((entry) => {
          const line = object(entry, [
            "lineReference",
            "inventoryItemReference",
            "itemName",
            "requestedQuantity",
            "requestedUnit",
            "requiredByUtc",
            "candidateSupplierSummaries",
            "allocationReferences",
          ]);
          if (
            !Array.isArray(line.candidateSupplierSummaries) ||
            (line.allocationReferences !== null && !Array.isArray(line.allocationReferences)) ||
            (!access.mayViewAllocationReferences && line.allocationReferences !== null)
          )
            fail();
          const candidateSupplierSummaries = line.candidateSupplierSummaries as unknown[];
          const allocationReferences = line.allocationReferences as unknown[] | null;
          return Object.freeze({
            lineReference: ref(line.lineReference),
            inventoryItemReference: ref(line.inventoryItemReference),
            itemName: text(line.itemName),
            requestedQuantity: decimal(line.requestedQuantity),
            requestedUnit: text(line.requestedUnit),
            requiredByUtc: instant(line.requiredByUtc),
            candidateSupplierSummaries: Object.freeze(candidateSupplierSummaries.map(text)),
            allocationReferences:
              allocationReferences === null ? null : Object.freeze(allocationReferences.map(ref)),
          });
        }),
      ),
      approvalReference,
      approverReference,
      timeline: Object.freeze(
        rawTimeline.map((entry) => {
          const event = object(entry, ["action", "occurredAt"]);
          return Object.freeze({
            action: text(event.action),
            occurredAt: instant(event.occurredAt),
          });
        }),
      ),
    });
  }
  if ((screenId === "PROC-REQUISITION-DETAIL") !== (detail !== null)) fail();
  return Object.freeze({
    screenId,
    projectionName: "procurement_requisition_v1",
    projectionVersion: 1,
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial as boolean,
    permissions: access,
    rows,
    detail,
    nextCursor: raw.nextCursor as string | null,
  });
}
export const unavailableRequisitionClient: RequisitionProjectionClient = Object.freeze({
  load: async () => {
    throw new RequisitionClientError("Unavailable");
  },
});
