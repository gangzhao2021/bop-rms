import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiscrepancyState, DiscrepancyWorkbench } from "./DiscrepancyPage.js";
import { DiscrepancyClientError, parseDiscrepancyView } from "./discrepancy-page.js";
const id = (n: number) => `018fac00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(masked = false) {
  return {
    screenId: "PROC-DISCREPANCY",
    projectionName: "procurement_discrepancy_v1",
    projectionVersion: 1,
    brandLabel: "Synthetic Brand",
    stockSiteLabel: "Toronto Stock Site",
    asOfUtc: "2026-08-14T10:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: {
      mayManage: true,
      mayWaiveRemainder: true,
      mayViewSupplierContact: !masked,
      mayViewEvidence: !masked,
      mayViewCost: !masked,
      mayViewHistory: !masked,
    },
    rows: [
      {
        discrepancyReference: id(10),
        version: 2,
        type: "Short",
        status: "InReview",
        purchaseOrderReference: id(5),
        goodsReceiptReference: id(7),
        supplierReference: id(4),
        supplierSummary: "Synthetic Supplier",
        itemSummary: "Synthetic Tomatoes",
        varianceQuantity: "3",
        unit: "CASE",
        toleranceQuantity: "1",
        withinTolerance: false,
        ownerReference: id(12),
        ownerSummary: "Synthetic Owner",
        overdue: true,
        supplierContactOutcome: masked ? null : "Correction promised",
        evidenceCount: masked ? null : 2,
        unitCost: masked ? null : "12.50",
        history: masked
          ? null
          : [{ action: "Acknowledged", occurredAt: "2026-08-14T09:00:00.000Z" }],
      },
    ],
  };
}
describe("Discrepancy page", () => {
  it("strictly parses the named projection and rejects undeclared fields", () => {
    expect(parseDiscrepancyView(projection())).toMatchObject({
      screenId: "PROC-DISCREPANCY",
      rows: [{ type: "Short" }],
    });
    expect(() => parseDiscrepancyView({ ...projection(), extra: true })).toThrow(
      DiscrepancyClientError,
    );
  });
  it("renders registered filters, exact variance and guarded resolution actions", () => {
    const html = renderToStaticMarkup(
      <DiscrepancyWorkbench view={parseDiscrepancyView(projection())} />,
    );
    for (const text of [
      "PROC-DISCREPANCY",
      "PO / receipt / supplier",
      "Type / status / Store",
      "Owner / overdue",
      "Variance 3 CASE",
      "Request correction",
      "Request replacement",
      "Waive remainder with approval",
      "cannot be edited here",
    ])
      expect(html).toContain(text);
  });
  it("omits restricted supplier contact, evidence, cost and history", () => {
    const html = renderToStaticMarkup(
      <DiscrepancyWorkbench view={parseDiscrepancyView(projection(true))} />,
    );
    expect(html).not.toContain("Supplier contact");
    expect(html).not.toContain("Evidence 2");
    expect(html).not.toContain("Unit cost");
    expect(html).not.toContain("Acknowledged");
  });
  it("keeps stale data read-only and covers mandatory failure states", () => {
    const html = renderToStaticMarkup(
      <DiscrepancyWorkbench
        view={parseDiscrepancyView({ ...projection(true), freshness: "Stale" })}
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
      "ValidationFailed",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<DiscrepancyState state={state} />)).toContain("status");
  });
});
