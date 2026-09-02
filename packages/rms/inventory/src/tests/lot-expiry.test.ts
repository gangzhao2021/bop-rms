import { describe, expect, it, vi } from "vitest";
import {
  createLotHold,
  executeLotHold,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  queryLotExpiry,
  quarantineLot,
  releaseLot,
  type LotExpiryPorts,
  type LotHoldAggregate,
  type LotHoldCommand,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (hour: number) =>
  parseInventoryInstant(`2026-08-14T${hour.toString().padStart(2, "0")}:00:00.000Z`);
const stockScope = Object.freeze({ scopeType: "Location" as const, scopeReference: id(10) });
const hash = `sha256:${"5".repeat(64)}`;

function held(): LotHoldAggregate {
  return createLotHold({
    holdReference: id(30),
    tenantReference: id(1),
    brandReference: id(2),
    stockScope,
    locationReference: id(10),
    itemReference: id(20),
    lotReference: id(21),
    expiryDate: "2026-09-01",
    onHand: "8",
    reserved: "2",
    balanceVersion: 7,
    reasonCode: "QUALITY_REVIEW",
    complianceDecisionReference: id(40),
    actorReference: id(3),
    occurredAt: at(9),
  });
}

function command(
  action: LotHoldCommand["action"] = "Quarantine",
  existing: LotHoldAggregate | null = null,
): LotHoldCommand {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "LotHoldManagement",
    permission: "inventory.manage",
    operationReference: id(action === "Quarantine" ? 50 : 51),
    occurredAt: at(10),
    action,
    payload: Object.freeze({
      stockScope,
      locationReference: id(10),
      itemReference: id(20),
      lotReference: id(21),
      expectedVersion: existing?.aggregateVersion ?? 0,
      reasonCode: action === "Quarantine" ? "QUALITY_REVIEW" : "QUALITY_CLEARED",
      complianceDecisionReference: id(action === "Quarantine" ? 40 : 41),
    }),
  };
}

const audit = Object.freeze({
  auditId: id(60),
  brandId: id(2),
  actor: { type: "User" as const, reference: id(3) },
  actionCode: "INVENTORY_LOT_HOLD",
  targetType: "LotHold",
  targetId: id(30),
  reasonCode: "QUALITY_REVIEW",
  correlationId: id(50),
  occurredAt: at(10),
  sourceChannel: "MerchantWeb",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "INVENTORY_LEDGER",
  retentionPolicyVersion: 1,
});

function projection() {
  return {
    projectionName: "inventory_lot_expiry_v1" as const,
    projectionVersion: 1 as const,
    tenantReference: id(1),
    brandReference: id(2),
    stockScope,
    asOfUtc: at(11),
    freshness: "Current" as const,
    partial: false,
    rows: [
      {
        itemReference: id(20),
        itemName: "Tomatoes",
        internalCode: "ING-TOMATO",
        barcode: "001234567890",
        lotReference: id(21),
        lotCode: "LOT-2026-08",
        expiryDate: "2026-09-01",
        receivedAt: at(8),
        locationReference: id(10),
        locationLabel: "Walk-in Fridge",
        onHand: parseInventoryDecimal("8"),
        reserved: parseInventoryDecimal("2"),
        unitCode: "KG",
        status: "Quarantined" as const,
        holdReference: id(30),
        holdVersion: 1,
        supplierReference: id(70),
        supplierLabel: "Approved supplier",
        receiptReference: id(71),
        fefoException: true,
      },
    ],
    trace: {
      lotReference: id(21),
      locationReference: id(10),
      receiptReference: id(71),
      supplierReference: id(70),
      movementReferences: [id(80), id(81)],
      complianceTraceReference: id(82),
      wasteHref: `/operations/inventory/waste/new?lot=${id(21)}`,
      transferHref: `/operations/inventory/transfers?lot=${id(21)}`,
      countHref: `/operations/inventory/counts?lot=${id(21)}`,
    },
    nextCursor: null,
  };
}

function ports(existing: LotHoldAggregate | null = null): LotExpiryPorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayViewSupplierTrace: true,
        mayOpenComplianceTrace: true,
        mayManageHold: true,
      })),
    },
    projection: { query: vi.fn(async () => projection()) },
    snapshot: {
      inspect: vi.fn(async () => ({
        tenantReference: id(1),
        brandReference: id(2),
        stockScope,
        locationReference: id(10),
        itemReference: id(20),
        lotReference: id(21),
        expiryDate: "2026-09-01",
        onHand: "8",
        reserved: "2",
        balanceVersion: 7,
        holdReference: existing?.holdReference ?? null,
        holdVersion: existing?.aggregateVersion ?? 0,
        holdStatus: existing?.status ?? "Available",
      })),
    },
    compliance: {
      resolveDecision: vi.fn(async (input) => ({
        tenantReference: id(1),
        brandReference: id(2),
        stockScope,
        locationReference: id(10),
        lotReference: id(21),
        decisionReference: id(input.action === "Quarantine" ? 40 : 41),
        decision: input.action === "Quarantine" ? "QuarantineApproved" : "ReleaseApproved",
        status: "Active",
        effectiveAt: at(9),
      })),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () => existing),
      commit: vi.fn(async (record) => record),
    },
    audit: { create: vi.fn(async () => audit) },
    references: {
      generate: vi.fn(() => id(30)),
      hashIntent: vi.fn(() => hash),
      equals: vi.fn((left, right) => left === right),
    },
  };
}

describe("Lot Hold aggregate", () => {
  it("creates immutable quarantine evidence and preserves exact lot facts", () => {
    expect(held()).toMatchObject({
      status: "Quarantined",
      itemReference: id(20),
      lotReference: id(21),
      expiryDate: "2026-09-01",
      onHand: "8",
      reserved: "2",
      decisions: [{ decision: "Quarantined", reasonCode: "QUALITY_REVIEW" }],
    });
  });

  it("releases only a quarantined lot with the exact expected version", () => {
    const released = releaseLot(held(), {
      expectedVersion: 1,
      reasonCode: "QUALITY_CLEARED",
      complianceDecisionReference: id(41),
      onHand: "7",
      reserved: "1",
      balanceVersion: 8,
      actorReference: id(4),
      occurredAt: at(10),
    });
    expect(released).toMatchObject({
      status: "Available",
      aggregateVersion: 2,
      decisions: [{ decision: "Quarantined" }, { decision: "Released" }],
      onHand: "7",
      balanceVersion: 8,
    });
    expect(() =>
      releaseLot(released, {
        expectedVersion: 2,
        reasonCode: "QUALITY_CLEARED",
        complianceDecisionReference: id(41),
        onHand: "7",
        reserved: "1",
        balanceVersion: 8,
        actorReference: id(4),
        occurredAt: at(11),
      }),
    ).toThrowError(expect.objectContaining({ code: "LOT_HOLD_STATE_CONFLICT" }));
  });

  it("allows a released lot to be quarantined again without rewriting decisions", () => {
    const released = releaseLot(held(), {
      expectedVersion: 1,
      reasonCode: "QUALITY_CLEARED",
      complianceDecisionReference: id(41),
      onHand: "7",
      reserved: "1",
      balanceVersion: 8,
      actorReference: id(4),
      occurredAt: at(10),
    });
    const requarantined = quarantineLot(released, {
      expectedVersion: 2,
      reasonCode: "NEW_INCIDENT",
      complianceDecisionReference: id(42),
      onHand: "6",
      reserved: "1",
      balanceVersion: 9,
      actorReference: id(3),
      occurredAt: at(11),
    });
    expect(requarantined.decisions.map((entry) => entry.decision)).toEqual([
      "Quarantined",
      "Released",
      "Quarantined",
    ]);
  });
});

describe("Lot / Expiry application", () => {
  it("requires authorization before idempotency, repository or snapshot reads", async () => {
    const adapter = ports();
    await executeLotHold(command(), adapter);
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.repository.resolveOperation as never,
    );
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.snapshot.inspect as never,
    );
    expect(adapter.audit.create).toHaveBeenCalledBefore(adapter.repository.commit as never);
  });

  it("fails closed before reads when hold management is unauthorized", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce(null);
    await expect(executeLotHold(command(), adapter)).rejects.toMatchObject({
      code: "LOT_HOLD_PERMISSION_DENIED",
    });
    expect(adapter.repository.resolveOperation).not.toHaveBeenCalled();
    expect(adapter.snapshot.inspect).not.toHaveBeenCalled();
  });

  it("rejects a forged Compliance decision or mismatched lot snapshot", async () => {
    const adapter = ports();
    vi.mocked(adapter.compliance.resolveDecision).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      stockScope,
      locationReference: id(10),
      lotReference: id(21),
      decisionReference: id(40),
      decision: "ReleaseApproved",
      status: "Active",
      effectiveAt: at(9),
    });
    await expect(executeLotHold(command(), adapter)).rejects.toMatchObject({
      code: "LOT_HOLD_INVALID",
    });
    const mismatched = ports();
    vi.mocked(mismatched.snapshot.inspect).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      stockScope,
      locationReference: id(10),
      itemReference: id(99),
      lotReference: id(21),
      expiryDate: "2026-09-01",
      onHand: "8",
      reserved: "2",
      balanceVersion: 7,
      holdReference: null,
      holdVersion: 0,
      holdStatus: "Available",
    });
    await expect(executeLotHold(command(), mismatched)).rejects.toMatchObject({
      code: "LOT_HOLD_INVALID",
    });
  });

  it("creates and releases a hold without posting a stock movement", async () => {
    const created = await executeLotHold(command(), ports());
    expect(created).toMatchObject({ hold: { status: "Quarantined", aggregateVersion: 1 } });
    const existing = held();
    const released = await executeLotHold(command("Release", existing), ports(existing));
    expect(released).toMatchObject({ hold: { status: "Available", aggregateVersion: 2 } });
    expect("movement" in released).toBe(false);
  });

  it("returns only an exact, authorized scoped projection and trace", async () => {
    const adapter = ports();
    const result = await queryLotExpiry(
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        purpose: "LotExpiryRead",
        permission: "inventory.manage",
        stockScope,
        search: "LOT-2026",
        expiryWindow: "Due30",
        locationReference: id(10),
        holdStatus: "Held",
        supplierReference: id(70),
        fefoExceptionOnly: true,
        selectedLotReference: id(21),
        cursor: null,
      },
      adapter,
    );
    expect(result).toMatchObject({
      projectionName: "inventory_lot_expiry_v1",
      rows: [{ status: "Quarantined", fefoException: true }],
      trace: { movementReferences: [id(80), id(81)] },
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });

  it("blocks supplier filtering and rejects unmasked trace fields without field permission", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({
      authorized: true,
      mayViewSupplierTrace: false,
      mayOpenComplianceTrace: false,
      mayManageHold: false,
    });
    await expect(
      queryLotExpiry(
        {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(3),
          purpose: "LotExpiryRead",
          permission: "inventory.manage",
          stockScope,
          search: null,
          expiryWindow: "All",
          locationReference: null,
          holdStatus: "All",
          supplierReference: id(70),
          fefoExceptionOnly: false,
          selectedLotReference: null,
          cursor: null,
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "LOT_HOLD_PERMISSION_DENIED" });
  });
});
