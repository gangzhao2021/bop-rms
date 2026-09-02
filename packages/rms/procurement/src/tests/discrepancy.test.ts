import { describe, expect, it, vi } from "vitest";
import {
  assignDiscrepancy,
  closeDiscrepancy,
  executeDiscrepancy,
  ingestGoodsReceiptDiscrepancy,
  offeringReference,
  openSupplierDiscrepancy,
  queryDiscrepancies,
  resolveDiscrepancy,
  type DiscrepancyCommand,
  type DiscrepancyPorts,
  type SupplierDiscrepancy,
} from "../index.js";
const id = (n: number) =>
  offeringReference(`018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (h: number) => `2026-08-14T${String(h).padStart(2, "0")}:00:00.000Z`;
const hash = `sha256:${"9".repeat(64)}`;
function discrepancy(type: "Short" | "Over" = "Short"): SupplierDiscrepancy {
  return openSupplierDiscrepancy({
    discrepancyReference: id(10),
    tenantReference: id(1),
    brandReference: id(2),
    stockSiteReference: id(3),
    supplierReference: id(4),
    purchaseOrderReference: id(5),
    purchaseOrderLineReference: id(6),
    goodsReceiptReference: id(7),
    receiptLineReference: id(8),
    sourceEventReference: id(9),
    type,
    orderedQuantity: "10" as never,
    priorAcceptedQuantity: "0" as never,
    acceptedQuantity: (type === "Over" ? "11" : "7") as never,
    rejectedQuantity: "0" as never,
    damagedQuantity: "0" as never,
    varianceQuantity: (type === "Over" ? "1" : "3") as never,
    unit: "CASE",
    toleranceQuantity: "1" as never,
    withinTolerance: type === "Over",
    createdAt: at(8),
  });
}
function command(action: DiscrepancyCommand["action"]): DiscrepancyCommand {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    stockSiteReference: id(3),
    actorReference: id(11),
    purpose: "DiscrepancyManagement",
    permission: "procurement.manage",
    operationReference: id(20),
    occurredAt: at(10),
    action,
    payload:
      action === "Assign"
        ? {
            discrepancyReference: id(10),
            expectedVersion: 1,
            decisionReference: id(21),
            ownerReference: id(12),
          }
        : action === "RecordSupplierContact"
          ? {
              discrepancyReference: id(10),
              expectedVersion: 1,
              decisionReference: id(21),
              outcome: "Disputed",
              reasonCode: "SUPPLIER_DISPUTED",
            }
          : action === "Acknowledge"
            ? { discrepancyReference: id(10), expectedVersion: 1, decisionReference: id(21) }
            : action === "WaiveRemainder"
              ? {
                  discrepancyReference: id(10),
                  expectedVersion: 1,
                  decisionReference: id(21),
                  reasonCode: "POLICY_RESOLUTION",
                  approvalReference: id(22),
                }
              : action === "Close"
                ? {
                    discrepancyReference: id(10),
                    expectedVersion: 1,
                    decisionReference: id(21),
                    closureReference: id(22),
                  }
                : {
                    discrepancyReference: id(10),
                    expectedVersion: 1,
                    decisionReference: id(21),
                    reasonCode: "POLICY_RESOLUTION",
                  },
  };
}
function source(before = discrepancy()) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    stockSiteReference: id(3),
    supplierReference: id(4),
    purchaseOrderReference: id(5),
    purchaseOrderLineReference: id(6),
    goodsReceiptReference: id(7),
    receiptLineReference: id(8),
    sourceEventReference: id(9),
    type: before.type,
    varianceQuantity: before.varianceQuantity,
    unit: before.unit,
    toleranceQuantity: before.toleranceQuantity,
    withinTolerance: before.withinTolerance,
    pending: false,
  };
}
function ports(before = discrepancy()): DiscrepancyPorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayViewSupplierContact: false,
        mayViewEvidence: false,
        mayViewCost: false,
        mayViewHistory: false,
        mayWaiveRemainder: true,
      })),
    },
    projection: {
      query: vi.fn(async () => ({
        projectionName: "procurement_discrepancy_v1" as const,
        projectionVersion: 1 as const,
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        asOfUtc: at(11),
        freshness: "Current" as const,
        partial: false,
        mayViewSupplierContact: false,
        mayViewEvidence: false,
        mayViewCost: false,
        mayViewHistory: false,
        rows: [
          {
            discrepancyReference: id(10),
            version: 1,
            type: before.type,
            status: before.status,
            purchaseOrderReference: id(5),
            goodsReceiptReference: id(7),
            supplierReference: id(4),
            supplierSummary: "Synthetic Supplier",
            itemSummary: "Synthetic Item",
            varianceQuantity: before.varianceQuantity,
            unit: "CASE",
            toleranceQuantity: "1",
            withinTolerance: before.withinTolerance,
            ownerReference: null,
            ownerSummary: null,
            overdue: false,
            supplierContactOutcome: null,
            evidenceCount: null,
            unitCost: null,
            history: null,
          },
        ],
      })),
    },
    source: { inspect: vi.fn(async () => source(before)) },
    approvals: {
      validate: vi.fn(async (approvalReference) => ({
        approvalReference,
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        discrepancyReference: id(10),
        decision: "Approved",
        approvedBy: id(13),
        approvedAt: at(9),
      })),
    },
    collaboration: {
      request: vi.fn(async ({ command: input }) => ({
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        discrepancyReference: id(10),
        action: input.action,
        outcomeReference: id(30),
        status: "Applied",
      })),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      resolveSource: vi.fn(async () => null),
      load: vi.fn(async () => before),
      commit: vi.fn(async (record) => record),
    },
    audit: {
      create: vi.fn(async () => ({
        auditId: id(40),
        brandId: id(2),
        actor: { type: "User" as const, reference: id(11) },
        actionCode: "PROCUREMENT_DISCREPANCY",
        targetType: "SupplierDiscrepancy",
        targetId: id(10),
        reasonCode: "POLICY_RESOLUTION",
        correlationId: id(20),
        occurredAt: at(10),
        sourceChannel: "MerchantWeb",
        dataClassification: "Internal" as const,
        retentionPolicyCode: "PROCUREMENT",
        retentionPolicyVersion: 1,
      })),
    },
    references: { hashIntent: vi.fn(() => hash), equals: vi.fn((a, b) => a === b) },
  };
}
describe("Supplier Discrepancy", () => {
  it("preserves source facts through assignment and resolution", () => {
    const assigned = assignDiscrepancy(discrepancy(), {
      expectedVersion: 1,
      decisionReference: id(21),
      ownerReference: id(12),
      actorReference: id(11),
      occurredAt: at(9),
    });
    const resolved = resolveDiscrepancy(assigned, {
      expectedVersion: 2,
      decisionReference: id(22),
      resolution: "RemainderWaived",
      outcomeReference: id(30),
      reasonCode: "APPROVED_WAIVER",
      actorReference: id(11),
      occurredAt: at(10),
    });
    expect(resolved).toMatchObject({
      status: "Resolved",
      varianceQuantity: "3",
      decisions: [{ action: "Assigned" }, { resolution: "RemainderWaived" }],
    });
  });
  it("blocks invalid policy acceptance and close without resolution", () => {
    expect(() =>
      resolveDiscrepancy(discrepancy(), {
        expectedVersion: 1,
        decisionReference: id(21),
        resolution: "AcceptedWithinPolicy",
        outcomeReference: id(30),
        reasonCode: "POLICY",
        actorReference: id(11),
        occurredAt: at(9),
      }),
    ).toThrowError(expect.objectContaining({ code: "DISCREPANCY_POLICY_BLOCKED" }));
    expect(() =>
      closeDiscrepancy(discrepancy(), {
        expectedVersion: 1,
        decisionReference: id(21),
        closureReference: id(30),
        actorReference: id(11),
        occurredAt: at(9),
      }),
    ).toThrowError(expect.objectContaining({ code: "DISCREPANCY_CLOSE_BLOCKED" }));
  });
  it("authorizes before reads and records an exact collaboration outcome", async () => {
    const adapter = ports(discrepancy("Over"));
    const result = await executeDiscrepancy(command("AcceptWithinPolicy"), adapter);
    expect(result.discrepancy).toMatchObject({
      resolution: "AcceptedWithinPolicy",
      resolutionOutcomeReference: id(30),
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.repository.resolveOperation as never,
    );
    expect(adapter.source.inspect).toHaveBeenCalledBefore(adapter.collaboration.request as never);
  });
  it("requires independent approval for a short remainder waiver", async () => {
    const adapter = ports();
    vi.mocked(adapter.approvals.validate).mockResolvedValueOnce({
      approvalReference: id(22),
      tenantReference: id(1),
      brandReference: id(2),
      stockSiteReference: id(3),
      discrepancyReference: id(10),
      decision: "Approved",
      approvedBy: id(11),
      approvedAt: at(9),
    });
    await expect(executeDiscrepancy(command("WaiveRemainder"), adapter)).rejects.toMatchObject({
      code: "DISCREPANCY_APPROVAL_REQUIRED",
    });
  });
  it("creates one case per Receipt Event line and replays the source key", async () => {
    const adapter = ports();
    const item = discrepancy();
    const input = {
      tenantReference: id(1),
      brandReference: id(2),
      stockSiteReference: id(3),
      actorReference: id(14),
      purpose: "DiscrepancyIngestion",
      permission: "procurement.discrepancy.consume",
      operationReference: id(23),
      occurredAt: at(8),
      payload: {
        discrepancyReference: item.discrepancyReference,
        supplierReference: item.supplierReference,
        purchaseOrderReference: item.purchaseOrderReference,
        purchaseOrderLineReference: item.purchaseOrderLineReference,
        goodsReceiptReference: item.goodsReceiptReference,
        receiptLineReference: item.receiptLineReference,
        sourceEventReference: item.sourceEventReference,
        type: item.type,
        orderedQuantity: item.orderedQuantity,
        priorAcceptedQuantity: item.priorAcceptedQuantity,
        acceptedQuantity: item.acceptedQuantity,
        rejectedQuantity: item.rejectedQuantity,
        damagedQuantity: item.damagedQuantity,
        varianceQuantity: item.varianceQuantity,
        unit: item.unit,
        toleranceQuantity: item.toleranceQuantity,
        withinTolerance: item.withinTolerance,
      },
    };
    vi.mocked(adapter.source.inspect).mockResolvedValueOnce({
      tenantReference: id(1),
      brandReference: id(2),
      stockSiteReference: id(3),
      ...Object.fromEntries(
        Object.entries(input.payload).filter(([key]) => key !== "discrepancyReference"),
      ),
    });
    const result = await ingestGoodsReceiptDiscrepancy(input, adapter);
    expect(result.discrepancy).toMatchObject({
      sourceEventReference: id(9),
      receiptLineReference: id(8),
      status: "Open",
    });
    vi.mocked(adapter.repository.resolveSource).mockResolvedValueOnce(result);
    expect(
      (await ingestGoodsReceiptDiscrepancy({ ...input, operationReference: id(24) }, adapter))
        .outcome,
    ).toBe("AlreadyApplied");
  });
  it("keeps correction and replacement requests pending", async () => {
    const result = await executeDiscrepancy(command("RequestCorrection"), ports());
    expect(result.discrepancy).toMatchObject({
      status: "ResolutionPending",
      resolution: "CorrectionRequested",
    });
  });
  it("validates permission-trimmed scoped projection", async () => {
    const adapter = ports();
    const result = await queryDiscrepancies(
      {
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        actorReference: id(11),
        purpose: "DiscrepancyRead",
        permission: "procurement.manage",
        search: null,
        type: "All",
        status: "All",
        ownerReference: null,
        overdue: null,
      },
      adapter,
    );
    expect(result).toMatchObject({
      projectionName: "procurement_discrepancy_v1",
      rows: [{ supplierContactOutcome: null }],
    });
  });
});
