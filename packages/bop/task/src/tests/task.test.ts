import type { ActorReference } from "@bop/identity";
import type { MembershipReference, StoreAssignmentReference } from "@bop/membership";
import { parsePolicyReference, parsePolicyVersion, type PermissionDecision } from "@bop/permission";
import { describe, expect, it } from "vitest";
import {
  TaskContractError,
  TaskServiceError,
  assignTask,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  createTaskRecord,
  createTaskScope,
  escalateOverdueTask,
  failTask,
  parseTaskCode,
  parseTaskDigest,
  parseTaskInstant,
  parseTaskReference,
  parseTaskVersion,
  type TaskAssignmentRecord,
  type TaskEscalationRecord,
  type TaskRecord,
  type TaskReference,
  type TaskTerminalOutcome,
} from "../index.js";
import type {
  CommitTaskMutationInput,
  RequestTaskEscalationNotificationInput,
  TaskAuthorizationRequest,
  TaskEligibilityEvidence,
  TaskPorts,
} from "../application/ports/task-ports.js";

function reference(sequence: number): TaskReference {
  return parseTaskReference(`018f0000-0000-7000-8000-${sequence.toString().padStart(12, "0")}`);
}

const actor = reference(1) as unknown as ActorReference;
const otherActor = reference(2) as unknown as ActorReference;
const brand = reference(3);
const store = reference(4);
const source = reference(5);
const policy = reference(6);
const digest = `sha256:${"a".repeat(64)}`;
const createdAt = "2026-07-29T10:00:00.000Z";
const assignedAt = "2026-07-29T10:10:00.000Z";
const claimedAt = "2026-07-29T10:20:00.000Z";
const completedAt = "2026-07-29T10:30:00.000Z";
const dueAt = "2026-07-29T11:00:00.000Z";
const overdueAt = "2026-07-29T11:00:00.001Z";

function openTask(overrides: Partial<Record<string, unknown>> = {}): TaskRecord {
  return createTaskRecord({
    taskReference: reference(10),
    scope: { kind: "Store", brandReference: brand, storeReference: store },
    source: {
      sourceType: "PAYMENT_EXCEPTION",
      sourceReference: source,
      snapshotDigest: digest,
    },
    taskType: "REVIEW_PAYMENT",
    severityCode: "HIGH",
    priorityCode: "URGENT",
    status: "Open",
    assignmentHistory: [],
    currentAssignment: null,
    claimHistory: [],
    currentClaim: null,
    dueAt,
    escalationPolicyReference: policy,
    escalationHistory: [],
    terminalOutcome: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}

function assignment(
  targetKind: "User" | "Role" | "Position" | "Queue" = "Queue",
  targetReference: TaskReference = reference(20),
): TaskAssignmentRecord {
  return {
    assignmentReference: reference(21),
    target: { kind: targetKind, reference: targetReference },
    assignedBy: actor,
    assignedAt: parseTaskInstant(assignedAt),
    reasonCode: parseTaskCode("SUPERVISOR_ASSIGNMENT"),
  };
}

function outcome(
  kind: "Completed" | "Failed" | "Cancelled",
  at = completedAt,
): TaskTerminalOutcome {
  return {
    outcomeReference: reference(kind === "Completed" ? 40 : kind === "Failed" ? 41 : 42),
    kind,
    resultCode: parseTaskCode(`${kind.toUpperCase()}_RESULT`),
    completionReference: kind === "Completed" ? reference(43) : null,
    decidedBy: actor,
    occurredAt: at as TaskTerminalOutcome["occurredAt"],
  };
}

function escalation(level = 1): TaskEscalationRecord {
  return {
    escalationReference: reference(50 + level),
    notificationIntentReference: reference(
      60 + level,
    ) as unknown as TaskEscalationRecord["notificationIntentReference"],
    level,
    escalatedAt: overdueAt as TaskEscalationRecord["escalatedAt"],
    reasonCode: parseTaskCode("TASK_OVERDUE"),
  };
}

function context(version: number, occurredAt: string, seed: number) {
  return {
    actorReference: actor,
    purposeCode: parseTaskCode("TASK_OPERATION"),
    expectedVersion: parseTaskVersion(version),
    idempotencyKey: reference(100 + seed),
    requestDigest: parseTaskDigest(`sha256:${seed.toString(16).padStart(64, "0")}`),
    auditId: reference(200 + seed),
    correlationId: reference(300 + seed),
    occurredAt,
    sourceChannel: parseTaskCode("MERCHANT_WEB"),
  };
}

interface FakeState {
  readonly commits: CommitTaskMutationInput[];
  readonly notifications: RequestTaskEscalationNotificationInput[];
  readonly authorizationRequests: TaskAuthorizationRequest[];
  deny: boolean;
  ineligible: boolean;
  staleEligibility: boolean;
  notificationFails: boolean;
  commitFails: boolean;
}

function fakePorts(): { readonly ports: TaskPorts; readonly state: FakeState } {
  const state: FakeState = {
    commits: [],
    notifications: [],
    authorizationRequests: [],
    deny: false,
    ineligible: false,
    staleEligibility: false,
    notificationFails: false,
    commitFails: false,
  };
  const committed = new Map<string, string>();
  const ports: TaskPorts = {
    authorization: {
      async authorize(request): Promise<PermissionDecision> {
        state.authorizationRequests.push(request);
        return Object.freeze({
          effect: state.deny ? "Deny" : "Allow",
          reason: state.deny ? "DEFAULT_DENY" : "EXPLICIT_ALLOW",
          source: state.deny ? "DefaultDeny" : "ExplicitAllow",
          action: request.action,
          scopeKind: request.scope.kind,
          policySnapshotReference: parsePolicyReference(reference(400)),
          policyVersion: parsePolicyVersion(1),
          audit: Object.freeze({
            effect: state.deny ? "Deny" : "Allow",
            reason: state.deny ? "DEFAULT_DENY" : "EXPLICIT_ALLOW",
            source: state.deny ? "DefaultDeny" : "ExplicitAllow",
          }),
        });
      },
    },
    eligibility: {
      async resolve(input): Promise<TaskEligibilityEvidence> {
        return Object.freeze({
          evidenceReference: reference(401),
          actorReference: input.actorReference,
          target: Object.freeze({ ...input.target }),
          scope: Object.freeze({ ...input.scope }),
          membershipReference: reference(402) as unknown as MembershipReference,
          storeAssignmentReference: reference(403) as unknown as StoreAssignmentReference,
          eligible: !state.ineligible,
          checkedAt: state.staleEligibility ? "2026-07-29T09:00:00.000Z" : assignedAt,
          validUntil: state.staleEligibility ? assignedAt : dueAt,
        });
      },
    },
    unitOfWork: {
      async commit(input): Promise<void> {
        if (state.commitFails) throw new Error("synthetic persistence detail");
        const key = `${input.next.scope.brandReference}:${input.operation}:${input.next.taskReference}:${input.idempotencyKey}`;
        const prior = committed.get(key);
        if (prior !== undefined && prior !== input.requestDigest)
          throw new Error("conflicting replay");
        if (prior === undefined) {
          committed.set(key, input.requestDigest);
          state.commits.push(input);
        }
      },
    },
    notifications: {
      async requestEscalation(input): Promise<void> {
        if (state.notificationFails) throw new Error("provider detail must not escape");
        state.notifications.push(input);
      },
    },
  };
  return { ports, state };
}

async function assignedTask(
  fixture: ReturnType<typeof fakePorts>,
  targetKind: "User" | "Role" | "Position" | "Queue" = "Queue",
  targetReference?: TaskReference,
): Promise<TaskRecord> {
  return assignTask(
    {
      ...context(1, assignedAt, 1),
      current: openTask(),
      assignment: assignment(targetKind, targetReference),
    },
    fixture.ports,
  );
}

async function claimedTask(
  fixture: ReturnType<typeof fakePorts>,
  targetKind: "User" | "Role" | "Position" | "Queue" = "Queue",
  targetReference?: TaskReference,
): Promise<TaskRecord> {
  const assigned = await assignedTask(fixture, targetKind, targetReference);
  return claimTask(
    {
      ...context(2, claimedAt, 2),
      current: assigned,
      claimReference: reference(30),
    },
    fixture.ports,
  );
}

describe("WP-0125 Task minimum contract", () => {
  it("validates exact Brand and Store scopes", () => {
    expect(createTaskScope({ kind: "Brand", brandReference: brand, storeReference: null })).toEqual(
      { kind: "Brand", brandReference: brand, storeReference: null },
    );
    expect(() =>
      createTaskScope({ kind: "Brand", brandReference: brand, storeReference: store }),
    ).toThrowError(TaskContractError);
    expect(() =>
      createTaskScope({
        kind: "Store",
        brandReference: brand,
        storeReference: store,
        tenantName: "forbidden",
      }),
    ).toThrowError(TaskContractError);
  });

  it("accepts a frozen opaque Open record", () => {
    const task = openTask();
    expect(Object.isFrozen(task)).toBe(true);
    expect(task.status).toBe("Open");
    expect(task.source).toEqual({
      sourceType: "PAYMENT_EXCEPTION",
      sourceReference: source,
      snapshotDigest: digest,
    });
  });

  it("rejects free-form body and malformed source digest", () => {
    expect(() => openTask({ body: "customer data" })).toThrowError(TaskContractError);
    expect(() =>
      openTask({
        source: {
          sourceType: "PAYMENT_EXCEPTION",
          sourceReference: source,
          snapshotDigest: "raw-payload",
        },
      }),
    ).toThrowError(TaskContractError);
  });

  it("creates an exact-scope Task with atomic Audit metadata", async () => {
    const fixture = fakePorts();
    const task = await createTask({ ...context(1, createdAt, 0), task: openTask() }, fixture.ports);
    expect(task.status).toBe("Open");
    expect(fixture.state.commits).toHaveLength(1);
    expect(fixture.state.commits[0]?.audit).toMatchObject({
      brandId: brand,
      storeId: store,
      actionCode: "TASK_CREATED",
      targetType: "Task",
      targetId: task.taskReference,
    });
    expect(fixture.state.authorizationRequests[0]?.scope).toEqual(task.scope);
  });

  it("fails closed when Permission denies", async () => {
    const fixture = fakePorts();
    fixture.state.deny = true;
    await expect(
      createTask({ ...context(1, createdAt, 0), task: openTask() }, fixture.ports),
    ).rejects.toMatchObject({ code: "TASK_PERMISSION_DENIED" });
    expect(fixture.state.commits).toHaveLength(0);
  });

  it("rejects malformed command envelopes", async () => {
    const fixture = fakePorts();
    await expect(
      createTask(
        {
          ...context(1, createdAt, 0),
          task: openTask(),
          sourcePayload: "forbidden",
        } as Parameters<typeof createTask>[0],
        fixture.ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_MUTATION_INVALID" });
  });

  it("assigns User, Role, Position and Queue targets with append-only history", async () => {
    for (const kind of ["User", "Role", "Position", "Queue"] as const) {
      const fixture = fakePorts();
      const target = kind === "User" ? (actor as unknown as TaskReference) : reference(20);
      const task = await assignedTask(fixture, kind, target);
      expect(task.status).toBe("Assigned");
      expect(task.currentAssignment?.target.kind).toBe(kind);
      expect(task.assignmentHistory).toHaveLength(1);
      expect(task.currentClaim).toBeNull();
    }
  });

  it("rejects stale expected version before assignment", async () => {
    const fixture = fakePorts();
    await expect(
      assignTask(
        {
          ...context(2, assignedAt, 1),
          current: openTask(),
          assignment: assignment(),
        },
        fixture.ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_MUTATION_INVALID" });
  });

  it("preserves prior Claim history when a supervisor reassigns work", async () => {
    const fixture = fakePorts();
    const claimed = await claimedTask(fixture);
    const reassignedAt = "2026-07-29T10:40:00.000Z";
    const task = await assignTask(
      {
        ...context(3, reassignedAt, 8),
        current: claimed,
        assignment: {
          assignmentReference: reference(22),
          target: { kind: "Role", reference: reference(23) },
          assignedBy: actor,
          assignedAt: parseTaskInstant(reassignedAt),
          reasonCode: parseTaskCode("SUPERVISOR_REASSIGNMENT"),
        },
      },
      fixture.ports,
    );
    expect(task.status).toBe("Assigned");
    expect(task.claimHistory).toHaveLength(1);
    expect(task.currentClaim).toBeNull();
    expect(task.assignmentHistory).toHaveLength(2);
  });

  it("claims Queue work with current exact-scope Membership evidence", async () => {
    const fixture = fakePorts();
    const task = await claimedTask(fixture);
    expect(task.status).toBe("Claimed");
    expect(task.currentClaim).toMatchObject({
      actorReference: actor,
      eligibilityEvidenceReference: reference(401),
      membershipReference: reference(402),
      storeAssignmentReference: reference(403),
    });
  });

  it("restricts User-targeted work to the assigned Actor", async () => {
    const fixture = fakePorts();
    const assigned = await assignedTask(fixture, "User", otherActor as unknown as TaskReference);
    await expect(
      claimTask(
        {
          ...context(2, claimedAt, 2),
          current: assigned,
          claimReference: reference(30),
        },
        fixture.ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_ELIGIBILITY_DENIED" });
  });

  it("does not treat Membership eligibility as Permission", async () => {
    const fixture = fakePorts();
    fixture.state.deny = true;
    const assigned = createTaskRecord({
      ...openTask(),
      status: "Assigned",
      assignmentHistory: [assignment()],
      currentAssignment: assignment(),
      version: 2,
      updatedAt: assignedAt,
    });
    await expect(
      claimTask(
        {
          ...context(2, claimedAt, 2),
          current: assigned,
          claimReference: reference(30),
        },
        fixture.ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_PERMISSION_DENIED" });
  });

  it("rejects ineligible and stale Membership evidence", async () => {
    for (const mode of ["ineligible", "stale"] as const) {
      const fixture = fakePorts();
      if (mode === "ineligible") fixture.state.ineligible = true;
      else fixture.state.staleEligibility = true;
      const assigned = await assignedTask(fixture);
      await expect(
        claimTask(
          {
            ...context(2, claimedAt, 2),
            current: assigned,
            claimReference: reference(30),
          },
          fixture.ports,
        ),
      ).rejects.toMatchObject({ code: "TASK_ELIGIBILITY_DENIED" });
    }
  });

  it("rejects Membership evidence carrying undeclared personal fields", async () => {
    const fixture = fakePorts();
    const assigned = await assignedTask(fixture);
    const original = fixture.ports.eligibility.resolve;
    const ports: TaskPorts = {
      ...fixture.ports,
      eligibility: {
        async resolve(input) {
          return Object.freeze({
            ...(await original(input)),
            employeeEmail: "forbidden@example.invalid",
          }) as TaskEligibilityEvidence;
        },
      },
    };
    await expect(
      claimTask(
        {
          ...context(2, claimedAt, 2),
          current: assigned,
          claimReference: reference(30),
        },
        ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_ELIGIBILITY_DENIED" });
  });

  it("rejects history timestamps later than the record version timestamp", () => {
    expect(() =>
      createTaskRecord({
        ...openTask(),
        status: "Assigned",
        assignmentHistory: [assignment()],
        currentAssignment: assignment(),
        version: 2,
        updatedAt: createdAt,
      }),
    ).toThrowError(TaskContractError);
  });

  it("rejects version-one records carrying pre-existing history or later updates", () => {
    expect(() => openTask({ updatedAt: assignedAt })).toThrowError(TaskContractError);
  });

  it("completes claimed work with only an opaque completion reference", async () => {
    const fixture = fakePorts();
    const claimed = await claimedTask(fixture);
    const task = await completeTask(
      {
        ...context(3, completedAt, 3),
        current: claimed,
        outcome: outcome("Completed"),
      },
      fixture.ports,
    );
    expect(task.status).toBe("Completed");
    expect(task.terminalOutcome?.completionReference).toBe(reference(43));
    expect(task.source).toEqual(claimed.source);
  });

  it("makes repeated same-command Completion idempotent at the unit of work", async () => {
    const fixture = fakePorts();
    const claimed = await claimedTask(fixture);
    const command = {
      ...context(3, completedAt, 3),
      current: claimed,
      outcome: outcome("Completed"),
    };
    const first = await completeTask(command, fixture.ports);
    const second = await completeTask(command, fixture.ports);
    expect(second).toEqual(first);
    expect(fixture.state.commits.filter((item) => item.operation === "Complete")).toHaveLength(1);
  });

  it("records Failed and Cancelled terminal outcomes without completion references", async () => {
    const failedFixture = fakePorts();
    const claimed = await claimedTask(failedFixture);
    const failed = await failTask(
      {
        ...context(3, completedAt, 4),
        current: claimed,
        outcome: outcome("Failed"),
      },
      failedFixture.ports,
    );
    expect(failed.terminalOutcome).toMatchObject({ kind: "Failed", completionReference: null });

    const cancelFixture = fakePorts();
    const cancelled = await cancelTask(
      {
        ...context(1, assignedAt, 5),
        current: openTask(),
        outcome: outcome("Cancelled", assignedAt),
      },
      cancelFixture.ports,
    );
    expect(cancelled.status).toBe("Cancelled");
  });

  it("prevents terminal Tasks from being reassigned or reopened", async () => {
    const fixture = fakePorts();
    const claimed = await claimedTask(fixture);
    const completed = await completeTask(
      {
        ...context(3, completedAt, 3),
        current: claimed,
        outcome: outcome("Completed"),
      },
      fixture.ports,
    );
    await expect(
      assignTask(
        {
          ...context(4, "2026-07-29T10:40:00.000Z", 6),
          current: completed,
          assignment: {
            ...assignment(),
            assignmentReference: reference(22),
            assignedAt: parseTaskInstant("2026-07-29T10:40:00.000Z"),
          },
        },
        fixture.ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_DENIED" });
  });

  it("requires an explicit instant strictly after due time for escalation", async () => {
    const fixture = fakePorts();
    const assigned = await assignedTask(fixture);
    await expect(
      escalateOverdueTask(
        {
          ...context(2, dueAt, 7),
          current: assigned,
          escalation: { ...escalation(), escalatedAt: parseTaskInstant(dueAt) },
        },
        fixture.ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_NOT_OVERDUE" });
  });

  it("appends sequential escalation history and requests only opaque Notification intent", async () => {
    const fixture = fakePorts();
    const assigned = await assignedTask(fixture);
    const task = await escalateOverdueTask(
      {
        ...context(2, overdueAt, 7),
        current: assigned,
        escalation: escalation(),
      },
      fixture.ports,
    );
    expect(task.escalationHistory).toHaveLength(1);
    expect(task.status).toBe("Assigned");
    expect(fixture.state.notifications[0]).toEqual({
      notificationIntentReference: reference(61),
      taskReference: task.taskReference,
      scope: task.scope,
      priorityCode: task.priorityCode,
      reasonCode: "TASK_OVERDUE",
      requestedAt: overdueAt,
    });
    expect(Object.keys(fixture.state.notifications[0] ?? {})).not.toContain("sourcePayload");
  });

  it("does not roll back escalation when Notification fails", async () => {
    const fixture = fakePorts();
    fixture.state.notificationFails = true;
    const assigned = await assignedTask(fixture);
    const task = await escalateOverdueTask(
      {
        ...context(2, overdueAt, 7),
        current: assigned,
        escalation: escalation(),
      },
      fixture.ports,
    );
    expect(task.escalationHistory).toHaveLength(1);
    expect(fixture.state.commits.at(-1)?.operation).toBe("Escalate");
  });

  it("rejects skipped escalation levels", async () => {
    const fixture = fakePorts();
    const assigned = await assignedTask(fixture);
    await expect(
      escalateOverdueTask(
        {
          ...context(2, overdueAt, 7),
          current: assigned,
          escalation: escalation(2),
        },
        fixture.ports,
      ),
    ).rejects.toMatchObject({ code: "TASK_MUTATION_INVALID" });
  });

  it("maps unit-of-work failures to a bounded error without leaking detail", async () => {
    const fixture = fakePorts();
    fixture.state.commitFails = true;
    const error = await createTask(
      { ...context(1, createdAt, 0), task: openTask() },
      fixture.ports,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TaskServiceError);
    expect(error).toMatchObject({ code: "TASK_COMMIT_FAILED" });
    expect(String(error)).not.toContain("synthetic persistence detail");
  });
});
