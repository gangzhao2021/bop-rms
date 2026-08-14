import { describe, expect, it, vi } from "vitest";
import {
  correctStockMovement,
  parseInventoryReference,
  parseStockMovementFact,
  queryStockMovements,
  type CorrectStockMovementCommand,
  type StockMovementCorrectionRecord,
  type StockMovementPorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const hash = `sha256:${"0".repeat(64)}`;
const scope = Object.freeze({ scopeType: "Store" as const, scopeReference: id(4) });

function rawMovement(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    movementReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    itemReference: id(20),
    movementType: "Receive",
    quantityDelta: "5.000000",
    unitCode: "KG",
    baseQuantityDelta: "5.000000",
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceScope: null,
    destinationScope: scope,
    lotReference: id(30),
    expiryDate: "2026-12-31",
    businessSourceType: "GOODS_RECEIPT",
    businessSourceReference: id(40),
    reasonCode: "RECEIVED",
    performedBy: id(3),
    occurredAt: "2026-08-14T12:00:00.000Z",
    before: {
      onHand: "0",
      reserved: "0",
      available: "0",
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 1,
    },
    after: {
      onHand: "5.000000",
      reserved: "0",
      available: "5.000000",
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 2,
    },
    auditReference: id(50),
    correctsMovementReference: null,
    ...overrides,
  };
}

function command(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "StockMovementCorrection",
    permission: "inventory.movement.correct",
    operationReference: id(60),
    occurredAt: "2026-08-14T13:00:00.000Z",
    stockScope: scope,
    movementReference: id(10),
    expectedBalanceVersion: 2,
    reasonCode: "DUPLICATE_RECEIPT",
    ...overrides,
  };
}

function query(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "StockMovementRead",
    permission: "inventory.movement.read",
    stockScope: scope,
    movementReference: null,
    itemReference: null,
    movementTypes: [],
    lotReference: null,
    performedBy: null,
    occurredFrom: null,
    occurredUntil: null,
    corrected: null,
    search: null,
    limit: 100,
    ...overrides,
  };
}

const audit = Object.freeze({
  auditId: id(70),
  brandId: id(2),
  actor: { type: "User" as const, reference: id(3) },
  actionCode: "INVENTORY_MOVEMENT_CORRECT",
  targetType: "StockMovement",
  targetId: id(10),
  reasonCode: "DUPLICATE_RECEIPT",
  correlationId: id(60),
  occurredAt: "2026-08-14T13:00:00.000Z",
  sourceChannel: "MerchantWeb",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "INVENTORY_LEDGER",
  retentionPolicyVersion: 1,
});

function correctionRecord(
  parsedCommand: CorrectStockMovementCommand,
): StockMovementCorrectionRecord {
  const original = parseStockMovementFact(rawMovement());
  const correction = parseStockMovementFact(
    rawMovement({
      movementReference: id(11),
      movementType: "Correction",
      quantityDelta: "-5.000000",
      baseQuantityDelta: "-5.000000",
      sourceScope: scope,
      destinationScope: null,
      businessSourceType: "CORRECTION",
      businessSourceReference: id(10),
      reasonCode: parsedCommand.reasonCode,
      performedBy: parsedCommand.actorReference,
      occurredAt: parsedCommand.occurredAt,
      before: {
        onHand: "5.000000",
        reserved: "0",
        available: "5.000000",
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: 2,
      },
      after: {
        onHand: "0",
        reserved: "0",
        available: "0",
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: 3,
      },
      auditReference: id(70),
      correctsMovementReference: id(10),
    }),
  );
  return Object.freeze({
    operationReference: parsedCommand.operationReference,
    intentHash: hash,
    command: parsedCommand,
    original,
    correction,
    audit,
    outcome: "Applied",
  });
}

function ports(): StockMovementPorts {
  return {
    authorization: { authorize: vi.fn(async () => ({ authorized: true as const })) },
    projection: {
      query: vi.fn(async () => ({
        projectionName: "inventory_movement_explorer_v1",
        projectionVersion: 1,
        stockScope: scope,
        asOfUtc: "2026-08-14T12:30:00.000Z",
        freshness: "Current",
        partial: false,
        movements: [{ movement: rawMovement(), correctedByMovementReference: null }],
      })),
    },
    ledger: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => rawMovement()),
      findCorrection: vi.fn(async () => null),
      currentBalanceVersion: vi.fn(async () => 2),
      commitCorrection: vi.fn(async ({ command: parsed }) => correctionRecord(parsed)),
    },
    audit: { create: vi.fn(async () => audit) },
    references: {
      hashIntent: vi.fn(() => hash),
      equals: vi.fn((left, right) => left === right),
    },
  };
}

describe("immutable Stock Movement Explorer", () => {
  it("requires one explicit Stock Scope before authorization or projection access", async () => {
    const adapter = ports();
    await expect(queryStockMovements(query({ stockScope: null }), adapter)).rejects.toMatchObject({
      code: "STOCK_MOVEMENT_INVALID",
    });
    expect(adapter.authorization.authorize).not.toHaveBeenCalled();
    expect(adapter.projection.query).not.toHaveBeenCalled();
  });

  it("authorizes before returning immutable scoped movement evidence", async () => {
    const adapter = ports();
    const result = await queryStockMovements(query(), adapter);
    expect(result.movements[0]).toMatchObject({
      correctedByMovementReference: null,
      movement: {
        movementType: "Receive",
        quantityDelta: "5.000000",
        auditReference: id(50),
      },
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });

  it("rejects a projection row from another tenant or scope", async () => {
    const adapter = ports();
    vi.mocked(adapter.projection.query).mockResolvedValueOnce({
      projectionName: "inventory_movement_explorer_v1",
      projectionVersion: 1,
      stockScope: scope,
      asOfUtc: "2026-08-14T12:30:00.000Z",
      freshness: "Current",
      partial: false,
      movements: [
        { movement: rawMovement({ tenantReference: id(99) }), correctedByMovementReference: null },
      ],
    });
    await expect(queryStockMovements(query(), adapter)).rejects.toMatchObject({
      code: "STOCK_MOVEMENT_PERMISSION_DENIED",
    });
  });
});

describe("compensating correction", () => {
  it("posts one exact inverse linked to the immutable original", async () => {
    const adapter = ports();
    const result = await correctStockMovement(command(), adapter);
    expect(result.correction).toMatchObject({
      movementType: "Correction",
      quantityDelta: "-5.000000",
      correctsMovementReference: id(10),
      businessSourceReference: id(10),
    });
    expect(adapter.audit.create).toHaveBeenCalledBefore(adapter.ledger.commitCorrection as never);
  });

  it("fails closed when a prior correction exists or the balance version is stale", async () => {
    const corrected = ports();
    vi.mocked(corrected.ledger.findCorrection).mockResolvedValueOnce(rawMovement());
    await expect(correctStockMovement(command(), corrected)).rejects.toMatchObject({
      code: "STOCK_MOVEMENT_ALREADY_CORRECTED",
    });
    const stale = ports();
    vi.mocked(stale.ledger.currentBalanceVersion).mockResolvedValueOnce(3);
    await expect(correctStockMovement(command(), stale)).rejects.toMatchObject({
      code: "STOCK_MOVEMENT_NOT_CORRECTABLE",
    });
  });

  it("rejects Transfer correction and forged adapter outcomes", async () => {
    const transfer = ports();
    vi.mocked(transfer.ledger.load).mockResolvedValueOnce(
      rawMovement({
        movementType: "Transfer",
        sourceScope: scope,
        destinationScope: {
          scopeType: "Location",
          scopeReference: id(5),
        },
      }),
    );
    await expect(correctStockMovement(command(), transfer)).rejects.toMatchObject({
      code: "STOCK_MOVEMENT_NOT_CORRECTABLE",
    });
    const forged = ports();
    vi.mocked(forged.ledger.commitCorrection).mockImplementationOnce(
      async ({ command: parsed }) => {
        const record = correctionRecord(parsed);
        return {
          ...record,
          correction: parseStockMovementFact(
            rawMovement({
              movementReference: id(11),
              movementType: "Correction",
              quantityDelta: "-4.000000",
              baseQuantityDelta: "-4.000000",
              sourceScope: scope,
              destinationScope: null,
              businessSourceType: "CORRECTION",
              businessSourceReference: id(10),
              reasonCode: parsed.reasonCode,
              performedBy: parsed.actorReference,
              occurredAt: parsed.occurredAt,
              auditReference: id(70),
              correctsMovementReference: id(10),
            }),
          ),
        };
      },
    );
    await expect(correctStockMovement(command(), forged)).rejects.toMatchObject({
      code: "STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE",
    });
  });
});
