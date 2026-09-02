import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  InventoryTransferDetail,
  InventoryTransferList,
  InventoryTransferState,
} from "./InventoryTransferPages.js";
import {
  InventoryTransferClientError,
  parseInventoryTransferDetailView,
  parseInventoryTransferListView,
} from "./inventory-transfer-pages.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function summary() {
  return {
    transferReference: id(40),
    sourceLabel: "Source fridge",
    destinationLabel: "Destination kitchen",
    status: "PartiallyReceived",
    itemCount: 1,
    requestedQuantity: "5",
    dispatchedQuantity: "3",
    receivedQuantity: "2",
    discrepancyQuantity: "0",
    ownerDisplay: "Authorized owner",
    updatedAt: "2026-08-14T13:00:00.000Z",
  };
}
function listProjection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    screenId: "INV-TRANSFER-LIST",
    projectionName: "inventory_transfer_list_v1",
    projectionVersion: 1,
    stockScope: { scopeType: "Location", scopeReference: id(10), scopeLabel: "Source fridge" },
    asOfUtc: "2026-08-14T13:00:00.000Z",
    freshness: "Current",
    partial: false,
    transfers: [summary()],
    ...overrides,
  };
}
function detailProjection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    screenId: "INV-TRANSFER-DETAIL",
    projectionName: "inventory_transfer_detail_v1",
    projectionVersion: 1,
    asOfUtc: "2026-08-14T13:00:00.000Z",
    freshness: "Current",
    partial: false,
    transfer: {
      ...summary(),
      revision: 1,
      sourceScopeReference: id(10),
      destinationScopeReference: id(11),
      submittedByDisplay: "Authorized submitter",
      approvedByDisplay: "Authorized approver",
      lines: [
        {
          lineReference: id(30),
          itemDisplay: "Synthetic ingredient",
          lotReference: id(21),
          expiryDate: "2026-12-31",
          requestedQuantity: "5",
          dispatchedQuantity: "3",
          receivedQuantity: "2",
          inTransitQuantity: "1",
          discrepancyQuantity: "0",
          cancelledQuantity: "0",
          warnings: [],
          unitCode: "KG",
        },
      ],
      timeline: [
        {
          action: "Received",
          actorDisplay: "Authorized receiver",
          occurredAt: "2026-08-14T13:00:00.000Z",
          reasonCode: "TRANSFER_RECEIVED",
        },
      ],
    },
    ...overrides,
  };
}

describe("Inventory Transfer pages", () => {
  it("strictly parses scoped list and detail projections", () => {
    expect(parseInventoryTransferListView(listProjection())).toMatchObject({
      screenId: "INV-TRANSFER-LIST",
      transfers: [{ status: "PartiallyReceived" }],
    });
    expect(parseInventoryTransferDetailView(detailProjection())).toMatchObject({
      screenId: "INV-TRANSFER-DETAIL",
      transfer: { lines: [{ inTransitQuantity: "1" }] },
    });
    expect(() => parseInventoryTransferListView({ ...listProjection(), extra: true })).toThrow(
      InventoryTransferClientError,
    );
  });
  it("renders list filters, quantities and canonical detail navigation", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryTransferList view={parseInventoryTransferListView(listProjection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "INV-TRANSFER-LIST",
      "Transfer ref / Item",
      "Source fridge",
      "dispatched 3",
      `/operations/inventory/transfers/${id(40)}`,
    ])
      expect(html).toContain(text);
  });
  it("renders immutable revision, in-transit, discrepancy and actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryTransferDetail view={parseInventoryTransferDetailView(detailProjection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "immutable revision 1",
      "In Transit 1",
      "Report discrepancy",
      "Cancel remaining by policy",
      "Immutable timeline",
    ])
      expect(html).toContain(text);
  });
  it("keeps stale projections read-only", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryTransferList
          view={parseInventoryTransferListView(listProjection({ freshness: "Stale" }))}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Projection stale");
  });
  it("covers every mandatory failure state", () => {
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
      expect(renderToStaticMarkup(<InventoryTransferState state={state} />)).toContain("status");
  });
});
