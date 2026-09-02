import { describe, expect, it } from "vitest";

import {
  createReservation,
  parseReservationCode,
  parseReservationInstant,
  parseReservationReference,
  ReservationError,
  reviseReservation,
  transitionReservation,
} from "../index.js";

const id = (n: number) => `018fa000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = (hour: number) => `2026-09-01T${hour.toString().padStart(2, "0")}:00:00.000Z`;
function reservation(overrides: Record<string, unknown> = {}) {
  return createReservation({
    reservationReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    capacityPoolReference: id(5),
    capacityHoldReference: id(6),
    capacityHoldExpiresAt: at(11),
    startAt: at(12),
    expectedEndAt: at(14),
    partySize: 4,
    contact: {
      displayName: "Synthetic Guest",
      contactKind: "Email",
      contactValue: "guest@example.test",
    },
    channel: "Staff",
    accessibilityRequestCodes: ["STEP_FREE"],
    specialRequestCode: null,
    depositPolicyReference: null,
    depositPolicyVersion: null,
    paymentIntentReference: null,
    depositOutcome: "NotRequired",
    status: "Pending",
    revisionNumber: 1,
    aggregateVersion: 1,
    diningSessionReference: null,
    terminalReasonCode: null,
    createdAt: at(9),
    observedAt: at(9),
    ...overrides,
  });
}

describe("Reservation aggregate", () => {
  it("confirms, checks in and records only a Dining-issued seated result", () => {
    const confirmed = transitionReservation(reservation(), "Confirm", {
      observedAt: parseReservationInstant(at(10)),
      reasonCode: null,
      diningSessionReference: null,
      noShowEligibleAt: null,
    });
    const checkedIn = transitionReservation(confirmed, "CheckIn", {
      observedAt: parseReservationInstant(at(11)),
      reasonCode: null,
      diningSessionReference: null,
      noShowEligibleAt: null,
    });
    const seated = transitionReservation(checkedIn, "RecordSeated", {
      observedAt: parseReservationInstant(at(12)),
      reasonCode: null,
      diningSessionReference: parseReservationReference(id(8)),
      noShowEligibleAt: null,
    });
    expect(seated).toMatchObject({
      status: "Seated",
      diningSessionReference: id(8),
      aggregateVersion: 4,
    });
    expect(() =>
      transitionReservation(seated, "Cancel", {
        observedAt: parseReservationInstant(at(13)),
        reasonCode: parseReservationCode("CUSTOMER_CANCELLED"),
        diningSessionReference: null,
        noShowEligibleAt: null,
      }),
    ).toThrow(ReservationError);
  });

  it("keeps Deposit outcome separate and fails confirmation closed", () => {
    const pending = reservation({
      depositPolicyReference: id(9),
      depositPolicyVersion: 3,
      paymentIntentReference: id(10),
      depositOutcome: "Pending",
    });
    expect(() =>
      transitionReservation(pending, "Confirm", {
        observedAt: parseReservationInstant(at(10)),
        reasonCode: null,
        diningSessionReference: null,
        noShowEligibleAt: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "RESERVATION_DEPOSIT_CONFLICT" }));
    expect(pending.status).toBe("Pending");
  });

  it("requires a new unexpired hold for a critical append-only revision", () => {
    const current = reservation();
    const candidate = reservation({
      capacityHoldReference: id(11),
      capacityHoldExpiresAt: at(15),
      startAt: at(13),
      expectedEndAt: at(15),
      revisionNumber: 2,
      aggregateVersion: 2,
      observedAt: at(10),
    });
    const result = reviseReservation(current, candidate, {
      revisionReference: parseReservationReference(id(12)),
      reasonCode: parseReservationCode("CUSTOMER_RESCHEDULE"),
      actorReference: parseReservationReference(id(13)),
      observedAt: parseReservationInstant(at(10)),
      critical: true,
    });
    expect(result.revision).toMatchObject({
      revisionNumber: 2,
      critical: true,
      previousCapacityHoldReference: id(6),
    });
    expect(() =>
      reviseReservation(
        current,
        createReservation({ ...candidate, capacityHoldReference: id(6) }),
        {
          revisionReference: parseReservationReference(id(12)),
          reasonCode: parseReservationCode("CUSTOMER_RESCHEDULE"),
          actorReference: parseReservationReference(id(13)),
          observedAt: parseReservationInstant(at(10)),
          critical: true,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "RESERVATION_CAPACITY_CONFLICT" }));
  });

  it("does not let a non-critical revision bypass capacity or Payment ownership", () => {
    const current = reservation();
    const changedTime = reservation({
      startAt: at(13),
      expectedEndAt: at(15),
      revisionNumber: 2,
      aggregateVersion: 2,
      observedAt: at(10),
    });
    expect(() =>
      reviseReservation(current, changedTime, {
        revisionReference: parseReservationReference(id(12)),
        reasonCode: parseReservationCode("CUSTOMER_RESCHEDULE"),
        actorReference: parseReservationReference(id(13)),
        observedAt: parseReservationInstant(at(10)),
        critical: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "RESERVATION_INPUT_INVALID" }));
    expect(() =>
      reviseReservation(
        current,
        reservation({
          depositPolicyReference: id(9),
          depositPolicyVersion: 1,
          paymentIntentReference: id(10),
          depositOutcome: "Pending",
          revisionNumber: 2,
          aggregateVersion: 2,
          observedAt: at(10),
        }),
        {
          revisionReference: parseReservationReference(id(12)),
          reasonCode: parseReservationCode("POLICY_CHANGE"),
          actorReference: parseReservationReference(id(13)),
          observedAt: parseReservationInstant(at(10)),
          critical: false,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "RESERVATION_INPUT_INVALID" }));
  });

  it("rejects raw-shape injection, invalid contact and premature no-show", () => {
    expect(() => createReservation({ ...reservation(), extra: true })).toThrow(ReservationError);
    expect(() =>
      reservation({
        contact: { displayName: "<script>", contactKind: "Email", contactValue: "bad" },
      }),
    ).toThrow(ReservationError);
    expect(() =>
      transitionReservation(reservation({ status: "Confirmed" }), "MarkNoShow", {
        observedAt: parseReservationInstant(at(12)),
        reasonCode: parseReservationCode("NO_SHOW"),
        diningSessionReference: null,
        noShowEligibleAt: parseReservationInstant(at(13)),
      }),
    ).toThrow(ReservationError);
  });
});
