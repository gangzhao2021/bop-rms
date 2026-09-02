import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { WaitlistScreen, WaitlistState } from "./WaitlistPages.js";
import { parseWaitlistView, WaitlistClientError, type WaitlistScreenId } from "./waitlist-pages.js";

const id = (n: number) => `018fa500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const entry = (overrides: Record<string, unknown> = {}) => ({
  waitlistEntryReference: id(1),
  dynamicPosition: 1,
  partySize: 3,
  customerDisplayName: "Synthetic Party",
  contactState: "Verified",
  contactSummary: "Authorized masked contact",
  status: "Ready",
  joinMode: "Remote",
  areaPreferenceCode: "MAIN",
  seatingConstraintCodes: ["STEP_FREE"],
  joinedAt: "2026-09-04T10:00:00.000Z",
  checkedInAt: "2026-09-04T10:15:00.000Z",
  quotedMinimumMinutes: 20,
  quotedMaximumMinutes: 35,
  currentMinimumMinutes: 25,
  currentMaximumMinutes: 40,
  estimateCalculatedAt: "2026-09-04T10:20:00.000Z",
  estimateCalculationVersion: "ETA_V1",
  priorityKind: "Default",
  priorityReasonCode: null,
  responseDeadline: "2026-09-04T10:25:00.000Z",
  readyExpiresAt: "2026-09-04T10:35:00.000Z",
  readyExtensionUsed: false,
  notificationStatus: "Delivered",
  seatingEligibility: "Eligible",
  diningSessionReference: null,
  overdue: false,
  revisionNumber: 2,
  timeline: [
    {
      actionCode: "WAITLIST_READY",
      actorSummary: "Authorized Host",
      occurredAt: "2026-09-04T10:20:00.000Z",
    },
  ],
  ...overrides,
});
const view = (screenId: WaitlistScreenId = "WAIT-BOARD") => ({
  screenId,
  asOfUtc: "2026-09-04T10:21:00.000Z",
  freshness: "Current",
  entries: [entry()],
});
const render = (screenId: WaitlistScreenId) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <WaitlistScreen view={parseWaitlistView(view(screenId), screenId)} />
    </MemoryRouter>,
  );

describe("Waitlist screens", () => {
  it.each([
    ["WAIT-BOARD", "Dynamic compatibility order and readiness"],
    ["WAIT-ENTRY", "Controlled details, estimates and timeline"],
  ] as const)("renders the complete %s contract", (screenId, heading) => {
    const html = render(screenId);
    for (const text of [
      screenId,
      heading,
      "Customer-safe name / reference",
      "Dynamic position",
      "Reference / contact state",
      "Party / preferences",
      "Arrival / wait metrics",
      "Quoted / current ETA range",
      "estimate, not guarantee",
      "Priority reason",
      "Contact / ready expiry / notification",
      "Seating eligibility / Dining handoff",
      "Revision / timeline",
      "Update estimate",
      "Notify ready",
      "Extend once by policy",
      "Seat through Dining handoff",
    ])
      expect(html).toContain(text);
    expect(html).toContain("disabled");
  });

  it("rejects injected, promised, inconsistent and unsorted projections", () => {
    expect(() => parseWaitlistView({ ...view(), extra: true })).toThrow(WaitlistClientError);
    expect(() =>
      parseWaitlistView({
        ...view(),
        entries: [{ ...entry(), contactSummary: "https://unsafe.test" }],
      }),
    ).toThrow(WaitlistClientError);
    expect(() =>
      parseWaitlistView({ ...view(), entries: [{ ...entry(), status: "Seated" }] }),
    ).toThrow(WaitlistClientError);
    expect(() =>
      parseWaitlistView({
        ...view(),
        entries: [entry({ waitlistEntryReference: id(2), dynamicPosition: 2 }), entry()],
      }),
    ).toThrow(WaitlistClientError);
    expect(() => parseWaitlistView({ ...view("WAIT-ENTRY"), entries: [] })).toThrow(
      WaitlistClientError,
    );
  });

  it("renders empty, stale and every mandatory recovery state", () => {
    const empty = renderToStaticMarkup(
      <MemoryRouter>
        <WaitlistScreen view={parseWaitlistView({ ...view(), freshness: "Stale", entries: [] })} />
      </MemoryRouter>,
    );
    expect(empty).toContain("Projection is stale");
    expect(empty).toContain("No Waitlist Entries");
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
            <WaitlistState state={state} />
          </MemoryRouter>,
        ).length,
      ).toBeGreaterThan(50);
  });
});
