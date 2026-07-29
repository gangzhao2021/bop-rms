import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  type ActorReference,
  type CanonicalInstant,
} from "@bop/identity";
import type { MembershipReference, StoreAssignmentReference } from "@bop/membership";
import type { NotificationReference } from "@bop/notification";
import {
  taskStatuses,
  taskTerminalKinds,
  type TaskStatus,
  type TaskTerminalKind,
} from "../domain/task-lifecycle.js";

export type { TaskStatus, TaskTerminalKind } from "../domain/task-lifecycle.js";

export type TaskReference = string & { readonly __taskReference: unique symbol };
export type TaskDigest = string & { readonly __taskDigest: unique symbol };
export type TaskCode = string & { readonly __taskCode: unique symbol };
export type TaskVersion = number & { readonly __taskVersion: unique symbol };

export const taskScopeKinds = ["Brand", "Store"] as const;
export type TaskScopeKind = (typeof taskScopeKinds)[number];
export const taskAssignmentKinds = ["User", "Role", "Position", "Queue"] as const;
export type TaskAssignmentKind = (typeof taskAssignmentKinds)[number];
export const taskContractErrorCodes = [
  "TASK_INPUT_INVALID",
  "TASK_REFERENCE_INVALID",
  "TASK_DIGEST_INVALID",
  "TASK_CODE_INVALID",
  "TASK_VERSION_INVALID",
  "TASK_INSTANT_INVALID",
  "TASK_SCOPE_INVALID",
  "TASK_ASSIGNMENT_INVALID",
  "TASK_CLAIM_INVALID",
  "TASK_ESCALATION_INVALID",
  "TASK_OUTCOME_INVALID",
  "TASK_RECORD_INVALID",
] as const;
export type TaskContractErrorCode = (typeof taskContractErrorCodes)[number];

const safeMessages: Readonly<Record<TaskContractErrorCode, string>> = {
  TASK_INPUT_INVALID: "task input is invalid",
  TASK_REFERENCE_INVALID: "task reference is invalid",
  TASK_DIGEST_INVALID: "task digest is invalid",
  TASK_CODE_INVALID: "task code is invalid",
  TASK_VERSION_INVALID: "task version is invalid",
  TASK_INSTANT_INVALID: "task instant is invalid",
  TASK_SCOPE_INVALID: "task scope is invalid",
  TASK_ASSIGNMENT_INVALID: "task assignment is invalid",
  TASK_CLAIM_INVALID: "task claim is invalid",
  TASK_ESCALATION_INVALID: "task escalation is invalid",
  TASK_OUTCOME_INVALID: "task outcome is invalid",
  TASK_RECORD_INVALID: "task record is invalid",
};

export class TaskContractError extends Error {
  readonly code: TaskContractErrorCode;

  constructor(code: TaskContractErrorCode) {
    super(safeMessages[code]);
    this.name = "TaskContractError";
    this.code = code;
  }
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const codePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,7}$/u;

export function parseTaskReference(value: unknown): TaskReference {
  try {
    return parseOpaqueUuidV7(value, "IDENTITY_INPUT_INVALID") as TaskReference;
  } catch {
    throw new TaskContractError("TASK_REFERENCE_INVALID");
  }
}

export function parseTaskDigest(value: unknown): TaskDigest {
  if (typeof value !== "string" || !digestPattern.test(value))
    throw new TaskContractError("TASK_DIGEST_INVALID");
  return value as TaskDigest;
}

export function parseTaskCode(value: unknown): TaskCode {
  if (typeof value !== "string" || value.length > 96 || !codePattern.test(value))
    throw new TaskContractError("TASK_CODE_INVALID");
  return value as TaskCode;
}

export function parseTaskVersion(value: unknown): TaskVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TaskContractError("TASK_VERSION_INVALID");
  return value as TaskVersion;
}

export function parseTaskInstant(value: unknown): CanonicalInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    throw new TaskContractError("TASK_INSTANT_INVALID");
  }
}

function exact(
  value: unknown,
  fields: readonly string[],
  code: TaskContractErrorCode,
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new TaskContractError(code);
    const keys = Reflect.ownKeys(value);
    const allowed = new Set(fields);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      keys.some((key) => {
        if (typeof key !== "string") return true;
        const descriptor = descriptors[key];
        return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
      })
    )
      throw new TaskContractError(code);
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof TaskContractError) throw error;
    throw new TaskContractError(code);
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  code: TaskContractErrorCode,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number]))
    throw new TaskContractError(code);
  return value as T[number];
}

export interface TaskScope {
  readonly kind: TaskScopeKind;
  readonly brandReference: TaskReference;
  readonly storeReference: TaskReference | null;
}

export interface TaskSource {
  readonly sourceType: TaskCode;
  readonly sourceReference: TaskReference;
  readonly snapshotDigest: TaskDigest;
}

export interface TaskAssignmentTarget {
  readonly kind: TaskAssignmentKind;
  readonly reference: TaskReference;
}

export interface TaskAssignmentRecord {
  readonly assignmentReference: TaskReference;
  readonly target: TaskAssignmentTarget;
  readonly assignedBy: ActorReference;
  readonly assignedAt: CanonicalInstant;
  readonly reasonCode: TaskCode;
}

export interface TaskClaimRecord {
  readonly claimReference: TaskReference;
  readonly actorReference: ActorReference;
  readonly eligibilityEvidenceReference: TaskReference;
  readonly membershipReference: MembershipReference;
  readonly storeAssignmentReference: StoreAssignmentReference | null;
  readonly claimedAt: CanonicalInstant;
}

export interface TaskEscalationRecord {
  readonly escalationReference: TaskReference;
  readonly notificationIntentReference: NotificationReference;
  readonly level: number;
  readonly escalatedAt: CanonicalInstant;
  readonly reasonCode: TaskCode;
}

export interface TaskTerminalOutcome {
  readonly outcomeReference: TaskReference;
  readonly kind: TaskTerminalKind;
  readonly resultCode: TaskCode;
  readonly completionReference: TaskReference | null;
  readonly decidedBy: ActorReference;
  readonly occurredAt: CanonicalInstant;
}

export interface TaskRecord {
  readonly taskReference: TaskReference;
  readonly scope: TaskScope;
  readonly source: TaskSource;
  readonly taskType: TaskCode;
  readonly severityCode: TaskCode;
  readonly priorityCode: TaskCode;
  readonly status: TaskStatus;
  readonly assignmentHistory: readonly TaskAssignmentRecord[];
  readonly currentAssignment: TaskAssignmentRecord | null;
  readonly claimHistory: readonly TaskClaimRecord[];
  readonly currentClaim: TaskClaimRecord | null;
  readonly dueAt: CanonicalInstant;
  readonly escalationPolicyReference: TaskReference;
  readonly escalationHistory: readonly TaskEscalationRecord[];
  readonly terminalOutcome: TaskTerminalOutcome | null;
  readonly version: TaskVersion;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
}

export function createTaskScope(value: unknown): TaskScope {
  const input = exact(value, ["kind", "brandReference", "storeReference"], "TASK_SCOPE_INVALID");
  const kind = oneOf(input.kind, taskScopeKinds, "TASK_SCOPE_INVALID");
  const storeReference =
    input.storeReference === null ? null : parseTaskReference(input.storeReference);
  if (
    (kind === "Brand" && storeReference !== null) ||
    (kind === "Store" && storeReference === null)
  )
    throw new TaskContractError("TASK_SCOPE_INVALID");
  return Object.freeze({
    kind,
    brandReference: parseTaskReference(input.brandReference),
    storeReference,
  });
}

export function createTaskSource(value: unknown): TaskSource {
  const input = exact(
    value,
    ["sourceType", "sourceReference", "snapshotDigest"],
    "TASK_RECORD_INVALID",
  );
  return Object.freeze({
    sourceType: parseTaskCode(input.sourceType),
    sourceReference: parseTaskReference(input.sourceReference),
    snapshotDigest: parseTaskDigest(input.snapshotDigest),
  });
}

export function createTaskAssignmentTarget(value: unknown): TaskAssignmentTarget {
  const input = exact(value, ["kind", "reference"], "TASK_ASSIGNMENT_INVALID");
  return Object.freeze({
    kind: oneOf(input.kind, taskAssignmentKinds, "TASK_ASSIGNMENT_INVALID"),
    reference: parseTaskReference(input.reference),
  });
}

export function createTaskAssignmentRecord(value: unknown): TaskAssignmentRecord {
  const input = exact(
    value,
    ["assignmentReference", "target", "assignedBy", "assignedAt", "reasonCode"],
    "TASK_ASSIGNMENT_INVALID",
  );
  return Object.freeze({
    assignmentReference: parseTaskReference(input.assignmentReference),
    target: createTaskAssignmentTarget(input.target),
    assignedBy: parseTaskReference(input.assignedBy) as unknown as ActorReference,
    assignedAt: parseTaskInstant(input.assignedAt),
    reasonCode: parseTaskCode(input.reasonCode),
  });
}

export function createTaskClaimRecord(value: unknown): TaskClaimRecord {
  const input = exact(
    value,
    [
      "claimReference",
      "actorReference",
      "eligibilityEvidenceReference",
      "membershipReference",
      "storeAssignmentReference",
      "claimedAt",
    ],
    "TASK_CLAIM_INVALID",
  );
  return Object.freeze({
    claimReference: parseTaskReference(input.claimReference),
    actorReference: parseTaskReference(input.actorReference) as unknown as ActorReference,
    eligibilityEvidenceReference: parseTaskReference(input.eligibilityEvidenceReference),
    membershipReference: parseTaskReference(
      input.membershipReference,
    ) as unknown as MembershipReference,
    storeAssignmentReference:
      input.storeAssignmentReference === null
        ? null
        : (parseTaskReference(
            input.storeAssignmentReference,
          ) as unknown as StoreAssignmentReference),
    claimedAt: parseTaskInstant(input.claimedAt),
  });
}

export function createTaskEscalationRecord(value: unknown): TaskEscalationRecord {
  const input = exact(
    value,
    ["escalationReference", "notificationIntentReference", "level", "escalatedAt", "reasonCode"],
    "TASK_ESCALATION_INVALID",
  );
  if (!Number.isSafeInteger(input.level) || (input.level as number) < 1)
    throw new TaskContractError("TASK_ESCALATION_INVALID");
  return Object.freeze({
    escalationReference: parseTaskReference(input.escalationReference),
    notificationIntentReference: parseTaskReference(
      input.notificationIntentReference,
    ) as unknown as NotificationReference,
    level: input.level as number,
    escalatedAt: parseTaskInstant(input.escalatedAt),
    reasonCode: parseTaskCode(input.reasonCode),
  });
}

export function createTaskTerminalOutcome(value: unknown): TaskTerminalOutcome {
  const input = exact(
    value,
    ["outcomeReference", "kind", "resultCode", "completionReference", "decidedBy", "occurredAt"],
    "TASK_OUTCOME_INVALID",
  );
  const kind = oneOf(input.kind, taskTerminalKinds, "TASK_OUTCOME_INVALID");
  const completionReference =
    input.completionReference === null ? null : parseTaskReference(input.completionReference);
  if ((kind === "Completed") !== (completionReference !== null))
    throw new TaskContractError("TASK_OUTCOME_INVALID");
  return Object.freeze({
    outcomeReference: parseTaskReference(input.outcomeReference),
    kind,
    resultCode: parseTaskCode(input.resultCode),
    completionReference,
    decidedBy: parseTaskReference(input.decidedBy) as unknown as ActorReference,
    occurredAt: parseTaskInstant(input.occurredAt),
  });
}

function sameAssignment(
  left: TaskAssignmentRecord | null,
  right: TaskAssignmentRecord | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.assignmentReference === right.assignmentReference &&
      left.target.kind === right.target.kind &&
      left.target.reference === right.target.reference &&
      left.assignedBy === right.assignedBy &&
      left.assignedAt === right.assignedAt &&
      left.reasonCode === right.reasonCode)
  );
}

function sameClaim(left: TaskClaimRecord | null, right: TaskClaimRecord | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.claimReference === right.claimReference &&
      left.actorReference === right.actorReference &&
      left.eligibilityEvidenceReference === right.eligibilityEvidenceReference &&
      left.membershipReference === right.membershipReference &&
      left.storeAssignmentReference === right.storeAssignmentReference &&
      left.claimedAt === right.claimedAt)
  );
}

export function sameTaskScope(left: TaskScope, right: TaskScope): boolean {
  return (
    left.kind === right.kind &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference
  );
}

export function createTaskRecord(value: unknown): TaskRecord {
  const input = exact(
    value,
    [
      "taskReference",
      "scope",
      "source",
      "taskType",
      "severityCode",
      "priorityCode",
      "status",
      "assignmentHistory",
      "currentAssignment",
      "claimHistory",
      "currentClaim",
      "dueAt",
      "escalationPolicyReference",
      "escalationHistory",
      "terminalOutcome",
      "version",
      "createdAt",
      "updatedAt",
    ],
    "TASK_RECORD_INVALID",
  );
  if (
    !Array.isArray(input.assignmentHistory) ||
    !Array.isArray(input.claimHistory) ||
    !Array.isArray(input.escalationHistory)
  )
    throw new TaskContractError("TASK_RECORD_INVALID");
  const assignmentHistory = Object.freeze(input.assignmentHistory.map(createTaskAssignmentRecord));
  const claimHistory = Object.freeze(input.claimHistory.map(createTaskClaimRecord));
  const escalationHistory = Object.freeze(input.escalationHistory.map(createTaskEscalationRecord));
  const currentAssignment =
    input.currentAssignment === null ? null : createTaskAssignmentRecord(input.currentAssignment);
  const currentClaim =
    input.currentClaim === null ? null : createTaskClaimRecord(input.currentClaim);
  const terminalOutcome =
    input.terminalOutcome === null ? null : createTaskTerminalOutcome(input.terminalOutcome);
  const status = oneOf(input.status, taskStatuses, "TASK_RECORD_INVALID");
  const createdAt = parseTaskInstant(input.createdAt);
  const updatedAt = parseTaskInstant(input.updatedAt);
  const dueAt = parseTaskInstant(input.dueAt);
  const version = parseTaskVersion(input.version);
  const lastAssignment = assignmentHistory.at(-1) ?? null;
  const assignmentReferences = assignmentHistory.map((item) => item.assignmentReference);
  const claimReferences = claimHistory.flatMap((item) => [
    item.claimReference,
    item.eligibilityEvidenceReference,
  ]);
  const escalationReferences = escalationHistory.flatMap((item) => [
    item.escalationReference,
    item.notificationIntentReference,
  ]);
  if (
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    Date.parse(dueAt) < Date.parse(createdAt) ||
    assignmentHistory.some(
      (item, index) =>
        Date.parse(item.assignedAt) < Date.parse(createdAt) ||
        Date.parse(item.assignedAt) > Date.parse(updatedAt) ||
        (index > 0 &&
          Date.parse(item.assignedAt) <
            Date.parse(assignmentHistory[index - 1]?.assignedAt ?? createdAt)),
    ) ||
    new Set(assignmentReferences).size !== assignmentReferences.length ||
    !sameAssignment(currentAssignment, lastAssignment) ||
    claimHistory.some(
      (item, index) =>
        Date.parse(item.claimedAt) < Date.parse(assignmentHistory[0]?.assignedAt ?? createdAt) ||
        Date.parse(item.claimedAt) > Date.parse(updatedAt) ||
        (index > 0 &&
          Date.parse(item.claimedAt) < Date.parse(claimHistory[index - 1]?.claimedAt ?? createdAt)),
    ) ||
    new Set(claimReferences).size !== claimReferences.length ||
    (currentClaim !== null && !claimHistory.some((item) => sameClaim(item, currentClaim))) ||
    escalationHistory.some(
      (item, index) =>
        item.level !== index + 1 ||
        Date.parse(item.escalatedAt) <= Date.parse(dueAt) ||
        Date.parse(item.escalatedAt) > Date.parse(updatedAt) ||
        (index > 0 &&
          Date.parse(item.escalatedAt) <=
            Date.parse(escalationHistory[index - 1]?.escalatedAt ?? dueAt)),
    ) ||
    new Set(escalationReferences).size !== escalationReferences.length ||
    (currentClaim !== null &&
      (currentAssignment === null ||
        Date.parse(currentClaim.claimedAt) > Date.parse(updatedAt) ||
        Date.parse(currentClaim.claimedAt) < Date.parse(currentAssignment.assignedAt))) ||
    (terminalOutcome !== null &&
      (Date.parse(terminalOutcome.occurredAt) > Date.parse(updatedAt) ||
        Date.parse(terminalOutcome.occurredAt) <
          Date.parse(currentClaim?.claimedAt ?? currentAssignment?.assignedAt ?? createdAt))) ||
    (version === 1 &&
      (status !== "Open" ||
        updatedAt !== createdAt ||
        assignmentHistory.length !== 0 ||
        claimHistory.length !== 0 ||
        escalationHistory.length !== 0)) ||
    (status === "Open" &&
      (currentAssignment !== null || currentClaim !== null || terminalOutcome !== null)) ||
    (status === "Assigned" &&
      (currentAssignment === null || currentClaim !== null || terminalOutcome !== null)) ||
    (status === "Claimed" &&
      (currentAssignment === null || currentClaim === null || terminalOutcome !== null)) ||
    (taskTerminalKinds.includes(status as TaskTerminalKind) &&
      (terminalOutcome === null || terminalOutcome.kind !== status))
  )
    throw new TaskContractError("TASK_RECORD_INVALID");
  return Object.freeze({
    taskReference: parseTaskReference(input.taskReference),
    scope: createTaskScope(input.scope),
    source: createTaskSource(input.source),
    taskType: parseTaskCode(input.taskType),
    severityCode: parseTaskCode(input.severityCode),
    priorityCode: parseTaskCode(input.priorityCode),
    status,
    assignmentHistory,
    currentAssignment,
    claimHistory,
    currentClaim,
    dueAt,
    escalationPolicyReference: parseTaskReference(input.escalationPolicyReference),
    escalationHistory,
    terminalOutcome,
    version,
    createdAt,
    updatedAt,
  });
}
