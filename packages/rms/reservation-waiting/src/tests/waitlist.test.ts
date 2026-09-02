import { describe, expect, it } from "vitest";

import {
  calculateDeterministicWaitEstimate,
  createWaitlistEntry,
  orderEligibleWaitlistEntries,
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  recordWaitlistNotificationOutcome,
  ReservationError,
  reviseWaitEstimate,
  reviseWaitlistEntry,
  reviseWaitPriority,
  transitionWaitlistEntry,
} from "../index.js";

const id = (n: number) => `018fa300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (hour: number, minute = 0) =>
  `2026-09-02T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:00.000Z`;

function entry(overrides: Record<string, unknown> = {}) {
  return createWaitlistEntry({
    waitlistEntryReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    status: "Waiting",
    joinMode: "Remote",
    partySize: 3,
    contact: {
      displayName: "Synthetic Party",
      contactState: "Verified",
      contactSummary: "Authorized masked contact",
    },
    areaPreferenceCode: "MAIN",
    seatingConstraintCodes: ["STEP_FREE"],
    joinedAt: at(10),
    checkedInAt: null,
    calledAt: null,
    responseDeadline: null,
    readyAt: null,
    readyExpiresAt: null,
    readyExtensionUsed: false,
    maxWaitExpiresAt: at(14),
    quotedEstimate: {
      minimumMinutes: 20,
      maximumMinutes: 35,
      calculatedAt: at(10),
      calculationVersion: "ETA_V1",
    },
    currentEstimate: {
      minimumMinutes: 20,
      maximumMinutes: 35,
      calculatedAt: at(10),
      calculationVersion: "ETA_V1",
    },
    priorityKind: "Default",
    priorityReasonCode: null,
    priorityReference: null,
    priorityExpiresAt: null,
    notificationRequestReference: null,
    notificationStatus: "NotRequested",
    diningSessionReference: null,
    terminalReasonCode: null,
    revisionNumber: 1,
    aggregateVersion: 1,
    createdAt: at(10),
    observedAt: at(10),
    ...overrides,
  });
}

const evidence = (overrides: Record<string, unknown> = {}) => ({
  observedAt: parseReservationInstant(at(11)),
  reasonCode: null,
  deadline: null,
  eligibleAt: null,
  notificationRequestReference: null,
  diningSessionReference: null,
  ...overrides,
});

describe("Waitlist Entry aggregate", () => {
  it("moves through Check-in, Call, Ready, one extension and Dining-issued seating", () => {
    const checked = transitionWaitlistEntry(entry(), "CheckIn", evidence());
    const called = transitionWaitlistEntry(
      checked,
      "Call",
      evidence({
        observedAt: parseReservationInstant(at(11, 5)),
        deadline: parseReservationInstant(at(11, 15)),
        notificationRequestReference: parseReservationReference(id(10)),
      }),
    );
    const ready = transitionWaitlistEntry(
      called,
      "MarkReady",
      evidence({
        observedAt: parseReservationInstant(at(11, 10)),
        deadline: parseReservationInstant(at(11, 25)),
      }),
    );
    const extended = transitionWaitlistEntry(
      ready,
      "ExtendReady",
      evidence({
        observedAt: parseReservationInstant(at(11, 20)),
        reasonCode: parseReservationCode("POLICY_EXTENSION"),
        deadline: parseReservationInstant(at(11, 35)),
      }),
    );
    const seated = transitionWaitlistEntry(
      extended,
      "RecordSeated",
      evidence({
        observedAt: parseReservationInstant(at(11, 30)),
        diningSessionReference: parseReservationReference(id(11)),
      }),
    );
    expect(seated).toMatchObject({
      status: "Seated",
      readyExtensionUsed: true,
      diningSessionReference: id(11),
      aggregateVersion: 6,
    });
    expect(() =>
      transitionWaitlistEntry(seated, "Cancel", evidence({ reasonCode: "CANCELLED" })),
    ).toThrow(ReservationError);
  });

  it("marks a missed Call only after its deadline and restores with reason", () => {
    const called = transitionWaitlistEntry(
      entry(),
      "Call",
      evidence({
        deadline: parseReservationInstant(at(11, 10)),
        notificationRequestReference: parseReservationReference(id(10)),
      }),
    );
    expect(() =>
      transitionWaitlistEntry(
        called,
        "MarkMissed",
        evidence({
          observedAt: parseReservationInstant(at(11, 5)),
          reasonCode: parseReservationCode("NO_RESPONSE"),
        }),
      ),
    ).toThrow(ReservationError);
    const missed = transitionWaitlistEntry(
      called,
      "MarkMissed",
      evidence({
        observedAt: parseReservationInstant(at(11, 10)),
        reasonCode: parseReservationCode("NO_RESPONSE"),
      }),
    );
    const restored = transitionWaitlistEntry(
      missed,
      "RestoreCheckedIn",
      evidence({
        observedAt: parseReservationInstant(at(11, 20)),
        reasonCode: parseReservationCode("MANAGER_RESTORE"),
      }),
    );
    expect(restored).toMatchObject({ status: "CheckedIn", notificationStatus: "NotRequested" });
  });

  it("keeps Notification outcome independent from lifecycle", () => {
    const called = transitionWaitlistEntry(
      entry(),
      "Call",
      evidence({
        deadline: parseReservationInstant(at(11, 10)),
        notificationRequestReference: parseReservationReference(id(10)),
      }),
    );
    const failed = recordWaitlistNotificationOutcome(
      called,
      createWaitlistEntry({
        ...called,
        notificationStatus: "Failed",
        aggregateVersion: 3,
        observedAt: at(11, 2),
      }),
      parseReservationInstant(at(11, 2)),
    );
    expect(failed).toMatchObject({ status: "Called", notificationStatus: "Failed" });
  });

  it("appends controlled detail, ETA and priority revisions without storing queue position", () => {
    const current = entry();
    const actorReference = parseReservationReference(id(20));
    const revised = reviseWaitlistEntry(
      current,
      entry({
        partySize: 4,
        areaPreferenceCode: "PATIO",
        revisionNumber: 2,
        aggregateVersion: 2,
        observedAt: at(11),
      }),
      {
        revisionReference: parseReservationReference(id(21)),
        reasonCode: parseReservationCode("PARTY_UPDATED"),
        actorReference,
        observedAt: parseReservationInstant(at(11)),
      },
    );
    const estimated = reviseWaitEstimate(
      revised.entry,
      createWaitlistEntry({
        ...revised.entry,
        currentEstimate: {
          minimumMinutes: 30,
          maximumMinutes: 50,
          calculatedAt: at(11, 5),
          calculationVersion: "ETA_V1",
        },
        aggregateVersion: 3,
        observedAt: at(11, 5),
      }),
      {
        estimateRevisionReference: parseReservationReference(id(22)),
        reasonCode: parseReservationCode("TABLE_STATE_CHANGED"),
        actorReference,
        observedAt: parseReservationInstant(at(11, 5)),
      },
    );
    const prioritized = reviseWaitPriority(
      estimated.entry,
      createWaitlistEntry({
        ...estimated.entry,
        priorityKind: "ManagerOverride",
        priorityReasonCode: "ACCESSIBILITY_OVERRIDE",
        priorityReference: id(23),
        priorityExpiresAt: at(12),
        aggregateVersion: 4,
        observedAt: at(11, 10),
      }),
      {
        priorityRevisionReference: parseReservationReference(id(24)),
        reasonCode: parseReservationCode("ACCESSIBILITY_OVERRIDE"),
        actorReference,
        observedAt: parseReservationInstant(at(11, 10)),
      },
    );
    expect(prioritized.entry).not.toHaveProperty("queuePosition");
    expect(prioritized.entry).toMatchObject({
      joinedAt: at(10),
      priorityKind: "ManagerOverride",
      aggregateVersion: 4,
    });
  });

  it("rejects raw-shape injection, promised ETA ranges and direct seating", () => {
    expect(() => createWaitlistEntry({ ...entry(), queuePosition: 1 })).toThrow(ReservationError);
    expect(() =>
      entry({
        currentEstimate: {
          minimumMinutes: 50,
          maximumMinutes: 20,
          calculatedAt: at(10),
          calculationVersion: "ETA_V1",
        },
      }),
    ).toThrow(ReservationError);
    expect(() => entry({ status: "Seated", diningSessionReference: null })).toThrow(
      ReservationError,
    );
  });

  it("computes compatibility order dynamically and an integer ETA range", () => {
    const checkedIn = entry({
      waitlistEntryReference: id(30),
      status: "CheckedIn",
      joinMode: "WalkIn",
      joinedAt: at(10, 5),
      checkedInAt: at(10, 5),
      createdAt: at(10, 5),
      observedAt: at(10, 5),
    });
    const override = entry({
      waitlistEntryReference: id(31),
      joinedAt: at(10, 10),
      createdAt: at(10, 10),
      observedAt: at(10, 10),
      priorityKind: "ManagerOverride",
      priorityReasonCode: "ACCESSIBILITY_OVERRIDE",
      priorityReference: id(32),
      priorityExpiresAt: at(13),
    });
    expect(
      orderEligibleWaitlistEntries([entry(), checkedIn, override], {
        minimumPartySize: 1,
        maximumPartySize: 4,
        areaCode: parseReservationCode("MAIN"),
        supportedConstraintCodes: [parseReservationCode("STEP_FREE")],
        checkedInFirst: true,
        observedAt: parseReservationInstant(at(11)),
      }),
    ).toEqual([id(31), id(30), id(1)]);
    expect(
      calculateDeterministicWaitEstimate({
        availableInMinutes: 10,
        compatibleEntriesAhead: 2,
        standardTurnMinutes: 30,
        cleaningBufferMinutes: 5,
        reservationPressureMinutes: 10,
        holdPressureMinutes: 5,
        calculatedAt: parseReservationInstant(at(11)),
        calculationVersion: parseReservationCode("ETA_V1"),
      }),
    ).toMatchObject({ minimumMinutes: 70, maximumMinutes: 90 });
  });
});
