import {
  DeliveryTaskError,
  deliveryInstant,
  deliveryReference,
  type DeliveryInstant,
  type DeliveryReference,
} from "./delivery-task.js";
export type DeliveryExceptionLifecycle =
  "Open" | "Contacting" | "ActionRequired" | "Escalated" | "Resolved";
export type DeliveryExceptionSeverity = "AtRisk" | "Delayed" | "Critical";
export type DeliveryExceptionReason =
  | "CUSTOMER_UNREACHABLE"
  | "CUSTOMER_UNAVAILABLE"
  | "RECIPIENT_VERIFICATION_FAILED"
  | "ACCESS_BLOCKED"
  | "ADDRESS_OR_LOCATION_MISMATCH"
  | "UNATTENDED_DELIVERY_NOT_ALLOWED"
  | "PACKAGE_DAMAGED"
  | "PACKAGE_SAFETY_OR_FRESHNESS_RISK"
  | "DELIVERY_INSTRUCTIONS_CONFLICT"
  | "PROVIDER_REPORTED_COMPLETION_FAILURE"
  | "OTHER";
export type DeliveryResolution =
  | "DeliveredOnReattempt"
  | "ReturnedToStore"
  | "AuthorizedDisposal"
  | "FulfillmentFailed"
  | "CancelledByOrdering"
  | "CreatedInError";
export interface DeliveryRemedyAttempt {
  readonly attemptReference: DeliveryReference;
  readonly sequence: number;
  readonly kind: "Reattempt" | "Reroute";
  readonly windowReference: DeliveryReference;
  readonly capacityReference: DeliveryReference;
  readonly proofPolicyReference: DeliveryReference;
  readonly createdAt: DeliveryInstant;
}
export interface DeliveryCompletionException {
  readonly exceptionReference: DeliveryReference;
  readonly taskReference: DeliveryReference;
  readonly orderReference: DeliveryReference;
  readonly lifecycle: DeliveryExceptionLifecycle;
  readonly severity: DeliveryExceptionSeverity;
  readonly reason: DeliveryExceptionReason;
  readonly ownerReference: DeliveryReference | null;
  readonly resolutionDeadline: DeliveryInstant;
  readonly customerImpact: "None" | "Delayed" | "ActionRequired";
  readonly triggeringAttemptReference: DeliveryReference;
  readonly remedyAttempts: readonly DeliveryRemedyAttempt[];
  readonly resolution: DeliveryResolution | null;
  readonly resolutionEvidenceReference: DeliveryReference | null;
  readonly aggregateVersion: number;
  readonly createdAt: DeliveryInstant;
  readonly updatedAt: DeliveryInstant;
}
const fail = (code: DeliveryTaskError["code"] = "INVALID"): never => {
  throw new DeliveryTaskError(code);
};
export function openDeliveryCompletionException(input: {
  exceptionReference: unknown;
  taskReference: unknown;
  orderReference: unknown;
  triggeringAttemptReference: unknown;
  reason: DeliveryExceptionReason;
  severity: DeliveryExceptionSeverity;
  customerImpact: DeliveryCompletionException["customerImpact"];
  resolutionDeadline: unknown;
  occurredAt: unknown;
  hasActiveCompletionException: boolean;
}): DeliveryCompletionException {
  const createdAt = deliveryInstant(input.occurredAt),
    resolutionDeadline = deliveryInstant(input.resolutionDeadline);
  if (
    input.hasActiveCompletionException ||
    createdAt >= resolutionDeadline ||
    (input.reason === "OTHER" && input.customerImpact === "None")
  )
    fail("CONFLICT");
  return Object.freeze({
    exceptionReference: deliveryReference(input.exceptionReference),
    taskReference: deliveryReference(input.taskReference),
    orderReference: deliveryReference(input.orderReference),
    lifecycle: "Open",
    severity: input.severity,
    reason: input.reason,
    ownerReference: null,
    resolutionDeadline,
    customerImpact: input.customerImpact,
    triggeringAttemptReference: deliveryReference(input.triggeringAttemptReference),
    remedyAttempts: Object.freeze([]),
    resolution: null,
    resolutionEvidenceReference: null,
    aggregateVersion: 1,
    createdAt,
    updatedAt: createdAt,
  });
}
export function assignDeliveryException(
  exception: DeliveryCompletionException,
  input: { expectedVersion: number; ownerReference: unknown; occurredAt: unknown },
) {
  if (exception.aggregateVersion !== input.expectedVersion || exception.lifecycle === "Resolved")
    fail("CONFLICT");
  return Object.freeze({
    ...exception,
    ownerReference: deliveryReference(input.ownerReference),
    lifecycle: "Contacting" as const,
    aggregateVersion: exception.aggregateVersion + 1,
    updatedAt: deliveryInstant(input.occurredAt),
  });
}
export function planDeliveryRemedy(
  exception: DeliveryCompletionException,
  input: {
    expectedVersion: number;
    attemptReference: unknown;
    kind: "Reattempt" | "Reroute";
    occurredAt: unknown;
    maxReattempts: number;
    latestReattemptAt: unknown;
    windowReference: unknown;
    capacityReference: unknown;
    proofPolicyReference: unknown;
    evidence: {
      customerAvailable: boolean;
      addressAndInstructionsCurrent: boolean;
      packageFreshAndSafe: boolean;
      assignmentEligible: boolean;
      capacityAccepted: boolean;
      hardBlocked: boolean;
    };
  },
) {
  if (exception.aggregateVersion !== input.expectedVersion || exception.lifecycle === "Resolved")
    fail("CONFLICT");
  const occurredAt = deliveryInstant(input.occurredAt),
    latest = deliveryInstant(input.latestReattemptAt);
  if (
    !Number.isSafeInteger(input.maxReattempts) ||
    exception.remedyAttempts.length >= input.maxReattempts ||
    occurredAt > latest ||
    input.evidence.hardBlocked ||
    Object.entries(input.evidence).some(([key, value]) => key !== "hardBlocked" && value !== true)
  )
    fail("PROOF_REQUIRED");
  const remedy: DeliveryRemedyAttempt = Object.freeze({
    attemptReference: deliveryReference(input.attemptReference),
    sequence: exception.remedyAttempts.length + 1,
    kind: input.kind,
    windowReference: deliveryReference(input.windowReference),
    capacityReference: deliveryReference(input.capacityReference),
    proofPolicyReference: deliveryReference(input.proofPolicyReference),
    createdAt: occurredAt,
  });
  return Object.freeze({
    ...exception,
    lifecycle: "ActionRequired" as const,
    remedyAttempts: Object.freeze([...exception.remedyAttempts, remedy]),
    aggregateVersion: exception.aggregateVersion + 1,
    updatedAt: occurredAt,
  });
}
export function resolveDeliveryException(
  exception: DeliveryCompletionException,
  input: {
    expectedVersion: number;
    resolution: DeliveryResolution;
    resolutionEvidenceReference: unknown;
    occurredAt: unknown;
    evidence: {
      validatedDeliveryProof: boolean;
      validatedReturnHandoff: boolean;
      disposalPolicyAuthorized: boolean;
      orderingCancelled: boolean;
      remediesExhausted: boolean;
      noActiveCriticalException: boolean;
      allItemsFinal: boolean;
      failureAuthorized: boolean;
      noActualHandlingNeeded: boolean;
    };
  },
) {
  if (exception.aggregateVersion !== input.expectedVersion || exception.lifecycle === "Resolved")
    fail("CONFLICT");
  const allowed =
    input.resolution === "DeliveredOnReattempt"
      ? input.evidence.validatedDeliveryProof
      : input.resolution === "ReturnedToStore"
        ? input.evidence.validatedReturnHandoff
        : input.resolution === "AuthorizedDisposal"
          ? input.evidence.disposalPolicyAuthorized
          : input.resolution === "CancelledByOrdering"
            ? input.evidence.orderingCancelled
            : input.resolution === "CreatedInError"
              ? input.evidence.noActualHandlingNeeded
              : input.evidence.remediesExhausted &&
                input.evidence.noActiveCriticalException &&
                input.evidence.allItemsFinal &&
                input.evidence.failureAuthorized;
  if (!allowed) fail("PROOF_REQUIRED");
  const taskEffect =
    input.resolution === "DeliveredOnReattempt"
      ? "Delivered"
      : input.resolution === "CancelledByOrdering"
        ? "Cancelled"
        : input.resolution === "FulfillmentFailed"
          ? "Failed"
          : "Unchanged";
  return Object.freeze({
    exception: Object.freeze({
      ...exception,
      lifecycle: "Resolved" as const,
      resolution: input.resolution,
      resolutionEvidenceReference: deliveryReference(input.resolutionEvidenceReference),
      aggregateVersion: exception.aggregateVersion + 1,
      updatedAt: deliveryInstant(input.occurredAt),
    }),
    taskEffect,
  });
}
export function finalizeReturnDisposition(input: {
  returnHandoffStatus: "Pending" | "Validated" | "NeedsReview" | "Rejected";
  disposition:
    | "EligibleForReattempt"
    | "RemakeRequired"
    | "ReplacementRequired"
    | "DisposalRequired"
    | "HeldForInvestigation";
  ownerActionReference: unknown | null;
  ownerActionFinal: boolean;
}) {
  if (
    input.returnHandoffStatus !== "Validated" ||
    input.ownerActionReference === null ||
    !input.ownerActionFinal
  )
    fail("PROOF_REQUIRED");
  return Object.freeze({
    disposition: input.disposition,
    status: "Finalized" as const,
    ownerActionReference: deliveryReference(input.ownerActionReference),
  });
}
