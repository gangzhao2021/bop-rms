import { describe, expect, it, vi } from "vitest";

import {
  createWaitlistEntry,
  createWaitlistService,
  parseReservationInstant,
  parseReservationReference,
  recordWaitlistNotificationOutcome,
  transitionWaitlistEntry,
  type WaitlistAction,
  type WaitlistOperationRecord,
  type WaitlistPorts,
} from "../index.js";

const id = (n: number) => `018fa400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const ref = (n: number) => parseReservationReference(id(n));
const at = (hour: number, minute = 0) =>
  `2026-09-03T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00.000Z`;

function entry(overrides: Record<string, unknown> = {}) {
  return createWaitlistEntry({
    waitlistEntryReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    status: "Waiting",
    joinMode: "Remote",
    partySize: 2,
    contact: {
      displayName: "Synthetic Party",
      contactState: "Verified",
      contactSummary: "Authorized masked contact",
    },
    areaPreferenceCode: null,
    seatingConstraintCodes: [],
    joinedAt: at(10),
    checkedInAt: null,
    calledAt: null,
    responseDeadline: null,
    readyAt: null,
    readyExpiresAt: null,
    readyExtensionUsed: false,
    maxWaitExpiresAt: at(14),
    quotedEstimate: {
      minimumMinutes: 15,
      maximumMinutes: 25,
      calculatedAt: at(10),
      calculationVersion: "ETA_V1",
    },
    currentEstimate: {
      minimumMinutes: 15,
      maximumMinutes: 25,
      calculatedAt: at(10),
      calculationVersion: "ETA_V1",
    },
    priorityKind: "Default",
    priorityReasonCode: null,
    priorityReference: null,
    priorityExpiresAt: null,
    notificationRequestReference: null,
    notificationStatus: "NotRequested",
    diningSessionReference: null,
    terminalReasonCode: null,
    revisionNumber: 1,
    aggregateVersion: 1,
    createdAt: at(10),
    observedAt: at(10),
    ...overrides,
  });
}

const noEvidence = () => ({
  reasonCode: null,
  evidenceReference: null,
  deadline: null,
  eligibleAt: null,
  notificationRequestReference: null,
  diningSessionReference: null,
});

function fixture(
  options: {
    readonly denied?: boolean;
    readonly collaboration?: boolean;
    readonly initial?: ReturnType<typeof entry>;
  } = {},
) {
  let aggregate = options.initial ?? null;
  const operations = new Map<string, WaitlistOperationRecord>();
  const repositoryReads = vi.fn();
  const collaborators = vi.fn(async () => options.collaboration !== false);
  const ports: WaitlistPorts = {
    authorization: {
      async authorize(input) {
        if (options.denied) return null;
        return {
          tenantReference: ref(2),
          brandReference: ref(3),
          storeReference: ref(4),
          actorReference: ref(5),
          purpose: "waitlist-management",
          permission: { effect: "Allow", action: "dining.operate", scopeKind: "Store" },
          audit: {
            auditId: id(6),
            brandId: id(3),
            storeId: id(4),
            actor: { type: "User", reference: id(5) },
            actionCode: `WAITLIST_${input.action.toUpperCase()}`,
            targetType: "WaitlistEntry",
            targetId: id(1),
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: id(7),
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        };
      },
    },
    references: {
      hashIntent(value) {
        let state = 2166136261;
        for (const character of value) {
          state ^= character.charCodeAt(0);
          state = Math.imul(state, 16777619);
        }
        return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
      },
      equals: (left, right) => left === right,
    },
    collaborators: {
      validateJoin: collaborators,
      validateEstimate: collaborators,
      validatePriority: collaborators,
      validateNotificationOutcome: collaborators,
      validateDiningResult: collaborators,
    },
    repository: {
      async resolveOperation(reference) {
        repositoryReads();
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        repositoryReads();
        return aggregate?.waitlistEntryReference === reference ? aggregate : null;
      },
      async commit(record) {
        aggregate = record.entry;
        operations.set(record.operationReference, record);
      },
    },
  };
  return {
    execute: createWaitlistService(ports).execute,
    current: () => aggregate,
    repositoryReads,
    collaborators,
    operation: (reference = id(10)) => operations.get(reference),
  };
}

function command(
  action: WaitlistAction,
  candidate: ReturnType<typeof entry>,
  overrides: Record<string, unknown> = {},
) {
  return {
    action,
    operationReference: id(10),
    expectedAggregateVersion: action === "Join" ? null : candidate.aggregateVersion - 1,
    candidate,
    evidence:
      action === "Join"
        ? { ...noEvidence(), evidenceReference: id(40) }
        : action === "CheckIn"
          ? null
          : noEvidence(),
    observedAt: candidate.observedAt,
    ...overrides,
  };
}

describe("Waitlist application service", () => {
  it("authorizes before reads and replays one Join intent", async () => {
    const denied = fixture({ denied: true });
    await expect(denied.execute(command("Join", entry()))).rejects.toThrowError(
      expect.objectContaining({ code: "WAITLIST_PERMISSION_DENIED" }),
    );
    expect(denied.repositoryReads).not.toHaveBeenCalled();

    const allowed = fixture();
    const input = command("Join", entry());
    await expect(allowed.execute(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(allowed.execute(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
    expect(allowed.operation()?.event).toMatchObject({ eventType: "WaitlistEntryJoined" });
  });

  it("calls the party while leaving Notification delivery independent", async () => {
    const context = fixture();
    await context.execute(command("Join", entry()));
    const called = transitionWaitlistEntry(entry(), "Call", {
      observedAt: parseReservationInstant(at(10, 5)),
      reasonCode: null,
      deadline: parseReservationInstant(at(10, 15)),
      eligibleAt: null,
      notificationRequestReference: ref(20),
      diningSessionReference: null,
    });
    await context.execute(
      command("Call", called, {
        operationReference: id(11),
        evidence: {
          ...noEvidence(),
          deadline: at(10, 15),
          notificationRequestReference: id(20),
        },
      }),
    );
    const failed = recordWaitlistNotificationOutcome(
      called,
      createWaitlistEntry({
        ...called,
        notificationStatus: "Failed",
        aggregateVersion: 3,
        observedAt: at(10, 6),
      }),
      parseReservationInstant(at(10, 6)),
    );
    await context.execute(
      command("RecordNotificationOutcome", failed, {
        operationReference: id(12),
        evidence: { ...noEvidence(), evidenceReference: id(21) },
      }),
    );
    expect(context.current()).toMatchObject({ status: "Called", notificationStatus: "Failed" });
    expect(context.collaborators).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Dining result evidence is not authoritative", async () => {
    const ready = entry({
      status: "Ready",
      checkedInAt: at(10),
      calledAt: at(10),
      responseDeadline: at(10, 10),
      readyAt: at(10, 5),
      readyExpiresAt: at(10, 20),
    });
    const context = fixture({ collaboration: false, initial: ready });
    const seated = transitionWaitlistEntry(ready, "RecordSeated", {
      observedAt: parseReservationInstant(at(10, 6)),
      reasonCode: null,
      deadline: null,
      eligibleAt: null,
      notificationRequestReference: null,
      diningSessionReference: ref(30),
    });
    await expect(
      context.execute(
        command("RecordSeated", seated, {
          evidence: {
            ...noEvidence(),
            evidenceReference: id(31),
            diningSessionReference: id(30),
          },
        }),
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: "WAITLIST_LIFECYCLE_CONFLICT" }));
    expect(context.current()).toMatchObject({ status: "Ready", diningSessionReference: null });
  });
});
