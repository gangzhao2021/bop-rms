import { offeringReference, type OfferingReference } from "./offering.js";

export type PurchaseOrderReference = OfferingReference;
export type PurchaseOrderWorkflow =
  "Draft" | "Submitted" | "Approved" | "Issued" | "Acknowledged" | "SupplierDeclined" | "Cancelled";
export type PurchaseOrderFulfillment = "NotReceived" | "PartiallyReceived" | "FullyReceived";
export type PurchaseOrderRevisionLifecycle = "Draft" | "Submitted" | "Approved" | "Issued";
export interface PurchaseOrderLineSnapshot {
  readonly lineReference: PurchaseOrderReference;
  readonly inventoryItemReference: PurchaseOrderReference;
  readonly offeringReference: PurchaseOrderReference;
  readonly offeringVersionReference: PurchaseOrderReference;
  readonly priceRecordReference: PurchaseOrderReference;
  readonly priceVersionReference: PurchaseOrderReference;
  readonly requisitionAllocationReferences: readonly PurchaseOrderReference[];
  readonly inventoryItemName: string;
  readonly supplierItemCode: string;
  readonly supplierItemName: string;
  readonly purchaseUnit: string;
  readonly packQuantity: string;
  readonly baseUnit: string;
  readonly baseQuantity: string;
  readonly orderedQuantity: string;
  readonly unitCost: string;
  readonly currency: string;
  readonly discount: string;
  readonly lineTotal: string;
  readonly expectedDeliveryUtc: string;
  readonly commercialTermsReference: PurchaseOrderReference;
}
export interface PurchaseOrderRevision {
  readonly revisionReference: PurchaseOrderReference;
  readonly revisionNumber: number;
  readonly lifecycle: PurchaseOrderRevisionLifecycle;
  readonly reasonCode: string | null;
  readonly lines: readonly PurchaseOrderLineSnapshot[];
  readonly submittedBy: PurchaseOrderReference | null;
  readonly approverReference: PurchaseOrderReference | null;
  readonly approvalReference: PurchaseOrderReference | null;
  readonly buyerAuthorityDecisionReference: PurchaseOrderReference | null;
  readonly issueReference: PurchaseOrderReference | null;
  readonly issuedAt: string | null;
  readonly createdBy: PurchaseOrderReference;
  readonly createdAt: string;
}
export interface SupplierPurchaseOrderResponse {
  readonly responseReference: PurchaseOrderReference;
  readonly revisionNumber: number;
  readonly response: "Acknowledged" | "Declined";
  readonly reasonCode: string | null;
  readonly recordedBy: PurchaseOrderReference;
  readonly recordedAt: string;
}
export interface PurchaseOrderCancellation {
  readonly cancellationReference: PurchaseOrderReference;
  readonly lineReference: PurchaseOrderReference;
  readonly quantity: string;
  readonly reasonCode: string;
  readonly approvalReference: PurchaseOrderReference;
  readonly cancelledBy: PurchaseOrderReference;
  readonly cancelledAt: string;
}
export interface PurchaseOrderFulfillmentSnapshot {
  readonly snapshotReference: PurchaseOrderReference;
  readonly sourceAsOfUtc: string;
  readonly openDiscrepancyCount: number;
  readonly lineReceivedQuantities: readonly {
    readonly lineReference: PurchaseOrderReference;
    readonly receivedQuantity: string;
  }[];
}
export interface PurchaseOrder {
  readonly purchaseOrderReference: PurchaseOrderReference;
  readonly tenantReference: PurchaseOrderReference;
  readonly brandReference: PurchaseOrderReference;
  readonly supplierReference: PurchaseOrderReference;
  readonly buyerLegalEntityReference: PurchaseOrderReference;
  readonly shipToStockSiteReference: PurchaseOrderReference;
  readonly shipToAddressSnapshotReference: PurchaseOrderReference;
  readonly currency: string;
  readonly workflow: PurchaseOrderWorkflow;
  readonly fulfillmentStatus: PurchaseOrderFulfillment;
  readonly closureStatus: "Open" | "Closed";
  readonly aggregateVersion: number;
  readonly effectiveRevisionNumber: number | null;
  readonly pendingRevisionNumber: number | null;
  readonly revisions: readonly PurchaseOrderRevision[];
  readonly supplierResponses: readonly SupplierPurchaseOrderResponse[];
  readonly cancellations: readonly PurchaseOrderCancellation[];
  readonly fulfillmentSnapshots: readonly PurchaseOrderFulfillmentSnapshot[];
  readonly decisions: readonly {
    readonly action: string;
    readonly reasonCode: string | null;
    readonly actorReference: PurchaseOrderReference;
    readonly occurredAt: string;
  }[];
  readonly updatedBy: PurchaseOrderReference;
  readonly updatedAt: string;
}
export class PurchaseOrderError extends Error {
  constructor(
    readonly code:
      | "PURCHASE_ORDER_INVALID"
      | "PURCHASE_ORDER_STATE_CONFLICT"
      | "PURCHASE_ORDER_SEGREGATION_REQUIRED"
      | "PURCHASE_ORDER_AMOUNT_MISMATCH"
      | "PURCHASE_ORDER_OVER_CLOSED"
      | "PURCHASE_ORDER_CLOSE_BLOCKED",
  ) {
    super(code);
  }
}
const fail = (code: PurchaseOrderError["code"]): never => {
  throw new PurchaseOrderError(code);
};
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("PURCHASE_ORDER_INVALID");
  }
};
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("PURCHASE_ORDER_INVALID");
const code = (value: unknown, pattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u) =>
  typeof value === "string" && pattern.test(value) ? value : fail("PURCHASE_ORDER_INVALID");
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[<>{}\p{Cc}\p{Cf}]/u.test(value)
    ? value
    : fail("PURCHASE_ORDER_INVALID");
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const decimal = (value: unknown, positive = false) =>
  typeof value === "string" &&
  decimalPattern.test(value) &&
  (!positive || !/^0(?:\.0+)?$/u.test(value))
    ? value
    : fail("PURCHASE_ORDER_INVALID");
interface Decimal {
  readonly numerator: bigint;
  readonly scale: number;
}
function parts(value: string): Decimal {
  const parsed = decimal(value);
  const [whole, fraction = ""] = parsed.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), scale: fraction.length };
}
const pow = (scale: number) => 10n ** BigInt(scale);
function compare(left: Decimal, right: Decimal) {
  const scale = Math.max(left.scale, right.scale);
  const result =
    left.numerator * pow(scale - left.scale) - right.numerator * pow(scale - right.scale);
  return result < 0n ? -1 : result > 0n ? 1 : 0;
}
function add(values: readonly string[]) {
  const parsed = values.map(parts);
  const scale = Math.max(0, ...parsed.map((value) => value.scale));
  return {
    numerator: parsed.reduce(
      (total, value) => total + value.numerator * pow(scale - value.scale),
      0n,
    ),
    scale,
  };
}
function expectedTotal(quantity: string, unitCost: string, discount: string) {
  const q = parts(quantity);
  const cost = parts(unitCost);
  const reduction = parts(discount);
  const grossScale = q.scale + cost.scale;
  const scale = Math.max(grossScale, reduction.scale);
  const gross = q.numerator * cost.numerator * pow(scale - grossScale);
  const normalizedReduction = reduction.numerator * pow(scale - reduction.scale);
  if (normalizedReduction >= gross) return fail("PURCHASE_ORDER_AMOUNT_MISMATCH");
  return { numerator: gross - normalizedReduction, scale };
}
function line(input: PurchaseOrderLineSnapshot, currency: string): PurchaseOrderLineSnapshot {
  if (
    !Array.isArray(input.requisitionAllocationReferences) ||
    input.requisitionAllocationReferences.length > 200
  )
    return fail("PURCHASE_ORDER_INVALID");
  const allocations = Object.freeze(input.requisitionAllocationReferences.map(ref));
  if (new Set(allocations).size !== allocations.length) return fail("PURCHASE_ORDER_INVALID");
  const orderedQuantity = decimal(input.orderedQuantity, true);
  const unitCost = decimal(input.unitCost, true);
  const discount = decimal(input.discount);
  const lineTotal = decimal(input.lineTotal, true);
  if (
    input.currency !== currency ||
    compare(expectedTotal(orderedQuantity, unitCost, discount), parts(lineTotal)) !== 0
  )
    return fail("PURCHASE_ORDER_AMOUNT_MISMATCH");
  return Object.freeze({
    lineReference: ref(input.lineReference),
    inventoryItemReference: ref(input.inventoryItemReference),
    offeringReference: ref(input.offeringReference),
    offeringVersionReference: ref(input.offeringVersionReference),
    priceRecordReference: ref(input.priceRecordReference),
    priceVersionReference: ref(input.priceVersionReference),
    requisitionAllocationReferences: allocations,
    inventoryItemName: text(input.inventoryItemName),
    supplierItemCode: code(input.supplierItemCode),
    supplierItemName: text(input.supplierItemName),
    purchaseUnit: code(input.purchaseUnit),
    packQuantity: decimal(input.packQuantity, true),
    baseUnit: code(input.baseUnit),
    baseQuantity: decimal(input.baseQuantity, true),
    orderedQuantity,
    unitCost,
    currency: code(input.currency, /^[A-Z]{3}$/u),
    discount,
    lineTotal,
    expectedDeliveryUtc: instant(input.expectedDeliveryUtc),
    commercialTermsReference: ref(input.commercialTermsReference),
  });
}
function lines(input: readonly PurchaseOrderLineSnapshot[], currency: string) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 500)
    return fail("PURCHASE_ORDER_INVALID");
  const parsed = Object.freeze(input.map((entry) => line(entry, currency)));
  if (new Set(parsed.map((entry) => entry.lineReference)).size !== parsed.length)
    return fail("PURCHASE_ORDER_INVALID");
  return parsed;
}
function base(value: PurchaseOrder, actor: unknown, occurredAt: unknown) {
  return {
    ...value,
    aggregateVersion: value.aggregateVersion + 1,
    updatedBy: ref(actor),
    updatedAt: instant(occurredAt),
  };
}
function decision(
  value: PurchaseOrder,
  action: string,
  reasonCode: string | null,
  actor: PurchaseOrderReference,
  occurredAt: string,
) {
  return Object.freeze([
    ...value.decisions,
    Object.freeze({ action, reasonCode, actorReference: actor, occurredAt }),
  ]);
}
function revisionAt(value: PurchaseOrder, revisionNumber: number) {
  return (
    value.revisions.find((entry) => entry.revisionNumber === revisionNumber) ??
    fail("PURCHASE_ORDER_INVALID")
  );
}
export function createPurchaseOrder(input: {
  purchaseOrderReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  supplierReference: unknown;
  buyerLegalEntityReference: unknown;
  shipToStockSiteReference: unknown;
  shipToAddressSnapshotReference: unknown;
  currency: unknown;
  revisionReference: unknown;
  lines: readonly PurchaseOrderLineSnapshot[];
  actorReference: unknown;
  occurredAt: unknown;
}): PurchaseOrder {
  const currency = code(input.currency, /^[A-Z]{3}$/u);
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const revision: PurchaseOrderRevision = Object.freeze({
    revisionReference: ref(input.revisionReference),
    revisionNumber: 1,
    lifecycle: "Draft",
    reasonCode: null,
    lines: lines(input.lines, currency),
    submittedBy: null,
    approverReference: null,
    approvalReference: null,
    buyerAuthorityDecisionReference: null,
    issueReference: null,
    issuedAt: null,
    createdBy: actor,
    createdAt: occurredAt,
  });
  return Object.freeze({
    purchaseOrderReference: ref(input.purchaseOrderReference),
    tenantReference: ref(input.tenantReference),
    brandReference: ref(input.brandReference),
    supplierReference: ref(input.supplierReference),
    buyerLegalEntityReference: ref(input.buyerLegalEntityReference),
    shipToStockSiteReference: ref(input.shipToStockSiteReference),
    shipToAddressSnapshotReference: ref(input.shipToAddressSnapshotReference),
    currency,
    workflow: "Draft",
    fulfillmentStatus: "NotReceived",
    closureStatus: "Open",
    aggregateVersion: 1,
    effectiveRevisionNumber: null,
    pendingRevisionNumber: 1,
    revisions: Object.freeze([revision]),
    supplierResponses: Object.freeze([]),
    cancellations: Object.freeze([]),
    fulfillmentSnapshots: Object.freeze([]),
    decisions: Object.freeze([
      { action: "Created", reasonCode: null, actorReference: actor, occurredAt },
    ]),
    updatedBy: actor,
    updatedAt: occurredAt,
  });
}
export function revisePurchaseOrder(
  value: PurchaseOrder,
  input: {
    expectedVersion: number;
    revisionReference: unknown;
    reasonCode: unknown;
    lines: readonly PurchaseOrderLineSnapshot[];
    actorReference: unknown;
    occurredAt: unknown;
  },
): PurchaseOrder {
  if (value.aggregateVersion !== input.expectedVersion || value.closureStatus === "Closed")
    return fail("PURCHASE_ORDER_STATE_CONFLICT");
  const pending =
    value.pendingRevisionNumber === null ? null : revisionAt(value, value.pendingRevisionNumber);
  const postIssue = value.effectiveRevisionNumber !== null;
  if (
    (!pending && !postIssue) ||
    (!pending && !["Issued", "Acknowledged", "SupplierDeclined"].includes(value.workflow))
  )
    return fail("PURCHASE_ORDER_STATE_CONFLICT");
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const reason = postIssue
    ? code(input.reasonCode)
    : input.reasonCode === null
      ? null
      : code(input.reasonCode);
  if (postIssue && reason === null) return fail("PURCHASE_ORDER_INVALID");
  const revisionNumber = value.revisions.length + 1;
  const revision: PurchaseOrderRevision = Object.freeze({
    revisionReference: ref(input.revisionReference),
    revisionNumber,
    lifecycle: "Draft",
    reasonCode: reason,
    lines: lines(input.lines, value.currency),
    submittedBy: null,
    approverReference: null,
    approvalReference: null,
    buyerAuthorityDecisionReference: null,
    issueReference: null,
    issuedAt: null,
    createdBy: actor,
    createdAt: occurredAt,
  });
  const changed = base(value, actor, occurredAt);
  return Object.freeze({
    ...changed,
    workflow: postIssue ? value.workflow : "Draft",
    pendingRevisionNumber: revisionNumber,
    revisions: Object.freeze([...value.revisions, revision]),
    decisions: decision(
      value,
      postIssue ? "RevisionCreated" : "DraftRevised",
      reason,
      actor,
      occurredAt,
    ),
  });
}
export function transitionPurchaseOrder(
  value: PurchaseOrder,
  input: {
    expectedVersion: number;
    action: "Submit" | "Approve" | "Issue" | "Cancel";
    actorReference: unknown;
    occurredAt: unknown;
    approvalReference: unknown | null;
    buyerAuthorityDecisionReference: unknown | null;
    issueReference: unknown | null;
    reasonCode: unknown | null;
  },
): PurchaseOrder {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.closureStatus === "Closed" ||
    value.pendingRevisionNumber === null
  )
    return fail("PURCHASE_ORDER_STATE_CONFLICT");
  const pending = revisionAt(value, value.pendingRevisionNumber);
  const expected = {
    Submit: "Draft",
    Approve: "Submitted",
    Issue: "Approved",
    Cancel: pending.lifecycle,
  } as const;
  if (input.action !== "Cancel" && pending.lifecycle !== expected[input.action])
    return fail("PURCHASE_ORDER_STATE_CONFLICT");
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  if (input.action === "Approve" && actor === pending.submittedBy)
    return fail("PURCHASE_ORDER_SEGREGATION_REQUIRED");
  const approval = input.approvalReference === null ? null : ref(input.approvalReference);
  const authority =
    input.buyerAuthorityDecisionReference === null
      ? null
      : ref(input.buyerAuthorityDecisionReference);
  const issueReference = input.issueReference === null ? null : ref(input.issueReference);
  const reason = input.reasonCode === null ? null : code(input.reasonCode);
  if (input.action === "Approve" && approval === null) return fail("PURCHASE_ORDER_INVALID");
  if (
    input.action === "Issue" &&
    (authority === null || issueReference === null || approval !== pending.approvalReference)
  )
    return fail("PURCHASE_ORDER_INVALID");
  if (input.action === "Cancel" && reason === null) return fail("PURCHASE_ORDER_INVALID");
  if (input.action === "Cancel") {
    const changed = base(value, actor, occurredAt);
    return Object.freeze({
      ...changed,
      workflow: "Cancelled",
      closureStatus: "Closed",
      pendingRevisionNumber: null,
      decisions: decision(value, "Cancelled", reason, actor, occurredAt),
    });
  }
  const lifecycle = { Submit: "Submitted", Approve: "Approved", Issue: "Issued" }[
    input.action
  ] as PurchaseOrderRevisionLifecycle;
  const revised = Object.freeze({
    ...pending,
    lifecycle,
    submittedBy: input.action === "Submit" ? actor : pending.submittedBy,
    approverReference: input.action === "Approve" ? actor : pending.approverReference,
    approvalReference: input.action === "Approve" ? approval : pending.approvalReference,
    buyerAuthorityDecisionReference:
      input.action === "Issue" ? authority : pending.buyerAuthorityDecisionReference,
    issueReference: input.action === "Issue" ? issueReference : pending.issueReference,
    issuedAt: input.action === "Issue" ? occurredAt : pending.issuedAt,
  });
  const revisions = value.revisions.map((entry) =>
    entry.revisionNumber === pending.revisionNumber ? revised : entry,
  );
  const changed = base(value, actor, occurredAt);
  const isIssue = input.action === "Issue";
  return Object.freeze({
    ...changed,
    workflow: value.effectiveRevisionNumber === null || isIssue ? lifecycle : value.workflow,
    effectiveRevisionNumber: isIssue ? pending.revisionNumber : value.effectiveRevisionNumber,
    pendingRevisionNumber: isIssue ? null : pending.revisionNumber,
    revisions: Object.freeze(revisions),
    decisions: decision(
      value,
      value.effectiveRevisionNumber === null ? input.action : `Revision${input.action}`,
      reason,
      actor,
      occurredAt,
    ),
  });
}
export function recordSupplierPurchaseOrderResponse(
  value: PurchaseOrder,
  input: {
    expectedVersion: number;
    responseReference: unknown;
    revisionNumber: number;
    response: "Acknowledged" | "Declined";
    reasonCode: unknown | null;
    actorReference: unknown;
    occurredAt: unknown;
  },
): PurchaseOrder {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.closureStatus === "Closed" ||
    value.effectiveRevisionNumber !== input.revisionNumber ||
    !["Issued", "Acknowledged"].includes(value.workflow) ||
    value.supplierResponses.some((entry) => entry.revisionNumber === input.revisionNumber)
  )
    return fail("PURCHASE_ORDER_STATE_CONFLICT");
  if (
    !Number.isSafeInteger(input.revisionNumber) ||
    input.revisionNumber < 1 ||
    !["Acknowledged", "Declined"].includes(input.response)
  )
    return fail("PURCHASE_ORDER_INVALID");
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const reason = input.reasonCode === null ? null : code(input.reasonCode);
  if (input.response === "Declined" && reason === null) return fail("PURCHASE_ORDER_INVALID");
  const response = Object.freeze({
    responseReference: ref(input.responseReference),
    revisionNumber: input.revisionNumber,
    response: input.response,
    reasonCode: reason,
    recordedBy: actor,
    recordedAt: occurredAt,
  });
  const changed = base(value, actor, occurredAt);
  return Object.freeze({
    ...changed,
    workflow: input.response === "Acknowledged" ? "Acknowledged" : "SupplierDeclined",
    supplierResponses: Object.freeze([...value.supplierResponses, response]),
    decisions: decision(value, input.response, reason, actor, occurredAt),
  });
}
function effectiveLines(value: PurchaseOrder) {
  return value.effectiveRevisionNumber === null
    ? []
    : revisionAt(value, value.effectiveRevisionNumber).lines;
}
function received(value: PurchaseOrder, lineReference: PurchaseOrderReference) {
  return (
    value.fulfillmentSnapshots
      .at(-1)
      ?.lineReceivedQuantities.find((entry) => entry.lineReference === lineReference)
      ?.receivedQuantity ?? "0"
  );
}
function cancelled(value: PurchaseOrder, lineReference: PurchaseOrderReference) {
  return add(
    value.cancellations
      .filter((entry) => entry.lineReference === lineReference)
      .map((entry) => entry.quantity),
  );
}
export function cancelPurchaseOrderLineRemainder(
  value: PurchaseOrder,
  input: {
    expectedVersion: number;
    cancellationReference: unknown;
    lineReference: unknown;
    quantity: unknown;
    reasonCode: unknown;
    approvalReference: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): PurchaseOrder {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.closureStatus === "Closed" ||
    value.effectiveRevisionNumber === null ||
    !["Issued", "Acknowledged", "SupplierDeclined"].includes(value.workflow)
  )
    return fail("PURCHASE_ORDER_STATE_CONFLICT");
  const lineReference = ref(input.lineReference);
  const target = effectiveLines(value).find((entry) => entry.lineReference === lineReference);
  if (!target) return fail("PURCHASE_ORDER_INVALID");
  const quantity = decimal(input.quantity, true);
  const total = add([received(value, lineReference), quantity]);
  const prior = cancelled(value, lineReference);
  const combined = {
    numerator:
      total.numerator * pow(Math.max(total.scale, prior.scale) - total.scale) +
      prior.numerator * pow(Math.max(total.scale, prior.scale) - prior.scale),
    scale: Math.max(total.scale, prior.scale),
  };
  if (compare(combined, parts(target.orderedQuantity)) > 0)
    return fail("PURCHASE_ORDER_OVER_CLOSED");
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const cancellation = Object.freeze({
    cancellationReference: ref(input.cancellationReference),
    lineReference,
    quantity,
    reasonCode: code(input.reasonCode),
    approvalReference: ref(input.approvalReference),
    cancelledBy: actor,
    cancelledAt: occurredAt,
  });
  if (
    value.cancellations.some(
      (entry) => entry.cancellationReference === cancellation.cancellationReference,
    )
  )
    return fail("PURCHASE_ORDER_INVALID");
  const changed = base(value, actor, occurredAt);
  return Object.freeze({
    ...changed,
    cancellations: Object.freeze([...value.cancellations, cancellation]),
    decisions: decision(value, "RemainderCancelled", cancellation.reasonCode, actor, occurredAt),
  });
}
export function closePurchaseOrder(
  value: PurchaseOrder,
  input: {
    expectedVersion: number;
    fulfillmentSnapshot: PurchaseOrderFulfillmentSnapshot;
    actorReference: unknown;
    occurredAt: unknown;
  },
): PurchaseOrder {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.closureStatus === "Closed" ||
    value.effectiveRevisionNumber === null ||
    value.pendingRevisionNumber !== null ||
    !["Issued", "Acknowledged", "SupplierDeclined"].includes(value.workflow)
  )
    return fail("PURCHASE_ORDER_STATE_CONFLICT");
  const snapshot = input.fulfillmentSnapshot;
  if (
    !Number.isSafeInteger(snapshot.openDiscrepancyCount) ||
    snapshot.openDiscrepancyCount < 0 ||
    !Array.isArray(snapshot.lineReceivedQuantities)
  )
    return fail("PURCHASE_ORDER_INVALID");
  const source = Object.freeze({
    snapshotReference: ref(snapshot.snapshotReference),
    sourceAsOfUtc: instant(snapshot.sourceAsOfUtc),
    openDiscrepancyCount: snapshot.openDiscrepancyCount,
    lineReceivedQuantities: Object.freeze(
      snapshot.lineReceivedQuantities.map((entry) =>
        Object.freeze({
          lineReference: ref(entry.lineReference),
          receivedQuantity: decimal(entry.receivedQuantity),
        }),
      ),
    ),
  });
  if (
    value.fulfillmentSnapshots.some((entry) => entry.snapshotReference === source.snapshotReference)
  )
    return fail("PURCHASE_ORDER_INVALID");
  const active = effectiveLines(value);
  if (
    source.lineReceivedQuantities.length !== active.length ||
    new Set(source.lineReceivedQuantities.map((entry) => entry.lineReference)).size !==
      active.length ||
    source.openDiscrepancyCount > 0
  )
    return fail("PURCHASE_ORDER_CLOSE_BLOCKED");
  let receivedCount = 0;
  for (const item of active) {
    const receivedQuantity =
      source.lineReceivedQuantities.find((entry) => entry.lineReference === item.lineReference)
        ?.receivedQuantity ?? fail("PURCHASE_ORDER_CLOSE_BLOCKED");
    const receivedPart = parts(receivedQuantity);
    if (receivedPart.numerator > 0n) receivedCount += 1;
    const cancelledPart = cancelled(value, item.lineReference);
    const scale = Math.max(receivedPart.scale, cancelledPart.scale);
    const covered = {
      numerator:
        receivedPart.numerator * pow(scale - receivedPart.scale) +
        cancelledPart.numerator * pow(scale - cancelledPart.scale),
      scale,
    };
    if (compare(covered, parts(item.orderedQuantity)) !== 0)
      return fail("PURCHASE_ORDER_CLOSE_BLOCKED");
  }
  const fulfillmentStatus: PurchaseOrderFulfillment =
    receivedCount === 0
      ? "NotReceived"
      : active.every(
            (item) =>
              compare(
                parts(
                  source.lineReceivedQuantities.find(
                    (entry) => entry.lineReference === item.lineReference,
                  )?.receivedQuantity ?? "0",
                ),
                parts(item.orderedQuantity),
              ) === 0,
          )
        ? "FullyReceived"
        : "PartiallyReceived";
  const actor = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const changed = base(value, actor, occurredAt);
  return Object.freeze({
    ...changed,
    fulfillmentStatus,
    closureStatus: "Closed",
    fulfillmentSnapshots: Object.freeze([...value.fulfillmentSnapshots, source]),
    decisions: decision(value, "Closed", null, actor, occurredAt),
  });
}
