export type PurchaseOrderClientErrorCode =
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
export class PurchaseOrderClientError extends Error {
  constructor(readonly code: PurchaseOrderClientErrorCode) {
    super("Purchase Order view is unavailable");
    this.name = "PurchaseOrderClientError";
  }
}
export interface PurchaseOrderRow {
  readonly purchaseOrderReference: string;
  readonly purchaseOrderVersion: number;
  readonly supplierReference: string;
  readonly supplierName: string;
  readonly buyerEntityReference: string;
  readonly buyerEntityName: string;
  readonly shipToStockSiteReference: string;
  readonly shipToLabel: string;
  readonly currency: string;
  readonly workflow:
    | "Draft"
    | "Submitted"
    | "Approved"
    | "Issued"
    | "Acknowledged"
    | "SupplierDeclined"
    | "Cancelled";
  readonly fulfillment: "NotReceived" | "PartiallyReceived" | "FullyReceived";
  readonly closure: "Open" | "Closed";
  readonly orderedAmount: string | null;
  readonly receivedAmount: string | null;
  readonly openAmount: string | null;
  readonly issuedAt: string | null;
  readonly expectedDeliveryUtc: string;
  readonly overdue: boolean;
  readonly discrepancyCount: number | null;
}
export interface PurchaseOrderView {
  readonly screenId: "PROC-PO-LIST" | "PROC-PO-EDITOR" | "PROC-PO-DETAIL";
  readonly projectionName: "procurement_purchase_order_v1";
  readonly projectionVersion: 1;
  readonly brandLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayApprove: boolean;
    readonly mayIssue: boolean;
    readonly mayRecordResponse: boolean;
    readonly mayCancel: boolean;
    readonly mayClose: boolean;
    readonly mayViewCost: boolean;
    readonly mayViewSupplierResponse: boolean;
    readonly mayViewReceipt: boolean;
    readonly mayViewDiscrepancy: boolean;
    readonly mayViewHistory: boolean;
  };
  readonly rows: readonly PurchaseOrderRow[];
  readonly editor: null | {
    readonly purchaseOrderReference: string;
    readonly purchaseOrderVersion: number;
    readonly supplierReference: string;
    readonly buyerEntityReference: string;
    readonly shipToStockSiteReference: string;
    readonly shipToAddressSnapshotReference: string;
    readonly currency: string;
    readonly pendingRevisionNumber: number;
    readonly pendingRevisionLifecycle: "Draft" | "Submitted" | "Approved";
    readonly lines: readonly {
      readonly lineReference: string;
      readonly itemName: string;
      readonly supplierItemSummary: string;
      readonly orderedQuantity: string;
      readonly purchaseUnit: string;
      readonly unitCost: string;
      readonly discount: string;
      readonly lineTotal: string;
      readonly expectedDeliveryUtc: string;
      readonly sourceAllocationReferences: readonly string[];
    }[];
    readonly validationIssues: readonly {
      readonly code: string;
      readonly severity: "Blocking" | "Warning";
      readonly message: string;
    }[];
  };
  readonly detail: null | {
    readonly purchaseOrderReference: string;
    readonly effectiveRevisionNumber: number;
    readonly issuedSnapshotReference: string;
    readonly supplierResponse: null | {
      readonly response: "Acknowledged" | "Declined";
      readonly responseReference: string;
      readonly recordedAt: string;
    };
    readonly revisions:
      | readonly {
          readonly revisionReference: string;
          readonly revisionNumber: number;
          readonly lifecycle: string;
          readonly reasonCode: string | null;
        }[]
      | null;
    readonly receiptReferences: readonly string[] | null;
    readonly discrepancyReferences: readonly string[] | null;
    readonly lineCompletion: readonly {
      readonly lineReference: string;
      readonly orderedQuantity: string;
      readonly receivedQuantity: string | null;
      readonly cancelledQuantity: string;
      readonly final: boolean;
    }[];
    readonly timeline: readonly { readonly action: string; readonly occurredAt: string }[];
  };
  readonly nextCursor: string | null;
}
export interface PurchaseOrderProjectionClient {
  load(input: { purchaseOrderReference: string | null; editor: boolean }): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u;
const cursor = /^[A-Za-z0-9_-]{1,200}$/u;
const fail = (): never => {
  throw new PurchaseOrderClientError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
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
}
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail());
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
const nullableDecimal = (value: unknown) => (value === null ? null : decimal(value));
function permissions(value: unknown) {
  const fields = [
    "mayManage",
    "mayApprove",
    "mayIssue",
    "mayRecordResponse",
    "mayCancel",
    "mayClose",
    "mayViewCost",
    "mayViewSupplierResponse",
    "mayViewReceipt",
    "mayViewDiscrepancy",
    "mayViewHistory",
  ];
  const raw = object(value, fields);
  if (Object.values(raw).some((entry) => typeof entry !== "boolean")) fail();
  return raw as unknown as PurchaseOrderView["permissions"];
}
function row(value: unknown, access: PurchaseOrderView["permissions"]): PurchaseOrderRow {
  const raw = object(value, [
    "purchaseOrderReference",
    "purchaseOrderVersion",
    "supplierReference",
    "supplierName",
    "buyerEntityReference",
    "buyerEntityName",
    "shipToStockSiteReference",
    "shipToLabel",
    "currency",
    "workflow",
    "fulfillment",
    "closure",
    "orderedAmount",
    "receivedAmount",
    "openAmount",
    "issuedAt",
    "expectedDeliveryUtc",
    "overdue",
    "discrepancyCount",
  ]);
  const amounts = [
    nullableDecimal(raw.orderedAmount),
    nullableDecimal(raw.receivedAmount),
    nullableDecimal(raw.openAmount),
  ] as const;
  const discrepancyCount = raw.discrepancyCount === null ? null : integer(raw.discrepancyCount);
  if (
    (!access.mayViewCost && amounts.some((entry) => entry !== null)) ||
    (!access.mayViewDiscrepancy && discrepancyCount !== null) ||
    typeof raw.overdue !== "boolean"
  )
    fail();
  return Object.freeze({
    purchaseOrderReference: ref(raw.purchaseOrderReference),
    purchaseOrderVersion: integer(raw.purchaseOrderVersion, 1),
    supplierReference: ref(raw.supplierReference),
    supplierName: text(raw.supplierName),
    buyerEntityReference: ref(raw.buyerEntityReference),
    buyerEntityName: text(raw.buyerEntityName),
    shipToStockSiteReference: ref(raw.shipToStockSiteReference),
    shipToLabel: text(raw.shipToLabel),
    currency: oneOf(raw.currency, [
      typeof raw.currency === "string" && /^[A-Z]{3}$/u.test(raw.currency)
        ? raw.currency
        : "__INVALID__",
    ]),
    workflow: oneOf(raw.workflow, [
      "Draft",
      "Submitted",
      "Approved",
      "Issued",
      "Acknowledged",
      "SupplierDeclined",
      "Cancelled",
    ]),
    fulfillment: oneOf(raw.fulfillment, ["NotReceived", "PartiallyReceived", "FullyReceived"]),
    closure: oneOf(raw.closure, ["Open", "Closed"]),
    orderedAmount: amounts[0],
    receivedAmount: amounts[1],
    openAmount: amounts[2],
    issuedAt: raw.issuedAt === null ? null : instant(raw.issuedAt),
    expectedDeliveryUtc: instant(raw.expectedDeliveryUtc),
    overdue: raw.overdue as boolean,
    discrepancyCount,
  });
}
export function parsePurchaseOrderView(value: unknown): PurchaseOrderView {
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
    "editor",
    "detail",
    "nextCursor",
  ]);
  if (
    raw.projectionName !== "procurement_purchase_order_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 100 ||
    (raw.nextCursor !== null &&
      (typeof raw.nextCursor !== "string" || !cursor.test(raw.nextCursor)))
  )
    fail();
  const access = permissions(raw.permissions);
  const screenId = oneOf(raw.screenId, ["PROC-PO-LIST", "PROC-PO-EDITOR", "PROC-PO-DETAIL"]);
  const rows = Object.freeze((raw.rows as unknown[]).map((entry) => row(entry, access)));
  let editor: PurchaseOrderView["editor"] = null;
  if (raw.editor !== null) {
    if (!access.mayViewCost) fail();
    const item = object(raw.editor, [
      "purchaseOrderReference",
      "purchaseOrderVersion",
      "supplierReference",
      "buyerEntityReference",
      "shipToStockSiteReference",
      "shipToAddressSnapshotReference",
      "currency",
      "pendingRevisionNumber",
      "pendingRevisionLifecycle",
      "lines",
      "validationIssues",
    ]);
    if (
      !Array.isArray(item.lines) ||
      !Array.isArray(item.validationIssues) ||
      item.lines.length > 500
    )
      fail();
    editor = Object.freeze({
      purchaseOrderReference: ref(item.purchaseOrderReference),
      purchaseOrderVersion: integer(item.purchaseOrderVersion, 1),
      supplierReference: ref(item.supplierReference),
      buyerEntityReference: ref(item.buyerEntityReference),
      shipToStockSiteReference: ref(item.shipToStockSiteReference),
      shipToAddressSnapshotReference: ref(item.shipToAddressSnapshotReference),
      currency: text(item.currency),
      pendingRevisionNumber: integer(item.pendingRevisionNumber, 1),
      pendingRevisionLifecycle: oneOf(item.pendingRevisionLifecycle, [
        "Draft",
        "Submitted",
        "Approved",
      ]),
      lines: Object.freeze(
        (item.lines as unknown[]).map((entry) => {
          const line = object(entry, [
            "lineReference",
            "itemName",
            "supplierItemSummary",
            "orderedQuantity",
            "purchaseUnit",
            "unitCost",
            "discount",
            "lineTotal",
            "expectedDeliveryUtc",
            "sourceAllocationReferences",
          ]);
          if (!Array.isArray(line.sourceAllocationReferences)) fail();
          return Object.freeze({
            lineReference: ref(line.lineReference),
            itemName: text(line.itemName),
            supplierItemSummary: text(line.supplierItemSummary),
            orderedQuantity: decimal(line.orderedQuantity),
            purchaseUnit: text(line.purchaseUnit),
            unitCost: decimal(line.unitCost),
            discount: decimal(line.discount),
            lineTotal: decimal(line.lineTotal),
            expectedDeliveryUtc: instant(line.expectedDeliveryUtc),
            sourceAllocationReferences: Object.freeze(
              (line.sourceAllocationReferences as unknown[]).map(ref),
            ),
          });
        }),
      ),
      validationIssues: Object.freeze(
        (item.validationIssues as unknown[]).map((entry) => {
          const issue = object(entry, ["code", "severity", "message"]);
          return Object.freeze({
            code: text(issue.code),
            severity: oneOf(issue.severity, ["Blocking", "Warning"]),
            message: text(issue.message),
          });
        }),
      ),
    });
  }
  let detail: PurchaseOrderView["detail"] = null;
  if (raw.detail !== null) {
    const item = object(raw.detail, [
      "purchaseOrderReference",
      "effectiveRevisionNumber",
      "issuedSnapshotReference",
      "supplierResponse",
      "revisions",
      "receiptReferences",
      "discrepancyReferences",
      "lineCompletion",
      "timeline",
    ]);
    if (
      (item.revisions !== null && !Array.isArray(item.revisions)) ||
      (item.receiptReferences !== null && !Array.isArray(item.receiptReferences)) ||
      (item.discrepancyReferences !== null && !Array.isArray(item.discrepancyReferences)) ||
      !Array.isArray(item.lineCompletion) ||
      !Array.isArray(item.timeline)
    )
      fail();
    if (
      (!access.mayViewSupplierResponse && item.supplierResponse !== null) ||
      (!access.mayViewHistory && item.revisions !== null) ||
      (!access.mayViewReceipt && item.receiptReferences !== null) ||
      (!access.mayViewDiscrepancy && item.discrepancyReferences !== null)
    )
      fail();
    const response =
      item.supplierResponse === null
        ? null
        : object(item.supplierResponse, ["response", "responseReference", "recordedAt"]);
    detail = Object.freeze({
      purchaseOrderReference: ref(item.purchaseOrderReference),
      effectiveRevisionNumber: integer(item.effectiveRevisionNumber, 1),
      issuedSnapshotReference: ref(item.issuedSnapshotReference),
      supplierResponse:
        response === null
          ? null
          : Object.freeze({
              response: oneOf(response.response, ["Acknowledged", "Declined"]),
              responseReference: ref(response.responseReference),
              recordedAt: instant(response.recordedAt),
            }),
      revisions:
        item.revisions === null
          ? null
          : Object.freeze(
              (item.revisions as unknown[]).map((entry) => {
                const revision = object(entry, [
                  "revisionReference",
                  "revisionNumber",
                  "lifecycle",
                  "reasonCode",
                ]);
                return Object.freeze({
                  revisionReference: ref(revision.revisionReference),
                  revisionNumber: integer(revision.revisionNumber, 1),
                  lifecycle: text(revision.lifecycle),
                  reasonCode: revision.reasonCode === null ? null : text(revision.reasonCode),
                });
              }),
            ),
      receiptReferences:
        item.receiptReferences === null
          ? null
          : Object.freeze((item.receiptReferences as unknown[]).map(ref)),
      discrepancyReferences:
        item.discrepancyReferences === null
          ? null
          : Object.freeze((item.discrepancyReferences as unknown[]).map(ref)),
      lineCompletion: Object.freeze(
        (item.lineCompletion as unknown[]).map((entry) => {
          const completion = object(entry, [
            "lineReference",
            "orderedQuantity",
            "receivedQuantity",
            "cancelledQuantity",
            "final",
          ]);
          if (typeof completion.final !== "boolean") fail();
          return Object.freeze({
            lineReference: ref(completion.lineReference),
            orderedQuantity: decimal(completion.orderedQuantity),
            receivedQuantity:
              completion.receivedQuantity === null ? null : decimal(completion.receivedQuantity),
            cancelledQuantity: decimal(completion.cancelledQuantity),
            final: completion.final as boolean,
          });
        }),
      ),
      timeline: Object.freeze(
        (item.timeline as unknown[]).map((entry) => {
          const event = object(entry, ["action", "occurredAt"]);
          return Object.freeze({
            action: text(event.action),
            occurredAt: instant(event.occurredAt),
          });
        }),
      ),
    });
  }
  if (
    (screenId === "PROC-PO-EDITOR") !== (editor !== null) ||
    (screenId === "PROC-PO-DETAIL") !== (detail !== null)
  )
    fail();
  return Object.freeze({
    screenId,
    projectionName: "procurement_purchase_order_v1",
    projectionVersion: 1,
    brandLabel: text(raw.brandLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial as boolean,
    permissions: access,
    rows,
    editor,
    detail,
    nextCursor: raw.nextCursor as string | null,
  });
}
export const unavailablePurchaseOrderClient: PurchaseOrderProjectionClient = Object.freeze({
  load: async () => {
    throw new PurchaseOrderClientError("Unavailable");
  },
});
