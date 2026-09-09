import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  createDiningTable,
  createDiningTableService,
  DiningTableWorkflowError,
  type DiningSessionMoveRecord,
  type DiningTableOperationRecord,
  type DiningTablePorts,
} from "../index.js";

const ref = (suffix: string) => `018f3000-0000-7000-8000-${suffix.padStart(12, "0")}`;
const ids = {
  tenant: ref("1"),
  brand: ref("2"),
  store: ref("3"),
  actor: ref("4"),
  area: ref("5"),
  source: ref("6"),
  target: ref("7"),
  session: ref("8"),
  operation: ref("9"),
  audit: ref("10"),
  correlation: ref("11"),
} as const;
const observedAt = "2026-08-13T12:00:00.000Z";

function table(
  tableReference: string,
  options: {
    lifecycle?: "Draft" | "Published";
    version?: number;
    capacity?: number;
    activeSession?: string | null;
  } = {},
) {
  const lifecycle = options.lifecycle ?? "Draft";
  return createDiningTable({
    tableReference,
    tenantReference: ids.tenant,
    brandReference: ids.brand,
    storeReference: ids.store,
    stableLabel: tableReference === ids.source ? "T01" : "T02",
    areaReference: ids.area,
    areaCode: "MAIN",
    capacity: options.capacity ?? 4,
    accessibilityAttributes: ["STEP_FREE"],
    lifecycle,
    qrStatus: lifecycle === "Draft" ? "Inactive" : "Active",
    qrVersion: lifecycle === "Draft" ? 0 : 1,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: options.activeSession ?? null,
    aggregateVersion: options.version ?? 1,
    createdAt: observedAt,
    observedAt,
  });
}

function fixture(options: { denied?: boolean } = {}) {
  const tables = new Map<string, ReturnType<typeof table>>();
  const tableOperations = new Map<string, DiningTableOperationRecord>();
  const moveOperations = new Map<string, DiningSessionMoveRecord>();
  const session = {
    diningSessionReference: ids.session,
    brandReference: ids.brand,
    storeReference: ids.store,
    tableReference: ids.source,
    tableAssignmentVersion: 3,
    phase: "Active" as const,
    version: 2,
    startedByActorReference: ids.actor,
    startedAt: observedAt,
    hostParticipantReference: null,
  };
  const authorizationCalls: string[] = [];
  let repositoryReads = 0;
  const ports: DiningTablePorts = {
    authorization: {
      async authorize(input) {
        authorizationCalls.push(input.action);
        if (options.denied) return null;
        return {
          tenantReference: ids.tenant as never,
          brandReference: ids.brand as never,
          storeReference: ids.store as never,
          actorReference: ids.actor as never,
          purpose: "dining-table",
          permission: {
            effect: "Allow",
            action: "dining.operate",
            scopeKind: "Store",
          },
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            storeId: ids.store,
            actor: { type: "User", reference: ids.actor },
            actionCode:
              input.action === "MoveSession"
                ? "DINING_SESSION_MOVE_TABLE"
                : `DINING_TABLE_${input.action.toUpperCase()}`,
            targetType: input.action === "MoveSession" ? "DiningSession" : "DiningTable",
            targetId: input.targetReference,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: {
      hashIntent: () => `sha256:${"a".repeat(64)}`,
      equals: (left, right) => left === right,
    },
    repository: {
      async resolveTableOperation(reference) {
        repositoryReads += 1;
        return tableOperations.get(reference) ?? null;
      },
      async loadTable(reference) {
        repositoryReads += 1;
        return tables.get(reference) ?? null;
      },
      async commitTable(record) {
        tables.set(record.table.tableReference, record.table);
        tableOperations.set(record.operationReference, record);
      },
      async resolveMoveOperation(reference) {
        repositoryReads += 1;
        return moveOperations.get(reference) ?? null;
      },
      async loadSession(reference) {
        repositoryReads += 1;
        return reference === ids.session ? (session as never) : null;
      },
      async commitMove(record) {
        tables.set(record.sourceTable.tableReference, record.sourceTable);
        tables.set(record.targetTable.tableReference, record.targetTable);
        moveOperations.set(record.operationReference, record);
      },
    },
  };
  return {
    ports,
    tables,
    tableOperations,
    moveOperations,
    authorizationCalls,
    repositoryReadCount: () => repositoryReads,
  };
}

describe("Dining Table application service", () => {
  it("creates an authorized draft and authorizes an idempotent replay", async () => {
    const state = fixture();
    const service = createDiningTableService(state.ports);
    const input = {
      action: "CreateDraft",
      operationReference: ids.operation,
      expectedAggregateVersion: null,
      candidate: table(ids.source),
      observedAt,
    };

    await expect(service.executeTable(input)).resolves.toMatchObject({ status: "Applied" });
    await expect(service.executeTable(input)).resolves.toMatchObject({ status: "AlreadyApplied" });
    expect(state.authorizationCalls).toEqual(["CreateDraft", "CreateDraft"]);
    expect(state.tableOperations.get(ids.operation)?.event.eventType).toBe("DiningTableDrafted");
  });

  it("rejects denied table configuration without reading object state", async () => {
    const state = fixture({ denied: true });
    const service = createDiningTableService(state.ports);
    await expect(
      service.executeTable({
        action: "CreateDraft",
        operationReference: ids.operation,
        expectedAggregateVersion: null,
        candidate: table(ids.source),
        observedAt,
      }),
    ).rejects.toMatchObject({ code: "DINING_TABLE_PERMISSION_DENIED" });
    await expect(
      service.moveSession({
        operationReference: ids.operation,
        diningSessionReference: ids.session,
        sourceTableReference: ids.source,
        targetTableReference: ids.target,
        expectedSessionVersion: 2,
        expectedSourceTableVersion: 3,
        expectedTargetTableVersion: 5,
        partySize: 2,
        observedAt,
      }),
    ).rejects.toMatchObject({ code: "DINING_TABLE_PERMISSION_DENIED" });
    expect(state.tableOperations.size).toBe(0);
    expect(state.repositoryReadCount()).toBe(0);
  });

  it("rejects accessor-bearing command input without invoking the accessor", async () => {
    const state = fixture();
    const service = createDiningTableService(state.ports);
    let invoked = false;
    const input = {
      action: "CreateDraft",
      operationReference: ids.operation,
      expectedAggregateVersion: null,
      candidate: table(ids.source),
      observedAt,
    };
    Object.defineProperty(input, "operationReference", {
      enumerable: true,
      get() {
        invoked = true;
        return ids.operation;
      },
    });

    await expect(service.executeTable(input)).rejects.toMatchObject({
      code: "DINING_TABLE_INPUT_INVALID",
    });
    expect(invoked).toBe(false);
    expect(state.authorizationCalls).toEqual([]);
  });

  it("moves one active session atomically and enforces target capacity", async () => {
    const state = fixture();
    state.tables.set(
      ids.source,
      table(ids.source, { lifecycle: "Published", version: 3, activeSession: ids.session }),
    );
    state.tables.set(
      ids.target,
      table(ids.target, { lifecycle: "Published", version: 5, capacity: 2 }),
    );
    const service = createDiningTableService(state.ports);
    const input = {
      operationReference: ids.operation,
      diningSessionReference: ids.session,
      sourceTableReference: ids.source,
      targetTableReference: ids.target,
      expectedSessionVersion: 2,
      expectedSourceTableVersion: 3,
      expectedTargetTableVersion: 5,
      partySize: 2,
      observedAt,
    };

    await expect(service.moveSession(input)).resolves.toMatchObject({ status: "Applied" });
    expect(state.moveOperations.get(ids.operation)?.session.tableReference).toBe(ids.target);
    expect(state.tables.get(ids.source)?.activeDiningSessionReference).toBeNull();
    expect(state.tables.get(ids.target)?.activeDiningSessionReference).toBe(ids.session);
    const tooSmall = fixture();
    tooSmall.tables.set(
      ids.source,
      table(ids.source, { lifecycle: "Published", version: 3, activeSession: ids.session }),
    );
    tooSmall.tables.set(
      ids.target,
      table(ids.target, { lifecycle: "Published", version: 5, capacity: 2 }),
    );
    await expect(
      createDiningTableService(tooSmall.ports).moveSession({ ...input, partySize: 5 }),
    ).rejects.toMatchObject({ code: "DINING_TABLE_LIFECYCLE_CONFLICT" });
  });
});

const tableInput = () => ({
  action: "CreateDraft",
  operationReference: ids.operation,
  expectedAggregateVersion: null,
  candidate: table(ids.source),
  observedAt,
});
const moveInput = () => ({
  operationReference: ids.operation,
  diningSessionReference: ids.session,
  sourceTableReference: ids.source,
  targetTableReference: ids.target,
  expectedSessionVersion: 2,
  expectedSourceTableVersion: 3,
  expectedTargetTableVersion: 5,
  partySize: 2,
  observedAt,
});
function moveFixture() {
  const state = fixture();
  state.tables.set(
    ids.source,
    table(ids.source, { lifecycle: "Published", version: 3, activeSession: ids.session }),
  );
  state.tables.set(
    ids.target,
    table(ids.target, { lifecycle: "Published", version: 5, capacity: 2 }),
  );
  return state;
}
async function tableHistory() {
  const state = fixture();
  const service = createDiningTableService(state.ports);
  await service.executeTable(tableInput());
  const original = state.tableOperations.get(ids.operation);
  if (!original) throw new Error("synthetic record missing");
  const record = JSON.parse(JSON.stringify(original)) as DiningTableOperationRecord;
  return { ...state, service, record };
}
async function moveHistory() {
  const state = moveFixture();
  const service = createDiningTableService(state.ports);
  await service.moveSession(moveInput());
  const original = state.moveOperations.get(ids.operation);
  if (!original) throw new Error("synthetic record missing");
  const record = JSON.parse(JSON.stringify(original)) as DiningSessionMoveRecord;
  return { ...state, service, record };
}

const tableChanges: { name: string; alter: (record: DiningTableOperationRecord) => unknown }[] = [
  { name: "operation", alter: (r) => ({ ...r, operationReference: ref("90") }) },
  ...["tableReference", "tenantReference", "brandReference", "storeReference"].map((field) => ({
    name: field,
    alter: (r: DiningTableOperationRecord) => ({ ...r, table: { ...r.table, [field]: ref("90") } }),
  })),
  { name: "revision", alter: (r) => ({ ...r, table: { ...r.table, aggregateVersion: 2 } }) },
  { name: "result content", alter: (r) => ({ ...r, table: { ...r.table, stableLabel: "OTHER" } }) },
  {
    name: "result time",
    alter: (r) => ({ ...r, table: { ...r.table, observedAt: "2026-08-13T12:01:00.000Z" } }),
  },
  ...["brandId", "storeId", "targetId"].map((field) => ({
    name: `Audit ${field}`,
    alter: (r: DiningTableOperationRecord) => ({ ...r, audit: { ...r.audit, [field]: ref("90") } }),
  })),
  {
    name: "Audit actor",
    alter: (r) => ({ ...r, audit: { ...r.audit, actor: { type: "User", reference: ref("90") } } }),
  },
  {
    name: "Audit action",
    alter: (r) => ({ ...r, audit: { ...r.audit, actionCode: "OTHER_ACTION" } }),
  },
  {
    name: "Audit time",
    alter: (r) => ({ ...r, audit: { ...r.audit, occurredAt: "2026-08-13T12:01:00.000Z" } }),
  },
  {
    name: "Event reference",
    alter: (r) => ({ ...r, event: { ...r.event, tableReference: ref("90") } }),
  },
  { name: "Event version", alter: (r) => ({ ...r, event: { ...r.event, aggregateVersion: "2" } }) },
  {
    name: "Event type",
    alter: (r) => ({ ...r, event: { ...r.event, eventType: "DiningTableConfigurationPublished" } }),
  },
  { name: "extra record field", alter: (r) => ({ ...r, extra: true }) },
  { name: "malformed digest", alter: (r) => ({ ...r, intentDigest: "invalid" }) },
];

describe("WP-2271 Table historical result isolation", () => {
  it.each(tableChanges)("rejects mismatched $name despite a matching digest", async ({ alter }) => {
    const state = await tableHistory();
    state.tableOperations.set(ids.operation, alter(state.record) as never);
    const commit = vi.spyOn(state.ports.repository, "commitTable");
    await expect(state.service.executeTable(tableInput())).rejects.toMatchObject({
      code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      message: "Dining Table operation is unavailable",
    });
    expect(commit).not.toHaveBeenCalled();
  });
  it("preserves changed-intent conflict without exposing history", async () => {
    const state = await tableHistory();
    state.tableOperations.set(ids.operation, {
      ...state.record,
      intentDigest: `sha256:${"b".repeat(64)}`,
    });
    await expect(state.service.executeTable(tableInput())).rejects.toMatchObject({
      code: "DINING_TABLE_IDEMPOTENCY_CONFLICT",
    });
  });
  it.each(["table", "audit", "summary array"])(
    "does not execute a historical %s getter",
    async (field) => {
      const state = await tableHistory();
      const getter = vi.fn(() => {
        throw new Error("synthetic private detail");
      });
      let record: unknown;
      if (field === "summary array") {
        const values = Object.defineProperty([0], "0", { enumerable: true, get: getter });
        record = { ...state.record, audit: { ...state.record.audit, beforeSummary: { values } } };
      } else
        record = Object.defineProperty({ ...state.record }, field, {
          enumerable: true,
          get: getter,
        });
      state.tableOperations.set(ids.operation, record as never);
      await expect(state.service.executeTable(tableInput())).rejects.toMatchObject({
        code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      });
      expect(getter).not.toHaveBeenCalled();
    },
  );
  it("owns the historical snapshot before the equality callback", async () => {
    const state = await tableHistory();
    state.tableOperations.set(ids.operation, state.record);
    state.ports.references.equals = () => {
      Object.assign(state.record.table, { storeReference: ref("90"), stableLabel: "OTHER" });
      return true;
    };
    const result = await state.service.executeTable(tableInput());
    expect(result).toMatchObject({ status: "AlreadyApplied", table: table(ids.source) });
    expect(Object.isFrozen(result.table)).toBe(true);
    expect(Object.isFrozen(result.table.accessibilityAttributes)).toBe(true);
  });
  it("requires current authority before reading history", async () => {
    const state = await tableHistory();
    state.ports.authorization.authorize = async () => null;
    const read = vi.spyOn(state.ports.repository, "resolveTableOperation");
    await expect(state.service.executeTable(tableInput())).rejects.toMatchObject({
      code: "DINING_TABLE_PERMISSION_DENIED",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("copies current authorization before a repository callback mutates its source", async () => {
    const state = fixture();
    const authorize = state.ports.authorization.authorize;
    let source: Awaited<ReturnType<typeof authorize>>;
    state.ports.authorization.authorize = async (input) => {
      source = await authorize(input);
      return source;
    };
    state.ports.repository.resolveTableOperation = async () => {
      if (!source) throw new Error("synthetic evidence missing");
      Object.assign(source.audit.actor, { reference: ref("90") });
      Object.assign(source.audit, { brandId: ref("90") });
      return null;
    };
    await createDiningTableService(state.ports).executeTable(tableInput());
    expect(state.tableOperations.get(ids.operation)?.audit).toMatchObject({
      brandId: ids.brand,
      actor: { reference: ids.actor },
    });
    expect(Object.isFrozen(state.tableOperations.get(ids.operation)?.audit.actor)).toBe(true);
  });
});

const moveChanges: { name: string; alter: (record: DiningSessionMoveRecord) => unknown }[] = [
  { name: "operation", alter: (r) => ({ ...r, operationReference: ref("90") }) },
  ...[
    "diningSessionReference",
    "brandReference",
    "storeReference",
    "tableReference",
    "startedByActorReference",
  ].map((field) => ({
    name: `Session ${field}`,
    alter: (r: DiningSessionMoveRecord) => ({
      ...r,
      session: { ...r.session, [field]: ref("90") },
    }),
  })),
  { name: "Session version", alter: (r) => ({ ...r, session: { ...r.session, version: 4 } }) },
  {
    name: "assignment version",
    alter: (r) => ({ ...r, session: { ...r.session, tableAssignmentVersion: 7 } }),
  },
  { name: "Session phase", alter: (r) => ({ ...r, session: { ...r.session, phase: "Closing" } }) },
  ...["sourceTable", "targetTable"].flatMap((side) =>
    ["tableReference", "tenantReference", "brandReference", "storeReference"].map((field) => ({
      name: `${side} ${field}`,
      alter: (r: DiningSessionMoveRecord) => ({
        ...r,
        [side]: { ...r[side as "sourceTable" | "targetTable"], [field]: ref("90") },
      }),
    })),
  ),
  {
    name: "source version",
    alter: (r) => ({ ...r, sourceTable: { ...r.sourceTable, aggregateVersion: 5 } }),
  },
  {
    name: "target version",
    alter: (r) => ({ ...r, targetTable: { ...r.targetTable, aggregateVersion: 7 } }),
  },
  {
    name: "source assignment",
    alter: (r) => ({
      ...r,
      sourceTable: { ...r.sourceTable, activeDiningSessionReference: ids.session },
    }),
  },
  {
    name: "target assignment",
    alter: (r) => ({ ...r, targetTable: { ...r.targetTable, activeDiningSessionReference: null } }),
  },
  {
    name: "target capacity",
    alter: (r) => ({ ...r, targetTable: { ...r.targetTable, capacity: 1 } }),
  },
  { name: "Audit target", alter: (r) => ({ ...r, audit: { ...r.audit, targetId: ref("90") } }) },
  {
    name: "Event target",
    alter: (r) => ({ ...r, event: { ...r.event, targetTableReference: ref("90") } }),
  },
  {
    name: "Event time",
    alter: (r) => ({ ...r, event: { ...r.event, occurredAt: "2026-08-13T12:01:00.000Z" } }),
  },
];

describe("WP-2271 Move historical and current object isolation", () => {
  it("returns frozen original Move history without a second write", async () => {
    const state = await moveHistory();
    state.moveOperations.set(ids.operation, state.record);
    const commit = vi.spyOn(state.ports.repository, "commitMove");
    const result = await state.service.moveSession(moveInput());
    expect(result).toMatchObject({ status: "AlreadyApplied", result: state.record });
    for (const part of [
      result.result,
      result.result.session,
      result.result.sourceTable,
      result.result.targetTable,
      result.result.audit,
      result.result.audit.actor,
      result.result.event,
    ])
      expect(Object.isFrozen(part)).toBe(true);
    Object.assign(state.record.session, { diningSessionReference: ref("90") });
    expect(result.result.session.diningSessionReference).toBe(ids.session);
    expect(commit).not.toHaveBeenCalled();
  });
  it.each(moveChanges)("rejects mismatched $name before replay", async ({ alter }) => {
    const state = await moveHistory();
    state.moveOperations.set(ids.operation, alter(state.record) as never);
    const commit = vi.spyOn(state.ports.repository, "commitMove");
    await expect(state.service.moveSession(moveInput())).rejects.toMatchObject({
      code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
    });
    expect(commit).not.toHaveBeenCalled();
  });
  it.each(["Session", "source", "target"])(
    "rejects a coherent but wrong current %s locator",
    async (kind) => {
      const state = moveFixture();
      const loadSession = state.ports.repository.loadSession;
      const loadTable = state.ports.repository.loadTable;
      state.ports.repository.loadSession = async (reference) => {
        const original = await loadSession(reference);
        if (!original) return null;
        return {
          ...original,
          ...(kind === "Session"
            ? { diningSessionReference: ref("90") }
            : kind === "source"
              ? { tableReference: ref("90") }
              : {}),
        } as never;
      };
      state.ports.repository.loadTable = async (reference) => {
        const original = await loadTable(reference);
        if (!original) return null;
        return {
          ...original,
          ...(reference === ids.source && kind === "Session"
            ? { activeDiningSessionReference: ref("90") }
            : (reference === ids.source && kind === "source") ||
                (reference === ids.target && kind === "target")
              ? { tableReference: ref("90") }
              : {}),
        } as never;
      };
      const commit = vi.spyOn(state.ports.repository, "commitMove");
      await expect(
        createDiningTableService(state.ports).moveSession(moveInput()),
      ).rejects.toMatchObject({ code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE" });
      expect(commit).not.toHaveBeenCalled();
    },
  );
  it("preserves changed Move intent conflict", async () => {
    const state = await moveHistory();
    state.moveOperations.set(ids.operation, {
      ...state.record,
      intentDigest: `sha256:${"b".repeat(64)}`,
    });
    await expect(state.service.moveSession(moveInput())).rejects.toMatchObject({
      code: "DINING_TABLE_IDEMPOTENCY_CONFLICT",
    });
  });
  it("does not leak a private repository failure", async () => {
    const state = await moveHistory();
    state.ports.repository.resolveMoveOperation = async () => {
      throw new Error("synthetic private detail");
    };
    await expect(state.service.moveSession(moveInput())).rejects.toMatchObject({
      code: "DINING_TABLE_DEPENDENCY_UNAVAILABLE",
      message: "Dining Table operation is unavailable",
    });
  });
});

describe("WP-2272 canonical Table persistence handoff", () => {
  it("replays the same parsed command despite candidate key and attribute ordering", async () => {
    const state = fixture();
    state.ports.references.hashIntent = (value) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const service = createDiningTableService(state.ports);
    const candidate = { ...table(ids.source), accessibilityAttributes: ["WIDE_DOOR", "STEP_FREE"] };
    const input = { ...tableInput(), candidate };
    const commit = vi.spyOn(state.ports.repository, "commitTable");
    const first = await service.executeTable(input);
    const reordered = Object.fromEntries(
      Object.entries({
        ...candidate,
        accessibilityAttributes: ["STEP_FREE", "WIDE_DOOR"],
      }).reverse(),
    );
    const retry = await service.executeTable({ ...input, candidate: reordered });
    expect(retry).toEqual({ status: "AlreadyApplied", table: first.table });
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it.each(["DINING_TABLE_VERSION_CONFLICT", "DINING_TABLE_IDEMPOTENCY_CONFLICT"] as const)(
    "preserves the owning writer's %s",
    async (code) => {
      const state = fixture();
      state.ports.repository.commitTable = async () => {
        throw new DiningTableWorkflowError(code);
      };
      await expect(
        createDiningTableService(state.ports).executeTable(tableInput()),
      ).rejects.toMatchObject({ code });
    },
  );
});
