import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoodsReceiptState, GoodsReceiptWizard } from "./GoodsReceiptPage.js";
import { GoodsReceiptClientError, parseGoodsReceiptView } from "./goods-receipt-page.js";
const id = (n: number) => `018fab00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(masked = false) {
  return {
    screenId: "INV-GOODS-RECEIPT",
    projectionName: "inventory_goods_receipt_v1",
    projectionVersion: 1,
    brandLabel: "Synthetic Brand",
    stockSiteLabel: "Toronto Stock Site",
    asOfUtc: "2026-08-14T10:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: {
      mayReceive: true,
      mayOverride: true,
      mayViewCost: !masked,
      mayViewEvidence: !masked,
      mayViewTemperature: !masked,
    },
    draft: {
      goodsReceiptReference: id(10),
      supplierReference: id(4),
      supplierSummary: "Synthetic Supplier",
      purchaseOrderReference: id(5),
      purchaseOrderVersion: 7,
      purchaseOrderRevisionNumber: 2,
      issuedSnapshotReference: id(6),
      receivedAt: "2026-08-14T09:00:00.000Z",
      lines: [
        {
          receiptLineReference: id(20),
          purchaseOrderLineReference: id(21),
          inventoryItemReference: id(22),
          itemSummary: "Synthetic Tomatoes",
          barcode: "12345678",
          orderedQuantity: "10",
          priorAcceptedQuantity: "4",
          deliveredQuantity: "6",
          acceptedQuantity: "4",
          rejectedQuantity: "1",
          damagedQuantity: "1",
          purchaseUnit: "CASE",
          baseUnit: "EA",
          conversionMultiplier: "12",
          lotCode: "LOT-26",
          expiryDate: "2026-09-30",
          locationSummary: "Quarantine A",
          qualityDisposition: "Quarantined",
          temperatureReading: masked ? null : "3.5",
          temperatureUnit: masked ? null : "C",
          evidenceCount: masked ? null : 1,
          overReceiptPolicy: "Block",
          toleranceQuantity: "0",
          overrideReasonCode: null,
          discrepancyRequired: true,
          unitCost: masked ? null : "12.50",
        },
      ],
    },
  };
}
describe("Goods Receipt page", () => {
  it("strictly parses the named projection and rejects undeclared fields", () => {
    expect(parseGoodsReceiptView(projection())).toMatchObject({
      screenId: "INV-GOODS-RECEIPT",
      draft: { purchaseOrderVersion: 7 },
    });
    expect(() => parseGoodsReceiptView({ ...projection(), extra: true })).toThrow(
      GoodsReceiptClientError,
    );
  });
  it("renders PO snapshot, actual quantities, quality and immutable submit boundary", () => {
    const html = renderToStaticMarkup(
      <GoodsReceiptWizard view={parseGoodsReceiptView(projection())} />,
    );
    for (const value of [
      "INV-GOODS-RECEIPT",
      "PO / Supplier / Item / barcode",
      "ordered 10",
      "accepted 4",
      "rejected 1",
      "damaged 1",
      "Quality Quarantined",
      "Temperature 3.5 C",
      "Submit Receipt and Stock Movements atomically",
      "original remains immutable",
    ])
      expect(html).toContain(value);
  });
  it("omits restricted cost, evidence and temperature instead of leaking placeholders", () => {
    const html = renderToStaticMarkup(
      <GoodsReceiptWizard view={parseGoodsReceiptView(projection(true))} />,
    );
    expect(html).not.toContain("Unit cost");
    expect(html).not.toContain("Evidence attachments");
    expect(html).not.toContain("Temperature");
  });
  it("keeps stale data read-only and renders all mandatory failure states", () => {
    const html = renderToStaticMarkup(
      <GoodsReceiptWizard
        view={parseGoodsReceiptView({ ...projection(true), freshness: "Stale" })}
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
      expect(renderToStaticMarkup(<GoodsReceiptState state={state} />)).toContain("status");
  });
});
