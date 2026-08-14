import { describe, expect, it } from "vitest";

import {
  CapacityPolicyError,
  createCapacityPolicy,
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  reviseCapacityPolicy,
  simulateCapacityPolicy,
  transitionCapacityPolicy,
} from "../index.js";

const id = (n: number) => `018fa500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (day: number, hour: number) =>
  `2026-09-${day.toString().padStart(2, "0")}T${hour.toString().padStart(2, "0")}:00:00.000Z`;

function policy(overrides: Record<string, unknown> = {}) {
  return createCapacityPolicy({
    policyReference: id(1),
    versionReference: id(2),
    tenantReference: id(3),
    brandReference: id(4),
    storeReference: id(5),
    areaReference: id(6),
    serviceCode: "DINNER",
    timeZone: "America/Toronto",
    policyVersion: 1,
    aggregateVersion: 1,
    lifecycle: "Draft",
    effectiveFrom: at(10, 10),
    effectiveUntil: at(30, 10),
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
    closures: [],
    depositPolicyReference: id(20),
    depositPolicyVersion: 3,
    cancellationPolicyReference: id(21),
    cancellationPolicyVersion: 2,
    noShowPolicyReference: id(22),
    noShowPolicyVersion: 4,
    createdByActorReference: id(30),
    createdAt: at(1, 10),
    observedAt: at(1, 10),
    ...overrides,
  });
}

function scenario(overrides: Record<string, unknown> = {}) {
  return {
    scenarioReference: id(40),
    versionReference: id(2),
    occursAt: at(12, 18),
    dayOfWeek: 4,
    localMinute: 1080,
    channel: "Customer",
    requestedPartySize: 4,
    confirmedSeats: 16,
    heldSeats: 2,
    diningCompatibleSeats: 38,
    storeOpen: true,
    pricingPolicyEvidence: "Current",
    managerOverrideReference: null,
    ...overrides,
  };
}

describe("Reservation Capacity Policy", () => {
  it("rejects overlapping buckets and allocations beyond configured capacity", () => {
    expect(() =>
      policy({
        buckets: [
          {
            bucketReference: id(10),
            dayOfWeek: 4,
            startMinute: 1020,
            endMinute: 1200,
            capacitySeats: 40,
            onlineAllocationSeats: 24,
            overbookMode: "Disabled",
            overbookAllowanceSeats: 0,
            turnTimeMinutes: 90,
          },
          {
            bucketReference: id(11),
            dayOfWeek: 4,
            startMinute: 1100,
            endMinute: 1250,
            capacitySeats: 20,
            onlineAllocationSeats: 21,
            overbookMode: "Disabled",
            overbookAllowanceSeats: 0,
            turnTimeMinutes: 90,
          },
        ],
      }),
    ).toThrow(CapacityPolicyError);
  });

  it("applies online allocation without promising Dining capacity", () => {
    const result = simulateCapacityPolicy(policy(), scenario());
    expect(result).toMatchObject({
      effectiveCapacitySeats: 24,
      availableSeatsBeforeRequest: 6,
      availableSeatsAfterRequest: 2,
      blockingCodes: [],
      warningCodes: ["DINING_CAPACITY_LIMITED", "ONLINE_ALLOCATION_APPLIED"],
    });
  });

  it("requires explicit Manager evidence before overbook allowance applies", () => {
    const without = simulateCapacityPolicy(
      policy(),
      scenario({ channel: "Staff", confirmedSeats: 38, heldSeats: 0, requestedPartySize: 4 }),
    );
    const withOverride = simulateCapacityPolicy(
      policy(),
      scenario({
        channel: "Staff",
        confirmedSeats: 38,
        heldSeats: 0,
        requestedPartySize: 4,
        managerOverrideReference: id(41),
      }),
    );
    expect(without.blockingCodes).toContain("CAPACITY_EXCEEDED");
    expect(withOverride).toMatchObject({
      effectiveCapacitySeats: 42,
      availableSeatsAfterRequest: 0,
      blockingCodes: [],
    });
    expect(withOverride.warningCodes).toContain("MANAGER_OVERBOOK_APPLIED");
  });

  it("blocks a closure and indeterminate Pricing-policy evidence", () => {
    const result = simulateCapacityPolicy(
      policy({
        closures: [
          {
            closureReference: id(50),
            startsAt: at(12, 17),
            endsAt: at(12, 20),
            reasonCode: "PRIVATE_EVENT",
          },
        ],
      }),
      scenario({ pricingPolicyEvidence: "Indeterminate" }),
    );
    expect(result.blockingCodes).toEqual(["CAPACITY_CLOSURE", "POLICY_EVIDENCE_UNKNOWN"]);
  });

  it("creates an append-only draft revision and publishes only at its effective instant", () => {
    const current = policy({ lifecycle: "Published" });
    const revisedCandidate = policy({
      versionReference: id(60),
      policyVersion: 2,
      aggregateVersion: 2,
      createdByActorReference: id(31),
      createdAt: at(9, 10),
      observedAt: at(9, 10),
    });
    const revised = reviseCapacityPolicy(current, revisedCandidate, {
      revisionReference: parseReservationReference(id(61)),
      reasonCode: parseReservationCode("CAPACITY_CORRECTION"),
      actorReference: parseReservationReference(id(31)),
      observedAt: parseReservationInstant(at(9, 10)),
    });
    expect(revised.revision.previousSnapshot.lifecycle).toBe("Published");
    expect(() =>
      transitionCapacityPolicy(revised.policy, "Publish", parseReservationInstant(at(9, 11))),
    ).toThrow(CapacityPolicyError);
    expect(
      transitionCapacityPolicy(revised.policy, "Schedule", parseReservationInstant(at(9, 11))),
    ).toMatchObject({ lifecycle: "Scheduled", aggregateVersion: 3 });
  });
});
