import type { AppendAuditRecordInput } from "@bop/audit";
import type { ActorReference } from "@bop/identity";
import type { MembershipReference, StoreAssignmentReference } from "@bop/membership";
import type { NotificationReference } from "@bop/notification";
import type { BusinessAction, PermissionDecision } from "@bop/permission";
import type {
  TaskAssignmentTarget,
  TaskCode,
  TaskDigest,
  TaskRecord,
  TaskReference,
  TaskScope,
  TaskVersion,
} from "../../contracts/task.js";
import type { TaskOperation } from "../../domain/task-lifecycle.js";

export interface TaskAuthorizationRequest {
  readonly actorReference: ActorReference;
  readonly action: BusinessAction;
  readonly scope: TaskScope;
  readonly taskReference: TaskReference;
  readonly purposeCode: TaskCode;
  readonly expectedVersion: TaskVersion;
  readonly evaluatedAt: string;
}

export interface TaskAuthorizationPort {
  authorize(request: TaskAuthorizationRequest): Promise<PermissionDecision>;
}

export interface ResolveTaskEligibilityInput {
  readonly actorReference: ActorReference;
  readonly target: TaskAssignmentTarget;
  readonly scope: TaskScope;
  readonly evaluatedAt: string;
}

export interface TaskEligibilityEvidence {
  readonly evidenceReference: TaskReference;
  readonly actorReference: ActorReference;
  readonly target: TaskAssignmentTarget;
  readonly scope: TaskScope;
  readonly membershipReference: MembershipReference;
  readonly storeAssignmentReference: StoreAssignmentReference | null;
  readonly eligible: boolean;
  readonly checkedAt: string;
  readonly validUntil: string;
}

export interface TaskEligibilityPort {
  resolve(input: ResolveTaskEligibilityInput): Promise<TaskEligibilityEvidence>;
}

export interface CommitTaskMutationInput {
  readonly operation: TaskOperation;
  readonly expectedVersion: TaskVersion;
  readonly idempotencyKey: TaskReference;
  readonly requestDigest: TaskDigest;
  readonly current: TaskRecord | null;
  readonly next: TaskRecord;
  readonly audit: AppendAuditRecordInput;
}

export interface TaskUnitOfWorkPort {
  /**
   * Atomically enforces scope + operation + Task + idempotency key + request digest, checks the
   * authoritative expected version, appends immutable assignment/escalation/outcome history, writes
   * the next Task version, and appends Audit. Same-command replay returns the original result;
   * conflicting replay, stale version, partial write, or history rewrite fails the transaction.
   */
  commit(input: CommitTaskMutationInput): Promise<void>;
}

export interface RequestTaskEscalationNotificationInput {
  readonly notificationIntentReference: NotificationReference;
  readonly taskReference: TaskReference;
  readonly scope: TaskScope;
  readonly priorityCode: TaskCode;
  readonly reasonCode: TaskCode;
  readonly requestedAt: string;
}

export interface TaskNotificationPort {
  /**
   * Requests Notification after the Task escalation commit. Failure is non-critical and cannot
   * roll back or otherwise change the Task or its source business fact.
   */
  requestEscalation(input: RequestTaskEscalationNotificationInput): Promise<void>;
}

export interface TaskPorts {
  readonly authorization: TaskAuthorizationPort;
  readonly eligibility: TaskEligibilityPort;
  readonly unitOfWork: TaskUnitOfWorkPort;
  readonly notifications: TaskNotificationPort;
}
