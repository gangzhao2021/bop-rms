import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeReplenishmentNeed,
  detectReplenishmentNeed,
  dismissReplenishmentNeed,
  executeReplenishment,
  linkRequisitionDraft,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  queryReplenishment,
  type ReplenishmentCommand,
  type ReplenishmentNeedAggregate,
  type ReplenishmentPorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (hour: number) =>
  parseInventoryInstant(`2026-08-14T${hour.toString().padStart(2, "0")}:00:00.000Z`);
const stockScope = Object.freeze({ scopeType: "Store" as const, scopeReference: id(10) });
const hash = `sha256:${"7".repeat(64)}`;

function need(): ReplenishmentNeedAggregate {
  return detectReplenishmentNeed({
    needReference: id(20),
    tenantReference: id(1),
    brandReference: id(2),
    stockScope,
    itemReference: id(30),
    available: parseInventoryDecimal("4"),
    reorderPoint: parseInventoryDecimal("10"),
    safetyStock: parseInventoryDecimal("3"),
    forecastQuantity: parseInventoryDecimal("2"),
    suggestedQuantity: parseInventoryDecimal("16"),
    baseUnitCode: "KG",
    requiredBy: "2026-08-17",
    reasonCode: "BELOW_REORDER",
    urgency: "High",
    policyReference: id(31),
    balanceVersion: 8,
    forecastReference: id(32),
    forecastAsOfUtc: at(8),
    createdAt: at(9),
  });
}

function command(action: ReplenishmentCommand["action"]): ReplenishmentCommand {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "ReplenishmentManagement",
    permission:
      action === "CreateRequisitionDraft" ? "procurement.requisition.create" : "inventory.manage",
    operationReference: id(action === "Acknowledge" ? 50 : action === "Dismiss" ? 51 : 52),
    occurredAt: at(10),
    action,
    payload: Object.freeze({
      stockScope,
      needReference: id(20),
      expectedVersion: 1,
      ...(action === "Dismiss" ? { reasonCode: "DUPLICATE_NEED" } : {}),
    }),
  };
}

function projection(supplier = true) {
  return {
    projectionName: "inventory_replenishment_v1" as const,
    projectionVersion: 1 as const,
    tenantReference: id(1),
    brandReference: id(2),
    stockScope,
    asOfUtc: at(11),
    freshness: "Current" as const,
    partial: false,
    rows: [
      {
        needReference: id(20),
        needVersion: 1,
        itemReference: id(30),
        itemName: "Tomatoes",
        internalCode: "ING-TOMATO",
        available: parseInventoryDecimal("4"),
        reorderPoint: parseInventoryDecimal("10"),
        safetyStock: parseInventoryDecimal("3"),
        forecastQuantity: parseInventoryDecimal("2"),
        forecastReference: id(32),
        forecastAsOfUtc: at(8),
        suggestedQuantity: parseInventoryDecimal("16"),
        baseUnitCode: "KG",
        requiredBy: "2026-08-17",
        urgency: "High" as const,
        reasonCode: "BELOW_REORDER",
        preferredSupplierMappingReference: supplier ? id(40) : null,
        preferredSupplierReference: supplier ? id(41) : null,
        preferredSupplierSummary: supplier ? "Preferred supplier available" : null,
        status: "Open" as const,
        requisitionReference: null,
      },
    ],
    nextCursor: null,
  };
}

function snapshot() {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    stockScope,
    needReference: id(20),
    itemReference: id(30),
    available: "4",
    reorderPoint: "10",
    safetyStock: "3",
    forecastQuantity: "2",
    suggestedQuantity: "16",
    baseUnitCode: "KG",
    requiredBy: "2026-08-17",
    reasonCode: "BELOW_REORDER",
    urgency: "High",
    policyReference: id(31),
    balanceVersion: 8,
    forecastReference: id(32),
    forecastAsOfUtc: at(8),
    needVersion: 1,
    needStatus: "Open",
  };
}

const audit = Object.freeze({
  auditId: id(60),
  brandId: id(2),
  actor: { type: "User" as const, reference: id(3) },
  actionCode: "INVENTORY_REPLENISHMENT",
  targetType: "ReplenishmentNeed",
  targetId: id(20),
  reasonCode: "BELOW_REORDER",
  correlationId: id(50),
  occurredAt: at(10),
  sourceChannel: "MerchantWeb",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "INVENTORY_LEDGER",
  retentionPolicyVersion: 1,
});

function ports(): ReplenishmentPorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayViewSupplierSummary: true,
        mayAcknowledge: true,
        mayDismiss: true,
        mayCreateRequisitionDraft: true,
      })),
    },
    projection: { query: vi.fn(async () => projection()) },
    snapshot: { inspect: vi.fn(async () => snapshot()) },
    procurement: {
      createRequisitionDraft: vi.fn(async () => ({
        tenantReference: id(1),
        brandReference: id(2),
        stockScope,
        sourceNeedReference: id(20),
        requisitionReference: id(70),
        workflowStatus: "Draft",
        purchaseOrderReference: null,
      })),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => need()),
      commit: vi.fn(async (record) => record),
    },
    audit: { create: vi.fn(async () => audit) },
    references: { hashIntent: vi.fn(() => hash), equals: vi.fn((left, right) => left === right) },
  };
}

describe("Replenishment Need aggregate", () => {
  it("preserves immutable source evidence and append-only decisions", () => {
    const acknowledged = acknowledgeReplenishmentNeed(need(), {
      expectedVersion: 1,
      actorReference: id(3),
      occurredAt: at(10),
    });
    const linked = linkRequisitionDraft(acknowledged, {
      expectedVersion: 2,
      requisitionReference: id(70),
      actorReference: id(3),
      occurredAt: at(11),
    });
    expect(linked).toMatchObject({
      status: "RequisitionDraftCreated",
      aggregateVersion: 3,
      available: "4",
      decisions: [
        { kind: "Acknowledged" },
        { kind: "RequisitionDraftLinked", requisitionReference: id(70) },
      ],
    });
  });

  it("requires a controlled dismissal reason and blocks terminal rewrites", () => {
    const dismissed = dismissReplenishmentNeed(need(), {
      expectedVersion: 1,
      reasonCode: "DUPLICATE_NEED",
      actorReference: id(3),
      occurredAt: at(10),
    });
    expect(dismissed).toMatchObject({
      status: "Dismissed",
      decisions: [{ reasonCode: "DUPLICATE_NEED" }],
    });
    expect(() =>
      acknowledgeReplenishmentNeed(dismissed, {
        expectedVersion: 2,
        actorReference: id(3),
        occurredAt: at(11),
      }),
    ).toThrowError(expect.objectContaining({ code: "REPLENISHMENT_STATE_CONFLICT" }));
  });
});

describe("Replenishment application", () => {
  it("authorizes before reads and validates the named scoped projection", async () => {
    const adapter = ports();
    const result = await queryReplenishment(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purpose: "ReplenishmentRead",
        permission: "inventory.manage",
        stockScope,
        search: "TOM",
        storeReference: id(10),
        status: "All",
        urgency: "High",
        supplier: "Mapped",
        supplierReference: id(41),
        cursor: null,
      },
      adapter,
    );
    expect(result.rows[0]).toMatchObject({
      needReference: id(20),
      suggestedQuantity: "16",
      preferredSupplierSummary: "Preferred supplier available",
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });

  it("masks supplier facts and rejects supplier filters without separate access", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({
      authorized: true,
      mayViewSupplierSummary: false,
    });
    await expect(
      queryReplenishment(
        {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(3),
          purpose: "ReplenishmentRead",
          permission: "inventory.manage",
          stockScope,
          search: null,
          storeReference: null,
          status: "All",
          urgency: "All",
          supplier: "Mapped",
          supplierReference: null,
          cursor: null,
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "REPLENISHMENT_PERMISSION_DENIED" });
  });

  it("creates only a Draft Requisition using Need ID as the handoff idempotency key", async () => {
    const adapter = ports();
    const result = await executeReplenishment(command("CreateRequisitionDraft"), adapter);
    expect(adapter.procurement.createRequisitionDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceNeedReference: id(20),
        idempotencyReference: id(20),
        requestedQuantity: "16",
      }),
    );
    expect(result).toMatchObject({
      requisitionReference: id(70),
      need: { status: "RequisitionDraftCreated" },
    });
    expect(adapter.audit.create).toHaveBeenCalledBefore(adapter.repository.commit as never);
  });

  it("fails closed on a Procurement result that approves work or creates a PO", async () => {
    const adapter = ports();
    vi.mocked(adapter.procurement.createRequisitionDraft).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      stockScope,
      sourceNeedReference: id(20),
      requisitionReference: id(70),
      workflowStatus: "Approved",
      purchaseOrderReference: id(71),
    });
    await expect(
      executeReplenishment(command("CreateRequisitionDraft"), adapter),
    ).rejects.toMatchObject({ code: "REPLENISHMENT_DEPENDENCY_UNAVAILABLE" });
    expect(adapter.repository.commit).not.toHaveBeenCalled();
  });

  it("returns an idempotent replay without repeating the Procurement handoff", async () => {
    const adapter = ports();
    const first = await executeReplenishment(command("CreateRequisitionDraft"), adapter);
    vi.mocked(adapter.repository.resolveOperation).mockResolvedValueOnce(first);
    const replay = await executeReplenishment(command("CreateRequisitionDraft"), adapter);
    expect(replay.outcome).toBe("AlreadyApplied");
    expect(adapter.procurement.createRequisitionDraft).toHaveBeenCalledTimes(1);
  });

  it("requires expected source snapshots and dismissal reasons", async () => {
    const adapter = ports();
    vi.mocked(adapter.snapshot.inspect).mockResolvedValueOnce({ ...snapshot(), balanceVersion: 9 });
    await expect(executeReplenishment(command("Dismiss"), adapter)).rejects.toMatchObject({
      code: "REPLENISHMENT_CONFLICT",
    });
    await expect(
      executeReplenishment(
        {
          ...command("Dismiss"),
          payload: {
            stockScope,
            needReference: id(20),
            expectedVersion: 1,
            reasonCode: "free form",
          },
        },
        ports(),
      ),
    ).rejects.toMatchObject({ code: "REPLENISHMENT_INVALID" });
  });
});
