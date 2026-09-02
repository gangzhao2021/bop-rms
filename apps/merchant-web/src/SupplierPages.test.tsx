import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SupplierDetail, SupplierList, SupplierState } from "./SupplierPages.js";
import { parseSupplierView, SupplierClientError } from "./supplier-pages.js";
const id = (n: number) => `018fa900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(detail = false, masked = false) {
  return {
    screenId: detail ? "SUP-SUPPLIER-DETAIL" : "SUP-SUPPLIER-LIST",
    projectionName: "procurement_supplier_v1",
    projectionVersion: 1,
    brandReference: id(2),
    brandLabel: "Synthetic Brand",
    asOfUtc: "2026-08-14T10:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: {
      contactFields: !masked,
      qualificationEvidence: !masked,
      purchaseOrderReferences: !masked,
      performance: !masked,
      manageSupplier: true,
      reviewQualification: true,
    },
    rows: [
      {
        supplierReference: id(10),
        supplierVersion: 2,
        supplierCode: "SUP-001",
        legalName: "Synthetic Foods Incorporated",
        displayName: "Synthetic Foods",
        supplierType: "FOOD_DISTRIBUTOR",
        status: "Active",
        qualificationStatus: "Current",
        nextQualificationExpiry: "2026-08-28T10:00:00.000Z",
        offeringCount: 3,
        openPurchaseOrderCount: 1,
        performanceSummary: masked ? null : "Performance source current",
        performanceFlag: masked ? null : false,
      },
    ],
    detail: detail
      ? {
          supplierReference: id(10),
          taxRegistrationReference: masked ? null : id(22),
          contacts: [
            {
              contactReference: id(20),
              roleCode: "ORDERING",
              displayName: masked ? null : "Synthetic Purchasing Contact",
              email: masked ? null : "p***@example.invalid",
              phone: masked ? null : "+1 *** *** 0199",
            },
          ],
          addresses: [
            {
              addressReference: id(21),
              addressType: "Ordering",
              addressSummary: masked ? null : "Synthetic Toronto business address",
              countryCode: "CA",
              regionCode: "ON",
            },
          ],
          qualifications: [
            {
              qualificationReference: id(30),
              qualificationType: "FOOD_SAFETY",
              jurisdiction: "CA_ON",
              certificateNumber: masked ? null : "SYNTHETIC-CERT-001",
              issuer: masked ? null : "Synthetic Authority",
              effectiveFrom: "2026-08-01T10:00:00.000Z",
              effectiveUntil: "2026-08-28T10:00:00.000Z",
              documentReference: masked ? null : id(32),
              status: "Effective",
            },
          ],
          offeringCount: 3,
          openPurchaseOrderCount: masked ? null : 1,
          performanceSummary: masked ? null : "Performance source current",
          historyCount: 4,
          auditAvailable: !masked,
        }
      : null,
    nextCursor: null,
  };
}
describe("Supplier pages", () => {
  it("strictly parses list/detail and rejects extra fields", () => {
    expect(parseSupplierView(projection())).toMatchObject({
      screenId: "SUP-SUPPLIER-LIST",
      rows: [{ status: "Active" }],
    });
    expect(() => parseSupplierView({ ...projection(), extra: true })).toThrow(SupplierClientError);
  });
  it("renders registered list fields, filters and lifecycle controls", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SupplierList view={parseSupplierView(projection())} />
      </MemoryRouter>,
    );
    for (const value of [
      "SUP-SUPPLIER-LIST",
      "Name / Code / approved Contact ref",
      "Status / Type / Qualification",
      "Performance / Open PO",
      "Qualification Current",
      "Offerings 3 · open POs 1",
      "Suspend with reason",
      "Reactivate with approval",
      "Archive (no physical delete)",
    ])
      expect(html).toContain(value);
  });
  it("renders field-masked detail, qualification and immutable-history boundary", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SupplierDetail view={parseSupplierView(projection(true, true))} />
      </MemoryRouter>,
    );
    for (const value of [
      "SUP-SUPPLIER-DETAIL",
      "Identity and restricted fields",
      "Qualifications and evidence",
      "Restricted",
      "Authorized summaries",
      "Open Offerings",
      "Open Purchase Orders",
      "Open Discrepancies",
      "Suspension never changes an existing Purchase Order",
      "Physical delete is unavailable",
    ])
      expect(html).toContain(value);
    expect(html).not.toContain("SYNTHETIC-CERT-001");
  });
  it("makes stale detail read-only and covers mandatory states", () => {
    const stale = { ...projection(true), freshness: "Stale" };
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <SupplierDetail view={parseSupplierView(stale)} />
        </MemoryRouter>,
      ),
    ).toContain("Projection stale");
    for (const state of [
      "Loading",
      "Empty",
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
      expect(renderToStaticMarkup(<SupplierState state={state} />)).toContain("status");
  });
});
