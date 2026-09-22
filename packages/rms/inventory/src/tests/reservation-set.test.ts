import { describe, expect, it } from "vitest";
import {
  advanceInventoryReservation,
  createInventoryReservation,
} from "../domain/inventory-reservation.js";
import {
  parseInventoryReservationSet,
  planInventoryReservationSetRelease,
} from "../domain/reservation-set.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const binding = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  stockSiteReference: id(4),
  locationReference: id(5),
  itemReference: id(6),
  lotReference: null,
  submissionReference: id(7),
  cartReference: id(8),
  cartVersion: 2,
  quoteReference: id(9),
  demandReference: id(10),
  demandDigest: "sha256:" + "a".repeat(64),
};
const entry = (n: number) => ({
  accountReference: id(n),
  operationReference: id(n + 1),
  movementReference: id(n + 2),
  auditReference: id(n + 3),
  reservation: createInventoryReservation({
    reservationReference: id(n + 4),
    binding,
    unit: {
      unitCode: "KG",
      dimension: "Mass",
      displayPrecision: 2,
      ledgerPrecision: 6,
      roundingMode: "HalfEven",
    },
    quantity: "0.5",
    occurredAt: "2026-09-11T10:00:00.000Z",
  }),
});
const input = () => ({
  schemaVersion: 1,
  setReference: id(20),
  operationReference: id(21),
  actorReference: id(22),
  auditReference: id(24),
  workflowReference: id(23),
  workflowVersion: 1,
  requestDigest: "sha256:" + "b".repeat(64),
  entries: [entry(100), entry(200)],
});
describe("complete inventory reservation set", () => {
  it("retains every original reservation and source binding in a frozen snapshot", () => {
    const raw = input(),
      set = parseInventoryReservationSet(raw);
    expect(set).toEqual(raw);
    expect(set.entries).toHaveLength(2);
    expect(Object.isFrozen(set.entries[0]?.reservation)).toBe(true);
    raw.entries.pop();
    expect(set.entries).toHaveLength(2);
  });
  it("rejects a child bound to a different submission", () => {
    const raw = input();
    raw.entries[1] = {
      ...entry(200),
      reservation: {
        ...entry(200).reservation,
        binding: { ...binding, submissionReference: id(99) },
      },
    } as (typeof raw.entries)[number];
    expect(() => parseInventoryReservationSet(raw)).toThrow();
  });
  it.each(["accountReference", "operationReference", "movementReference", "auditReference"])(
    "rejects duplicate %s",
    (field) => {
      const raw = input();
      const second = raw.entries[1];
      if (!second) throw new Error("missing fixture");
      Object.assign(second, {
        [field]: (raw.entries[0] as unknown as Record<string, unknown>)[field],
      });
      expect(() => parseInventoryReservationSet(raw)).toThrow();
    },
  );
  it("rejects empty and sparse child sets", () => {
    expect(() => parseInventoryReservationSet({ ...input(), entries: [] })).toThrow();
    expect(() => parseInventoryReservationSet({ ...input(), entries: new Array(1) })).toThrow();
  });
});

const releaseInput = () => {
  const set = input();
  return {
    set,
    current: set.entries.map(({ accountReference, reservation }) => ({
      accountReference,
      reservation,
    })),
    occurredAt: "2026-09-11T10:30:00.000Z",
  };
};
describe("complete submission release planning", () => {
  it("releases exact remaining quantities in stable order without changing originals", () => {
    const raw = releaseInput();
    raw.current.reverse();
    const result = planInventoryReservationSetRelease(raw);
    expect(result.entries.map((e) => e.accountReference)).toEqual([id(100), id(200)]);
    for (const entry of result.entries) {
      expect(entry.reservation).toMatchObject({
        remainingQuantity: "0",
        releasedQuantity: "0.5",
        consumedQuantity: "0",
        version: 2,
      });
      expect(entry.expectedReservationVersion).toBe(1);
    }
    expect(raw.current[0]?.reservation.remainingQuantity).toBe("0.5");
    expect(Object.isFrozen(result.entries)).toBe(true);
  });
  it.each([
    "missing",
    "duplicate",
    "foreignAccount",
    "foreignSubmission",
    "quantity",
    "started",
    "consumed",
    "future",
  ])("rejects %s before returning any release candidates", (kind) => {
    const raw = releaseInput();
    const first = raw.current[0];
    if (!first) throw new Error("fixture");
    if (kind === "missing") raw.current.pop();
    if (kind === "duplicate") raw.current[1] = first;
    if (kind === "foreignAccount") first.accountReference = id(999);
    if (kind === "foreignSubmission")
      first.reservation = {
        ...first.reservation,
        binding: {
          ...first.reservation.binding,
          submissionReference: first.reservation.binding.cartReference,
        },
      };
    if (kind === "quantity")
      first.reservation = {
        ...first.reservation,
        originalQuantity: "0.6",
        remainingQuantity: "0.6",
      };
    if (["started", "consumed"].includes(kind))
      first.reservation = advanceInventoryReservation(first.reservation, {
        reservationReference: first.reservation.reservationReference,
        binding: first.reservation.binding,
        expectedVersion: 1,
        action: kind === "started" ? "StartProduction" : "Consume",
        quantity: kind === "started" ? null : "0.1",
        occurredAt: raw.occurredAt,
      });
    if (kind === "future") raw.occurredAt = "2026-09-11T09:00:00.000Z";
    expect(() => planInventoryReservationSetRelease(raw)).toThrow();
  });
  it("releases only the remainder after an earlier partial release", () => {
    const raw = releaseInput();
    const first = raw.current[0];
    if (!first) throw new Error("fixture");
    first.reservation = advanceInventoryReservation(first.reservation, {
      reservationReference: first.reservation.reservationReference,
      binding: first.reservation.binding,
      expectedVersion: 1,
      action: "Release",
      quantity: "0.2",
      occurredAt: raw.occurredAt,
    });
    const result = planInventoryReservationSetRelease(raw);
    expect(result.entries[0]).toMatchObject({
      quantity: "0.3",
      expectedReservationVersion: 2,
      reservation: { releasedQuantity: "0.5", remainingQuantity: "0", version: 3 },
    });
  });
});
