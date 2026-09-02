import { describe, expect, it, vi } from "vitest";
import {
  appendGoodsReceiptCorrection,
  createValidatedGoodsReceipt,
  executeGoodsReceipt,
  markGoodsReceiptPosted,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  queryGoodsReceipt,
  type GoodsReceipt,
  type GoodsReceiptCommand,
  type GoodsReceiptLine,
  type GoodsReceiptPorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fab00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (hour: number) =>
  parseInventoryInstant(`2026-08-14T${String(hour).padStart(2, "0")}:00:00.000Z`);
const hash = `sha256:${"8".repeat(64)}`;
function line(overrides: Partial<GoodsReceiptLine> = {}): GoodsReceiptLine {
  return {
    receiptLineReference: id(20),
    purchaseOrderLineReference: id(21),
    inventoryItemReference: id(22),
    offeringReference: id(23),
    offeringVersionReference: id(24),
    priceVersionReference: id(25),
    lotReference: id(26),
    lotCode: "LOT-26",
    expiryDate: "2026-09-30",
    locationReference: id(27),
    deliveredQuantity: parseInventoryDecimal("6"),
    acceptedQuantity: parseInventoryDecimal("4"),
    rejectedQuantity: parseInventoryDecimal("1"),
    damagedQuantity: parseInventoryDecimal("1"),
    purchaseUnit: "CASE",
    baseUnit: "EA",
    conversionMultiplier: parseInventoryDecimal("12"),
    orderedQuantity: parseInventoryDecimal("10"),
    priorAcceptedQuantity: parseInventoryDecimal("4"),
    overReceiptPolicy: "Block",
    toleranceQuantity: parseInventoryDecimal("0"),
    managerOverrideApprovalReference: null,
    overrideReasonCode: null,
    qualityDisposition: "Quarantined",
    temperatureReading: "3.50",
    temperatureUnit: "C",
    evidenceReferences: [id(28)],
    discrepancyRequired: true,
    ...overrides,
  };
}
function draft(lines: readonly GoodsReceiptLine[] = [line()]): GoodsReceipt {
  return createValidatedGoodsReceipt({
    goodsReceiptReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    stockSiteReference: id(3),
    supplierReference: id(4),
    purchaseOrderReference: id(5),
    purchaseOrderVersion: 7,
    purchaseOrderRevisionNumber: 2,
    issuedSnapshotReference: id(6),
    receivedAt: at(9),
    lines,
    actorReference: id(7),
    occurredAt: at(10),
  });
}
function command(action: GoodsReceiptCommand["action"] = "Post"): GoodsReceiptCommand {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    stockSiteReference: id(3),
    actorReference: id(7),
    purpose: "GoodsReceiptManagement",
    permission: "inventory.receive",
    operationReference: id(action === "Post" ? 30 : action === "Adjust" ? 31 : 32),
    occurredAt: at(10),
    action,
    payload:
      action === "Post"
        ? {
            goodsReceiptReference: id(10),
            purchaseOrderReference: id(5),
            purchaseOrderVersion: 7,
            purchaseOrderRevisionNumber: 2,
            issuedSnapshotReference: id(6),
            supplierReference: id(4),
            receivedAt: at(9),
            eventReference: id(40),
            lines: [line()],
          }
        : {
            goodsReceiptReference: id(10),
            expectedVersion: 2,
            correctionReference: id(41),
            eventReference: id(42),
            reasonCode: "COUNT_CORRECTION",
            lines: [
              {
                receiptLineReference: id(20),
                purchaseOrderLineReference: id(21),
                acceptedQuantityDelta: "-1",
                rejectedQuantityDelta: "1",
                damagedQuantityDelta: "0",
                unit: "CASE",
              },
            ],
          },
  };
}
function snapshot() {
  const value = line();
  return {
    tenantReference: id(1),
    brandReference: id(2),
    stockSiteReference: id(3),
    supplierReference: id(4),
    purchaseOrderReference: id(5),
    purchaseOrderVersion: 7,
    purchaseOrderRevisionNumber: 2,
    issuedSnapshotReference: id(6),
    workflow: "Issued",
    closure: "Open",
    lines: [
      {
        purchaseOrderLineReference: value.purchaseOrderLineReference,
        inventoryItemReference: value.inventoryItemReference,
        offeringReference: value.offeringReference,
        offeringVersionReference: value.offeringVersionReference,
        priceVersionReference: value.priceVersionReference,
        purchaseUnit: value.purchaseUnit,
        baseUnit: value.baseUnit,
        conversionMultiplier: value.conversionMultiplier,
        orderedQuantity: value.orderedQuantity,
        priorAcceptedQuantity: value.priorAcceptedQuantity,
        overReceiptPolicy: value.overReceiptPolicy,
        toleranceQuantity: value.toleranceQuantity,
      },
    ],
  };
}
function ports(): GoodsReceiptPorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayViewCost: false,
        mayViewEvidence: true,
        mayViewTemperature: true,
      })),
    },
    projection: {
      query: vi.fn(async () => ({
        projectionName: "inventory_goods_receipt_v1" as const,
        projectionVersion: 1 as const,
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        asOfUtc: at(11),
        freshness: "Current" as const,
        partial: false,
        mayViewCost: false,
        mayViewEvidence: true,
        mayViewTemperature: true,
        draft: {
          goodsReceiptReference: id(10),
          supplierReference: id(4),
          supplierSummary: "Synthetic Supplier",
          purchaseOrderReference: id(5),
          purchaseOrderVersion: 7,
          purchaseOrderRevisionNumber: 2,
          issuedSnapshotReference: id(6),
          receivedAt: at(9),
          lines: [line()],
        },
      })),
    },
    procurement: { receivingSnapshot: vi.fn(async () => snapshot()) },
    approvals: {
      validate: vi.fn(async (approvalReference) => ({
        approvalReference,
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        purchaseOrderLineReference: id(21),
        decision: "Approved",
        approvedBy: id(8),
        approvedAt: at(8),
        reasonCode: "AUTHORIZED_OVERAGE",
      })),
    },
    evidence: {
      validate: vi.fn(async (references) => ({
        references,
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
      })),
    },
    ledger: {
      preparePost: vi.fn(async () => [{ receiptLineReference: id(20), movementReference: id(50) }]),
      prepareCorrection: vi.fn(async () => [id(51)]),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      load: vi.fn(async () =>
        markGoodsReceiptPosted(draft(), {
          expectedVersion: 1,
          postedEventReference: id(40),
          stockMovementReferences: [id(50)],
          actorReference: id(7),
          occurredAt: at(10),
        }),
      ),
      commit: vi.fn(async (record) => record),
    },
    audit: {
      create: vi.fn(async () => ({
        auditId: id(60),
        brandId: id(2),
        actor: { type: "User" as const, reference: id(7) },
        actionCode: "INVENTORY_GOODS_RECEIPT",
        targetType: "GoodsReceipt",
        targetId: id(10),
        reasonCode: "RECEIPT",
        correlationId: id(30),
        occurredAt: at(10),
        sourceChannel: "MerchantWeb",
        dataClassification: "Internal" as const,
        retentionPolicyCode: "INVENTORY_LEDGER",
        retentionPolicyVersion: 1,
      })),
    },
    references: { hashIntent: vi.fn(() => hash), equals: vi.fn((left, right) => left === right) },
  };
}

describe("Goods Receipt aggregate", () => {
  it("keeps rejected and damaged quantities out of accepted movement cardinality", () => {
    const receipt = markGoodsReceiptPosted(draft(), {
      expectedVersion: 1,
      postedEventReference: id(40),
      stockMovementReferences: [id(50)],
      actorReference: id(7),
      occurredAt: at(10),
    });
    expect(receipt).toMatchObject({
      status: "Posted",
      stockMovementReferences: [id(50)],
      lines: [
        {
          acceptedQuantity: "4",
          rejectedQuantity: "1",
          damagedQuantity: "1",
          discrepancyRequired: true,
        },
      ],
    });
  });
  it("enforces block, tolerance and independent manager override", () => {
    expect(() =>
      draft([
        line({
          acceptedQuantity: parseInventoryDecimal("7"),
          rejectedQuantity: parseInventoryDecimal("0"),
          damagedQuantity: parseInventoryDecimal("0"),
          deliveredQuantity: parseInventoryDecimal("7"),
        }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "GOODS_RECEIPT_TOLERANCE_BLOCKED" }));
    expect(() =>
      draft([
        line({
          acceptedQuantity: parseInventoryDecimal("7"),
          rejectedQuantity: parseInventoryDecimal("0"),
          damagedQuantity: parseInventoryDecimal("0"),
          deliveredQuantity: parseInventoryDecimal("7"),
          overReceiptPolicy: "ManagerOverride",
        }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "GOODS_RECEIPT_OVERRIDE_REQUIRED" }));
    expect(
      draft([
        line({
          acceptedQuantity: parseInventoryDecimal("7"),
          rejectedQuantity: parseInventoryDecimal("0"),
          damagedQuantity: parseInventoryDecimal("0"),
          deliveredQuantity: parseInventoryDecimal("7"),
          overReceiptPolicy: "AllowWithinTolerance",
          toleranceQuantity: parseInventoryDecimal("1"),
        }),
      ]).lines[0]?.acceptedQuantity,
    ).toBe("7");
  });
  it("appends correction facts and preserves the posted receipt", () => {
    const posted = markGoodsReceiptPosted(draft(), {
      expectedVersion: 1,
      postedEventReference: id(40),
      stockMovementReferences: [id(50)],
      actorReference: id(7),
      occurredAt: at(10),
    });
    const adjusted = appendGoodsReceiptCorrection(posted, {
      expectedVersion: 2,
      correctionReference: id(41),
      correctionType: "Adjustment",
      eventReference: id(42),
      reasonCode: "COUNT_CORRECTION",
      lines: [
        {
          receiptLineReference: id(20),
          purchaseOrderLineReference: id(21),
          acceptedQuantityDelta: "-1",
          rejectedQuantityDelta: "1",
          damagedQuantityDelta: "0",
          unit: "CASE",
        },
      ],
      compensatingMovementReferences: [id(51)],
      actorReference: id(8),
      occurredAt: at(11),
    });
    expect(adjusted).toMatchObject({
      status: "Posted",
      postedEventReference: id(40),
      stockMovementReferences: [id(50)],
      corrections: [{ compensatingMovementReferences: [id(51)] }],
    });
  });
});

describe("Goods Receipt application", () => {
  it("authorizes first, rebinds the issued PO snapshot and commits exact movements", async () => {
    const adapter = ports();
    const result = await executeGoodsReceipt(command(), adapter);
    expect(result.event).toMatchObject({
      eventName: "GoodsReceiptPosted",
      purchaseOrderReference: id(5),
      lines: [
        {
          acceptedQuantity: "4",
          rejectedQuantity: "1",
          damagedQuantity: "1",
          stockMovementReference: id(50),
        },
      ],
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.repository.resolveOperation as never,
    );
    expect(adapter.procurement.receivingSnapshot).toHaveBeenCalledBefore(
      adapter.ledger.preparePost as never,
    );
    expect(adapter.repository.commit).toHaveBeenCalledOnce();
  });
  it("rejects owner-fact drift and a movement mapped to the wrong receipt line", async () => {
    const drift = ports();
    vi.mocked(drift.procurement.receivingSnapshot).mockResolvedValueOnce({
      ...snapshot(),
      purchaseOrderVersion: 8,
    });
    await expect(executeGoodsReceipt(command(), drift)).rejects.toMatchObject({
      code: "GOODS_RECEIPT_INVALID",
    });
    const mismatch = ports();
    vi.mocked(mismatch.ledger.preparePost).mockResolvedValueOnce([
      { receiptLineReference: id(99), movementReference: id(50) },
    ]);
    await expect(executeGoodsReceipt(command(), mismatch)).rejects.toMatchObject({
      code: "GOODS_RECEIPT_MOVEMENT_MISMATCH",
    });
  });
  it("replays only the same scoped Actor intent and appends corrections", async () => {
    const adapter = ports();
    const result = await executeGoodsReceipt(command("Adjust"), adapter);
    expect(result.receipt).toMatchObject({
      aggregateVersion: 3,
      corrections: [{ correctionType: "Adjustment", compensatingMovementReferences: [id(51)] }],
    });
    vi.mocked(adapter.repository.resolveOperation).mockResolvedValueOnce(result);
    await expect(
      executeGoodsReceipt({ ...command("Adjust"), actorReference: id(99) }, adapter),
    ).rejects.toMatchObject({ code: "GOODS_RECEIPT_INVALID" });
  });
  it("validates the named scoped projection and permission-trimmed evidence", async () => {
    const adapter = ports();
    const result = await queryGoodsReceipt(
      {
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        actorReference: id(7),
        purpose: "GoodsReceiptRead",
        permission: "inventory.receive",
        search: "PO",
        supplierReference: null,
        purchaseOrderReference: id(5),
        itemReference: null,
        barcode: null,
      },
      adapter,
    );
    expect(result).toMatchObject({
      projectionName: "inventory_goods_receipt_v1",
      draft: { purchaseOrderReference: id(5) },
    });
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({
      authorized: true,
      mayViewCost: false,
      mayViewEvidence: false,
      mayViewTemperature: true,
    });
    await expect(
      queryGoodsReceipt(
        {
          tenantReference: id(1),
          brandReference: id(2),
          stockSiteReference: id(3),
          actorReference: id(7),
          purpose: "GoodsReceiptRead",
          permission: "inventory.receive",
          search: null,
          supplierReference: null,
          purchaseOrderReference: null,
          itemReference: null,
          barcode: null,
        },
        adapter,
      ),
    ).rejects.toMatchObject({ code: "GOODS_RECEIPT_INVALID" });
  });
});
