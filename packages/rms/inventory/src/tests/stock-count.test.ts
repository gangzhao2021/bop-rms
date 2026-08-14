import { describe, expect, it, vi } from "vitest";
import {
  createStockCount,
  decideStockCount,
  executeStockCountCommand,
  markStockCountPosted,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  queryStockCounts,
  saveStockCountLine,
  startStockCount,
  submitStockCount,
  type StockCountAggregate,
  type StockCountCommand,
  type StockCountCommandRecord,
  type StockCountLine,
  type StockCountPorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (hour: number) =>
  parseInventoryInstant(`2026-08-14T${hour.toString().padStart(2, "0")}:00:00.000Z`);
const hash = `sha256:${"1".repeat(64)}`;
const scope = Object.freeze({ scopeType: "Location" as const, scopeReference: id(5) });

function line(): StockCountLine {
  return Object.freeze({
    lineReference: id(20),
    itemReference: id(21),
    lotReference: id(22),
    locationReference: id(5),
    unitCode: "KG",
    expectedQuantity: parseInventoryDecimal("10"),
    countedQuantity: null,
    variance: null,
    varianceReasonCode: null,
    recountNumber: 0,
    balanceVersion: 7,
    movementReference: null,
  });
}

function assignedCount(approvalPolicy: "Segregated" | "SelfAllowed" = "Segregated") {
  return createStockCount({
    countReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    stockScope: scope,
    countType: "Cycle",
    expectedQuantityVisibility: "BlindUntilSubmit",
    movementControl: "SnapshotOnly",
    approvalPolicy,
    snapshotReference: id(11),
    snapshotCapturedAt: at(9),
    assigneeReference: id(3),
    dueAt: at(18),
    lines: [line()],
    actorReference: id(4),
    occurredAt: at(9),
  });
}

function submittedCount(reasonCode: string | null = "COUNT_VARIANCE") {
  const started = startStockCount(assignedCount(), 1, id(3), at(10));
  const counted = saveStockCountLine(started, {
    lineReference: id(20),
    countedQuantity: "12",
    unitCode: "KG",
    varianceReasonCode: reasonCode,
    expectedVersion: 2,
    actorReference: id(3),
    occurredAt: at(11),
  });
  return submitStockCount(counted, 3, id(3), at(12));
}

function approvedCount() {
  return decideStockCount(submittedCount(), {
    decision: "Approve",
    reasonCode: "VARIANCE_APPROVED",
    expectedVersion: 4,
    actorReference: id(4),
    occurredAt: at(13),
  });
}

const audit = Object.freeze({
  auditId: id(70),
  brandId: id(2),
  actor: { type: "User" as const, reference: id(4) },
  actionCode: "INVENTORY_COUNT",
  targetType: "StockCount",
  targetId: id(10),
  reasonCode: "COUNT_OPERATION",
  correlationId: id(60),
  occurredAt: at(13),
  sourceChannel: "MerchantWeb",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "INVENTORY_COUNT",
  retentionPolicyVersion: 1,
});

function createCommand(): StockCountCommand {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    purpose: "StockCountManagement",
    permission: "inventory.count.manage",
    operationReference: id(60),
    occurredAt: at(9),
    action: "Create",
    payload: Object.freeze({
      stockScope: scope,
      countType: "Cycle",
      expectedQuantityVisibility: "BlindUntilSubmit",
      movementControl: "SnapshotOnly",
      approvalPolicy: "Segregated",
      assigneeReference: id(3),
      dueAt: at(18),
    }),
  };
}

function postCommand(): StockCountCommand {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    purpose: "StockCountManagement",
    permission: "inventory.count.post",
    operationReference: id(61),
    occurredAt: at(14),
    action: "Post",
    payload: Object.freeze({ countReference: id(10), expectedVersion: 5 }),
  };
}

function movement() {
  return {
    movementReference: id(30),
    tenantReference: id(1),
    brandReference: id(2),
    itemReference: id(21),
    movementType: "CountAdjustment",
    quantityDelta: "2",
    unitCode: "KG",
    baseQuantityDelta: "2",
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceScope: null,
    destinationScope: scope,
    lotReference: id(22),
    expiryDate: null,
    businessSourceType: "STOCK_COUNT",
    businessSourceReference: id(10),
    reasonCode: "COUNT_VARIANCE",
    performedBy: id(4),
    occurredAt: at(14),
    before: {
      onHand: "10",
      reserved: "0",
      available: "10",
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 7,
    },
    after: {
      onHand: "12",
      reserved: "0",
      available: "12",
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 8,
    },
    auditReference: id(70),
    correctsMovementReference: null,
  };
}

function ports(loaded: StockCountAggregate | null = null): StockCountPorts {
  return {
    authorization: { authorize: vi.fn(async () => ({ authorized: true as const })) },
    projection: {
      query: vi.fn(async () => ({
        projectionName: "inventory_count_workbench_v1" as const,
        projectionVersion: 1 as const,
        stockScope: scope,
        asOfUtc: at(14),
        freshness: "Current" as const,
        partial: false,
        counts: loaded ? [loaded] : [],
      })),
    },
    snapshot: {
      capture: vi.fn(async () => ({
        snapshotReference: id(11),
        capturedAt: at(9),
        stockScope: scope,
        lines: [
          {
            lineReference: id(20),
            itemReference: id(21),
            lotReference: id(22),
            locationReference: id(5),
            unitCode: "KG",
            expectedQuantity: "10",
            balanceVersion: 7,
          },
        ],
      })),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => loaded),
      commit: vi.fn(async (record) => record),
    },
    posting: {
      commit: vi.fn(async ({ command, before, intentHash, audit: evidence }) => {
        const posted = markStockCountPosted(
          before,
          new Map([[id(20), id(30)]]),
          5,
          command.actorReference,
          command.occurredAt,
        );
        return Object.freeze({
          operationReference: command.operationReference,
          intentHash,
          action: "Post" as const,
          command,
          count: posted,
          movements: [movement()] as never,
          audit: evidence,
          outcome: "Applied" as const,
        });
      }),
    },
    audit: { create: vi.fn(async () => audit) },
    references: {
      generate: vi.fn(() => id(10)),
      hashIntent: vi.fn(() => hash),
      equals: vi.fn((left, right) => left === right),
    },
  };
}

describe("Stock Count aggregate", () => {
  it("keeps the source snapshot internal and calculates exact decimal variance", () => {
    const started = startStockCount(assignedCount(), 1, id(3), at(10));
    const counted = saveStockCountLine(started, {
      lineReference: id(20),
      countedQuantity: "12.500000",
      unitCode: "KG",
      varianceReasonCode: "COUNT_VARIANCE",
      expectedVersion: 2,
      actorReference: id(3),
      occurredAt: at(11),
    });
    expect(counted.lines[0]).toMatchObject({ countedQuantity: "12.500000", variance: "2.5" });
  });

  it("requires every line and a controlled reason for non-zero variance", () => {
    expect(() => submittedCount(null)).toThrowError(
      expect.objectContaining({ code: "STOCK_COUNT_INCOMPLETE" }),
    );
  });

  it("enforces submitter/approver segregation and supports rejected recount", () => {
    const submitted = submittedCount();
    expect(() =>
      decideStockCount(submitted, {
        decision: "Approve",
        reasonCode: "VARIANCE_APPROVED",
        expectedVersion: 4,
        actorReference: id(3),
        occurredAt: at(13),
      }),
    ).toThrowError(expect.objectContaining({ code: "STOCK_COUNT_SEGREGATION_REQUIRED" }));
    const rejected = decideStockCount(submitted, {
      decision: "Reject",
      reasonCode: "RECOUNT_REQUIRED",
      expectedVersion: 4,
      actorReference: id(4),
      occurredAt: at(13),
    });
    expect(rejected).toMatchObject({ status: "InProgress", approvedBy: null });
  });
});

describe("Stock Count command service", () => {
  it("authorizes before capturing the server-owned blind snapshot", async () => {
    const adapter = ports();
    const result = await executeStockCountCommand(createCommand(), adapter);
    expect(result.count).toMatchObject({
      status: "Assigned",
      expectedQuantityVisibility: "BlindUntilSubmit",
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.snapshot.capture as never,
    );
    expect(createCommand().payload).not.toHaveProperty("expectedQuantity");
  });

  it("rejects malformed nested scope before authorization", async () => {
    const adapter = ports();
    await expect(
      executeStockCountCommand(
        {
          ...createCommand(),
          payload: { ...createCommand().payload, stockScope: { ...scope, extra: true } },
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "STOCK_COUNT_INVALID" });
    expect(adapter.authorization.authorize).not.toHaveBeenCalled();
  });

  it("atomically posts exactly one validated Movement for each non-zero line", async () => {
    const adapter = ports(approvedCount());
    const result = await executeStockCountCommand(postCommand(), adapter);
    expect(result).toMatchObject({
      count: { status: "Posted" },
      movements: [{ movementType: "CountAdjustment", quantityDelta: "2" }],
    });
    expect(adapter.audit.create).toHaveBeenCalledBefore(adapter.posting.commit as never);
  });

  it("rejects forged or duplicate posting outcomes", async () => {
    const forged = ports(approvedCount());
    vi.mocked(forged.posting.commit).mockImplementationOnce(async (input) => {
      const valid = await ports(approvedCount()).posting.commit(input);
      return {
        ...valid,
        movements: [{ ...movement(), quantityDelta: "3", baseQuantityDelta: "3" }] as never,
      };
    });
    await expect(executeStockCountCommand(postCommand(), forged)).rejects.toMatchObject({
      code: "STOCK_COUNT_DEPENDENCY_UNAVAILABLE",
    });
    const forgedAudit = ports(approvedCount());
    vi.mocked(forgedAudit.posting.commit).mockImplementationOnce(async (input) => {
      const valid = await ports(approvedCount()).posting.commit(input);
      return { ...valid, audit: { ...valid.audit, auditId: id(71) } };
    });
    await expect(executeStockCountCommand(postCommand(), forgedAudit)).rejects.toMatchObject({
      code: "STOCK_COUNT_DEPENDENCY_UNAVAILABLE",
    });
    const replay = ports(approvedCount());
    const valid = await replay.posting.commit({
      command: postCommand(),
      before: approvedCount(),
      intentHash: hash,
      audit,
    });
    vi.mocked(replay.repository.resolveOperation).mockResolvedValueOnce(
      valid as StockCountCommandRecord,
    );
    await expect(
      executeStockCountCommand({ ...postCommand(), actorReference: id(99) }, replay),
    ).rejects.toMatchObject({
      code: "STOCK_COUNT_IDEMPOTENCY_CONFLICT",
    });
  });
});

describe("blind Count projection", () => {
  const query = (hasVariance: boolean | null = null) => ({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "StockCountRead",
    permission: "inventory.count.read",
    stockScope: scope,
    countReference: id(10),
    statuses: ["InProgress"],
    assigneeReference: id(3),
    hasVariance,
    overdueAt: null,
    limit: 10,
  });

  it("redacts expected quantity, variance and reason before blind submission", async () => {
    const started = startStockCount(assignedCount(), 1, id(3), at(10));
    const counted = saveStockCountLine(started, {
      lineReference: id(20),
      countedQuantity: "12",
      unitCode: "KG",
      varianceReasonCode: "COUNT_VARIANCE",
      expectedVersion: 2,
      actorReference: id(3),
      occurredAt: at(11),
    });
    const adapter = ports(counted);
    const result = await queryStockCounts(query(), adapter);
    expect(result.counts[0]?.lines[0]).toMatchObject({
      expectedQuantity: null,
      countedQuantity: "12",
      variance: null,
      varianceReasonCode: null,
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });

  it("blocks variance filtering without expected-quantity field permission", async () => {
    const adapter = ports(startStockCount(assignedCount(), 1, id(3), at(10)));
    await expect(queryStockCounts(query(true), adapter)).rejects.toMatchObject({
      code: "STOCK_COUNT_PERMISSION_DENIED",
    });
    expect(adapter.projection.query).not.toHaveBeenCalled();
  });
});
