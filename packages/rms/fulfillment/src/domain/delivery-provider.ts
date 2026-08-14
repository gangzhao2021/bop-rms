import {
  DeliveryTaskError,
  deliveryInstant,
  deliveryReference,
  type DeliveryAssignmentStatus,
  type DeliveryExecutionStatus,
  type DeliveryInstant,
  type DeliveryReference,
} from "./delivery-task.js";
export type ProviderLifecycle = "Draft" | "Testing" | "Active" | "Suspended" | "Inactive";
export type ProviderHealth = "Healthy" | "Degraded" | "Unavailable" | "Unknown";
export type ProviderOperation = "Quote" | "Create" | "Status" | "Cancel" | "Webhook";
export type BreakerState = "Closed" | "Open" | "HalfOpen";
export interface DeliveryProviderAccount {
  readonly accountReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly merchantAccountReference: DeliveryReference;
  readonly secretReference: DeliveryReference;
  readonly lifecycle: ProviderLifecycle;
  readonly health: ProviderHealth;
  readonly storeReferences: readonly DeliveryReference[];
  readonly activationEvidenceReferences: readonly DeliveryReference[];
  readonly breakers: Readonly<Record<ProviderOperation, BreakerState>>;
}
export interface ProviderEventEnvelope {
  readonly envelopeReference: DeliveryReference;
  readonly providerAccountReference: DeliveryReference;
  readonly externalJobReference: DeliveryReference;
  readonly providerEventReference: DeliveryReference;
  readonly occurredAt: DeliveryInstant;
  readonly receivedAt: DeliveryInstant;
  readonly payloadVersion: string;
  readonly payloadHash: string;
  readonly mappingVersionReference: DeliveryReference;
}
export interface ProviderStatusResult {
  readonly envelope: ProviderEventEnvelope;
  readonly outcome:
    "Applied" | "Duplicate" | "Quarantined" | "IgnoredOutOfOrder" | "TerminalConflict";
  readonly assignmentStatus: DeliveryAssignmentStatus;
  readonly executionStatus: DeliveryExecutionStatus;
  readonly exceptionRequired: boolean;
}
export interface ProviderJobCreation {
  readonly operationReference: DeliveryReference;
  readonly idempotencyReference: DeliveryReference;
  readonly status: "Pending" | "Accepted" | "Rejected" | "Indeterminate";
  readonly externalJobReference: DeliveryReference | null;
}
const fail = (code: DeliveryTaskError["code"] = "INVALID"): never => {
  throw new DeliveryTaskError(code);
};
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : fail();
const version = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9._-]{1,32}$/u.test(value) ? value : fail();
export function providerEligibleForOffer(
  account: DeliveryProviderAccount,
  input: { storeReference: unknown; operation: "Quote" | "Create"; probeAuthorized: boolean },
) {
  const storeReference = deliveryReference(input.storeReference),
    breaker = account.breakers[input.operation];
  return (
    account.lifecycle === "Active" &&
    account.health !== "Unavailable" &&
    account.health !== "Unknown" &&
    account.activationEvidenceReferences.length >= 5 &&
    account.storeReferences.includes(storeReference) &&
    (breaker === "Closed" || (breaker === "HalfOpen" && input.probeAuthorized))
  );
}
export function receiveProviderEvent(input: {
  envelopeReference: unknown;
  providerAccountReference: unknown;
  externalJobReference: unknown;
  providerEventReference: unknown;
  occurredAt: unknown;
  receivedAt: unknown;
  replayWindowSeconds: number;
  signatureVerified: boolean;
  timestampVerified: boolean;
  payloadVersion: unknown;
  payloadHash: unknown;
  mappingVersionReference: unknown;
}): ProviderEventEnvelope {
  const occurredAt = deliveryInstant(input.occurredAt),
    receivedAt = deliveryInstant(input.receivedAt);
  if (
    !input.signatureVerified ||
    !input.timestampVerified ||
    !Number.isSafeInteger(input.replayWindowSeconds) ||
    input.replayWindowSeconds <= 0 ||
    Date.parse(receivedAt) - Date.parse(occurredAt) > input.replayWindowSeconds * 1000 ||
    occurredAt > receivedAt
  )
    fail("PROOF_REQUIRED");
  return Object.freeze({
    envelopeReference: deliveryReference(input.envelopeReference),
    providerAccountReference: deliveryReference(input.providerAccountReference),
    externalJobReference: deliveryReference(input.externalJobReference),
    providerEventReference: deliveryReference(input.providerEventReference),
    occurredAt,
    receivedAt,
    payloadVersion: version(input.payloadVersion),
    payloadHash: digest(input.payloadHash),
    mappingVersionReference: deliveryReference(input.mappingVersionReference),
  });
}
const assignmentOrder: readonly DeliveryAssignmentStatus[] = [
  "Unassigned",
  "Searching",
  "Offered",
  "Assigned",
  "Accepted",
  "ReassignmentRequired",
];
const executionOrder: readonly DeliveryExecutionStatus[] = [
  "Planned",
  "AtStore",
  "PickedUp",
  "EnRoute",
  "Delivered",
  "Failed",
  "Cancelled",
];
export function mapProviderStatus(input: {
  envelope: ProviderEventEnvelope;
  externalStatus: string;
  mapping: Readonly<
    Record<string, { assignment: DeliveryAssignmentStatus; execution: DeliveryExecutionStatus }>
  >;
  seenProviderEventReferences: readonly DeliveryReference[];
  currentAssignmentStatus: DeliveryAssignmentStatus;
  currentExecutionStatus: DeliveryExecutionStatus;
}): ProviderStatusResult {
  if (input.seenProviderEventReferences.includes(input.envelope.providerEventReference))
    return Object.freeze({
      envelope: input.envelope,
      outcome: "Duplicate",
      assignmentStatus: input.currentAssignmentStatus,
      executionStatus: input.currentExecutionStatus,
      exceptionRequired: false,
    });
  const mapped = input.mapping[input.externalStatus];
  if (!mapped)
    return Object.freeze({
      envelope: input.envelope,
      outcome: "Quarantined",
      assignmentStatus: input.currentAssignmentStatus,
      executionStatus: input.currentExecutionStatus,
      exceptionRequired: true,
    });
  const currentTerminal = ["Delivered", "Failed", "Cancelled"].includes(
      input.currentExecutionStatus,
    ),
    mappedTerminal = ["Delivered", "Failed", "Cancelled"].includes(mapped.execution);
  if (currentTerminal && mappedTerminal && mapped.execution !== input.currentExecutionStatus)
    return Object.freeze({
      envelope: input.envelope,
      outcome: "TerminalConflict",
      assignmentStatus: input.currentAssignmentStatus,
      executionStatus: input.currentExecutionStatus,
      exceptionRequired: true,
    });
  if (
    executionOrder.indexOf(mapped.execution) <
      executionOrder.indexOf(input.currentExecutionStatus) ||
    assignmentOrder.indexOf(mapped.assignment) <
      assignmentOrder.indexOf(input.currentAssignmentStatus)
  )
    return Object.freeze({
      envelope: input.envelope,
      outcome: "IgnoredOutOfOrder",
      assignmentStatus: input.currentAssignmentStatus,
      executionStatus: input.currentExecutionStatus,
      exceptionRequired: false,
    });
  return Object.freeze({
    envelope: input.envelope,
    outcome: "Applied",
    assignmentStatus: mapped.assignment,
    executionStatus: mapped.execution,
    exceptionRequired: false,
  });
}
export function createProviderJobResult(input: {
  operationReference: unknown;
  idempotencyReference: unknown;
  transportOutcome: "Accepted" | "Rejected" | "Timeout" | "InvalidResponse";
  externalJobReference: unknown | null;
}): ProviderJobCreation {
  if (input.transportOutcome === "Accepted" && input.externalJobReference === null)
    fail("PROOF_REQUIRED");
  const status: ProviderJobCreation["status"] =
    input.transportOutcome === "Timeout" || input.transportOutcome === "InvalidResponse"
      ? "Indeterminate"
      : input.transportOutcome;
  return Object.freeze({
    operationReference: deliveryReference(input.operationReference),
    idempotencyReference: deliveryReference(input.idempotencyReference),
    status,
    externalJobReference:
      input.externalJobReference === null ? null : deliveryReference(input.externalJobReference),
  });
}
export function reconcileProviderJob(
  creation: ProviderJobCreation,
  input: {
    idempotencyReference: unknown;
    externalJobReference: unknown | null;
    evidenceVerified: boolean;
  },
): ProviderJobCreation {
  if (
    creation.status !== "Indeterminate" ||
    deliveryReference(input.idempotencyReference) !== creation.idempotencyReference
  )
    fail("CONFLICT");
  if (!input.evidenceVerified || input.externalJobReference === null) return creation;
  return Object.freeze({
    ...creation,
    status: "Accepted",
    externalJobReference: deliveryReference(input.externalJobReference),
  });
}
export function providerQuote(input: {
  quoteReference: unknown;
  amountMinor: number;
  currency: string;
  quotedAt: unknown;
  expiresAt: unknown;
  usedAt: unknown;
  maxProviderCostMinor: number;
  managerApproved: boolean;
}) {
  const quotedAt = deliveryInstant(input.quotedAt),
    expiresAt = deliveryInstant(input.expiresAt),
    usedAt = deliveryInstant(input.usedAt);
  if (
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor < 0 ||
    !Number.isSafeInteger(input.maxProviderCostMinor) ||
    input.maxProviderCostMinor < 0 ||
    !/^[A-Z]{3}$/u.test(input.currency) ||
    quotedAt >= expiresAt ||
    usedAt >= expiresAt ||
    (input.amountMinor > input.maxProviderCostMinor && !input.managerApproved)
  )
    fail("PROOF_REQUIRED");
  return Object.freeze({
    quoteReference: deliveryReference(input.quoteReference),
    amountMinor: input.amountMinor,
    currency: input.currency,
    quotedAt,
    expiresAt,
  });
}
