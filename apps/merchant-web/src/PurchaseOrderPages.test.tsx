import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  PurchaseOrderDetail,
  PurchaseOrderEditor,
  PurchaseOrderList,
  PurchaseOrderState,
} from "./PurchaseOrderPages.js";
import { parsePurchaseOrderView, PurchaseOrderClientError } from "./purchase-order-pages.js";
const id = (n: number) => `018fa900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`;
function projection(screen: "list" | "editor" | "detail" = "list", masked = false) {
  const permissions = {
    mayManage: true,
    mayApprove: true,
    mayIssue: true,
    mayRecordResponse: true,
    mayCancel: true,
    mayClose: true,
    mayViewCost: !masked,
    mayViewSupplierResponse: !masked,
    mayViewReceipt: !masked,
    mayViewDiscrepancy: !masked,
    mayViewHistory: !masked,
  };
  return {
    screenId:
      screen === "list"
        ? "PROC-PO-LIST"
        : screen === "editor"
          ? "PROC-PO-EDITOR"
          : "PROC-PO-DETAIL",
    projectionName: "procurement_purchase_order_v1",
    projectionVersion: 1,
    brandLabel: "Synthetic Brand",
    asOfUtc: at(14),
    freshness: "Current",
    partial: false,
    permissions,
    rows: [
      {
        purchaseOrderReference: id(10),
        purchaseOrderVersion: 4,
        supplierReference: id(3),
        supplierName: "Synthetic Supplier",
        buyerEntityReference: id(4),
        buyerEntityName: "Synthetic Buyer Inc",
        shipToStockSiteReference: id(5),
        shipToLabel: "Toronto Stock Site",
        currency: "CAD",
        workflow: screen === "editor" ? "Approved" : "Issued",
        fulfillment: "PartiallyReceived",
        closure: "Open",
        orderedAmount: masked ? null : "125",
        receivedAmount: masked ? null : "75",
        openAmount: masked ? null : "50",
        issuedAt: at(10),
        expectedDeliveryUtc: at(20),
        overdue: false,
        discrepancyCount: masked ? null : 0,
      },
    ],
    editor:
      screen === "editor"
        ? {
            purchaseOrderReference: id(10),
            purchaseOrderVersion: 4,
            supplierReference: id(3),
            buyerEntityReference: id(4),
            shipToStockSiteReference: id(5),
            shipToAddressSnapshotReference: id(6),
            currency: "CAD",
            pendingRevisionNumber: 1,
            pendingRevisionLifecycle: "Approved",
            lines: [
              {
                lineReference: id(20),
                itemName: "Synthetic Tomatoes",
                supplierItemSummary: "SUP-TOM-01 · Synthetic Case",
                orderedQuantity: "10",
                purchaseUnit: "CASE",
                unitCost: "12.50",
                discount: "0",
                lineTotal: "125",
                expectedDeliveryUtc: at(20),
                sourceAllocationReferences: [id(26)],
              },
            ],
            validationIssues: [],
          }
        : null,
    detail:
      screen === "detail"
        ? {
            purchaseOrderReference: id(10),
            effectiveRevisionNumber: 1,
            issuedSnapshotReference: id(32),
            supplierResponse: masked
              ? null
              : { response: "Acknowledged", responseReference: id(40), recordedAt: at(11) },
            revisions: masked
              ? null
              : [
                  {
                    revisionReference: id(11),
                    revisionNumber: 1,
                    lifecycle: "Issued",
                    reasonCode: null,
                  },
                ],
            receiptReferences: masked ? null : [id(50)],
            discrepancyReferences: masked ? null : [],
            lineCompletion: [
              {
                lineReference: id(20),
                orderedQuantity: "10",
                receivedQuantity: masked ? null : "6",
                cancelledQuantity: "0",
                final: false,
              },
            ],
            timeline: [{ action: "Issued", occurredAt: at(10) }],
          }
        : null,
    nextCursor: null,
  };
}
describe("Purchase Order pages", () => {
  it("strictly parses all page modes and rejects extra fields", () => {
    expect(parsePurchaseOrderView(projection())).toMatchObject({
      screenId: "PROC-PO-LIST",
      rows: [{ workflow: "Issued" }],
    });
    expect(parsePurchaseOrderView(projection("editor"))).toMatchObject({
      screenId: "PROC-PO-EDITOR",
    });
    expect(() => parsePurchaseOrderView({ ...projection(), extra: true })).toThrow(
      PurchaseOrderClientError,
    );
  });
  it("renders list state dimensions, registered filters and Issue boundary", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PurchaseOrderList view={parsePurchaseOrderView(projection())} />
      </MemoryRouter>,
    );
    for (const value of [
      "PROC-PO-LIST",
      "PO ref / Supplier / Item",
      "Workflow / Fulfillment / Closure",
      "Store / Buyer / Date / Overdue / Discrepancy",
      "Ordered 125 · received 75 · open 50 CAD",
      "Only explicit Issue creates a Supplier commitment",
    ])
      expect(html).toContain(value);
  });
  it("renders editor snapshots, Offering lines and guarded actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PurchaseOrderEditor view={parsePurchaseOrderView(projection("editor"))} />
      </MemoryRouter>,
    );
    for (const value of [
      "PROC-PO-EDITOR",
      "Offering-based lines and source allocations",
      "Synthetic Tomatoes",
      "Unit cost 12.50",
      "Approved Requisition allocations",
      "Issue with Buyer authority",
      "Arbitrary line price is unavailable",
      "Issue freezes",
    ])
      expect(html).toContain(value);
  });
  it("renders masked immutable detail, stale read-only state and mandatory errors", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PurchaseOrderDetail view={parsePurchaseOrderView(projection("detail", true))} />
      </MemoryRouter>,
    );
    for (const value of [
      "PROC-PO-DETAIL",
      "Supplier response restricted",
      "received Restricted",
      "Goods Receipt and Stock Ledger facts belong to Inventory",
      "cannot override received quantity",
    ])
      expect(html).toContain(value);
    expect(html).not.toContain(id(50));
    const stale = { ...projection("detail", true), freshness: "Stale" };
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <PurchaseOrderDetail view={parsePurchaseOrderView(stale)} />
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
      expect(renderToStaticMarkup(<PurchaseOrderState state={state} />)).toContain("status");
  });
});
