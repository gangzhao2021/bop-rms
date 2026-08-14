import { positiveDecimal, offeringReference, type OfferingReference } from "./offering.js";

export type RequisitionReference = OfferingReference;
export type RequisitionWorkflow =
  "Draft" | "Submitted" | "InReview" | "Approved" | "Rejected" | "Cancelled";
export type AllocationStatus = "NotAllocated" | "PartiallyAllocated" | "FullyAllocated";
export interface RequisitionAllocation {
  readonly allocationReference: RequisitionReference;
  readonly purchaseOrderDraftReference: RequisitionReference;
  readonly purchaseOrderDraftLineReference: RequisitionReference;
  readonly offeringReference: RequisitionReference;
  readonly offeringVersionReference: RequisitionReference;
  readonly priceRecordReference: RequisitionReference;
  readonly priceVersionReference: RequisitionReference;
  readonly quantity: string;
  readonly allocatedBy: RequisitionReference;
  readonly allocatedAt: string;
}
export interface RequisitionCancellation {
  readonly cancellationReference: RequisitionReference;
  readonly quantity: string;
  readonly reasonCode: string;
  readonly approvalReference: RequisitionReference;
  readonly cancelledBy: RequisitionReference;
  readonly cancelledAt: string;
}
export interface RequisitionLine {
  readonly lineReference: RequisitionReference;
  readonly inventoryItemReference: RequisitionReference;
  readonly requestedQuantity: string;
  readonly requestedUnit: string;
  readonly requiredByUtc: string;
  readonly needSourceReferences: readonly RequisitionReference[];
  readonly allocations: readonly RequisitionAllocation[];
  readonly cancellations: readonly RequisitionCancellation[];
}
export interface PurchaseRequisition {
  readonly requisitionReference: RequisitionReference;
  readonly tenantReference: RequisitionReference;
  readonly brandReference: RequisitionReference;
  readonly requestingScopeKind: "Store" | "OperatingEntity";
  readonly requestingScopeReference: RequisitionReference;
  readonly requesterReference: RequisitionReference;
  readonly urgency: "Routine" | "Urgent" | "Emergency";
  readonly workflow: RequisitionWorkflow;
  readonly allocationStatus: AllocationStatus;
  readonly closureStatus: "Open" | "Closed";
  readonly aggregateVersion: number;
  readonly lines: readonly RequisitionLine[];
  readonly submittedBy: RequisitionReference | null;
  readonly approverReference: RequisitionReference | null;
  readonly approvalReference: RequisitionReference | null;
  readonly decisions: readonly {
    readonly action: string;
    readonly reasonCode: string | null;
    readonly actorReference: RequisitionReference;
    readonly occurredAt: string;
  }[];
  readonly updatedBy: RequisitionReference;
  readonly updatedAt: string;
}
export class RequisitionError extends Error {
  constructor(
    readonly code:
      | "REQUISITION_INVALID"
      | "REQUISITION_STATE_CONFLICT"
      | "REQUISITION_SEGREGATION_REQUIRED"
      | "REQUISITION_OVER_ALLOCATED",
  ) {
    super(code);
  }
}
const fail = (code: RequisitionError["code"]): never => {
  throw new RequisitionError(code);
};
const codePattern = /^[A-Z0-9][A-Z0-9._-]{0,63}$/u;
const utc = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail("REQUISITION_INVALID");
const code = (value: unknown) =>
  typeof value === "string" && codePattern.test(value) ? value : fail("REQUISITION_INVALID");
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("REQUISITION_INVALID");
  }
};
interface Decimal {
  readonly numerator: bigint;
  readonly scale: number;
}
function parts(value: string): Decimal {
  const parsed = positiveDecimal(value);
  const [whole, fraction = ""] = parsed.split(".");
  return { numerator: BigInt(`${whole}${fraction}`), scale: fraction.length };
}
const pow = (scale: number) => 10n ** BigInt(scale);
function compare(left: string, right: string) {
  const l = parts(left);
  const r = parts(right);
  const scale = Math.max(l.scale, r.scale);
  const diff = l.numerator * pow(scale - l.scale) - r.numerator * pow(scale - r.scale);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}
function sum(values: readonly string[]): Decimal {
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
function compareSum(values: readonly string[], target: string) {
  const total = sum(values);
  const right = parts(target);
  const scale = Math.max(total.scale, right.scale);
  const diff =
    total.numerator * pow(scale - total.scale) - right.numerator * pow(scale - right.scale);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}
function line(input: Omit<RequisitionLine, "allocations" | "cancellations">): RequisitionLine {
  if (!Array.isArray(input.needSourceReferences) || input.needSourceReferences.length > 100)
    return fail("REQUISITION_INVALID");
  const sources = Object.freeze(input.needSourceReferences.map(ref));
  if (new Set(sources).size !== sources.length) return fail("REQUISITION_INVALID");
  return Object.freeze({
    lineReference: ref(input.lineReference),
    inventoryItemReference: ref(input.inventoryItemReference),
    requestedQuantity: positiveDecimal(input.requestedQuantity),
    requestedUnit: code(input.requestedUnit),
    requiredByUtc: utc(input.requiredByUtc),
    needSourceReferences: sources,
    allocations: Object.freeze([]),
    cancellations: Object.freeze([]),
  });
}
function statuses(lines: readonly RequisitionLine[]) {
  let covered = 0;
  for (const item of lines) {
    const relation = compareSum(
      [
        ...item.allocations.map((value) => value.quantity),
        ...item.cancellations.map((value) => value.quantity),
      ],
      item.requestedQuantity,
    );
    if (relation > 0) return fail("REQUISITION_OVER_ALLOCATED");
    if (relation === 0) covered += 1;
  }
  const allocationStatus: AllocationStatus = lines.every((item) => item.allocations.length === 0)
    ? "NotAllocated"
    : lines.every(
          (item) =>
            compareSum(
              item.allocations.map((value) => value.quantity),
              item.requestedQuantity,
            ) === 0,
        )
      ? "FullyAllocated"
      : "PartiallyAllocated";
  return {
    allocationStatus,
    closureStatus: covered === lines.length ? ("Closed" as const) : ("Open" as const),
  };
}
function base(value: PurchaseRequisition, actor: unknown, occurredAt: unknown) {
  return {
    ...value,
    aggregateVersion: value.aggregateVersion + 1,
    updatedBy: ref(actor),
    updatedAt: utc(occurredAt),
  };
}
export function createRequisition(
  input: Omit<
    PurchaseRequisition,
    | "workflow"
    | "allocationStatus"
    | "closureStatus"
    | "aggregateVersion"
    | "submittedBy"
    | "approverReference"
    | "approvalReference"
    | "decisions"
    | "updatedBy"
    | "updatedAt"
    | "lines"
  > & {
    lines: readonly Omit<RequisitionLine, "allocations" | "cancellations">[];
    actorReference: unknown;
    occurredAt: unknown;
  },
): PurchaseRequisition {
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 200)
    return fail("REQUISITION_INVALID");
  if (
    !["Store", "OperatingEntity"].includes(input.requestingScopeKind) ||
    !["Routine", "Urgent", "Emergency"].includes(input.urgency)
  )
    return fail("REQUISITION_INVALID");
  const lines = Object.freeze(input.lines.map(line));
  if (new Set(lines.map((item) => item.lineReference)).size !== lines.length)
    return fail("REQUISITION_INVALID");
  const actor = ref(input.actorReference);
  const occurredAt = utc(input.occurredAt);
  return Object.freeze({
    requisitionReference: ref(input.requisitionReference),
    tenantReference: ref(input.tenantReference),
    brandReference: ref(input.brandReference),
    requestingScopeKind: input.requestingScopeKind,
    requestingScopeReference: ref(input.requestingScopeReference),
    requesterReference: ref(input.requesterReference),
    urgency: input.urgency,
    workflow: "Draft",
    allocationStatus: "NotAllocated",
    closureStatus: "Open",
    aggregateVersion: 1,
    lines,
    submittedBy: null,
    approverReference: null,
    approvalReference: null,
    decisions: Object.freeze([
      { action: "Created", reasonCode: null, actorReference: actor, occurredAt },
    ]),
    updatedBy: actor,
    updatedAt: occurredAt,
  });
}
export function reviseRequisitionDraft(
  value: PurchaseRequisition,
  input: {
    expectedVersion: number;
    urgency: PurchaseRequisition["urgency"];
    lines: readonly Omit<RequisitionLine, "allocations" | "cancellations">[];
    actorReference: unknown;
    occurredAt: unknown;
  },
): PurchaseRequisition {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.workflow !== "Draft" ||
    value.closureStatus !== "Open"
  )
    return fail("REQUISITION_STATE_CONFLICT");
  if (
    !Array.isArray(input.lines) ||
    input.lines.length < 1 ||
    input.lines.length > 200 ||
    !["Routine", "Urgent", "Emergency"].includes(input.urgency)
  )
    return fail("REQUISITION_INVALID");
  const lines = Object.freeze(input.lines.map(line));
  if (new Set(lines.map((item) => item.lineReference)).size !== lines.length)
    return fail("REQUISITION_INVALID");
  const changed = base(value, input.actorReference, input.occurredAt);
  return Object.freeze({
    ...changed,
    urgency: input.urgency,
    lines,
    allocationStatus: "NotAllocated",
    closureStatus: "Open",
    decisions: Object.freeze([
      ...value.decisions,
      Object.freeze({
        action: "Revised",
        reasonCode: null,
        actorReference: changed.updatedBy,
        occurredAt: changed.updatedAt,
      }),
    ]),
  });
}
export function transitionRequisition(
  value: PurchaseRequisition,
  input: {
    expectedVersion: number;
    action: "Submit" | "StartReview" | "Approve" | "Reject" | "Cancel";
    actorReference: unknown;
    occurredAt: unknown;
    approvalReference: unknown | null;
    reasonCode: unknown | null;
  },
): PurchaseRequisition {
  if (value.aggregateVersion !== input.expectedVersion || value.closureStatus === "Closed")
    return fail("REQUISITION_STATE_CONFLICT");
  const allowed: Record<typeof input.action, RequisitionWorkflow[]> = {
    Submit: ["Draft"],
    StartReview: ["Submitted"],
    Approve: ["InReview"],
    Reject: ["InReview"],
    Cancel: ["Draft", "Submitted", "InReview"],
  };
  if (!allowed[input.action].includes(value.workflow)) return fail("REQUISITION_STATE_CONFLICT");
  const actor = ref(input.actorReference);
  if (
    input.action === "Approve" &&
    (actor === value.requesterReference || actor === value.submittedBy)
  )
    return fail("REQUISITION_SEGREGATION_REQUIRED");
  const approval = input.approvalReference === null ? null : ref(input.approvalReference);
  const reason = input.reasonCode === null ? null : code(input.reasonCode);
  if (input.action === "Approve" && approval === null) return fail("REQUISITION_INVALID");
  if (["Reject", "Cancel"].includes(input.action) && reason === null)
    return fail("REQUISITION_INVALID");
  const workflow = {
    Submit: "Submitted",
    StartReview: "InReview",
    Approve: "Approved",
    Reject: "Rejected",
    Cancel: "Cancelled",
  }[input.action] as RequisitionWorkflow;
  const changed = base(value, actor, input.occurredAt);
  return Object.freeze({
    ...changed,
    workflow,
    closureStatus: ["Rejected", "Cancelled"].includes(workflow) ? "Closed" : value.closureStatus,
    submittedBy: input.action === "Submit" ? actor : value.submittedBy,
    approverReference: input.action === "Approve" ? actor : value.approverReference,
    approvalReference: input.action === "Approve" ? approval : value.approvalReference,
    decisions: Object.freeze([
      ...value.decisions,
      Object.freeze({
        action: input.action,
        reasonCode: reason,
        actorReference: actor,
        occurredAt: changed.updatedAt,
      }),
    ]),
  });
}
export function allocateRequisitionLine(
  value: PurchaseRequisition,
  input: { expectedVersion: number; lineReference: unknown; allocation: RequisitionAllocation },
): PurchaseRequisition {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.workflow !== "Approved" ||
    value.closureStatus === "Closed"
  )
    return fail("REQUISITION_STATE_CONFLICT");
  const lineReference = ref(input.lineReference);
  const target = value.lines.find((item) => item.lineReference === lineReference);
  if (!target) return fail("REQUISITION_INVALID");
  const allocation = Object.freeze({
    allocationReference: ref(input.allocation.allocationReference),
    purchaseOrderDraftReference: ref(input.allocation.purchaseOrderDraftReference),
    purchaseOrderDraftLineReference: ref(input.allocation.purchaseOrderDraftLineReference),
    offeringReference: ref(input.allocation.offeringReference),
    offeringVersionReference: ref(input.allocation.offeringVersionReference),
    priceRecordReference: ref(input.allocation.priceRecordReference),
    priceVersionReference: ref(input.allocation.priceVersionReference),
    quantity: positiveDecimal(input.allocation.quantity),
    allocatedBy: ref(input.allocation.allocatedBy),
    allocatedAt: utc(input.allocation.allocatedAt),
  });
  if (
    value.lines.some((item) =>
      item.allocations.some(
        (entry) => entry.allocationReference === allocation.allocationReference,
      ),
    )
  )
    return fail("REQUISITION_INVALID");
  const lines = value.lines.map((item) =>
    item.lineReference === lineReference
      ? Object.freeze({ ...item, allocations: Object.freeze([...item.allocations, allocation]) })
      : item,
  );
  const next = statuses(lines);
  const changed = base(value, allocation.allocatedBy, allocation.allocatedAt);
  return Object.freeze({
    ...changed,
    ...next,
    lines: Object.freeze(lines),
    decisions: Object.freeze([
      ...value.decisions,
      Object.freeze({
        action: "Allocated",
        reasonCode: null,
        actorReference: allocation.allocatedBy,
        occurredAt: allocation.allocatedAt,
      }),
    ]),
  });
}
export function assertRequisitionLineCapacity(
  value: PurchaseRequisition,
  input: { expectedVersion: number; lineReference: unknown; quantity: unknown },
): void {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.workflow !== "Approved" ||
    value.closureStatus === "Closed"
  )
    return fail("REQUISITION_STATE_CONFLICT");
  const lineReference = ref(input.lineReference);
  const target = value.lines.find((item) => item.lineReference === lineReference);
  if (!target) return fail("REQUISITION_INVALID");
  const quantity = positiveDecimal(input.quantity);
  if (
    compareSum(
      [
        ...target.allocations.map((entry) => entry.quantity),
        ...target.cancellations.map((entry) => entry.quantity),
        quantity,
      ],
      target.requestedQuantity,
    ) > 0
  )
    return fail("REQUISITION_OVER_ALLOCATED");
}
export function assertRequisitionLineRemainder(
  value: PurchaseRequisition,
  input: { expectedVersion: number; lineReference: unknown; quantity: unknown },
): void {
  assertRequisitionLineCapacity(value, input);
  const target = value.lines.find((item) => item.lineReference === ref(input.lineReference));
  if (!target) return fail("REQUISITION_INVALID");
  if (
    compareSum(
      [
        ...target.allocations.map((entry) => entry.quantity),
        ...target.cancellations.map((entry) => entry.quantity),
        positiveDecimal(input.quantity),
      ],
      target.requestedQuantity,
    ) !== 0
  )
    return fail("REQUISITION_INVALID");
}
export function cancelRequisitionRemainder(
  value: PurchaseRequisition,
  input: { expectedVersion: number; lineReference: unknown; cancellation: RequisitionCancellation },
): PurchaseRequisition {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    value.workflow !== "Approved" ||
    value.closureStatus === "Closed"
  )
    return fail("REQUISITION_STATE_CONFLICT");
  const lineReference = ref(input.lineReference);
  if (!value.lines.some((item) => item.lineReference === lineReference))
    return fail("REQUISITION_INVALID");
  const cancellation = Object.freeze({
    cancellationReference: ref(input.cancellation.cancellationReference),
    quantity: positiveDecimal(input.cancellation.quantity),
    reasonCode: code(input.cancellation.reasonCode),
    approvalReference: ref(input.cancellation.approvalReference),
    cancelledBy: ref(input.cancellation.cancelledBy),
    cancelledAt: utc(input.cancellation.cancelledAt),
  });
  if (
    value.lines.some((item) =>
      item.cancellations.some(
        (entry) => entry.cancellationReference === cancellation.cancellationReference,
      ),
    )
  )
    return fail("REQUISITION_INVALID");
  const lines = value.lines.map((item) =>
    item.lineReference === lineReference
      ? Object.freeze({
          ...item,
          cancellations: Object.freeze([...item.cancellations, cancellation]),
        })
      : item,
  );
  const next = statuses(lines);
  const changed = base(value, cancellation.cancelledBy, cancellation.cancelledAt);
  return Object.freeze({
    ...changed,
    ...next,
    lines: Object.freeze(lines),
    decisions: Object.freeze([
      ...value.decisions,
      Object.freeze({
        action: "RemainderCancelled",
        reasonCode: cancellation.reasonCode,
        actorReference: cancellation.cancelledBy,
        occurredAt: cancellation.cancelledAt,
      }),
    ]),
  });
}
export const compareRequisitionQuantity = compare;
