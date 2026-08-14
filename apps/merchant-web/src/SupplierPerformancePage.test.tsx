import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SupplierPerformanceDashboard,
  SupplierPerformanceState,
} from "./SupplierPerformancePage.js";
import {
  parseSupplierPerformanceView,
  SupplierPerformanceClientError,
} from "./supplier-performance-page.js";
const id = (n: number) => `018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const rate = (numerator: string, denominator: string, percent: string | null) => ({
  numerator,
  denominator,
  percent,
});
function projection(masked = false) {
  return {
    screenId: "SUP-PERFORMANCE",
    projectionName: "procurement_supplier_performance_v1",
    projectionVersion: 1,
    definitionVersion: 1,
    brandLabel: "Synthetic Brand",
    stockSiteLabel: "Toronto Stock Site",
    periodFromUtc: "2026-08-01T00:00:00.000Z",
    periodToUtc: "2026-09-01T00:00:00.000Z",
    asOfUtc: "2026-08-31T10:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: {
      mayDrillFacts: !masked,
      mayViewPriceVariance: !masked,
      mayViewManualAssessments: !masked,
      mayExport: !masked,
      mayOpenReviewTask: true,
    },
    rows: [
      {
        supplierReference: id(1),
        supplierSummary: "Synthetic Supplier",
        offeringReference: id(2),
        stockSiteReference: id(3),
        onTimeDelivery: rate("1", "2", "50"),
        fillRate: rate("4", "6", "66.666666"),
        acceptedQuality: rate("4", "5", "80"),
        overFrequency: rate("0", "2", "0"),
        shortFrequency: rate("1", "2", "50"),
        rejectedFrequency: rate("1", "2", "50"),
        damagedFrequency: rate("1", "2", "50"),
        acknowledgementResponseSeconds: "60.5",
        declineCancellationRate: rate("1", "2", "50"),
        purchasePriceVarianceAmount: masked ? null : "0.07",
        currency: masked ? null : "CAD",
        sourceFactCount: 2,
        incompleteFactCount: 1,
        factReferences: masked ? null : [id(4), id(5)],
        manualAssessments: masked
          ? null
          : [
              {
                assessmentReference: id(6),
                ratingCode: "NEEDS_REVIEW",
                occurredAt: "2026-08-31T09:00:00.000Z",
              },
            ],
      },
    ],
  };
}
describe("Supplier Performance page", () => {
  it("strictly parses the named projection and rejects undeclared fields", () => {
    expect(parseSupplierPerformanceView(projection())).toMatchObject({
      screenId: "SUP-PERFORMANCE",
      rows: [{ fillRate: { percent: "66.666666" } }],
    });
    expect(() => parseSupplierPerformanceView({ ...projection(), scoreOverride: 100 })).toThrow(
      SupplierPerformanceClientError,
    );
  });
  it("renders canonical filters, coverage, metrics and guarded actions", () => {
    const html = renderToStaticMarkup(
      <SupplierPerformanceDashboard view={parseSupplierPerformanceView(projection())} />,
    );
    for (const value of [
      "SUP-PERFORMANCE",
      "Supplier / item category",
      "Period / Store / Brand",
      "Metric threshold",
      "Coverage 2 facts · 1 incomplete",
      "Fill rate 66.666666%",
      "Acknowledgement response 60.5 seconds",
      "Purchase price variance CAD 0.07",
      "Drill to facts",
      "Export authorized fields",
      "Open review task",
      "never overwrites a score",
    ])
      expect(html).toContain(value);
  });
  it("omits independently restricted facts, variance, assessments and export", () => {
    const html = renderToStaticMarkup(
      <SupplierPerformanceDashboard view={parseSupplierPerformanceView(projection(true))} />,
    );
    for (const value of [
      "Authorized source facts",
      "Purchase price variance",
      "Independent manual assessments",
      "Export authorized fields",
      "Drill to facts",
    ])
      expect(html).not.toContain(value);
    expect(html).toContain("Open review task");
  });
  it("keeps stale projections read-only and covers registered states", () => {
    const html = renderToStaticMarkup(
      <SupplierPerformanceDashboard
        view={parseSupplierPerformanceView({ ...projection(true), freshness: "Stale" })}
      />,
    );
    expect(html).toContain("Projection stale");
    expect(html).toContain("disabled");
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<SupplierPerformanceState state={state} />)).toContain("status");
  });
});
