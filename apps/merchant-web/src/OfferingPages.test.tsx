import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { OfferingEditor, OfferingList, OfferingState } from "./OfferingPages.js";
import { OfferingClientError, parseOfferingView } from "./offering-pages.js";
const id = (n: number) => `018fa900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(detail = false, masked = false) {
  return {
    screenId: detail ? "SUP-OFFERING-EDITOR" : "SUP-OFFERING-LIST",
    projectionName: "procurement_offering_v1",
    projectionVersion: 1,
    brandReference: id(2),
    brandLabel: "Synthetic Brand",
    asOfUtc: "2026-08-14T10:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: {
      manage: true,
      approve: true,
      publish: true,
      cost: !masked,
      qualification: !masked,
      history: !masked,
    },
    rows: [
      {
        offeringReference: id(10),
        aggregateVersion: 4,
        supplierReference: id(3),
        supplierName: "Synthetic Supplier",
        inventoryItemReference: id(4),
        inventoryItemName: "Synthetic Item",
        supplierItemCode: "SUP-CASE-01",
        purchaseUnit: "CASE",
        packSummary: "1 CASE = 24 EA",
        leadTimeDays: 3,
        minimumOrderQuantity: "2",
        orderMultiple: "1",
        unitCost: masked ? null : "12.50",
        currency: masked ? null : "CAD",
        effectiveUntil: "2026-08-28T10:00:00.000Z",
        qualificationStatus: "Current",
        lifecycle: "Approved",
      },
    ],
    detail: detail
      ? {
          offeringReference: id(10),
          configVersions: [
            {
              versionReference: id(20),
              version: 1,
              purchaseUnit: "CASE",
              packQuantity: "1",
              baseUnit: "EA",
              baseQuantity: "24",
              minimumOrderQuantity: "2",
              orderMultiple: "1",
              leadTimeDays: 3,
            },
          ],
          priceRecords: [
            {
              priceRecordReference: id(30),
              priceVersionReference: id(31),
              currency: masked ? null : "CAD",
              unitCost: masked ? null : "12.50",
              priceUnit: "CASE",
              source: "Contract",
              scope: "Brand",
              effectiveFrom: "2026-08-01T10:00:00.000Z",
              effectiveUntil: "2026-08-28T10:00:00.000Z",
            },
          ],
          qualificationReferences: masked ? null : [id(40)],
          historyReferences: masked ? null : [id(20)],
          validationIssues: [
            {
              code: "PRICE_EXPIRING",
              severity: "Warning",
              message: "Synthetic price expires soon",
            },
          ],
        }
      : null,
    nextCursor: null,
  };
}
describe("Offering pages", () => {
  it("strictly parses list/editor and rejects extra fields", () => {
    expect(parseOfferingView(projection())).toMatchObject({
      screenId: "SUP-OFFERING-LIST",
      rows: [{ lifecycle: "Approved" }],
    });
    expect(() => parseOfferingView({ ...projection(), extra: true })).toThrow(OfferingClientError);
  });
  it("renders registered list fields, filters and controls", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OfferingList view={parseOfferingView(projection())} />
      </MemoryRouter>,
    );
    for (const value of [
      "SUP-OFFERING-LIST",
      "Supplier / Item / Code",
      "Status / Currency",
      "Store / expiry / qualification",
      "1 CASE = 24 EA",
      "MOQ 2",
      "Price 12.50 CAD",
      "Open editor",
    ])
      expect(html).toContain(value);
  });
  it("renders masked editor, versions, approval and immutable snapshot rule", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OfferingEditor view={parseOfferingView(projection(true, true))} />
      </MemoryRouter>,
    );
    for (const value of [
      "SUP-OFFERING-EDITOR",
      "Stable mapping and purchasing versions",
      "Price records",
      "Restricted",
      "Validation and qualification",
      "Approve as distinct Actor",
      "Publish validated Offering",
      "Arbitrary line price override is unavailable",
    ])
      expect(html).toContain(value);
    expect(html).not.toContain("12.50");
  });
  it("makes stale editor read-only and covers mandatory states", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OfferingEditor view={parseOfferingView({ ...projection(true), freshness: "Stale" })} />
      </MemoryRouter>,
    );
    expect(html).toContain("Projection stale");
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
      expect(renderToStaticMarkup(<OfferingState state={state} />)).toContain("status");
  });
});
