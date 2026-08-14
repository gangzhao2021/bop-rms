export type DeliveryReference = string & { readonly __deliveryReference: unique symbol };
export type DeliveryInstant = string & { readonly __deliveryInstant: unique symbol };
export type DeliveryExecutionStatus =
  "Planned" | "AtStore" | "PickedUp" | "EnRoute" | "Delivered" | "Failed" | "Cancelled";
export type DeliveryAssignmentStatus =
  "Unassigned" | "Searching" | "Offered" | "Assigned" | "Accepted" | "ReassignmentRequired";
export type AssignmentOutcome =
  "Pending" | "Accepted" | "Rejected" | "TimedOut" | "Withdrawn" | "ProviderError" | "Released";
export interface DeliveryAssignmentAttempt {
  readonly attemptReference: DeliveryReference;
  readonly sequence: number;
  readonly targetType: "InternalWorker" | "ExternalProvider";
  readonly targetReference: DeliveryReference;
  readonly dispatchMode: "Automatic" | "Manual";
  readonly dispatchPolicyVersionReference: DeliveryReference;
  readonly routePlanVersionReference: DeliveryReference;
  readonly assignmentVersion: number;
  readonly offeredAt: DeliveryInstant;
  readonly expiresAt: DeliveryInstant;
  readonly respondedAt: DeliveryInstant | null;
  readonly idempotencyReference: DeliveryReference;
  readonly outcome: AssignmentOutcome;
  readonly reasonCode: string | null;
}
export interface DeliveryDispatchException {
  readonly exceptionReference: DeliveryReference;
  readonly type: "AttemptsExhausted" | "DispatchDeadline" | "CandidateUnavailable";
  readonly severity: "Medium" | "High" | "Critical";
  readonly status: "Open" | "Acknowledged" | "Resolved" | "Escalated";
  readonly attemptReference: DeliveryReference | null;
  readonly createdAt: DeliveryInstant;
}
export interface DeliveryTask {
  readonly taskReference: DeliveryReference;
  readonly tenantReference: DeliveryReference;
  readonly brandReference: DeliveryReference;
  readonly storeReference: DeliveryReference;
  readonly fulfillmentReference: DeliveryReference;
  readonly orderReference: DeliveryReference;
  readonly addressSnapshotReference: DeliveryReference;
  readonly confirmedWindowReference: DeliveryReference;
  readonly capacityAllocationReference: DeliveryReference;
  readonly requirementsReference: DeliveryReference;
  readonly executionStatus: DeliveryExecutionStatus;
  readonly assignmentStatus: DeliveryAssignmentStatus;
  readonly attempts: readonly DeliveryAssignmentAttempt[];
  readonly exceptions: readonly DeliveryDispatchException[];
  readonly aggregateVersion: number;
  readonly createdAt: DeliveryInstant;
  readonly updatedAt: DeliveryInstant;
}
export class DeliveryTaskError extends Error {
  constructor(readonly code: "INVALID" | "CONFLICT" | "PROOF_REQUIRED" | "DEADLINE_EXCEEDED") {
    super("Delivery Task operation unavailable");
    this.name = "DeliveryTaskError";
  }
}
const fail = (code: DeliveryTaskError["code"] = "INVALID"): never => {
  throw new DeliveryTaskError(code);
};
export const deliveryReference = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v)
    ? (v as DeliveryReference)
    : fail();
export const deliveryInstant = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
  new Date(Date.parse(v)).toISOString() === v
    ? (v as DeliveryInstant)
    : fail();
const reason = (v: unknown) =>
  typeof v === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(v) ? v : fail();
const expected = (task: DeliveryTask, v: number) => {
  if (!Number.isSafeInteger(v) || task.aggregateVersion !== v) fail("CONFLICT");
};
const evolve = (task: DeliveryTask, patch: Partial<DeliveryTask>, at: unknown): DeliveryTask => {
  const updatedAt = deliveryInstant(at);
  if (task.updatedAt > updatedAt) fail("CONFLICT");
  return Object.freeze({
    ...task,
    ...patch,
    aggregateVersion: task.aggregateVersion + 1,
    updatedAt,
  });
};
export function createDeliveryTask(input: {
  taskReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  storeReference: unknown;
  fulfillmentReference: unknown;
  orderReference: unknown;
  fulfillmentType: "Delivery" | "Pickup";
  fulfillmentStatus: "Planned" | "Pending" | "Cancelled";
  addressSnapshotReference: unknown | null;
  confirmedWindowReference: unknown | null;
  capacityAllocationReference: unknown | null;
  requirementsReference: unknown | null;
  occurredAt: unknown;
}): DeliveryTask {
  if (
    input.fulfillmentType !== "Delivery" ||
    input.fulfillmentStatus !== "Planned" ||
    input.addressSnapshotReference === null ||
    input.confirmedWindowReference === null ||
    input.capacityAllocationReference === null ||
    input.requirementsReference === null
  )
    fail("PROOF_REQUIRED");
  const at = deliveryInstant(input.occurredAt);
  return Object.freeze({
    taskReference: deliveryReference(input.taskReference),
    tenantReference: deliveryReference(input.tenantReference),
    brandReference: deliveryReference(input.brandReference),
    storeReference: deliveryReference(input.storeReference),
    fulfillmentReference: deliveryReference(input.fulfillmentReference),
    orderReference: deliveryReference(input.orderReference),
    addressSnapshotReference: deliveryReference(input.addressSnapshotReference),
    confirmedWindowReference: deliveryReference(input.confirmedWindowReference),
    capacityAllocationReference: deliveryReference(input.capacityAllocationReference),
    requirementsReference: deliveryReference(input.requirementsReference),
    executionStatus: "Planned",
    assignmentStatus: "Unassigned",
    attempts: Object.freeze([]),
    exceptions: Object.freeze([]),
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
  });
}
export function beginDeliverySearch(
  task: DeliveryTask,
  input: { expectedVersion: number; occurredAt: unknown },
): DeliveryTask {
  expected(task, input.expectedVersion);
  if (
    !["Unassigned", "ReassignmentRequired"].includes(task.assignmentStatus) ||
    ["Accepted", "Cancelled", "Delivered", "Failed"].includes(task.executionStatus)
  )
    fail("CONFLICT");
  return evolve(task, { assignmentStatus: "Searching" }, input.occurredAt);
}
export function offerDeliveryAssignment(
  task: DeliveryTask,
  input: {
    expectedVersion: number;
    attemptReference: unknown;
    targetType: DeliveryAssignmentAttempt["targetType"];
    targetReference: unknown;
    dispatchMode: DeliveryAssignmentAttempt["dispatchMode"];
    dispatchPolicyVersionReference: unknown;
    routePlanVersionReference: unknown;
    assignmentVersion: number;
    offeredAt: unknown;
    expiresAt: unknown;
    dispatchDeadline: unknown;
    maxAutomaticAttempts: number;
    idempotencyReference: unknown;
    candidateEvidence: {
      readonly available: "Available" | "Unavailable" | "Indeterminate";
      readonly requirementsMatched: boolean;
      readonly hardBlocked: boolean;
    };
  },
): DeliveryTask {
  expected(task, input.expectedVersion);
  if (task.assignmentStatus !== "Searching" || task.attempts.some((x) => x.outcome === "Pending"))
    fail("CONFLICT");
  const offeredAt = deliveryInstant(input.offeredAt),
    expiresAt = deliveryInstant(input.expiresAt),
    deadline = deliveryInstant(input.dispatchDeadline);
  if (offeredAt >= expiresAt || expiresAt > deadline) fail("DEADLINE_EXCEEDED");
  if (
    input.candidateEvidence.available !== "Available" ||
    !input.candidateEvidence.requirementsMatched ||
    input.candidateEvidence.hardBlocked
  )
    fail("PROOF_REQUIRED");
  const automaticCount = task.attempts.filter((x) => x.dispatchMode === "Automatic").length;
  if (
    input.dispatchMode === "Automatic" &&
    (!Number.isSafeInteger(input.maxAutomaticAttempts) ||
      automaticCount >= input.maxAutomaticAttempts)
  )
    return openDispatchException(task, {
      expectedVersion: input.expectedVersion,
      exceptionReference: input.attemptReference,
      type: "AttemptsExhausted",
      severity: "High",
      attemptReference: task.attempts.at(-1)?.attemptReference ?? null,
      occurredAt: offeredAt,
    });
  const attempt = Object.freeze({
    attemptReference: deliveryReference(input.attemptReference),
    sequence: task.attempts.length + 1,
    targetType: input.targetType,
    targetReference: deliveryReference(input.targetReference),
    dispatchMode: input.dispatchMode,
    dispatchPolicyVersionReference: deliveryReference(input.dispatchPolicyVersionReference),
    routePlanVersionReference: deliveryReference(input.routePlanVersionReference),
    assignmentVersion: input.assignmentVersion,
    offeredAt,
    expiresAt,
    respondedAt: null,
    idempotencyReference: deliveryReference(input.idempotencyReference),
    outcome: "Pending" as const,
    reasonCode: null,
  });
  return evolve(
    task,
    { assignmentStatus: "Offered", attempts: Object.freeze([...task.attempts, attempt]) },
    offeredAt,
  );
}
export function respondDeliveryAssignment(
  task: DeliveryTask,
  input: {
    expectedVersion: number;
    attemptReference: unknown;
    assignmentVersion: number;
    outcome: "Accepted" | "Rejected" | "TimedOut" | "Withdrawn" | "ProviderError" | "Released";
    reasonCode: unknown;
    respondedAt: unknown;
  },
): DeliveryTask {
  expected(task, input.expectedVersion);
  const ref = deliveryReference(input.attemptReference),
    index = task.attempts.findIndex((x) => x.attemptReference === ref),
    prior = task.attempts[index];
  if (!prior || prior.outcome !== "Pending" || prior.assignmentVersion !== input.assignmentVersion)
    fail("CONFLICT");
  const attempt = prior as NonNullable<typeof prior>;
  const respondedAt = deliveryInstant(input.respondedAt);
  if (input.outcome === "Accepted" && respondedAt >= attempt.expiresAt) fail("CONFLICT");
  const attempts = [...task.attempts];
  attempts[index] = Object.freeze({
    ...attempt,
    outcome: input.outcome,
    respondedAt,
    reasonCode: reason(input.reasonCode),
  });
  return evolve(
    task,
    {
      attempts: Object.freeze(attempts),
      assignmentStatus: input.outcome === "Accepted" ? "Accepted" : "ReassignmentRequired",
    },
    respondedAt,
  );
}
export function openDispatchException(
  task: DeliveryTask,
  input: {
    expectedVersion: number;
    exceptionReference: unknown;
    type: DeliveryDispatchException["type"];
    severity: DeliveryDispatchException["severity"];
    attemptReference: unknown | null;
    occurredAt: unknown;
  },
): DeliveryTask {
  expected(task, input.expectedVersion);
  if (task.exceptions.some((x) => x.status === "Open" && x.type === input.type)) fail("CONFLICT");
  const createdAt = deliveryInstant(input.occurredAt),
    exception = Object.freeze({
      exceptionReference: deliveryReference(input.exceptionReference),
      type: input.type,
      severity: input.severity,
      status: "Open" as const,
      attemptReference:
        input.attemptReference === null ? null : deliveryReference(input.attemptReference),
      createdAt,
    });
  return evolve(
    task,
    {
      assignmentStatus: "ReassignmentRequired",
      exceptions: Object.freeze([...task.exceptions, exception]),
    },
    createdAt,
  );
}
