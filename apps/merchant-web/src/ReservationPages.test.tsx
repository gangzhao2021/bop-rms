import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ReservationScreen, ReservationState } from "./ReservationPages.js";
import {
  parseReservationView,
  ReservationClientError,
  type ReservationScreenId,
} from "./reservation-pages.js";

const id = (n: number) => `018fa200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const item = () => ({
  reservationReference: id(1),
  startAt: "2026-09-01T15:00:00.000Z",
  expectedEndAt: "2026-09-01T17:00:00.000Z",
  partySize: 4,
  customerDisplayName: "Synthetic Guest",
  contactSummary: "Authorized exact contact",
  status: "Confirmed",
  depositOutcome: "Pending",
  guaranteeStatus: "Required",
  source: "Staff",
  accessibilityRequestCodes: ["STEP_FREE"],
  specialRequestCode: "QUIET_AREA",
  capacityHoldReference: id(2),
  capacityHoldExpiresAt: "2026-09-01T14:00:00.000Z",
  revisionNumber: 2,
  notificationSummary: "Delivered",
  diningSessionReference: null,
  lateOrNoShow: false,
});
const view = (screenId: ReservationScreenId = "RES-LIST") => ({
  screenId,
  asOfUtc: "2026-09-01T13:00:00.000Z",
  freshness: "Current",
  capacityBands: [
    {
      areaCode: "MAIN",
      startAt: "2026-09-01T15:00:00.000Z",
      endAt: "2026-09-01T16:00:00.000Z",
      availableCapacity: 12,
      heldCapacity: 4,
      closureCode: null,
    },
  ],
  tableAreaHints: ["MAIN"],
  waitlistCount: 3,
  items: [item()],
});
const render = (screenId: ReservationScreenId) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ReservationScreen view={parseReservationView(view(screenId), screenId)} />
    </MemoryRouter>,
  );

describe("Reservation screens", () => {
  it.each([
    ["RES-CALENDAR", "Reservation Calendar"],
    ["RES-LIST", "Reservation lifecycle and guarantees"],
    ["RES-DETAIL", "Original facts, revisions and handoffs"],
    ["RES-CREATE-EDIT", "Create / Revision steps"],
  ] as const)("renders the complete %s contract", (screenId, heading) => {
    const html = render(screenId);
    for (const text of [
      screenId,
      heading,
      "Reference / customer-safe name / contact exact",
      "Day / week capacity bands, holds and closures",
      "Table / area hints",
      "Deposit / guarantee",
      "Accessibility / controlled need",
      "Notifications / seating handoff",
      "Revise atomically",
      "Seat by Dining command",
    ])
      expect(html).toContain(text);
    expect(html).toContain("disabled");
  });

  it("rejects injected, mismatched and internally inconsistent projections", () => {
    expect(() => parseReservationView({ ...view(), unexpected: true })).toThrow(
      ReservationClientError,
    );
    expect(() =>
      parseReservationView({
        ...view(),
        items: [{ ...item(), contactSummary: "https://bad.test" }],
      }),
    ).toThrow(ReservationClientError);
    expect(() =>
      parseReservationView({ ...view(), items: [{ ...item(), status: "Seated" }] }),
    ).toThrow(ReservationClientError);
    expect(() => parseReservationView(view("RES-LIST"), "RES-CALENDAR")).toThrow(
      ReservationClientError,
    );
    expect(() => parseReservationView({ ...view("RES-DETAIL"), items: [] })).toThrow(
      ReservationClientError,
    );
  });

  it("renders empty, stale and every mandatory recovery state", () => {
    const empty = renderToStaticMarkup(
      <MemoryRouter>
        <ReservationScreen
          view={parseReservationView({ ...view(), freshness: "Stale", items: [] })}
        />
      </MemoryRouter>,
    );
    expect(empty).toContain("Projection is stale");
    expect(empty).toContain("No Reservations");
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
            <ReservationState state={state} />
          </MemoryRouter>,
        ).length,
      ).toBeGreaterThan(50);
  });
});
