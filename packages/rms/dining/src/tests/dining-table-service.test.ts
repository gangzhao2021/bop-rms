import { describe, expect, it } from "vitest";

import {
  createDiningTable,
  createDiningTableService,
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
