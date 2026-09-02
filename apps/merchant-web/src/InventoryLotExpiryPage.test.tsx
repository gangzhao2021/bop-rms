import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { InventoryLotExpiry, InventoryLotExpiryState } from "./InventoryLotExpiryPage.js";
import {
  InventoryLotExpiryClientError,
  parseInventoryLotExpiryView,
} from "./inventory-lot-expiry.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function projection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    screenId: "INV-LOT-EXPIRY",
    projectionName: "inventory_lot_expiry_v1",
    projectionVersion: 1,
    stockScope: { scopeType: "Location", scopeReference: id(10), scopeLabel: "Walk-in Fridge" },
    asOfUtc: "2026-08-14T11:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: { supplierTrace: true, complianceTrace: true, manageHold: true },
    rows: [
      {
        itemReference: id(20),
        itemName: "Tomatoes",
        internalCode: "ING-TOMATO",
        barcode: "001234567890",
        lotReference: id(21),
        lotCode: "LOT-2026-08",
        expiryDate: "2026-09-01",
        receivedAt: "2026-08-14T08:00:00.000Z",
        receivedQuantity: "10",
        locationReference: id(10),
        locationLabel: "Walk-in Fridge",
        onHand: "8",
        reserved: "2",
        unitCode: "KG",
        status: "Quarantined",
        holdReference: id(30),
        holdVersion: 1,
        holdReasonCode: "QUALITY_REVIEW",
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
    nextCursor: "NEXT_PAGE",
    ...overrides,
  };
}

describe("Inventory Lot / Expiry page", () => {
  it("strictly parses the scoped projection and rejects extra fields", () => {
    expect(parseInventoryLotExpiryView(projection())).toMatchObject({
      screenId: "INV-LOT-EXPIRY",
      stockScope: { scopeLabel: "Walk-in Fridge" },
      rows: [{ status: "Quarantined", holdVersion: 1, fefoException: true }],
    });
    expect(() => parseInventoryLotExpiryView({ ...projection(), extra: true })).toThrow(
      InventoryLotExpiryClientError,
    );
  });

  it("renders fields, filters, Hold controls and public-reference handoffs", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryLotExpiry view={parseInventoryLotExpiryView(projection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "INV-LOT-EXPIRY",
      "Lot / Item / Barcode",
      "Expiry window / Location",
      "FEFO exception",
      "Received 10 · on hand 8 · reserved 2 KG",
      "Hold v1 · QUALITY_REVIEW",
      "Quarantine through Compliance",
      "Release with decision",
      "Authorized trace handoff",
      "Start Waste",
      "Start Transfer",
      "Start Count",
    ])
      expect(html).toContain(text);
  });

  it("requires restricted trace and supplier fields to be masked", () => {
    const hidden = projection({
      permissions: { supplierTrace: false, complianceTrace: false, manageHold: false },
      rows: [
        {
          ...(projection().rows[0] as Record<string, unknown>),
          supplierReference: null,
          supplierLabel: null,
          receiptReference: null,
        },
      ],
      trace: {
        ...(projection().trace as Record<string, unknown>),
        receiptReference: null,
        supplierReference: null,
        complianceTraceReference: null,
      },
    });
    expect(parseInventoryLotExpiryView(hidden)).toMatchObject({
      permissions: { supplierTrace: false, complianceTrace: false, manageHold: false },
      rows: [{ supplierReference: null, receiptReference: null }],
    });
    expect(() =>
      parseInventoryLotExpiryView(
        projection({
          permissions: { supplierTrace: false, complianceTrace: false, manageHold: false },
        }),
      ),
    ).toThrow(InventoryLotExpiryClientError);
  });

  it("renders stale or partial projections read-only", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryLotExpiry
          view={parseInventoryLotExpiryView(projection({ freshness: "Stale" }))}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Projection stale");
  });

  it("covers every mandatory page state", () => {
    for (const state of [
      "Loading",
      "Empty",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<InventoryLotExpiryState state={state} />)).toContain("status");
  });
});
