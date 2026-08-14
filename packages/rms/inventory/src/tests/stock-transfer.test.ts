import { describe, expect, it, vi } from "vitest";
import {
  approveStockTransfer,
  cancelStockTransferRemaining,
  createStockTransfer,
  dispatchStockTransfer,
  executeStockTransferCommand,
  parseInventoryInstant,
  parseInventoryReference,
  queryStockTransferDetail,
  queryStockTransferList,
  receiveStockTransfer,
  reportStockTransferDiscrepancy,
  submitStockTransfer,
  type StockTransferAggregate,
  type StockTransferCommand,
  type StockTransferPorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (hour: number) =>
  parseInventoryInstant(`2026-08-14T${hour.toString().padStart(2, "0")}:00:00.000Z`);
const source = Object.freeze({ scopeType: "Location" as const, scopeReference: id(10) });
const destination = Object.freeze({ scopeType: "Location" as const, scopeReference: id(11) });
const hash = `sha256:${"4".repeat(64)}`;

function resolvedLine(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    lineReference: id(30),
    itemReference: id(20),
    lotReference: id(21),
    expiryDate: "2026-12-31",
    requestedQuantity: "5",
    unitCode: "KG",
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceBalanceVersion: 7,
    sourceOnHand: "10",
    sourceReserved: "2",
    negativeStockPolicy: "Block",
    negativeOverrideAuthorized: false,
    itemLifecycle: "Active",
    lotRequirement: "LotAndExpiryRequired",
    ...overrides,
  };
}
function draft() {
  return createStockTransfer({
    transferReference: id(40),
    tenantReference: id(1),
    brandReference: id(2),
    sourceScope: source,
    destinationScope: destination,
    ownerReference: id(3),
    actorReference: id(3),
    occurredAt: at(9),
    lines: [resolvedLine()],
  });
}
function approved() {
  return approveStockTransfer(
    submitStockTransfer(draft(), 1, id(3), at(10)),
    2,
    id(4),
    at(11),
    "TRANSFER_APPROVED",
  );
}
function command(action: StockTransferCommand["action"] = "Create"): StockTransferCommand {
  const base = { sourceScope: source, destinationScope: destination };
  const payload =
    action === "Create"
      ? {
          ...base,
          ownerReference: id(3),
          lines: [
            { itemReference: id(20), lotReference: id(21), requestedQuantity: "5", unitCode: "KG" },
          ],
        }
      : action === "Dispatch" || action === "Receive"
        ? {
            ...base,
            transferReference: id(40),
            expectedVersion: action === "Dispatch" ? 3 : 4,
            quantities: [{ lineReference: id(30), quantity: "2" }],
          }
        : {
            ...base,
            transferReference: id(40),
            expectedVersion: 1,
            ...(["Approve", "CancelRemaining", "Close"].includes(action)
              ? { reasonCode: "TRANSFER_APPROVED" }
              : {}),
            ...(action === "ReportDiscrepancy"
              ? {
                  reasonCode: "SHORT_RECEIPT",
                  quantities: [{ lineReference: id(30), quantity: "1" }],
                }
              : {}),
          };
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: action === "Approve" || action === "Receive" ? id(4) : id(3),
    purpose: "StockTransferManagement",
    permission: action === "Approve" ? "inventory.transfer.approve" : "inventory.transfer.execute",
    operationReference: id(action === "Dispatch" ? 61 : 60),
    occurredAt: at(action === "Dispatch" ? 12 : 9),
    action,
    payload: Object.freeze(payload),
  };
}
const audit = Object.freeze({
  auditId: id(70),
  brandId: id(2),
  actor: { type: "User" as const, reference: id(3) },
  actionCode: "INVENTORY_TRANSFER",
  targetType: "StockTransfer",
  targetId: id(40),
  reasonCode: "TRANSFER_OPERATION",
  correlationId: id(60),
  occurredAt: at(9),
  sourceChannel: "MerchantWeb",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "INVENTORY_LEDGER",
  retentionPolicyVersion: 1,
});
function movement(action: "Dispatch" | "Receive") {
  const dispatch = action === "Dispatch";
  return {
    movementReference: id(80),
    tenantReference: id(1),
    brandReference: id(2),
    itemReference: id(20),
    movementType: "Transfer",
    quantityDelta: dispatch ? "-2" : "2",
    unitCode: "KG",
    baseQuantityDelta: dispatch ? "-2" : "2",
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceScope: source,
    destinationScope: destination,
    lotReference: id(21),
    expiryDate: "2026-12-31",
    businessSourceType: "STOCK_TRANSFER",
    businessSourceReference: id(40),
    reasonCode: dispatch ? "TRANSFER_DISPATCHED" : "TRANSFER_RECEIVED",
    performedBy: dispatch ? id(3) : id(4),
    occurredAt: dispatch ? at(12) : at(9),
    before: {
      onHand: "10",
      reserved: "2",
      available: "8",
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 7,
    },
    after: {
      onHand: "8",
      reserved: "2",
      available: "6",
      inTransit: "2",
      unitCode: "KG",
      ledgerVersion: 8,
    },
    auditReference: id(70),
    correctsMovementReference: null,
  };
}
function ports(loaded: StockTransferAggregate | null = null): StockTransferPorts {
  return {
    authorization: { authorize: vi.fn(async () => ({ authorized: true as const })) },
    snapshot: {
      resolve: vi.fn(async (parsed) => ({
        tenantReference: id(1),
        brandReference: id(2),
        sourceScope: source,
        destinationScope: destination,
        lines: (parsed.payload.lines as unknown[]).map(() => resolvedLine()),
      })),
    },
    repository: { resolveOperation: vi.fn(async () => null), load: vi.fn(async () => loaded) },
    transaction: {
      commit: vi.fn(async ({ command: parsed, after, intentHash, audit: evidence }) => ({
        operationReference: parsed.operationReference,
        intentHash,
        action: parsed.action,
        command: parsed,
        transfer: after,
        movements:
          parsed.action === "Dispatch" || parsed.action === "Receive"
            ? [movement(parsed.action) as never]
            : [],
        audit: evidence,
        outcome: "Applied" as const,
      })),
    },
    projection: {
      list: vi.fn(async () => ({
        projectionName: "inventory_transfer_list_v1" as const,
        projectionVersion: 1 as const,
        stockScope: source,
        asOfUtc: at(12),
        freshness: "Current" as const,
        partial: false,
        transfers: [loaded ?? draft()],
      })),
      detail: vi.fn(async () => ({
        projectionName: "inventory_transfer_detail_v1" as const,
        projectionVersion: 1 as const,
        sourceScope: source,
        destinationScope: destination,
        asOfUtc: at(12),
        freshness: "Current" as const,
        partial: false,
        transfer: loaded ?? draft(),
      })),
    },
    audit: { create: vi.fn(async () => audit) },
    references: {
      generate: vi.fn((purpose) => (purpose === "StockTransfer" ? id(40) : id(30))),
      hashIntent: vi.fn(() => hash),
      equals: vi.fn((left, right) => left === right),
    },
  };
}

describe("Stock Transfer aggregate", () => {
  it("requires distinct source and destination scopes", () => {
    expect(() =>
      createStockTransfer({
        transferReference: id(40),
        tenantReference: id(1),
        brandReference: id(2),
        sourceScope: source,
        destinationScope: source,
        ownerReference: id(3),
        actorReference: id(3),
        occurredAt: at(9),
        lines: [resolvedLine()],
      }),
    ).toThrowError(expect.objectContaining({ code: "STOCK_TRANSFER_INVALID" }));
  });
  it("fails closed for negative stock unless policy and override permit it", () => {
    expect(() =>
      createStockTransfer({
        transferReference: id(40),
        tenantReference: id(1),
        brandReference: id(2),
        sourceScope: source,
        destinationScope: destination,
        ownerReference: id(3),
        actorReference: id(3),
        occurredAt: at(9),
        lines: [
          resolvedLine({
            requestedQuantity: "11",
            negativeStockPolicy: "ManagerOverride",
            negativeOverrideAuthorized: false,
          }),
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "STOCK_TRANSFER_PERMISSION_DENIED" }));
    expect(
      createStockTransfer({
        transferReference: id(40),
        tenantReference: id(1),
        brandReference: id(2),
        sourceScope: source,
        destinationScope: destination,
        ownerReference: id(3),
        actorReference: id(3),
        occurredAt: at(9),
        lines: [
          resolvedLine({
            requestedQuantity: "11",
            negativeStockPolicy: "ManagerOverride",
            negativeOverrideAuthorized: true,
          }),
        ],
      }).lines[0]?.warnings,
    ).toEqual(["NEGATIVE_STOCK_OVERRIDE"]);
  });
  it("enforces independent approval", () => {
    const submitted = submitStockTransfer(draft(), 1, id(3), at(10));
    expect(() =>
      approveStockTransfer(submitted, 2, id(3), at(11), "TRANSFER_APPROVED"),
    ).toThrowError(expect.objectContaining({ code: "STOCK_TRANSFER_SEGREGATION_REQUIRED" }));
  });
  it("retains partial dispatch, receipt and in-transit quantities", () => {
    const dispatched = dispatchStockTransfer(approved(), {
      expectedVersion: 3,
      actorReference: id(3),
      occurredAt: at(12),
      quantities: [{ lineReference: id(30), quantity: "3" }],
    });
    const received = receiveStockTransfer(dispatched, {
      expectedVersion: 4,
      actorReference: id(4),
      occurredAt: at(13),
      quantities: [{ lineReference: id(30), quantity: "2" }],
    });
    expect(received).toMatchObject({
      status: "PartiallyReceived",
      lines: [
        {
          requestedQuantity: "5",
          dispatchedQuantity: "3",
          receivedQuantity: "2",
          inTransitQuantity: "1",
        },
      ],
    });
  });
  it("blocks over-receipt and appends discrepancy instead of rewriting facts", () => {
    const dispatched = dispatchStockTransfer(approved(), {
      expectedVersion: 3,
      actorReference: id(3),
      occurredAt: at(12),
      quantities: [{ lineReference: id(30), quantity: "3" }],
    });
    expect(() =>
      receiveStockTransfer(dispatched, {
        expectedVersion: 4,
        actorReference: id(4),
        occurredAt: at(13),
        quantities: [{ lineReference: id(30), quantity: "4" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "STOCK_TRANSFER_BLOCKED" }));
    const exception = reportStockTransferDiscrepancy(dispatched, {
      expectedVersion: 4,
      actorReference: id(4),
      occurredAt: at(13),
      reasonCode: "SHORT_RECEIPT",
      quantities: [{ lineReference: id(30), quantity: "1" }],
    });
    expect(exception).toMatchObject({
      status: "Exception",
      lines: [
        {
          dispatchedQuantity: "3",
          receivedQuantity: "0",
          inTransitQuantity: "2",
          discrepancyQuantity: "1",
        },
      ],
    });
  });
  it("cancels only the undispatched remainder and preserves request and dispatch facts", () => {
    const dispatched = dispatchStockTransfer(approved(), {
      expectedVersion: 3,
      actorReference: id(3),
      occurredAt: at(12),
      quantities: [{ lineReference: id(30), quantity: "3" }],
    });
    const cancelled = cancelStockTransferRemaining(dispatched, {
      expectedVersion: 4,
      actorReference: id(4),
      occurredAt: at(13),
      reasonCode: "DESTINATION_CAPACITY",
    });
    expect(cancelled.lines[0]).toMatchObject({
      requestedQuantity: "5",
      dispatchedQuantity: "3",
      inTransitQuantity: "3",
      cancelledQuantity: "2",
    });
  });
});

describe("Stock Transfer application", () => {
  it("authorizes both scopes before snapshot and persistence reads", async () => {
    const adapter = ports();
    const result = await executeStockTransferCommand(command(), adapter);
    expect(result.transfer).toMatchObject({
      sourceScope: source,
      destinationScope: destination,
      status: "Draft",
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.snapshot.resolve as never,
    );
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.repository.resolveOperation as never,
    );
  });
  it("fails closed before reads when either scope is unauthorized", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce(null);
    await expect(executeStockTransferCommand(command(), adapter)).rejects.toMatchObject({
      code: "STOCK_TRANSFER_PERMISSION_DENIED",
    });
    expect(adapter.snapshot.resolve).not.toHaveBeenCalled();
    expect(adapter.repository.resolveOperation).not.toHaveBeenCalled();
  });
  it("rejects a source snapshot that does not rebind the requested Item", async () => {
    const adapter = ports();
    vi.mocked(adapter.snapshot.resolve).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      sourceScope: source,
      destinationScope: destination,
      lines: [resolvedLine({ itemReference: id(99) })],
    });
    await expect(executeStockTransferCommand(command(), adapter)).rejects.toMatchObject({
      code: "STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("validates atomic dispatch Movement output", async () => {
    const adapter = ports(approved());
    const result = await executeStockTransferCommand(command("Dispatch"), adapter);
    expect(result).toMatchObject({
      transfer: { status: "PartiallyDispatched" },
      movements: [{ movementType: "Transfer", quantityDelta: "-2" }],
    });
    expect(adapter.audit.create).toHaveBeenCalledBefore(adapter.transaction.commit as never);
  });
  it("rejects forged Transfer Movement output", async () => {
    const adapter = ports(approved());
    vi.mocked(adapter.transaction.commit).mockImplementationOnce(async (input) => ({
      operationReference: input.command.operationReference,
      intentHash: input.intentHash,
      action: input.command.action,
      command: input.command,
      transfer: input.after,
      movements: [{ ...movement("Dispatch"), businessSourceReference: id(99) } as never],
      audit: input.audit,
      outcome: "Applied",
    }));
    await expect(executeStockTransferCommand(command("Dispatch"), adapter)).rejects.toMatchObject({
      code: "STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("authorizes list and detail projections before returning scoped facts", async () => {
    const adapter = ports(draft());
    const list = await queryStockTransferList(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purpose: "StockTransferRead",
        permission: "inventory.transfer.read",
        stockScope: source,
        status: null,
        discrepancyOnly: false,
        search: null,
        limit: 100,
      },
      adapter,
    );
    const detail = await queryStockTransferDetail(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purpose: "StockTransferRead",
        permission: "inventory.transfer.read",
        sourceScope: source,
        destinationScope: destination,
        transferReference: id(40),
      },
      adapter,
    );
    expect(list.transfers).toHaveLength(1);
    expect(detail.transfer.transferReference).toBe(id(40));
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.list as never,
    );
  });
});
