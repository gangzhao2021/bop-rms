import { createTaskRecord } from "@bop/task";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import { describe, expect, it, vi } from "vitest";

import {
  beginDiningClosing,
  createDiningClosingService,
  DiningClosingError,
  mayAdmitNewBatch,
  parseDiningClosureEvidence,
  type DiningClosingOperationRecord,
  type DiningClosingPorts,
  type DiningSession,
} from "../index.js";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing fixture");
  return value;
}

const id = (sequence: number) =>
  `018f3000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`;
const ids = {
  actor: id(1),
  brand: id(2),
  store: id(3),
  table: id(4),
  session: id(5),
  participant: id(6),
  guest: id(7),
  begin: id(8),
  cancel: id(9),
  finalize: id(10),
  orderOne: id(11),
  orderTwo: id(12),
  batchOne: id(13),
  batchTwo: id(14),
  finality: id(15),
  taskOne: id(16),
  taskTwo: id(17),
  policy: id(18),
  audit: id(19),
  correlation: id(20),
  assignment: id(21),
  managerQueue: id(22),
} as const;
const at = "2026-07-30T12:00:00.000Z";
const later = "2026-07-30T12:01:00.000Z";
const evidenceDigest = "e".repeat(64);

function session(phase: DiningSession["phase"] = "Active", version = 2): DiningSession {
  return Object.freeze({
    diningSessionReference: ids.session,
    brandReference: ids.brand,
    storeReference: ids.store,
    tableReference: ids.table,
    tableAssignmentVersion: 7,
    phase,
    version,
    startedByActorReference: ids.actor,
    startedAt: "2026-07-30T11:00:00.000Z",
    hostParticipantReference: ids.participant,
  }) as DiningSession;
}

function audit(operation: "Begin" | "Cancel" | "Finalize", actor = ids.guest) {
  return {
    auditId: ids.audit,
    brandId: ids.brand,
    storeId: ids.store,
    actor: { type: "User" as const, reference: actor },
    actionCode: `DINING_SESSION_CLOSING_${operation.toUpperCase()}`,
    targetType: "DiningSession",
    targetId: ids.session,
    beforeSummary: {},
    afterSummary: {},
    reasonCode: "AUTHORIZED_OPERATION",
    correlationId: ids.correlation,
    occurredAt: at,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
}

function digest(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return (state >>> 0).toString(16).padStart(8, "0").repeat(8);
}

type Financial = "Settled" | "AuthorizedWriteOff" | "Unpaid" | "Indeterminate";

function order(
  orderReference: string,
  batchReference: string,
  financialClass: Financial,
  executionState = "Fulfilled",
) {
  const unresolved = financialClass === "Unpaid" || financialClass === "Indeterminate";
  return {
    orderReference,
    orderClosureStatus: unresolved ? "Open" : "Closed",
    batches: [{ batchReference, executionState }],
    financialClass,
    ownerFinalityReference: unresolved ? null : ids.finality,
    ownerDecidedAt: unresolved ? null : at,
  };
}

function closure(orders: readonly ReturnType<typeof order>[] = []) {
  return {
    diningSessionReference: ids.session,
    brandReference: ids.brand,
    storeReference: ids.store,
    evidenceVersion: 4,
    evidenceDigest,
    observedAt: at,
    orders,
  };
}

function openTask(taskReference: string) {
  return createTaskRecord({
    taskReference,
    scope: { kind: "Store", brandReference: ids.brand, storeReference: ids.store },
    source: {
      sourceType: "DINING_SESSION",
      sourceReference: ids.session,
      snapshotDigest: `sha256:${evidenceDigest}`,
    },
    taskType: "DINING_UNPAID_BATCH_EXCEPTION",
    severityCode: "CRITICAL",
    priorityCode: "CRITICAL",
    status: "Assigned",
    assignmentHistory: [
      {
        assignmentReference: ids.assignment,
        target: { kind: "Queue", reference: ids.managerQueue },
        assignedBy: ids.actor,
        assignedAt: at,
        reasonCode: "MANAGER_QUEUE_ASSIGNMENT",
      },
    ],
    currentAssignment: {
      assignmentReference: ids.assignment,
      target: { kind: "Queue", reference: ids.managerQueue },
      assignedBy: ids.actor,
      assignedAt: at,
      reasonCode: "MANAGER_QUEUE_ASSIGNMENT",
    },
    claimHistory: [],
    currentClaim: null,
    dueAt: later,
    escalationPolicyReference: ids.policy,
    escalationHistory: [],
    terminalOutcome: null,
    version: 2,
    createdAt: at,
    updatedAt: at,
  });
}

function tenantContext() {
  const brand = createBrand({
    brandReference: ids.brand,
    code: "DINING",
    displayName: "Dining Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: ids.store,
    brandReference: ids.brand,
    code: "DINING-1",
    displayName: "Dining Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    brand,
    store,
    at,
  );
}

function fixture(
  options: {
    phase?: DiningSession["phase"];
    version?: number;
    authority?: "Host" | "Staff" | "Denied" | "WrongHost";
    reversibility?: "Reversible" | "Irreversible" | "Indeterminate" | "Unavailable";
    closure?: ReturnType<typeof closure>;
    badTask?: boolean;
  } = {},
) {
  let current = session(options.phase ?? "Active", options.version ?? 2);
  const operations = new Map<string, DiningClosingOperationRecord>();
  const ensured: string[] = [];
  const ports: DiningClosingPorts = {
    authorization: {
      async authorize(input) {
        if (options.authority === "Denied") return null;
        if (options.authority === "Staff") {
          return {
            kind: "Staff",
            tenantContext: tenantContext(),
            permission: Object.freeze({
              effect: "Allow",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
              action: "dining.session.close",
              scopeKind: "Store",
              policySnapshotReference: ids.policy,
              policyVersion: 1,
              audit: Object.freeze({
                effect: "Allow",
                reason: "ROLE_PERMISSION",
                source: "RolePermission",
              }),
            }),
            audit: audit(input.operation, ids.actor),
          } as never;
        }
        return {
          kind: "Host",
          guestSessionReference: ids.guest,
          participantReference: options.authority === "WrongHost" ? id(99) : ids.participant,
          diningSessionReference: ids.session,
          storeReference: ids.store,
          status: "CurrentHost",
          observedAt: input.observedAt,
          audit: {
            ...audit(input.operation),
            occurredAt: input.observedAt,
            actor: { type: "System" },
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
          },
        } as never;
      },
    },
    closureEvidence: {
      async resolve() {
        return parseDiningClosureEvidence(options.closure ?? closure());
      },
    },
    reversibility: {
      async evaluate() {
        return options.reversibility ?? "Reversible";
      },
    },
    tasks: {
      async ensure(input) {
        ensured.push(input.orderReference);
        const taskReference = input.orderReference === ids.orderOne ? ids.taskOne : ids.taskTwo;
        const task = openTask(taskReference);
        return {
          orderReference: (options.badTask ? ids.orderTwo : input.orderReference) as never,
          evidenceVersion: input.evidenceVersion,
          intentHash: input.intentHash,
          task,
        };
      },
    },
    hashes: {
      hashIntent: (value) => digest(value) as never,
      equals: (left, right) => left === right,
    },
    store: {
      async load(reference) {
        return reference === current.diningSessionReference ? current : null;
      },
      async resolveOperation(reference) {
        return operations.get(reference) ?? null;
      },
      async commit(input) {
        if (input.expectedSessionVersion !== current.version)
          throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
        current = input.record.session;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return {
    service: createDiningClosingService(ports),
    ensured,
    ports,
    operations,
    current: () => current,
  };
}

function command(operationReference: string, expectedSessionVersion: number) {
  return {
    diningSessionReference: ids.session,
    expectedSessionVersion,
    operationReference,
    requestedAt: at,
  };
}

describe("Dining Closing phase and authority", () => {
  it("admits new Batch only while Active and locks immediately on begin", async () => {
    const state = fixture();
    expect(mayAdmitNewBatch(state.current())).toBe(true);
    const result = await state.service.begin(command(ids.begin, 2));
    expect(result).toMatchObject({ status: "Applied", session: { phase: "Closing", version: 3 } });
    expect(mayAdmitNewBatch(result.session)).toBe(false);
    await expect(state.service.begin(command(id(80), 3))).rejects.toMatchObject({
      code: "DINING_CLOSING_PHASE_CONFLICT",
    });
  });

  it("accepts exact current Host or Store-scoped Staff and rejects wrong Host", async () => {
    await expect(fixture().service.begin(command(ids.begin, 2))).resolves.toMatchObject({
      session: { phase: "Closing" },
    });
    await expect(
      fixture({ authority: "Staff" }).service.begin(command(ids.begin, 2)),
    ).resolves.toMatchObject({ session: { phase: "Closing" } });
    await expect(
      fixture({ authority: "WrongHost" }).service.begin(command(ids.begin, 2)),
    ).rejects.toMatchObject({ code: "DINING_CLOSING_PERMISSION_DENIED" });
  });

  it("replays exact intent and rejects a changed operation intent", async () => {
    const state = fixture();
    await state.service.begin(command(ids.begin, 2));
    await expect(state.service.begin(command(ids.begin, 2))).resolves.toMatchObject({
      status: "AlreadyApplied",
    });
    await expect(
      state.service.begin({ ...command(ids.begin, 2), requestedAt: later }),
    ).rejects.toMatchObject({ code: "DINING_CLOSING_IDEMPOTENCY_CONFLICT" });
  });

  it.each(["Irreversible", "Indeterminate", "Unavailable"] as const)(
    "fails closed when cancel evidence is %s",
    async (reversibility) => {
      const state = fixture({ phase: "Closing", version: 3, reversibility });
      await expect(state.service.cancel(command(ids.cancel, 3))).rejects.toMatchObject({
        code: "DINING_CLOSING_UNAVAILABLE",
      });
      expect(state.current().phase).toBe("Closing");
    },
  );

  it("returns Closing to Active only with fresh Reversible evidence", async () => {
    const state = fixture({ phase: "Closing", version: 3 });
    await expect(state.service.cancel(command(ids.cancel, 3))).resolves.toMatchObject({
      session: { phase: "Active", version: 4 },
    });
  });
});

describe("Dining close evidence and Task boundary", () => {
  it.each(["Settled", "AuthorizedWriteOff"] as const)(
    "closes with owner-issued %s finality and creates no Task",
    async (financialClass) => {
      const state = fixture({
        phase: "Closing",
        version: 3,
        closure: closure([order(ids.orderOne, ids.batchOne, financialClass)]),
      });
      const result = await state.service.finalize(command(ids.finalize, 3));
      expect(result).toMatchObject({ session: { phase: "Closed", version: 4 } });
      expect(result.taskReferences).toEqual([]);
      expect(state.ensured).toEqual([]);
    },
  );

  it("ensures exactly one deterministic Store Task per unresolved Order before close", async () => {
    const state = fixture({
      phase: "Closing",
      version: 3,
      closure: closure([
        order(ids.orderOne, ids.batchOne, "Unpaid"),
        order(ids.orderTwo, ids.batchTwo, "Indeterminate"),
      ]),
    });
    const result = await state.service.finalize(command(ids.finalize, 3));
    expect(result).toMatchObject({ session: { phase: "Closed" } });
    expect(result.taskReferences).toEqual([ids.taskOne, ids.taskTwo]);
    expect(state.ensured).toEqual([ids.orderOne, ids.orderTwo]);
  });

  it("does not close for a non-terminal Batch", async () => {
    const state = fixture({
      phase: "Closing",
      version: 3,
      closure: closure([order(ids.orderOne, ids.batchOne, "Settled", "KitchenActive")]),
    });
    await expect(state.service.finalize(command(ids.finalize, 3))).rejects.toMatchObject({
      code: "DINING_CLOSING_BATCH_NOT_TERMINAL",
    });
    expect(state.current().phase).toBe("Closing");
  });

  it("rejects client-shaped write-off without opaque owner finality", () => {
    expect(() =>
      parseDiningClosureEvidence({
        ...closure(),
        orders: [
          {
            ...order(ids.orderOne, ids.batchOne, "AuthorizedWriteOff"),
            ownerFinalityReference: null,
            ownerDecidedAt: null,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "DINING_CLOSING_FINANCIAL_EVIDENCE_INVALID" }));
    expect(() =>
      parseDiningClosureEvidence({
        ...closure(),
        orders: [
          {
            ...order(ids.orderOne, ids.batchOne, "AuthorizedWriteOff"),
            ownerDecidedAt: later,
          },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "DINING_CLOSING_FINANCIAL_EVIDENCE_INVALID" }));
  });

  it("keeps Closing when the Task receipt does not match the deterministic intent", async () => {
    const state = fixture({
      phase: "Closing",
      version: 3,
      closure: closure([order(ids.orderOne, ids.batchOne, "Unpaid")]),
      badTask: true,
    });
    await expect(state.service.finalize(command(ids.finalize, 3))).rejects.toMatchObject({
      code: "DINING_CLOSING_TASK_REQUIRED",
    });
    expect(state.current().phase).toBe("Closing");
  });

  it("fails closed on stale expected version and malformed closed contracts", async () => {
    await expect(
      fixture({ phase: "Closing", version: 3 }).service.finalize(command(ids.finalize, 2)),
    ).rejects.toMatchObject({ code: "DINING_CLOSING_VERSION_CONFLICT" });
    expect(() => beginDiningClosing({ ...session(), extra: "forbidden" } as never)).toThrowError(
      expect.objectContaining({ code: "DINING_CLOSING_INPUT_INVALID" }),
    );
  });
});

describe("WP-2281 current Closing authority and complete results", () => {
  it.each(["begin", "cancel", "finalize"] as const)(
    "reauthorizes %s before historical replay",
    async (action) => {
      const state = fixture({ phase: action === "begin" ? "Active" : "Closing" });
      const request = command(ids[action], 2);
      await state.service[action](request);
      state.ports.authorization.authorize = vi.fn(async () => null);
      const history = vi.spyOn(state.ports.store, "resolveOperation");
      await expect(state.service[action](request)).rejects.toMatchObject({
        code: "DINING_CLOSING_PERMISSION_DENIED",
      });
      expect(history).not.toHaveBeenCalled();
    },
  );
  it("does not read finances or ensure Tasks before authority", async () => {
    const state = fixture({ phase: "Closing", authority: "Denied" });
    const read = vi.spyOn(state.ports.closureEvidence, "resolve");
    await expect(state.service.finalize(command(ids.finalize, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_PERMISSION_DENIED",
    });
    expect(read).not.toHaveBeenCalled();
    expect(state.ensured).toEqual([]);
  });
  it("preserves an original result after a later successful phase transition", async () => {
    const state = fixture();
    await state.service.begin(command(ids.begin, 2));
    await state.service.cancel(command(ids.cancel, 3));
    await expect(state.service.begin(command(ids.begin, 2))).resolves.toMatchObject({
      status: "AlreadyApplied",
      session: { phase: "Closing", version: 3 },
    });
  });
  it("rejects a wrong current Session before authorization", async () => {
    const state = fixture();
    state.ports.store.load = async () =>
      ({ ...session(), diningSessionReference: id(99) }) as never;
    const auth = vi.spyOn(state.ports.authorization, "authorize");
    await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
    });
    expect(auth).not.toHaveBeenCalled();
  });
  it.each([
    ["action", "Cancel"],
    ["operationReference", id(99)],
    ["closureEvidenceDigest", evidenceDigest],
    ["taskReferences", [ids.taskOne]],
  ])("rejects corrupt historical %s", async (field, value) => {
    const state = fixture();
    await state.service.begin(command(ids.begin, 2));
    state.operations.set(ids.begin, {
      ...required(state.operations.get(ids.begin)),
      [field as string]: value,
    } as never);
    await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each([
    ["diningSessionReference", id(99)],
    ["brandReference", id(99)],
    ["storeReference", id(99)],
    ["tableReference", id(99)],
    ["tableAssignmentVersion", 99],
    ["hostParticipantReference", id(99)],
    ["startedByActorReference", id(99)],
    ["startedAt", at],
    ["phase", "Active"],
    ["version", 4],
  ])("rejects corrupt historical Session %s", async (field, value) => {
    const state = fixture();
    await state.service.begin(command(ids.begin, 2));
    const prior = required(state.operations.get(ids.begin));
    state.operations.set(ids.begin, {
      ...prior,
      session: { ...prior.session, [field as string]: value },
    } as never);
    await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each([
    ["tableReference", id(99)],
    ["tableAssignmentVersion", 99],
    ["hostParticipantReference", id(99)],
    ["startedByActorReference", id(99)],
    ["startedAt", at],
  ])("rejects incomplete committed Session %s", async (field, value) => {
    const state = fixture();
    state.ports.store.commit = async ({ record }) =>
      ({ ...record, session: { ...record.session, [field as string]: value } }) as never;
    await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
    });
  });
  it.each([
    "unknownKind",
    "guestAsUser",
    "foreignHost",
    "staleHost",
    "guestFormat",
    "privateSummary",
  ])("rejects %s authority", async (variant) => {
    const state = fixture();
    const original = state.ports.authorization.authorize;
    state.ports.authorization.authorize = async (input) => {
      const value = await original(input);
      return {
        ...value,
        ...(variant === "unknownKind"
          ? { kind: "Other" }
          : variant === "foreignHost"
            ? { participantReference: id(99) }
            : variant === "staleHost"
              ? { observedAt: later }
              : variant === "guestFormat"
                ? { guestSessionReference: "invalid" }
                : {
                    audit:
                      variant === "guestAsUser"
                        ? audit(input.operation)
                        : { ...required(value).audit, afterSummary: { detail: "private" } },
                  }),
      } as never;
    };
    await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_PERMISSION_DENIED",
    });
  });
  it.each(["load", "authorize", "history", "commit", "hash", "equals"])(
    "bounds synchronous %s errors",
    async (dependency) => {
      const state = fixture();
      const fail = () => {
        throw new Error("private-dependency-payload");
      };
      if (dependency === "load") state.ports.store.load = fail;
      if (dependency === "authorize") state.ports.authorization.authorize = fail;
      if (dependency === "history") state.ports.store.resolveOperation = fail;
      if (dependency === "commit") state.ports.store.commit = fail;
      if (dependency === "hash") state.ports.hashes.hashIntent = fail;
      if (dependency === "equals") state.ports.hashes.equals = fail;
      await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
        code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
        message: new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE").message,
      });
    },
  );
  it("captures the current Session before callbacks can mutate its source", async () => {
    const state = fixture();
    const mutable = { ...session() };
    state.ports.store.load = async () => mutable;
    const original = state.ports.authorization.authorize;
    state.ports.authorization.authorize = async (input) => {
      mutable.tableReference = id(99) as never;
      return original(input);
    };
    await expect(state.service.begin(command(ids.begin, 2))).resolves.toMatchObject({
      session: { tableReference: ids.table },
    });
  });
  it("does not invoke getters in dependency facts", async () => {
    const state = fixture();
    const getter = vi.fn(() => ids.table);
    state.ports.store.load = async () =>
      Object.defineProperty({ ...session() }, "tableReference", { get: getter, enumerable: true });
    await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("WP-2281 remaining dependency fences", () => {
  it("reauthorizes revoked Staff on retry", async () => {
    const state = fixture({ authority: "Staff" });
    await state.service.begin(command(ids.begin, 2));
    state.ports.authorization.authorize = async () => null;
    const history = vi.spyOn(state.ports.store, "resolveOperation");
    await expect(state.service.begin(command(ids.begin, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_PERMISSION_DENIED",
    });
    expect(history).not.toHaveBeenCalled();
  });
  it("rejects foreign financial evidence before exception Task creation", async () => {
    const state = fixture({
      phase: "Closing",
      closure: {
        ...closure([order(ids.orderOne, ids.batchOne, "Unpaid")]),
        storeReference: id(99),
      },
    });
    await expect(state.service.finalize(command(ids.finalize, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_UNAVAILABLE",
    });
    expect(state.ensured).toEqual([]);
  });
  it.each(["resolve", "ensure", "evaluate"] as const)(
    "bounds asynchronous %s failures",
    async (method) => {
      const state = fixture({
        phase: "Closing",
        closure: closure([order(ids.orderOne, ids.batchOne, "Unpaid")]),
      });
      const fail = async () => {
        throw new Error("private-financial-payload");
      };
      if (method === "resolve") state.ports.closureEvidence.resolve = fail;
      if (method === "ensure") state.ports.tasks.ensure = fail;
      if (method === "evaluate") state.ports.reversibility.evaluate = fail;
      await expect(
        state.service[method === "evaluate" ? "cancel" : "finalize"](command(ids.finalize, 2)),
      ).rejects.toMatchObject({
        code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
        message: new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE").message,
      });
    },
  );
  it("recreates owned conflicts without dependency private messages", async () => {
    const state = fixture();
    const error = new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
    error.message = "private-store-payload";
    state.ports.store.commit = async () => {
      throw error;
    };
    try {
      await state.service.begin(command(ids.begin, 2));
      throw new Error("expected denial");
    } catch (received) {
      expect(received).not.toBe(error);
      expect(received).toMatchObject({
        code: error.code,
        message: new DiningClosingError(error.code).message,
      });
    }
  });
  it("rejects a finalize history without its closure digest", async () => {
    const state = fixture({ phase: "Closing" });
    await state.service.finalize(command(ids.finalize, 2));
    state.operations.set(ids.finalize, {
      ...required(state.operations.get(ids.finalize)),
      closureEvidenceDigest: null,
    });
    await expect(state.service.finalize(command(ids.finalize, 2))).rejects.toMatchObject({
      code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE",
    });
  });
});

it("WP-2281 rejects finalize outside Closing before financial work", async () => {
  const state = fixture({ closure: closure([order(ids.orderOne, ids.batchOne, "Unpaid")]) });
  const read = vi.spyOn(state.ports.closureEvidence, "resolve");
  await expect(state.service.finalize(command(ids.finalize, 2))).rejects.toMatchObject({
    code: "DINING_CLOSING_PHASE_CONFLICT",
  });
  expect(read).not.toHaveBeenCalled();
  expect(state.ensured).toEqual([]);
});
