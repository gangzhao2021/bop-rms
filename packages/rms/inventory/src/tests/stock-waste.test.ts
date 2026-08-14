import { describe, expect, it, vi } from "vitest";
import {
  createValidatedStockWaste,
  decideStockWaste,
  executeStockWasteCommand,
  markStockWastePosted,
  parseInventoryInstant,
  parseInventoryReference,
  parseStockMovementFact,
  queryStockWaste,
  submitStockWaste,
  type StockWasteAggregate,
  type StockWasteCommand,
  type StockWastePorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (hour: number) =>
  parseInventoryInstant(`2026-08-14T${hour.toString().padStart(2, "0")}:00:00.000Z`);
const hash = `sha256:${"2".repeat(64)}`;
const scope = Object.freeze({ scopeType: "Location" as const, scopeReference: id(5) });

function validated(overrides: Partial<Parameters<typeof createValidatedStockWaste>[0]> = {}) {
  return createValidatedStockWaste({
    wasteReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    stockScope: scope,
    itemReference: id(20),
    lotReference: id(21),
    expiryDate: "2026-12-31",
    locationReference: id(5),
    quantityDelta: "2",
    unitCode: "KG",
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    reasonCode: "SPOILAGE",
    sourceType: "FoodSafetyIncident",
    sourceReference: id(31),
    evidenceReferences: [id(30)],
    approvalRequirement: "Required",
    approvalPolicyReference: id(32),
    costSummary: { minorUnits: "1250", currencyCode: "CAD", valuationReference: id(33) },
    currentOnHand: "10",
    currentReserved: "2",
    currentAvailable: "8",
    currentInTransit: "0",
    balanceVersion: 7,
    negativeStockPolicy: "Block",
    negativeOverrideAuthorized: false,
    actorReference: id(3),
    occurredAt: at(9),
    ...overrides,
  });
}

function approved() {
  const submitted = submitStockWaste(validated(), 1, id(3), at(10));
  return decideStockWaste(submitted, {
    decision: "Approve",
    expectedVersion: 2,
    actorReference: id(4),
    occurredAt: at(11),
    reasonCode: "IMPACT_APPROVED",
  });
}

function command(action: StockWasteCommand["action"] = "Validate"): StockWasteCommand {
  const permission =
    action === "Approve" || action === "Reject"
      ? "inventory.waste.approve"
      : action === "Post"
        ? "inventory.waste.post"
        : "inventory.waste.record";
  const payload =
    action === "Validate"
      ? {
          stockScope: scope,
          itemReference: id(20),
          lotReference: id(21),
          locationReference: id(5),
          quantityDelta: "2",
          unitCode: "KG",
          reasonCode: "SPOILAGE",
          sourceType: "FoodSafetyIncident",
          sourceReference: id(31),
          evidenceReferences: [id(30)],
        }
      : {
          stockScope: scope,
          wasteReference: id(10),
          expectedVersion: action === "Post" ? 3 : 1,
          ...(["Approve", "Reject", "Cancel"].includes(action)
            ? { reasonCode: "IMPACT_APPROVED" }
            : {}),
        };
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: action === "Approve" || action === "Post" ? id(4) : id(3),
    purpose: "StockWasteManagement",
    permission,
    operationReference: action === "Post" ? id(61) : id(60),
    occurredAt: at(action === "Post" ? 12 : 9),
    action,
    payload: Object.freeze(payload),
  };
}

const audit = Object.freeze({
  auditId: id(70),
  brandId: id(2),
  actor: { type: "User" as const, reference: id(4) },
  actionCode: "INVENTORY_WASTE",
  targetType: "StockWaste",
  targetId: id(10),
  reasonCode: "SPOILAGE",
  correlationId: id(61),
  occurredAt: at(12),
  sourceChannel: "MerchantWeb",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "INVENTORY_LEDGER",
  retentionPolicyVersion: 1,
});

function movement() {
  return {
    movementReference: id(40),
    tenantReference: id(1),
    brandReference: id(2),
    itemReference: id(20),
    movementType: "Waste",
    quantityDelta: "-2",
    unitCode: "KG",
    baseQuantityDelta: "-2",
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceScope: scope,
    destinationScope: null,
    lotReference: id(21),
    expiryDate: "2026-12-31",
    businessSourceType: "STOCK_WASTE",
    businessSourceReference: id(10),
    reasonCode: "SPOILAGE",
    performedBy: id(4),
    occurredAt: at(12),
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
      inTransit: "0",
      unitCode: "KG",
      ledgerVersion: 8,
    },
    auditReference: id(70),
    correctsMovementReference: null,
  };
}

function ports(loaded: StockWasteAggregate | null = null): StockWastePorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayViewEvidence: true,
        mayViewCost: true,
      })),
    },
    projection: {
      query: vi.fn(async () => ({
        projectionName: "inventory_waste_wizard_v1" as const,
        projectionVersion: 1 as const,
        stockScope: scope,
        asOfUtc: at(12) as never,
        freshness: "Current" as const,
        partial: false,
        waste: loaded ?? validated(),
      })),
    },
    snapshot: {
      inspect: vi.fn(async () => ({
        tenantReference: id(1),
        brandReference: id(2),
        stockScope: scope,
        itemReference: id(20),
        lotReference: id(21),
        locationReference: id(5),
        expiryDate: "2026-12-31",
        currentOnHand: "10",
        currentReserved: "2",
        currentAvailable: "8",
        currentInTransit: "0",
        baseUnitCode: "KG",
        conversionMultiplier: "1",
        balanceVersion: 7,
        itemLifecycle: "Active",
        negativeStockPolicy: "Block",
        lotRequirement: "LotAndExpiryRequired",
      })),
    },
    evidence: {
      resolve: vi.fn(async () => ({ evidenceReferences: [id(30)] })),
    },
    source: {
      resolve: vi.fn(async () => ({
        sourceType: "FoodSafetyIncident",
        sourceReference: id(31),
      })),
    },
    policy: {
      decide: vi.fn(async () => ({
        approvalRequirement: "Required",
        approvalPolicyReference: id(32),
      })),
    },
    valuation: {
      inspect: vi.fn(async () => ({
        costSummary: { minorUnits: "1250", currencyCode: "CAD", valuationReference: id(33) },
      })),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => loaded),
      commit: vi.fn(async (record) => record),
    },
    posting: {
      commit: vi.fn(async ({ command: parsed, before, intentHash, audit: evidence }) => ({
        operationReference: parsed.operationReference,
        intentHash,
        action: "Post" as const,
        command: parsed,
        waste: markStockWastePosted(before, id(40), 3, parsed.actorReference, parsed.occurredAt),
        movement: movement() as never,
        audit: evidence,
        outcome: "Applied" as const,
      })),
    },
    audit: { create: vi.fn(async () => audit) },
    references: {
      generate: vi.fn(() => id(10)),
      hashIntent: vi.fn(() => hash),
      equals: vi.fn((left, right) => left === right),
    },
  };
}

describe("Stock Waste aggregate", () => {
  it("uses exact conversion and derives the source impact", () => {
    expect(validated({ quantityDelta: "1.5", conversionMultiplier: "2" })).toMatchObject({
      baseQuantityDelta: "-3",
      currentOnHand: "10",
      projectedOnHand: "7",
      status: "Validated",
    });
  });

  it("blocks forbidden negative stock and requires override authority when configured", () => {
    expect(() => validated({ quantityDelta: "11" })).toThrowError(
      expect.objectContaining({ code: "STOCK_WASTE_BLOCKED" }),
    );
    expect(() =>
      validated({
        quantityDelta: "11",
        negativeStockPolicy: "ManagerOverride",
      }),
    ).toThrowError(expect.objectContaining({ code: "STOCK_WASTE_PERMISSION_DENIED" }));
    expect(
      validated({
        quantityDelta: "11",
        negativeStockPolicy: "AllowWithWarning",
      }),
    ).toMatchObject({ projectedOnHand: "-1", warnings: ["NEGATIVE_STOCK"] });
    expect(
      parseStockMovementFact({
        ...movement(),
        quantityDelta: "-11",
        baseQuantityDelta: "-11",
        sourceScope: scope,
        destinationScope: null,
        after: {
          onHand: "-1",
          reserved: "2",
          available: "-3",
          inTransit: "0",
          unitCode: "KG",
          ledgerVersion: 8,
        },
      }),
    ).toMatchObject({ movementType: "Waste", after: { onHand: "-1" } });
  });

  it("enforces submitter and approver segregation", () => {
    const submitted = submitStockWaste(validated(), 1, id(3), at(10));
    expect(() =>
      decideStockWaste(submitted, {
        decision: "Approve",
        expectedVersion: 2,
        actorReference: id(3),
        occurredAt: at(11),
        reasonCode: "IMPACT_APPROVED",
      }),
    ).toThrowError(expect.objectContaining({ code: "STOCK_WASTE_SEGREGATION_REQUIRED" }));
  });

  it("auto-approves only when the server policy says approval is not required", () => {
    const result = submitStockWaste(
      validated({ approvalRequirement: "NotRequired" }),
      1,
      id(3),
      at(10),
    );
    expect(result).toMatchObject({
      status: "Approved",
      submittedBy: id(3),
      decisions: [{ decision: "Submitted" }, { decision: "Approved" }],
    });
  });
});

describe("Stock Waste application", () => {
  it("authorizes before obtaining the server-owned Balance snapshot", async () => {
    const adapter = ports();
    const result = await executeStockWasteCommand(command(), adapter);
    expect(result.waste).toMatchObject({ balanceVersion: 7, projectedOnHand: "8" });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.snapshot.inspect as never,
    );
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.evidence.resolve as never,
    );
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(adapter.source.resolve as never);
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(adapter.policy.decide as never);
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.valuation.inspect as never,
    );
    expect(adapter.authorization.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ stockScope: scope, permission: "inventory.waste.record" }),
    );
    expect(command().payload).not.toHaveProperty("currentOnHand");
  });

  it("denies scoped execution before reading Balance, evidence or repository state", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce(null);
    await expect(executeStockWasteCommand(command(), adapter)).rejects.toMatchObject({
      code: "STOCK_WASTE_PERMISSION_DENIED",
    });
    expect(adapter.snapshot.inspect).not.toHaveBeenCalled();
    expect(adapter.evidence.resolve).not.toHaveBeenCalled();
    expect(adapter.source.resolve).not.toHaveBeenCalled();
    expect(adapter.policy.decide).not.toHaveBeenCalled();
    expect(adapter.valuation.inspect).not.toHaveBeenCalled();
    expect(adapter.repository.resolveOperation).not.toHaveBeenCalled();
  });

  it("rejects a foreign or malformed snapshot as a dependency failure", async () => {
    const adapter = ports();
    const snapshot = (await ports().snapshot.inspect(command())) as Record<string, unknown>;
    vi.mocked(adapter.snapshot.inspect).mockResolvedValueOnce({
      ...snapshot,
      tenantReference: id(99),
    });
    await expect(executeStockWasteCommand(command(), adapter)).rejects.toMatchObject({
      code: "STOCK_WASTE_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("rejects evidence not resolved for the authorized command context", async () => {
    const adapter = ports();
    vi.mocked(adapter.evidence.resolve).mockResolvedValueOnce({ evidenceReferences: [id(99)] });
    await expect(executeStockWasteCommand(command(), adapter)).rejects.toMatchObject({
      code: "STOCK_WASTE_PERMISSION_DENIED",
    });
  });

  it("rejects a source reference not resolved by its owning Domain contract", async () => {
    const adapter = ports();
    vi.mocked(adapter.source.resolve).mockResolvedValueOnce({
      sourceType: "FoodSafetyIncident",
      sourceReference: id(99),
    });
    await expect(executeStockWasteCommand(command(), adapter)).rejects.toMatchObject({
      code: "STOCK_WASTE_PERMISSION_DENIED",
    });
  });

  it("posts one exact immutable Waste Movement after approval", async () => {
    const adapter = ports(approved());
    const result = await executeStockWasteCommand(command("Post"), adapter);
    expect(result).toMatchObject({
      waste: { status: "Posted", movementReference: id(40) },
      movement: { movementType: "Waste", before: { ledgerVersion: 7 } },
    });
    expect(adapter.audit.create).toHaveBeenCalledBefore(adapter.posting.commit as never);
  });

  it("rejects forged movement and Audit results", async () => {
    const forged = ports(approved());
    vi.mocked(forged.posting.commit).mockImplementationOnce(async (input) => {
      const valid = await ports(approved()).posting.commit(input);
      return { ...valid, movement: { ...movement(), quantityDelta: "-3" } as never };
    });
    await expect(executeStockWasteCommand(command("Post"), forged)).rejects.toMatchObject({
      code: "STOCK_WASTE_DEPENDENCY_UNAVAILABLE",
    });
  });

  it("authorizes scoped reads and masks evidence without field permission", async () => {
    const adapter = ports(validated());
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({ authorized: true });
    const result = await queryStockWaste(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purpose: "StockWasteRead",
        permission: "inventory.waste.read",
        stockScope: scope,
        wasteReference: id(10),
      },
      adapter,
    );
    expect(result.waste.evidenceReferences).toBeNull();
    expect(result.waste.costSummary).toBeNull();
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });
});
