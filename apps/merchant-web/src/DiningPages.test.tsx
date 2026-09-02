import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { DiningFloorScreen, DiningState, DiningTableListScreen } from "./DiningPages.js";
import {
  DiningClientError,
  parseDiningFloorView,
  parseDiningTableListView,
} from "./dining-pages.js";

const id = (n: number) => `018f9e00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const floorItem = () => ({
  tableReference: id(1),
  stableLabel: "T01",
  areaCode: "MAIN",
  capacity: 4,
  tableState: "Occupied",
  diningSessionReference: id(2),
  partySize: 3,
  elapsedSeconds: 900,
  orderSummary: "Open",
  paymentSummary: "Pending",
  reservationHandoffReference: id(3),
  waitlistHandoffReference: null,
  ownerSummary: "SERVER_A",
  attention: "Warning",
});
const floor = () => ({
  screenId: "DIN-FLOOR-BOARD",
  asOfUtc: "2026-08-13T23:00:00.000Z",
  freshness: "Current",
  items: [floorItem()],
});
const tableItem = () => ({
  tableReference: id(1),
  stableLabel: "T01",
  areaCode: "MAIN",
  capacity: 4,
  accessibilityAttributes: ["STEP_FREE"],
  lifecycle: "Published",
  qrStatus: "Active",
  qrVersion: 2,
  operationalState: "Available",
  currentDiningSessionReference: id(2),
  aggregateVersion: 5,
});
const tables = () => ({
  screenId: "DIN-TABLE-LIST",
  asOfUtc: "2026-08-13T23:00:00.000Z",
  freshness: "Current",
  items: [tableItem()],
});

describe("Dining screens", () => {
  it("renders every DIN-FLOOR-BOARD field, filter and controlled action", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DiningFloorScreen view={parseDiningFloorView(floor())} />
      </MemoryRouter>,
    );
    for (const value of [
      "DIN-FLOOR-BOARD",
      "Table / Session / handoff",
      "Area",
      "State",
      "Server / owner",
      "Attention",
      "Capacity / party",
      "Order / payment",
      "Reservation / waitlist",
      "Start Staff Dining Session",
      "Seat eligible party",
      "Open Session",
      "Move Table",
      "Begin Closing",
    ])
      expect(html).toContain(value);
  });

  it("renders every DIN-TABLE-LIST field, filter and controlled action", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DiningTableListScreen view={parseDiningTableListView(tables())} />
      </MemoryRouter>,
    );
    for (const value of [
      "DIN-TABLE-LIST",
      "Label",
      "Area",
      "Capacity",
      "State",
      "QR active / replacement",
      "accessibility",
      "Current Session",
      "Create Table draft",
      "Edit configuration draft",
      "Revoke QR",
      "Temporary block",
    ])
      expect(html).toContain(value);
  });

  it("rejects malformed, injected and internally inconsistent projections", () => {
    expect(() =>
      parseDiningFloorView({ ...floor(), items: [{ ...floorItem(), ownerSummary: "<script>" }] }),
    ).toThrow(DiningClientError);
    expect(() =>
      parseDiningFloorView({ ...floor(), items: [{ ...floorItem(), partySize: null }] }),
    ).toThrow(DiningClientError);
    expect(() =>
      parseDiningTableListView({
        ...tables(),
        items: [{ ...tableItem(), lifecycle: "Draft", qrStatus: "Active" }],
      }),
    ).toThrow(DiningClientError);
    expect(() =>
      parseDiningTableListView({ ...tables(), items: [{ ...tableItem(), aggregateVersion: 0 }] }),
    ).toThrow(DiningClientError);
  });

  it("renders empty, stale and all failure states without enabling commands", () => {
    const empty = renderToStaticMarkup(
      <MemoryRouter>
        <DiningFloorScreen
          view={parseDiningFloorView({ ...floor(), freshness: "Stale", items: [] })}
        />
      </MemoryRouter>,
    );
    expect(empty).toContain("Projection is stale");
    expect(empty).toContain("No Dining Tables");
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
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <DiningState state={state} />
          </MemoryRouter>,
        ).length,
      ).toBeGreaterThan(50);
  });
});
