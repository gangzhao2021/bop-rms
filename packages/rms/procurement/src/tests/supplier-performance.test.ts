import { describe, expect, it, vi } from "vitest";
import {
  executeSupplierPerformanceReview,
  offeringReference,
  querySupplierPerformance,
  type SupplierPerformancePorts,
  type SupplierPerformanceQuery,
} from "../index.js";
const id = (n: number) =>
  offeringReference(`018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`;
const query: SupplierPerformanceQuery = {
  tenantReference: id(1),
  brandReference: id(2),
  stockSiteReference: id(3),
  actorReference: id(4),
  purpose: "SupplierPerformanceRead",
  permission: "procurement.manage",
  supplierReference: null,
  offeringReference: null,
  itemCategoryCode: null,
  periodFromUtc: at(1),
  periodToUtc: at(31),
  metricThreshold: null,
};
const fact = (n: number, overrides: Record<string, unknown> = {}) => ({
  tenantReference: id(1),
  brandReference: id(2),
  stockSiteReference: id(3),
  supplierReference: id(5),
  supplierSummary: "Synthetic Supplier",
  offeringReference: id(6),
  itemCategoryCode: "PRODUCE",
  sourceFactReference: id(20 + n),
  occurredAt: at(10 + n),
  orderedQuantity: "3",
  acceptedQuantity: "2",
  receivedQuantity: "2.5",
  onTime: n === 1,
  acknowledgementResponseSeconds: n === 1 ? 61 : 60,
  supplierOutcome: n === 1 ? "Accepted" : "Declined",
  discrepancyTypes: n === 1 ? ["Short"] : ["Rejected", "Damaged"],
  priceVarianceAmount: n === 1 ? "0.10" : "-0.03",
  currency: "CAD",
  complete: n === 1,
  ...overrides,
});
function ports(): SupplierPerformancePorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({
        authorized: true as const,
        mayDrillFacts: true,
        mayViewPriceVariance: true,
        mayViewManualAssessments: false,
        mayExport: true,
        mayOpenReviewTask: true,
      })),
    },
    source: {
      read: vi.fn(async () => ({
        asOfUtc: at(31),
        freshness: "Current",
        partial: false,
        facts: [fact(1), fact(2)],
        manualAssessments: [
          {
            tenantReference: id(1),
            brandReference: id(2),
            stockSiteReference: id(3),
            supplierReference: id(5),
            assessmentReference: id(30),
            ratingCode: "NEEDS_REVIEW",
            occurredAt: at(30),
          },
        ],
      })),
    },
    repository: {
      resolveOperation: vi.fn(async () => null),
      commit: vi.fn(async (record) => record),
    },
    collaboration: {
      openReviewTask: vi.fn(async (command) => ({
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        supplierReference: command.payload.supplierReference,
        taskReference: id(40),
      })),
    },
    audit: {
      create: vi.fn(async () => ({
        auditId: id(50),
        brandId: id(2),
        actor: { type: "User" as const, reference: id(4) },
        actionCode: "SUPPLIER_PERFORMANCE_REVIEW",
        targetType: "Supplier",
        targetId: id(5),
        reasonCode: "PERFORMANCE_REVIEW",
        correlationId: id(41),
        occurredAt: at(31),
        sourceChannel: "MerchantWeb",
        dataClassification: "Internal" as const,
        retentionPolicyCode: "PROCUREMENT",
        retentionPolicyVersion: 1,
      })),
    },
    references: {
      hashIntent: vi.fn(() => `sha256:${"8".repeat(64)}`),
      equals: vi.fn((a, b) => a === b),
    },
  };
}
describe("Supplier Performance", () => {
  it("derives exact rates, coverage and signed same-currency price variance", async () => {
    const adapter = ports();
    const result = await querySupplierPerformance(query, adapter);
    expect(result.rows[0]).toMatchObject({
      fillRate: { numerator: "4", denominator: "6", percent: "66.666666" },
      acceptedQuality: { numerator: "4", denominator: "5", percent: "80" },
      onTimeDelivery: { numerator: "1", denominator: "2", percent: "50" },
      acknowledgementResponseSeconds: "60.5",
      declineCancellationRate: { percent: "50" },
      purchasePriceVarianceAmount: "0.07",
      currency: "CAD",
      sourceFactCount: 2,
      incompleteFactCount: 1,
    });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(adapter.source.read as never);
  });
  it("rejects leaked or out-of-scope source facts", async () => {
    const adapter = ports();
    vi.mocked(adapter.source.read).mockResolvedValueOnce({
      asOfUtc: at(31),
      freshness: "Current",
      partial: false,
      facts: [fact(1, { brandReference: id(99) })],
      manualAssessments: [],
    });
    await expect(querySupplierPerformance(query, adapter)).rejects.toMatchObject({
      code: "SUPPLIER_PERFORMANCE_INVALID",
    });
  });
  it("trims drill, variance and assessment fields independently", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({ authorized: true });
    const result = await querySupplierPerformance(query, adapter);
    expect(result.rows[0]).toMatchObject({
      factReferences: null,
      purchasePriceVarianceAmount: null,
      currency: null,
      manualAssessments: null,
    });
  });
  it("projects independent assessments without changing calculated metrics", async () => {
    const adapter = ports();
    vi.mocked(adapter.authorization.authorize).mockResolvedValueOnce({
      authorized: true,
      mayViewManualAssessments: true,
    });
    const result = await querySupplierPerformance(query, adapter);
    expect(result.rows[0]).toMatchObject({
      fillRate: { percent: "66.666666" },
      manualAssessments: [{ ratingCode: "NEEDS_REVIEW" }],
    });
  });
  it("opens only an explicit review task and never mutates Supplier lifecycle", async () => {
    const adapter = ports();
    const command = {
      tenantReference: id(1),
      brandReference: id(2),
      stockSiteReference: id(3),
      actorReference: id(4),
      purpose: "SupplierPerformanceReview",
      permission: "procurement.manage",
      operationReference: id(41),
      occurredAt: at(31),
      action: "OpenReviewTask",
      payload: {
        supplierReference: id(5),
        periodFromUtc: at(1),
        periodToUtc: at(31),
        reasonCode: "LOW_FILL_RATE",
      },
    };
    const result = await executeSupplierPerformanceReview(command, adapter);
    expect(result).toMatchObject({ collaborationReference: id(40), assessment: null });
    expect(adapter.collaboration.openReviewTask).toHaveBeenCalledTimes(1);
    expect(Object.keys(adapter)).not.toContain("supplierLifecycle");
  });
  it("appends a manual assessment separately from calculated metrics", async () => {
    const adapter = ports();
    const result = await executeSupplierPerformanceReview(
      {
        tenantReference: id(1),
        brandReference: id(2),
        stockSiteReference: id(3),
        actorReference: id(4),
        purpose: "SupplierPerformanceReview",
        permission: "procurement.manage",
        operationReference: id(42),
        occurredAt: at(31),
        action: "AddManualAssessment",
        payload: {
          supplierReference: id(5),
          assessmentReference: id(43),
          ratingCode: "NEEDS_REVIEW",
          note: "Synthetic assessment note",
        },
      },
      adapter,
    );
    expect(result.assessment).toMatchObject({ ratingCode: "NEEDS_REVIEW" });
    expect(result.collaborationReference).toBeNull();
    expect(adapter.source.read).not.toHaveBeenCalled();
  });
});
