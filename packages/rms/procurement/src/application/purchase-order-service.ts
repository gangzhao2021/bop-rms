import type {
  PurchaseOrderCommand,
  PurchaseOrderCommandRecord,
  PurchaseOrderProjection,
  PurchaseOrderQuery,
} from "../contracts/purchase-order.js";
import {
  cancelPurchaseOrderLineRemainder,
  closePurchaseOrder,
  createPurchaseOrder,
  PurchaseOrderError,
  recordSupplierPurchaseOrderResponse,
  revisePurchaseOrder,
  transitionPurchaseOrder,
  type PurchaseOrder,
  type PurchaseOrderReference,
} from "../domain/aggregates/purchase-order.js";
import { offeringReference } from "../domain/aggregates/offering.js";
import type { PurchaseOrderAccess, PurchaseOrderPorts } from "./ports/purchase-order-ports.js";
export class PurchaseOrderServiceError extends Error {
  constructor(
    readonly code:
      | "PURCHASE_ORDER_INVALID"
      | "PURCHASE_ORDER_PERMISSION_DENIED"
      | "PURCHASE_ORDER_NOT_FOUND"
      | "PURCHASE_ORDER_CONFLICT"
      | "PURCHASE_ORDER_STATE_CONFLICT"
      | "PURCHASE_ORDER_SEGREGATION_REQUIRED"
      | "PURCHASE_ORDER_AMOUNT_MISMATCH"
      | "PURCHASE_ORDER_OVER_CLOSED"
      | "PURCHASE_ORDER_CLOSE_BLOCKED"
      | "PURCHASE_ORDER_IDEMPOTENCY_CONFLICT"
      | "PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE"
      | "PURCHASE_ORDER_APPROVAL_REQUIRED"
      | "PURCHASE_ORDER_ISSUE_BLOCKED",
  ) {
    super(code);
  }
}
const fail = (code: PurchaseOrderServiceError["code"]): never => {
  throw new PurchaseOrderServiceError(code);
};
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("PURCHASE_ORDER_INVALID");
  return value as Record<string, unknown>;
}
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("PURCHASE_ORDER_INVALID");
  }
};
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const code = (value: unknown, pattern = codePattern) =>
  typeof value === "string" && pattern.test(value) ? value : fail("PURCHASE_ORDER_INVALID");
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : fail("PURCHASE_ORDER_INVALID");
const integer = (value: unknown, minimum = 0) =>
  Number.isSafeInteger(value) && (value as number) >= minimum
    ? (value as number)
    : fail("PURCHASE_ORDER_INVALID");
const bool = (value: unknown) =>
  typeof value === "boolean" ? value : fail("PURCHASE_ORDER_INVALID");
const at = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("PURCHASE_ORDER_INVALID");
const decimal = (value: unknown, positive = false) =>
  typeof value === "string" &&
  decimalPattern.test(value) &&
  (!positive || !/^0(?:\.0+)?$/u.test(value))
    ? value
    : fail("PURCHASE_ORDER_INVALID");
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[<>{}\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : fail("PURCHASE_ORDER_INVALID");
interface RequestedLine {
  readonly lineReference: PurchaseOrderReference;
  readonly inventoryItemReference: PurchaseOrderReference;
  readonly offeringReference: PurchaseOrderReference;
  readonly orderedQuantity: string;
  readonly expectedDeliveryUtc: string;
  readonly requisitionAllocationReferences: readonly PurchaseOrderReference[];
  readonly commercialTermsReference: PurchaseOrderReference;
}
function requestedLines(value: unknown): readonly RequestedLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500)
    return fail("PURCHASE_ORDER_INVALID");
  const parsed = value.map((entry) => {
    const raw = exact(entry, [
      "lineReference",
      "inventoryItemReference",
      "offeringReference",
      "orderedQuantity",
      "expectedDeliveryUtc",
      "requisitionAllocationReferences",
      "commercialTermsReference",
    ]);
    if (
      !Array.isArray(raw.requisitionAllocationReferences) ||
      raw.requisitionAllocationReferences.length > 200
    )
      return fail("PURCHASE_ORDER_INVALID");
    const allocations = Object.freeze(raw.requisitionAllocationReferences.map(ref));
    if (new Set(allocations).size !== allocations.length) return fail("PURCHASE_ORDER_INVALID");
    return Object.freeze({
      lineReference: ref(raw.lineReference),
      inventoryItemReference: ref(raw.inventoryItemReference),
      offeringReference: ref(raw.offeringReference),
      orderedQuantity: decimal(raw.orderedQuantity, true),
      expectedDeliveryUtc: at(raw.expectedDeliveryUtc),
      requisitionAllocationReferences: allocations,
      commercialTermsReference: ref(raw.commercialTermsReference),
    });
  });
  if (new Set(parsed.map((entry) => entry.lineReference)).size !== parsed.length)
    return fail("PURCHASE_ORDER_INVALID");
  return Object.freeze(parsed);
}
const commandFields = [
  "tenantReference",
  "brandReference",
  "actorReference",
  "purpose",
  "permission",
  "operationReference",
  "occurredAt",
  "action",
  "payload",
] as const;
function parseCommand(value: unknown): PurchaseOrderCommand {
  const raw = exact(value, commandFields);
  const action = oneOf(raw.action, [
    "CreateDraft",
    "ReviseDraft",
    "Submit",
    "Approve",
    "Issue",
    "RecordAcknowledgement",
    "RecordDecline",
    "Cancel",
    "CancelRemainder",
    "Close",
  ]);
  if (raw.purpose !== "PurchaseOrderManagement") return fail("PURCHASE_ORDER_INVALID");
  const permission =
    action === "Approve"
      ? "procurement.purchase_order.approve"
      : action === "Issue"
        ? "procurement.purchase_order.issue"
        : ["RecordAcknowledgement", "RecordDecline"].includes(action)
          ? "procurement.purchase_order.response"
          : ["Cancel", "CancelRemainder"].includes(action)
            ? "procurement.purchase_order.cancel"
            : action === "Close"
              ? "procurement.purchase_order.close"
              : "procurement.purchase_order.manage";
  if (raw.permission !== permission) return fail("PURCHASE_ORDER_INVALID");
  let payload: Record<string, unknown>;
  if (action === "CreateDraft")
    payload = exact(raw.payload, [
      "supplierReference",
      "buyerLegalEntityReference",
      "shipToStockSiteReference",
      "shipToAddressSnapshotReference",
      "currency",
      "requestedLines",
    ]);
  else if (action === "ReviseDraft")
    payload = exact(raw.payload, [
      "purchaseOrderReference",
      "expectedVersion",
      "reasonCode",
      "requestedLines",
    ]);
  else if (["RecordAcknowledgement", "RecordDecline"].includes(action))
    payload = exact(raw.payload, [
      "purchaseOrderReference",
      "expectedVersion",
      "revisionNumber",
      "reasonCode",
    ]);
  else if (action === "CancelRemainder")
    payload = exact(raw.payload, [
      "purchaseOrderReference",
      "expectedVersion",
      "lineReference",
      "quantity",
      "reasonCode",
      "approvalReference",
    ]);
  else if (action === "Close")
    payload = exact(raw.payload, ["purchaseOrderReference", "expectedVersion"]);
  else
    payload = exact(raw.payload, [
      "purchaseOrderReference",
      "expectedVersion",
      "approvalReference",
      "reasonCode",
    ]);
  const parsed =
    action === "CreateDraft"
      ? {
          supplierReference: ref(payload.supplierReference),
          buyerLegalEntityReference: ref(payload.buyerLegalEntityReference),
          shipToStockSiteReference: ref(payload.shipToStockSiteReference),
          shipToAddressSnapshotReference: ref(payload.shipToAddressSnapshotReference),
          currency: code(payload.currency, /^[A-Z]{3}$/u),
          requestedLines: requestedLines(payload.requestedLines),
        }
      : {
          purchaseOrderReference: ref(payload.purchaseOrderReference),
          expectedVersion: integer(payload.expectedVersion, 1),
          ...(action === "ReviseDraft"
            ? {
                reasonCode: payload.reasonCode === null ? null : code(payload.reasonCode),
                requestedLines: requestedLines(payload.requestedLines),
              }
            : {}),
          ...(["RecordAcknowledgement", "RecordDecline"].includes(action)
            ? {
                revisionNumber: integer(payload.revisionNumber, 1),
                reasonCode: payload.reasonCode === null ? null : code(payload.reasonCode),
              }
            : {}),
          ...(action === "CancelRemainder"
            ? {
                lineReference: ref(payload.lineReference),
                quantity: decimal(payload.quantity, true),
                reasonCode: code(payload.reasonCode),
                approvalReference: ref(payload.approvalReference),
              }
            : {}),
          ...(["Submit", "Approve", "Issue", "Cancel"].includes(action)
            ? {
                approvalReference: nullableRef(payload.approvalReference),
                reasonCode: payload.reasonCode === null ? null : code(payload.reasonCode),
              }
            : {}),
        };
  if (
    (["Submit"].includes(action) &&
      (payload.approvalReference !== null || payload.reasonCode !== null)) ||
    (action === "Approve" && (payload.approvalReference === null || payload.reasonCode !== null)) ||
    (action === "Issue" && (payload.approvalReference === null || payload.reasonCode !== null)) ||
    (action === "Cancel" && (payload.approvalReference !== null || payload.reasonCode === null)) ||
    (action === "RecordAcknowledgement" && payload.reasonCode !== null) ||
    (action === "RecordDecline" && payload.reasonCode === null)
  )
    return fail("PURCHASE_ORDER_INVALID");
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "PurchaseOrderManagement",
    permission,
    operationReference: ref(raw.operationReference),
    occurredAt: at(raw.occurredAt),
    action,
    payload: Object.freeze(parsed),
  });
}
function parseQuery(value: unknown): PurchaseOrderQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "selectedPurchaseOrderReference",
    "editor",
    "search",
    "supplierReference",
    "itemReference",
    "workflow",
    "fulfillment",
    "closure",
    "storeReference",
    "buyerEntityReference",
    "requiredFromUtc",
    "requiredUntilUtc",
    "overdueOnly",
    "discrepancyOnly",
    "cursor",
  ]);
  if (raw.purpose !== "PurchaseOrderRead" || raw.permission !== "procurement.purchase_order.read")
    return fail("PURCHASE_ORDER_INVALID");
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "PurchaseOrderRead",
    permission: "procurement.purchase_order.read",
    selectedPurchaseOrderReference: nullableRef(raw.selectedPurchaseOrderReference),
    editor: bool(raw.editor),
    search: raw.search === null ? null : code(raw.search, /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/u),
    supplierReference: nullableRef(raw.supplierReference),
    itemReference: nullableRef(raw.itemReference),
    workflow: oneOf(raw.workflow, [
      "All",
      "Draft",
      "Submitted",
      "Approved",
      "Issued",
      "Acknowledged",
      "SupplierDeclined",
      "Cancelled",
    ]),
    fulfillment: oneOf(raw.fulfillment, [
      "All",
      "NotReceived",
      "PartiallyReceived",
      "FullyReceived",
    ]),
    closure: oneOf(raw.closure, ["All", "Open", "Closed"]),
    storeReference: nullableRef(raw.storeReference),
    buyerEntityReference: nullableRef(raw.buyerEntityReference),
    requiredFromUtc: raw.requiredFromUtc === null ? null : at(raw.requiredFromUtc),
    requiredUntilUtc: raw.requiredUntilUtc === null ? null : at(raw.requiredUntilUtc),
    overdueOnly: bool(raw.overdueOnly),
    discrepancyOnly: bool(raw.discrepancyOnly),
    cursor: raw.cursor === null ? null : code(raw.cursor, /^[A-Za-z0-9_-]{1,256}$/u),
  });
}
function validateProjection(
  value: PurchaseOrderProjection,
  input: PurchaseOrderQuery,
  access: PurchaseOrderAccess,
) {
  if (
    value.projectionName !== "procurement_purchase_order_v1" ||
    !Number.isSafeInteger(value.projectionVersion) ||
    value.projectionVersion < 1 ||
    at(value.asOfUtc) !== value.asOfUtc ||
    value.tenantReference !== input.tenantReference ||
    value.brandReference !== input.brandReference ||
    value.items.length > 100 ||
    Object.entries(value.permissions).some(
      ([key, granted]) => granted !== access[key as keyof PurchaseOrderAccess],
    )
  )
    return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  for (const item of value.items) {
    ref(item.purchaseOrderReference);
    integer(item.purchaseOrderVersion, 1);
    ref(item.supplierReference);
    text(item.supplierName);
    ref(item.buyerEntityReference);
    text(item.buyerEntityName);
    ref(item.shipToStockSiteReference);
    text(item.shipToLabel);
    code(item.currency, /^[A-Z]{3}$/u);
    at(item.expectedDeliveryUtc);
    if (item.issuedAt !== null) at(item.issuedAt);
    if (
      !access.mayViewCost &&
      (item.orderedAmount !== null || item.receivedAmount !== null || item.openAmount !== null)
    )
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
    [item.orderedAmount, item.receivedAmount, item.openAmount].forEach((amount) => {
      if (amount !== null) decimal(amount);
    });
    if (!access.mayViewDiscrepancy && item.discrepancyCount !== null)
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
    if (item.discrepancyCount !== null) integer(item.discrepancyCount);
  }
  if (
    value.editor &&
    (!input.editor ||
      !access.mayViewCost ||
      value.editor.purchaseOrderReference !== input.selectedPurchaseOrderReference)
  )
    return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  if (value.editor) {
    integer(value.editor.purchaseOrderVersion, 1);
    integer(value.editor.pendingRevisionNumber, 1);
    oneOf(value.editor.pendingRevisionLifecycle, ["Draft", "Submitted", "Approved"]);
    ref(value.editor.supplierReference);
    ref(value.editor.buyerEntityReference);
    ref(value.editor.shipToStockSiteReference);
    ref(value.editor.shipToAddressSnapshotReference);
    code(value.editor.currency, /^[A-Z]{3}$/u);
    for (const line of value.editor.lines) {
      ref(line.lineReference);
      ref(line.inventoryItemReference);
      ref(line.offeringReference);
      ref(line.offeringVersionReference);
      ref(line.priceRecordReference);
      ref(line.priceVersionReference);
      line.requisitionAllocationReferences.forEach(ref);
      decimal(line.orderedQuantity, true);
      decimal(line.unitCost, true);
      decimal(line.discount);
      decimal(line.lineTotal, true);
      at(line.expectedDeliveryUtc);
    }
  }
  if (value.detail) {
    if (
      input.editor ||
      value.detail.purchaseOrderReference !== input.selectedPurchaseOrderReference
    )
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
    if (!access.mayViewSupplierResponse && value.detail.supplierResponse !== null)
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
    if (!access.mayViewHistory && value.detail.revisions !== null)
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
    if (!access.mayViewReceipt && value.detail.receiptReferences !== null)
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
    if (!access.mayViewDiscrepancy && value.detail.discrepancyReferences !== null)
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  }
}
export async function queryPurchaseOrders(value: unknown, ports: PurchaseOrderPorts) {
  const input = parseQuery(value);
  let access: PurchaseOrderAccess;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: input.purpose,
      permission: input.permission,
      action: "Query",
    });
  } catch {
    return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  }
  if (!access.authorized) return fail("PURCHASE_ORDER_PERMISSION_DENIED");
  try {
    const result = await ports.projection.query(input);
    validateProjection(result, input, access);
    return result;
  } catch (error) {
    if (error instanceof PurchaseOrderServiceError) throw error;
    return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  }
}
const intent = (value: PurchaseOrderCommand) => JSON.stringify(value);
const permissionKey = (action: PurchaseOrderCommand["action"]): keyof PurchaseOrderAccess =>
  action === "Approve"
    ? "mayApprove"
    : action === "Issue"
      ? "mayIssue"
      : ["RecordAcknowledgement", "RecordDecline"].includes(action)
        ? "mayRecordResponse"
        : ["Cancel", "CancelRemainder"].includes(action)
          ? "mayCancel"
          : action === "Close"
            ? "mayClose"
            : "mayManage";
interface ExistingPayload {
  purchaseOrderReference: PurchaseOrderReference;
  expectedVersion: number;
  approvalReference?: PurchaseOrderReference | null;
  reasonCode?: string | null;
  revisionNumber?: number;
  lineReference?: PurchaseOrderReference;
  quantity?: string;
  requestedLines?: readonly RequestedLine[];
}
function validateComposition(
  result: Awaited<ReturnType<PurchaseOrderPorts["composition"]["resolve"]>>,
  input: PurchaseOrderCommand,
  before: PurchaseOrder | null,
  requested: readonly RequestedLine[],
) {
  const source = input.payload;
  if (
    result.tenantReference !== input.tenantReference ||
    result.brandReference !== input.brandReference ||
    result.purchaseOrderReference !== (before?.purchaseOrderReference ?? null) ||
    result.purchaseOrderVersion !== (before?.aggregateVersion ?? null) ||
    result.supplierReference !== (before?.supplierReference ?? source.supplierReference) ||
    result.buyerLegalEntityReference !==
      (before?.buyerLegalEntityReference ?? source.buyerLegalEntityReference) ||
    result.shipToStockSiteReference !==
      (before?.shipToStockSiteReference ?? source.shipToStockSiteReference) ||
    result.shipToAddressSnapshotReference !==
      (before?.shipToAddressSnapshotReference ?? source.shipToAddressSnapshotReference) ||
    result.currency !== (before?.currency ?? source.currency) ||
    !result.supplierActive ||
    !result.offeringsApproved ||
    !result.pricesApproved ||
    !result.requisitionsApproved ||
    result.lines.length !== requested.length
  )
    return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  for (const item of requested) {
    const resolved = result.lines.find((entry) => entry.lineReference === item.lineReference);
    if (
      !resolved ||
      resolved.inventoryItemReference !== item.inventoryItemReference ||
      resolved.offeringReference !== item.offeringReference ||
      resolved.orderedQuantity !== item.orderedQuantity ||
      resolved.expectedDeliveryUtc !== item.expectedDeliveryUtc ||
      resolved.commercialTermsReference !== item.commercialTermsReference ||
      JSON.stringify(resolved.requisitionAllocationReferences) !==
        JSON.stringify(item.requisitionAllocationReferences) ||
      resolved.currency !== result.currency
    )
      return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  }
  return result.lines;
}
function validateApproval(
  result: Awaited<ReturnType<PurchaseOrderPorts["approval"]["validate"]>>,
  input: PurchaseOrderCommand,
  before: PurchaseOrder,
  lineReference: PurchaseOrderReference | null,
  quantity: string | null,
) {
  const expectedRevision =
    lineReference === null ? before.pendingRevisionNumber : before.effectiveRevisionNumber;
  if (
    result.tenantReference !== input.tenantReference ||
    result.brandReference !== input.brandReference ||
    result.purchaseOrderReference !== before.purchaseOrderReference ||
    result.purchaseOrderVersion !== before.aggregateVersion ||
    result.revisionNumber !== expectedRevision ||
    result.lineReference !== lineReference ||
    result.quantity !== quantity ||
    result.approvalReference !== input.payload.approvalReference ||
    !result.approved ||
    at(result.approvedAt) > input.occurredAt
  )
    return fail("PURCHASE_ORDER_APPROVAL_REQUIRED");
}
export async function executePurchaseOrder(value: unknown, ports: PurchaseOrderPorts) {
  const input = parseCommand(value);
  let access: PurchaseOrderAccess;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: input.purpose,
      permission: input.permission,
      action: input.action,
    });
  } catch {
    return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  }
  if (!access.authorized || !access[permissionKey(input.action)])
    return fail("PURCHASE_ORDER_PERMISSION_DENIED");
  try {
    const hash = ports.references.hashIntent(intent(input));
    const replay = await ports.repository.resolveOperation(input.operationReference);
    if (replay) {
      if (
        !ports.references.equals(replay.intentHash, hash) ||
        intent(replay.command) !== intent(input) ||
        replay.operationReference !== input.operationReference ||
        replay.action !== input.action ||
        replay.purchaseOrder.tenantReference !== input.tenantReference ||
        replay.purchaseOrder.brandReference !== input.brandReference
      )
        return fail("PURCHASE_ORDER_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
    }
    let before: PurchaseOrder | null = null;
    let after: PurchaseOrder;
    if (input.action === "CreateDraft") {
      const requested = input.payload.requestedLines as readonly RequestedLine[];
      const composition = await ports.composition.resolve({ command: input, purchaseOrder: null });
      const lines = validateComposition(composition, input, null, requested);
      after = createPurchaseOrder({
        purchaseOrderReference: ports.references.generate("PurchaseOrder"),
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        supplierReference: composition.supplierReference,
        buyerLegalEntityReference: composition.buyerLegalEntityReference,
        shipToStockSiteReference: composition.shipToStockSiteReference,
        shipToAddressSnapshotReference: composition.shipToAddressSnapshotReference,
        currency: composition.currency,
        revisionReference: ports.references.generate("Revision"),
        lines,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
      });
    } else {
      const p = input.payload as unknown as ExistingPayload;
      before = await ports.repository.load({
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        purchaseOrderReference: p.purchaseOrderReference,
      });
      if (
        !before ||
        before.tenantReference !== input.tenantReference ||
        before.brandReference !== input.brandReference ||
        before.purchaseOrderReference !== p.purchaseOrderReference
      )
        return fail("PURCHASE_ORDER_NOT_FOUND");
      if (before.aggregateVersion !== p.expectedVersion) return fail("PURCHASE_ORDER_CONFLICT");
      const pending =
        before.pendingRevisionNumber === null
          ? null
          : before.revisions.find(
              (entry) => entry.revisionNumber === before?.pendingRevisionNumber,
            );
      const expected: Partial<Record<PurchaseOrderCommand["action"], boolean>> = {
        ReviseDraft:
          (pending !== null || before.effectiveRevisionNumber !== null) &&
          before.closureStatus === "Open",
        Submit: pending?.lifecycle === "Draft",
        Approve: pending?.lifecycle === "Submitted",
        Issue: pending?.lifecycle === "Approved",
        RecordAcknowledgement: before.workflow === "Issued",
        RecordDecline: before.workflow === "Issued",
        Cancel: before.effectiveRevisionNumber === null && pending !== null,
        CancelRemainder: before.effectiveRevisionNumber !== null && before.closureStatus === "Open",
        Close:
          before.effectiveRevisionNumber !== null &&
          before.pendingRevisionNumber === null &&
          before.closureStatus === "Open",
      };
      if (!expected[input.action]) return fail("PURCHASE_ORDER_STATE_CONFLICT");
      if (input.action === "ReviseDraft") {
        const requested = p.requestedLines ?? fail("PURCHASE_ORDER_INVALID");
        const composition = await ports.composition.resolve({
          command: input,
          purchaseOrder: before,
        });
        const resolved = validateComposition(composition, input, before, requested);
        after = revisePurchaseOrder(before, {
          expectedVersion: p.expectedVersion,
          revisionReference: ports.references.generate("Revision"),
          reasonCode: p.reasonCode ?? null,
          lines: resolved,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      } else if (input.action === "Approve") {
        if (input.actorReference === pending?.submittedBy)
          return fail("PURCHASE_ORDER_SEGREGATION_REQUIRED");
        validateApproval(
          await ports.approval.validate({
            command: input,
            purchaseOrder: before,
            lineReference: null,
            quantity: null,
          }),
          input,
          before,
          null,
          null,
        );
        after = transitionPurchaseOrder(before, {
          expectedVersion: p.expectedVersion,
          action: "Approve",
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
          approvalReference: p.approvalReference ?? null,
          buyerAuthorityDecisionReference: null,
          issueReference: null,
          reasonCode: null,
        });
      } else if (input.action === "Issue") {
        const policy = await ports.issuePolicy.validate({ command: input, purchaseOrder: before });
        if (
          policy.tenantReference !== input.tenantReference ||
          policy.brandReference !== input.brandReference ||
          policy.purchaseOrderReference !== before.purchaseOrderReference ||
          policy.purchaseOrderVersion !== before.aggregateVersion ||
          policy.revisionNumber !== before.pendingRevisionNumber ||
          policy.supplierReference !== before.supplierReference ||
          policy.buyerLegalEntityReference !== before.buyerLegalEntityReference ||
          policy.shipToStockSiteReference !== before.shipToStockSiteReference ||
          policy.shipToAddressSnapshotReference !== before.shipToAddressSnapshotReference ||
          policy.currency !== before.currency ||
          policy.approvalReference !== p.approvalReference ||
          !policy.supplierActive ||
          !policy.valid ||
          !Array.isArray(policy.blockers) ||
          policy.blockers.length > 0 ||
          at(policy.buyerAuthorityEffectiveAt) > input.occurredAt
        )
          return fail("PURCHASE_ORDER_ISSUE_BLOCKED");
        after = transitionPurchaseOrder(before, {
          expectedVersion: p.expectedVersion,
          action: "Issue",
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
          approvalReference: p.approvalReference ?? null,
          buyerAuthorityDecisionReference: policy.buyerAuthorityDecisionReference,
          issueReference: ports.references.generate("Issue"),
          reasonCode: null,
        });
      } else if (input.action === "RecordAcknowledgement" || input.action === "RecordDecline")
        after = recordSupplierPurchaseOrderResponse(before, {
          expectedVersion: p.expectedVersion,
          responseReference: ports.references.generate("SupplierResponse"),
          revisionNumber: p.revisionNumber ?? fail("PURCHASE_ORDER_INVALID"),
          response: input.action === "RecordAcknowledgement" ? "Acknowledged" : "Declined",
          reasonCode: p.reasonCode ?? null,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      else if (input.action === "CancelRemainder") {
        const lineReference = p.lineReference ?? fail("PURCHASE_ORDER_INVALID");
        const quantity = p.quantity ?? fail("PURCHASE_ORDER_INVALID");
        validateApproval(
          await ports.approval.validate({
            command: input,
            purchaseOrder: before,
            lineReference,
            quantity,
          }),
          input,
          before,
          lineReference,
          quantity,
        );
        after = cancelPurchaseOrderLineRemainder(before, {
          expectedVersion: p.expectedVersion,
          cancellationReference: ports.references.generate("Cancellation"),
          lineReference,
          quantity,
          reasonCode: p.reasonCode ?? fail("PURCHASE_ORDER_INVALID"),
          approvalReference: p.approvalReference ?? fail("PURCHASE_ORDER_INVALID"),
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      } else if (input.action === "Close") {
        const result = await ports.fulfillment.resolveForClose({
          command: input,
          purchaseOrder: before,
        });
        if (
          result.tenantReference !== input.tenantReference ||
          result.brandReference !== input.brandReference ||
          result.purchaseOrderReference !== before.purchaseOrderReference ||
          result.purchaseOrderVersion !== before.aggregateVersion
        )
          return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
        if (at(result.snapshot.sourceAsOfUtc) > input.occurredAt)
          return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
        after = closePurchaseOrder(before, {
          expectedVersion: p.expectedVersion,
          fulfillmentSnapshot: result.snapshot,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
        });
      } else
        after = transitionPurchaseOrder(before, {
          expectedVersion: p.expectedVersion,
          action: input.action,
          actorReference: input.actorReference,
          occurredAt: input.occurredAt,
          approvalReference: p.approvalReference ?? null,
          buyerAuthorityDecisionReference: null,
          issueReference: null,
          reasonCode: p.reasonCode ?? null,
        });
    }
    const audit = await ports.audit.create({ command: input, before, after });
    const record: PurchaseOrderCommandRecord = Object.freeze({
      operationReference: input.operationReference,
      intentHash: hash,
      action: input.action,
      command: input,
      purchaseOrder: after,
      audit,
      outcome: "Applied",
    });
    return await ports.repository.commit(record);
  } catch (error) {
    if (error instanceof PurchaseOrderServiceError) throw error;
    if (error instanceof PurchaseOrderError) return fail(error.code);
    return fail("PURCHASE_ORDER_DEPENDENCY_UNAVAILABLE");
  }
}
