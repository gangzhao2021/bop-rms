import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { CapacityPolicyScreen, CapacityPolicyState } from "./CapacityPolicyPage.js";
import { CapacityPolicyClientError, parseCapacityPolicyView } from "./capacity-policy-pages.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function projection(overrides: Record<string, unknown> = {}) {
  return {
    screenId: "RES-CAPACITY-CONFIG",
    projectionVersion: "RESERVATION_CAPACITY_V1",
    asOfUtc: "2026-09-12T18:00:00.000Z",
    freshness: "Current",
    partial: false,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    policyReference: id(4),
    versionReference: id(5),
    areaReference: id(6),
    serviceCode: "DINNER",
    timeZone: "America/Toronto",
    policyVersion: 2,
    aggregateVersion: 3,
    lifecycle: "Scheduled",
    effectiveFrom: "2026-09-15T10:00:00.000Z",
    effectiveUntil: null,
    buckets: [
      {
        bucketReference: id(10),
        dayOfWeek: 4,
        startMinute: 1020,
        endMinute: 1200,
        capacitySeats: 40,
        onlineAllocationSeats: 24,
        overbookMode: "ManagerOnly",
        overbookAllowanceSeats: 4,
        turnTimeMinutes: 90,
      },
    ],
    closures: [
      {
        closureReference: id(11),
        startsAt: "2026-09-20T17:00:00.000Z",
        endsAt: "2026-09-20T20:00:00.000Z",
        reasonCode: "PRIVATE_EVENT",
      },
    ],
    depositPolicyReference: id(12),
    depositPolicyVersion: 3,
    cancellationPolicyReference: id(13),
    cancellationPolicyVersion: 2,
    noShowPolicyReference: id(14),
    noShowPolicyVersion: 4,
    issues: [
      {
        severity: "Warning",
        code: "DINING_CAPACITY_LIMITED",
        sourceSummary: "Authorized Dining summary limits the configured capacity.",
      },
    ],
    simulation: {
      scenarioReference: id(15),
      calculatedAt: "2026-09-12T18:00:00.000Z",
      calculationVersion: "CAPACITY_POLICY_V1",
      effectiveCapacitySeats: 38,
      availableSeatsBeforeRequest: 8,
      availableSeatsAfterRequest: 4,
      blockingCodes: [],
      warningCodes: ["DINING_CAPACITY_LIMITED"],
    },
    history: [
      {
        versionReference: id(5),
        policyVersion: 2,
        lifecycle: "Scheduled",
        effectiveFrom: "2026-09-15T10:00:00.000Z",
        actorSummary: "Authorized Store Manager",
      },
    ],
    ...overrides,
  };
}

describe("RES-CAPACITY-CONFIG", () => {
  it("strictly parses the complete projection and rejects unknown fields", () => {
    expect(parseCapacityPolicyView(projection())).toMatchObject({
      screenId: "RES-CAPACITY-CONFIG",
      lifecycle: "Scheduled",
      buckets: [{ capacitySeats: 40, onlineAllocationSeats: 24 }],
    });
    expect(() => parseCapacityPolicyView({ ...projection(), unexpected: true })).toThrow(
      CapacityPolicyClientError,
    );
  });

  it("renders fields, filters, simulation, policy boundaries and disabled commands", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CapacityPolicyScreen view={parseCapacityPolicyView(projection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "Date / area / service scenario",
      "Capacity time buckets",
      "Closures and manual capacity adjustments",
      "Pricing-owned policy references",
      "Demand / conflict simulation",
      "Version history and Audit",
      "Simulation is deterministic evidence",
    ])
      expect(html).toContain(text);
    expect(html).toMatch(/<button disabled="">Save draft<\/button>/u);
    expect(html).toMatch(/<button disabled="">Publish now<\/button>/u);
  });

  it("renders stale / partial evidence as read-only and explains blocking sources", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CapacityPolicyScreen
          view={parseCapacityPolicyView(
            projection({
              freshness: "Stale",
              partial: true,
              issues: [
                {
                  severity: "Blocking",
                  code: "POLICY_EVIDENCE_UNKNOWN",
                  sourceSummary: "Pricing policy evidence is not current.",
                },
              ],
            }),
          )}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Partial dependency evidence");
    expect(html).toContain("POLICY_EVIDENCE_UNKNOWN");
    expect(html).toContain("1 blocking issue(s)");
  });

  it("covers every mandatory failure, conflict and offline state", () => {
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
    ] as const) {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <CapacityPolicyState state={state} />
        </MemoryRouter>,
      );
      expect(html).toContain("status");
    }
  });
});
