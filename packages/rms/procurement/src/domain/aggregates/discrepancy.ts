import { offeringReference, type OfferingReference } from "./offering.js";

export type DiscrepancyDecimal = string & { readonly __discrepancyDecimal: unique symbol };
export type DiscrepancyInstant = string & { readonly __discrepancyInstant: unique symbol };

export type DiscrepancyType = "Short" | "Over" | "Rejected" | "Damaged" | "Quality";
export type DiscrepancyStatus =
  "Open" | "Acknowledged" | "InReview" | "ResolutionPending" | "Resolved" | "Closed";
export type DiscrepancyResolution =
  "AcceptedWithinPolicy" | "CorrectionRequested" | "ReplacementRequested" | "RemainderWaived";
export interface DiscrepancyDecision {
  readonly decisionReference: OfferingReference;
  readonly action:
    "Acknowledged" | "Assigned" | "SupplierContactRecorded" | "ResolutionRecorded" | "Closed";
  readonly actorReference: OfferingReference;
  readonly occurredAt: DiscrepancyInstant;
  readonly reasonCode: string | null;
  readonly ownerReference: OfferingReference | null;
  readonly supplierContactOutcome:
    | "Acknowledged"
    | "Disputed"
    | "CorrectionPromised"
    | "ReplacementPromised"
    | "NoResponse"
    | null;
  readonly resolution: DiscrepancyResolution | null;
  readonly outcomeReference: OfferingReference | null;
}
export interface SupplierDiscrepancy {
  readonly discrepancyReference: OfferingReference;
  readonly tenantReference: OfferingReference;
  readonly brandReference: OfferingReference;
  readonly stockSiteReference: OfferingReference;
  readonly supplierReference: OfferingReference;
  readonly purchaseOrderReference: OfferingReference;
  readonly purchaseOrderLineReference: OfferingReference;
  readonly goodsReceiptReference: OfferingReference;
  readonly receiptLineReference: OfferingReference;
  readonly sourceEventReference: OfferingReference;
  readonly type: DiscrepancyType;
  readonly orderedQuantity: DiscrepancyDecimal;
  readonly priorAcceptedQuantity: DiscrepancyDecimal;
  readonly acceptedQuantity: DiscrepancyDecimal;
  readonly rejectedQuantity: DiscrepancyDecimal;
  readonly damagedQuantity: DiscrepancyDecimal;
  readonly varianceQuantity: DiscrepancyDecimal;
  readonly unit: string;
  readonly toleranceQuantity: DiscrepancyDecimal;
  readonly withinTolerance: boolean;
  readonly status: DiscrepancyStatus;
  readonly ownerReference: OfferingReference | null;
  readonly resolution: DiscrepancyResolution | null;
  readonly resolutionOutcomeReference: OfferingReference | null;
  readonly aggregateVersion: number;
  readonly decisions: readonly DiscrepancyDecision[];
  readonly createdAt: DiscrepancyInstant;
  readonly updatedAt: DiscrepancyInstant;
}
export class DiscrepancyError extends Error {
  constructor(
    readonly code:
      | "DISCREPANCY_INVALID"
      | "DISCREPANCY_STATE_CONFLICT"
      | "DISCREPANCY_POLICY_BLOCKED"
      | "DISCREPANCY_APPROVAL_REQUIRED"
      | "DISCREPANCY_CLOSE_BLOCKED",
  ) {
    super(code);
  }
}
const fail = (code: DiscrepancyError["code"]): never => {
  throw new DiscrepancyError(code);
};
const ref = (value: unknown) => {
  try {
    return offeringReference(value);
  } catch {
    return fail("DISCREPANCY_INVALID");
  }
};
const decimal = (value: unknown) => {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)
    ? (value as DiscrepancyDecimal)
    : fail("DISCREPANCY_INVALID");
};
const instant = (value: unknown) => {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
    ? (value as DiscrepancyInstant)
    : fail("DISCREPANCY_INVALID");
};
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(value)
    ? value
    : fail("DISCREPANCY_INVALID");
const positive = (value: DiscrepancyDecimal) => !/^0(?:\.0+)?$/u.test(value);
const decision = (
  value: SupplierDiscrepancy,
  input: Omit<DiscrepancyDecision, "actorReference" | "occurredAt"> & {
    actorReference: unknown;
    occurredAt: unknown;
  },
  patch: Partial<SupplierDiscrepancy>,
): SupplierDiscrepancy => {
  const occurredAt = instant(input.occurredAt);
  if (occurredAt < value.updatedAt) return fail("DISCREPANCY_INVALID");
  const item = Object.freeze({
    ...input,
    decisionReference: ref(input.decisionReference),
    actorReference: ref(input.actorReference),
    occurredAt,
  });
  if (value.decisions.some((entry) => entry.decisionReference === item.decisionReference))
    return fail("DISCREPANCY_INVALID");
  return Object.freeze({
    ...value,
    ...patch,
    aggregateVersion: value.aggregateVersion + 1,
    decisions: Object.freeze([...value.decisions, item]),
    updatedAt: occurredAt,
  });
};
export function openSupplierDiscrepancy(
  input: Omit<
    SupplierDiscrepancy,
    | "status"
    | "ownerReference"
    | "resolution"
    | "resolutionOutcomeReference"
    | "aggregateVersion"
    | "decisions"
    | "createdAt"
    | "updatedAt"
  > & { createdAt: unknown },
): SupplierDiscrepancy {
  if (
    !["Short", "Over", "Rejected", "Damaged", "Quality"].includes(input.type) ||
    typeof input.withinTolerance !== "boolean"
  )
    return fail("DISCREPANCY_INVALID");
  const accepted = decimal(input.acceptedQuantity);
  const rejected = decimal(input.rejectedQuantity);
  const damaged = decimal(input.damagedQuantity);
  const variance = decimal(input.varianceQuantity);
  if (
    !positive(variance) ||
    (input.type === "Rejected" && !positive(rejected)) ||
    (input.type === "Damaged" && !positive(damaged)) ||
    (input.type === "Over" && !positive(accepted))
  )
    return fail("DISCREPANCY_INVALID");
  const createdAt = instant(input.createdAt);
  return Object.freeze({
    discrepancyReference: ref(input.discrepancyReference),
    tenantReference: ref(input.tenantReference),
    brandReference: ref(input.brandReference),
    stockSiteReference: ref(input.stockSiteReference),
    supplierReference: ref(input.supplierReference),
    purchaseOrderReference: ref(input.purchaseOrderReference),
    purchaseOrderLineReference: ref(input.purchaseOrderLineReference),
    goodsReceiptReference: ref(input.goodsReceiptReference),
    receiptLineReference: ref(input.receiptLineReference),
    sourceEventReference: ref(input.sourceEventReference),
    type: input.type,
    orderedQuantity: decimal(input.orderedQuantity),
    priorAcceptedQuantity: decimal(input.priorAcceptedQuantity),
    acceptedQuantity: accepted,
    rejectedQuantity: rejected,
    damagedQuantity: damaged,
    varianceQuantity: variance,
    unit: code(input.unit),
    toleranceQuantity: decimal(input.toleranceQuantity),
    withinTolerance: input.withinTolerance,
    status: "Open",
    ownerReference: null,
    resolution: null,
    resolutionOutcomeReference: null,
    aggregateVersion: 1,
    decisions: Object.freeze([]),
    createdAt,
    updatedAt: createdAt,
  });
}
export function acknowledgeDiscrepancy(
  value: SupplierDiscrepancy,
  input: {
    expectedVersion: number;
    decisionReference: OfferingReference;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierDiscrepancy {
  if (value.aggregateVersion !== input.expectedVersion || value.status !== "Open")
    return fail("DISCREPANCY_STATE_CONFLICT");
  return decision(
    value,
    {
      ...input,
      action: "Acknowledged",
      reasonCode: null,
      ownerReference: null,
      supplierContactOutcome: null,
      resolution: null,
      outcomeReference: null,
    },
    { status: "Acknowledged" },
  );
}
export function assignDiscrepancy(
  value: SupplierDiscrepancy,
  input: {
    expectedVersion: number;
    decisionReference: OfferingReference;
    ownerReference: OfferingReference;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierDiscrepancy {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    !["Open", "Acknowledged", "InReview"].includes(value.status)
  )
    return fail("DISCREPANCY_STATE_CONFLICT");
  const owner = ref(input.ownerReference);
  return decision(
    value,
    {
      ...input,
      ownerReference: owner,
      action: "Assigned",
      reasonCode: null,
      supplierContactOutcome: null,
      resolution: null,
      outcomeReference: null,
    },
    { status: "InReview", ownerReference: owner },
  );
}
export function recordSupplierContact(
  value: SupplierDiscrepancy,
  input: {
    expectedVersion: number;
    decisionReference: OfferingReference;
    outcome: DiscrepancyDecision["supplierContactOutcome"];
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierDiscrepancy {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    ["Resolved", "Closed"].includes(value.status) ||
    !input.outcome ||
    ![
      "Acknowledged",
      "Disputed",
      "CorrectionPromised",
      "ReplacementPromised",
      "NoResponse",
    ].includes(input.outcome)
  )
    return fail("DISCREPANCY_STATE_CONFLICT");
  return decision(
    value,
    {
      decisionReference: input.decisionReference,
      action: "SupplierContactRecorded",
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
      reasonCode: code(input.reasonCode),
      ownerReference: null,
      supplierContactOutcome: input.outcome,
      resolution: null,
      outcomeReference: null,
    },
    { status: "InReview" },
  );
}
export function resolveDiscrepancy(
  value: SupplierDiscrepancy,
  input: {
    expectedVersion: number;
    decisionReference: OfferingReference;
    resolution: DiscrepancyResolution;
    outcomeReference: OfferingReference;
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierDiscrepancy {
  if (
    value.aggregateVersion !== input.expectedVersion ||
    ["ResolutionPending", "Resolved", "Closed"].includes(value.status)
  )
    return fail("DISCREPANCY_STATE_CONFLICT");
  if (
    input.resolution === "AcceptedWithinPolicy" &&
    (value.type !== "Over" || !value.withinTolerance)
  )
    return fail("DISCREPANCY_POLICY_BLOCKED");
  if (input.resolution === "RemainderWaived" && value.type !== "Short")
    return fail("DISCREPANCY_POLICY_BLOCKED");
  const pending = ["CorrectionRequested", "ReplacementRequested"].includes(input.resolution);
  return decision(
    value,
    {
      decisionReference: input.decisionReference,
      action: "ResolutionRecorded",
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
      reasonCode: code(input.reasonCode),
      ownerReference: null,
      supplierContactOutcome: null,
      resolution: input.resolution,
      outcomeReference: ref(input.outcomeReference),
    },
    {
      status: pending ? "ResolutionPending" : "Resolved",
      resolution: input.resolution,
      resolutionOutcomeReference: ref(input.outcomeReference),
    },
  );
}
export function closeDiscrepancy(
  value: SupplierDiscrepancy,
  input: {
    expectedVersion: number;
    decisionReference: OfferingReference;
    closureReference: OfferingReference;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierDiscrepancy {
  if (value.aggregateVersion !== input.expectedVersion) return fail("DISCREPANCY_STATE_CONFLICT");
  if (
    !["Resolved", "ResolutionPending"].includes(value.status) ||
    !value.resolution ||
    !value.resolutionOutcomeReference
  )
    return fail("DISCREPANCY_CLOSE_BLOCKED");
  return decision(
    value,
    {
      decisionReference: input.decisionReference,
      action: "Closed",
      actorReference: input.actorReference,
      occurredAt: input.occurredAt,
      reasonCode: null,
      ownerReference: null,
      supplierContactOutcome: null,
      resolution: null,
      outcomeReference: ref(input.closureReference),
    },
    { status: "Closed" },
  );
}
