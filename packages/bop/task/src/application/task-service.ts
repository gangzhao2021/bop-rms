import { validateAuditRecord, type AppendAuditRecordInput, type JsonObject } from "@bop/audit";
import type { ActorReference } from "@bop/identity";
import { parseBusinessAction, type BusinessAction, type PermissionDecision } from "@bop/permission";
import {
  createTaskAssignmentRecord,
  createTaskAssignmentTarget,
  createTaskClaimRecord,
  createTaskEscalationRecord,
  createTaskRecord,
  createTaskScope,
  createTaskTerminalOutcome,
  parseTaskCode,
  parseTaskDigest,
  parseTaskInstant,
  parseTaskReference,
  parseTaskVersion,
  sameTaskScope,
  type TaskAssignmentRecord,
  type TaskAssignmentTarget,
  type TaskClaimRecord,
  type TaskCode,
  type TaskDigest,
  type TaskEscalationRecord,
  type TaskRecord,
  type TaskReference,
  type TaskScope,
  type TaskTerminalOutcome,
  type TaskVersion,
} from "../contracts/task.js";
import {
  evaluateTaskTransition,
  isTaskOverdue,
  type TaskOperation,
} from "../domain/task-lifecycle.js";
import type { TaskEligibilityEvidence, TaskPorts } from "./ports/task-ports.js";

export const taskServiceErrorCodes = [
  "TASK_MUTATION_INVALID",
  "TASK_PERMISSION_DENIED",
  "TASK_ELIGIBILITY_DENIED",
  "TASK_TRANSITION_DENIED",
  "TASK_NOT_OVERDUE",
  "TASK_COMMIT_FAILED",
] as const;
export type TaskServiceErrorCode = (typeof taskServiceErrorCodes)[number];

export class TaskServiceError extends Error {
  readonly code: TaskServiceErrorCode;

  constructor(code: TaskServiceErrorCode) {
    super("task operation is unavailable");
    this.name = "TaskServiceError";
    this.code = code;
  }
}

const actions: Readonly<Record<TaskOperation, BusinessAction>> = {
  Create: parseBusinessAction("task.create"),
  Assign: parseBusinessAction("task.assign"),
  Claim: parseBusinessAction("task.claim"),
  Complete: parseBusinessAction("task.complete"),
  Fail: parseBusinessAction("task.fail"),
  Cancel: parseBusinessAction("task.cancel"),
  Escalate: parseBusinessAction("task.escalate"),
};

const auditCodes: Readonly<Record<TaskOperation, TaskCode>> = {
  Create: parseTaskCode("TASK_CREATED"),
  Assign: parseTaskCode("TASK_ASSIGNED"),
  Claim: parseTaskCode("TASK_CLAIMED"),
  Complete: parseTaskCode("TASK_COMPLETED"),
  Fail: parseTaskCode("TASK_FAILED"),
  Cancel: parseTaskCode("TASK_CANCELLED"),
  Escalate: parseTaskCode("TASK_ESCALATED"),
};

function fail(code: TaskServiceErrorCode): never {
  throw new TaskServiceError(code);
}

function exactEnvelope(input: unknown, fields: readonly string[]): void {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail("TASK_MUTATION_INVALID");
  const keys = Reflect.ownKeys(input);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable;
    })
  )
    fail("TASK_MUTATION_INVALID");
}

function isExactDataRecord(value: unknown, fields: readonly string[]): boolean {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return false;
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (
      keys.length === fields.length &&
      fields.every((field) => keys.includes(field)) &&
      keys.every((key) => typeof key === "string" && fields.includes(key)) &&
      keys.every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = descriptors[key];
        return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
      })
    );
  } catch {
    return false;
  }
}

interface CommandContext {
  readonly actorReference: ActorReference;
  readonly purposeCode: TaskCode;
  readonly expectedVersion: TaskVersion;
  readonly idempotencyKey: TaskReference;
  readonly requestDigest: TaskDigest;
  readonly auditId: TaskReference;
  readonly correlationId: TaskReference;
  readonly occurredAt: string;
  readonly sourceChannel: TaskCode;
}

function parseContext(input: CommandContext): CommandContext {
  try {
    return Object.freeze({
      actorReference: parseTaskReference(input.actorReference) as unknown as ActorReference,
      purposeCode: parseTaskCode(input.purposeCode),
      expectedVersion: parseTaskVersion(input.expectedVersion),
      idempotencyKey: parseTaskReference(input.idempotencyKey),
      requestDigest: parseTaskDigest(input.requestDigest),
      auditId: parseTaskReference(input.auditId),
      correlationId: parseTaskReference(input.correlationId),
      occurredAt: parseTaskInstant(input.occurredAt),
      sourceChannel: parseTaskCode(input.sourceChannel),
    });
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
}

function accepted(
  decision: PermissionDecision,
  operation: TaskOperation,
  task: TaskRecord,
): boolean {
  return (
    Object.isFrozen(decision) &&
    isExactDataRecord(decision, [
      "effect",
      "reason",
      "source",
      "action",
      "scopeKind",
      "policySnapshotReference",
      "policyVersion",
      "audit",
    ]) &&
    isExactDataRecord(decision.audit, ["effect", "reason", "source"]) &&
    decision.effect === "Allow" &&
    decision.action === actions[operation] &&
    decision.scopeKind === task.scope.kind
  );
}

async function authorize(
  operation: TaskOperation,
  task: TaskRecord,
  context: CommandContext,
  ports: TaskPorts,
): Promise<void> {
  let decision: PermissionDecision;
  try {
    decision = await ports.authorization.authorize({
      actorReference: context.actorReference,
      action: actions[operation],
      scope: task.scope,
      taskReference: task.taskReference,
      purposeCode: context.purposeCode,
      expectedVersion: context.expectedVersion,
      evaluatedAt: context.occurredAt,
    });
  } catch {
    return fail("TASK_PERMISSION_DENIED");
  }
  if (!accepted(decision, operation, task)) fail("TASK_PERMISSION_DENIED");
}

function createAudit(
  operation: TaskOperation,
  current: TaskRecord | null,
  next: TaskRecord,
  context: CommandContext,
): AppendAuditRecordInput {
  const beforeSummary: JsonObject | undefined =
    current === null ? undefined : { status: current.status, version: current.version };
  const afterSummary: JsonObject = { status: next.status, version: next.version };
  try {
    return validateAuditRecord({
      auditId: context.auditId,
      brandId: next.scope.brandReference,
      ...(next.scope.storeReference === null ? {} : { storeId: next.scope.storeReference }),
      actor: { type: "User", reference: context.actorReference },
      actionCode: auditCodes[operation],
      targetType: "Task",
      targetId: next.taskReference,
      ...(beforeSummary === undefined ? {} : { beforeSummary }),
      afterSummary,
      reasonCode: auditCodes[operation],
      correlationId: context.correlationId,
      occurredAt: context.occurredAt,
      sourceChannel: context.sourceChannel,
      dataClassification: "Confidential",
      retentionPolicyCode: "TASK_AUDIT",
      retentionPolicyVersion: 1,
    });
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
}

function sameImmutableFamily(current: TaskRecord, next: TaskRecord): boolean {
  return (
    current.taskReference === next.taskReference &&
    sameTaskScope(current.scope, next.scope) &&
    current.source.sourceType === next.source.sourceType &&
    current.source.sourceReference === next.source.sourceReference &&
    current.source.snapshotDigest === next.source.snapshotDigest &&
    current.taskType === next.taskType &&
    current.severityCode === next.severityCode &&
    current.priorityCode === next.priorityCode &&
    current.dueAt === next.dueAt &&
    current.escalationPolicyReference === next.escalationPolicyReference &&
    current.createdAt === next.createdAt
  );
}

function validateCurrent(currentInput: TaskRecord, context: CommandContext): TaskRecord {
  let current: TaskRecord;
  try {
    current = createTaskRecord(currentInput);
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
  if (
    current.version !== context.expectedVersion ||
    Date.parse(context.occurredAt) < Date.parse(current.updatedAt)
  )
    fail("TASK_MUTATION_INVALID");
  return current;
}

async function commit(
  operation: TaskOperation,
  current: TaskRecord | null,
  nextInput: TaskRecord,
  context: CommandContext,
  ports: TaskPorts,
): Promise<TaskRecord> {
  let next: TaskRecord;
  try {
    next = createTaskRecord(nextInput);
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
  if (
    (current === null &&
      (next.version !== 1 ||
        context.expectedVersion !== 1 ||
        next.createdAt !== context.occurredAt)) ||
    (current !== null &&
      (!sameImmutableFamily(current, next) ||
        next.version !== current.version + 1 ||
        next.updatedAt !== context.occurredAt))
  )
    fail("TASK_MUTATION_INVALID");
  const transition = evaluateTaskTransition(operation, current);
  if (transition.outcome !== "Allowed" || transition.nextStatus !== next.status)
    fail("TASK_TRANSITION_DENIED");
  await authorize(operation, next, context, ports);
  const audit = createAudit(operation, current, next, context);
  try {
    await ports.unitOfWork.commit({
      operation,
      expectedVersion: context.expectedVersion,
      idempotencyKey: context.idempotencyKey,
      requestDigest: context.requestDigest,
      current,
      next,
      audit,
    });
  } catch {
    return fail("TASK_COMMIT_FAILED");
  }
  return next;
}

export interface CreateTaskInput extends CommandContext {
  readonly task: TaskRecord;
}

export async function createTask(input: CreateTaskInput, ports: TaskPorts): Promise<TaskRecord> {
  exactEnvelope(input, [
    "actorReference",
    "purposeCode",
    "expectedVersion",
    "idempotencyKey",
    "requestDigest",
    "auditId",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "task",
  ]);
  const context = parseContext(input);
  let task: TaskRecord;
  try {
    task = createTaskRecord(input.task);
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
  return commit("Create", null, task, context, ports);
}

interface ExistingTaskCommand extends CommandContext {
  readonly current: TaskRecord;
}

function nextBase(current: TaskRecord, context: CommandContext) {
  return {
    ...current,
    version: (current.version + 1) as TaskVersion,
    updatedAt: context.occurredAt,
  };
}

export interface AssignTaskInput extends ExistingTaskCommand {
  readonly assignment: TaskAssignmentRecord;
}

export async function assignTask(input: AssignTaskInput, ports: TaskPorts): Promise<TaskRecord> {
  exactEnvelope(input, [
    "actorReference",
    "purposeCode",
    "expectedVersion",
    "idempotencyKey",
    "requestDigest",
    "auditId",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "current",
    "assignment",
  ]);
  const context = parseContext(input);
  const current = validateCurrent(input.current, context);
  const transition = evaluateTaskTransition("Assign", current);
  if (transition.outcome !== "Allowed") fail("TASK_TRANSITION_DENIED");
  let assignment: TaskAssignmentRecord;
  try {
    assignment = createTaskAssignmentRecord(input.assignment);
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
  if (
    assignment.assignedBy !== context.actorReference ||
    assignment.assignedAt !== context.occurredAt ||
    current.assignmentHistory.some(
      (item) => item.assignmentReference === assignment.assignmentReference,
    )
  )
    fail("TASK_MUTATION_INVALID");
  const next = createTaskRecord({
    ...nextBase(current, context),
    status: "Assigned",
    assignmentHistory: [...current.assignmentHistory, assignment],
    currentAssignment: assignment,
    currentClaim: null,
  });
  return commit("Assign", current, next, context, ports);
}

function exactEligibility(
  value: TaskEligibilityEvidence,
  task: TaskRecord,
  actorReference: ActorReference,
  occurredAt: string,
): TaskEligibilityEvidence {
  let target: TaskAssignmentTarget;
  let scope: TaskScope;
  try {
    if (
      !isExactDataRecord(value, [
        "evidenceReference",
        "actorReference",
        "target",
        "scope",
        "membershipReference",
        "storeAssignmentReference",
        "eligible",
        "checkedAt",
        "validUntil",
      ])
    )
      fail("TASK_ELIGIBILITY_DENIED");
    target = createTaskAssignmentTarget(value.target);
    scope = createTaskScope(value.scope);
  } catch {
    return fail("TASK_ELIGIBILITY_DENIED");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !Object.isFrozen(value) ||
    value.actorReference !== actorReference ||
    target.kind !== task.currentAssignment?.target.kind ||
    target.reference !== task.currentAssignment.target.reference ||
    !sameTaskScope(scope, task.scope) ||
    value.eligible !== true ||
    Date.parse(value.checkedAt) > Date.parse(occurredAt) ||
    Date.parse(occurredAt) >= Date.parse(value.validUntil) ||
    (task.scope.kind === "Store" && value.storeAssignmentReference === null)
  )
    fail("TASK_ELIGIBILITY_DENIED");
  try {
    parseTaskReference(value.evidenceReference);
    parseTaskReference(value.membershipReference);
    if (value.storeAssignmentReference !== null) parseTaskReference(value.storeAssignmentReference);
    parseTaskInstant(value.checkedAt);
    parseTaskInstant(value.validUntil);
  } catch {
    return fail("TASK_ELIGIBILITY_DENIED");
  }
  return value;
}

export interface ClaimTaskInput extends ExistingTaskCommand {
  readonly claimReference: TaskReference;
}

export async function claimTask(input: ClaimTaskInput, ports: TaskPorts): Promise<TaskRecord> {
  exactEnvelope(input, [
    "actorReference",
    "purposeCode",
    "expectedVersion",
    "idempotencyKey",
    "requestDigest",
    "auditId",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "current",
    "claimReference",
  ]);
  const context = parseContext(input);
  const current = validateCurrent(input.current, context);
  const transition = evaluateTaskTransition("Claim", current);
  if (transition.outcome !== "Allowed" || current.currentAssignment === null)
    fail("TASK_TRANSITION_DENIED");
  if (
    current.currentAssignment.target.kind === "User" &&
    String(current.currentAssignment.target.reference) !== String(context.actorReference)
  )
    fail("TASK_ELIGIBILITY_DENIED");
  let evidence: TaskEligibilityEvidence;
  try {
    evidence = await ports.eligibility.resolve({
      actorReference: context.actorReference,
      target: current.currentAssignment.target,
      scope: current.scope,
      evaluatedAt: context.occurredAt,
    });
  } catch {
    return fail("TASK_ELIGIBILITY_DENIED");
  }
  evidence = exactEligibility(evidence, current, context.actorReference, context.occurredAt);
  let claim: TaskClaimRecord;
  try {
    claim = createTaskClaimRecord({
      claimReference: input.claimReference,
      actorReference: context.actorReference,
      eligibilityEvidenceReference: evidence.evidenceReference,
      membershipReference: evidence.membershipReference,
      storeAssignmentReference: evidence.storeAssignmentReference,
      claimedAt: context.occurredAt,
    });
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
  const next = createTaskRecord({
    ...nextBase(current, context),
    status: "Claimed",
    claimHistory: [...current.claimHistory, claim],
    currentClaim: claim,
  });
  return commit("Claim", current, next, context, ports);
}

interface TerminalTaskInput extends ExistingTaskCommand {
  readonly outcome: TaskTerminalOutcome;
}

async function terminateTask(
  operation: "Complete" | "Fail" | "Cancel",
  input: TerminalTaskInput,
  ports: TaskPorts,
): Promise<TaskRecord> {
  const context = parseContext(input);
  const current = validateCurrent(input.current, context);
  let outcome: TaskTerminalOutcome;
  try {
    outcome = createTaskTerminalOutcome(input.outcome);
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
  if (
    outcome.kind !==
      (operation === "Complete" ? "Completed" : operation === "Fail" ? "Failed" : "Cancelled") ||
    outcome.decidedBy !== context.actorReference ||
    outcome.occurredAt !== context.occurredAt
  )
    fail("TASK_MUTATION_INVALID");
  const next = createTaskRecord({
    ...nextBase(current, context),
    status: outcome.kind,
    terminalOutcome: outcome,
  });
  return commit(operation, current, next, context, ports);
}

const terminalFields = [
  "actorReference",
  "purposeCode",
  "expectedVersion",
  "idempotencyKey",
  "requestDigest",
  "auditId",
  "correlationId",
  "occurredAt",
  "sourceChannel",
  "current",
  "outcome",
] as const;

export async function completeTask(
  input: TerminalTaskInput,
  ports: TaskPorts,
): Promise<TaskRecord> {
  exactEnvelope(input, terminalFields);
  return terminateTask("Complete", input, ports);
}

export async function failTask(input: TerminalTaskInput, ports: TaskPorts): Promise<TaskRecord> {
  exactEnvelope(input, terminalFields);
  return terminateTask("Fail", input, ports);
}

export async function cancelTask(input: TerminalTaskInput, ports: TaskPorts): Promise<TaskRecord> {
  exactEnvelope(input, terminalFields);
  return terminateTask("Cancel", input, ports);
}

export interface EscalateTaskInput extends ExistingTaskCommand {
  readonly escalation: TaskEscalationRecord;
}

export async function escalateOverdueTask(
  input: EscalateTaskInput,
  ports: TaskPorts,
): Promise<TaskRecord> {
  exactEnvelope(input, [
    "actorReference",
    "purposeCode",
    "expectedVersion",
    "idempotencyKey",
    "requestDigest",
    "auditId",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "current",
    "escalation",
  ]);
  const context = parseContext(input);
  const current = validateCurrent(input.current, context);
  if (!isTaskOverdue(current, context.occurredAt)) fail("TASK_NOT_OVERDUE");
  let escalation: TaskEscalationRecord;
  try {
    escalation = createTaskEscalationRecord(input.escalation);
  } catch {
    return fail("TASK_MUTATION_INVALID");
  }
  if (
    escalation.level !== current.escalationHistory.length + 1 ||
    escalation.escalatedAt !== context.occurredAt
  )
    fail("TASK_MUTATION_INVALID");
  const next = createTaskRecord({
    ...nextBase(current, context),
    escalationHistory: [...current.escalationHistory, escalation],
  });
  const committed = await commit("Escalate", current, next, context, ports);
  try {
    await ports.notifications.requestEscalation({
      notificationIntentReference: escalation.notificationIntentReference,
      taskReference: committed.taskReference,
      scope: committed.scope,
      priorityCode: committed.priorityCode,
      reasonCode: escalation.reasonCode,
      requestedAt: context.occurredAt,
    });
  } catch {
    // Notification is intentionally non-critical after the atomic Task + Audit commit.
  }
  return committed;
}
