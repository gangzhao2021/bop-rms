import { expect, it } from "vitest";
import { finalValidationFixture } from "./submission-final-validation.fixture.js";
import {
  createInventoryItem,
  transitionInventoryItem,
  advanceInventoryReservation,
  evaluateIntactReservationPaymentRule,
} from "../index.js";
function fixture() {
  const record = finalValidationFixture();
  const required = record.items[0];
  if (!required) throw new Error("fixture Item missing");
  const inactive = createInventoryItem({
    itemReference: required.itemReference,
    tenantReference: record.tenantReference,
    brandReference: record.brandReference,
    internalCode: "SYNTHETIC",
    itemType: "RawMaterial",
    localizedNames: { en: "Synthetic" },
    baseUnit: required.unit,
    trackingPolicy: {
      stockTrackingEnabled: true,
      lotTrackingMode: "NoLot",
      defaultShelfLifeDays: null,
      expiryWarningDays: null,
      issuePolicy: "FIFO",
      negativeStockPolicy: "Block",
    },
    occurredAt: record.observedAt,
    actorReference: record.actorReference,
  });
  const item = transitionInventoryItem(inactive, "Active", {
    expectedVersion: 1,
    hasOpenWork: false,
    hasNonZeroStock: false,
    occurredAt: record.observedAt,
    actorReference: record.actorReference,
  });
  const input = {
    record,
    observedAt: record.observedAt,
    items: [item],
    reservations: record.reservationSet.entries,
  };
  const first = input.reservations[0];
  if (!first) throw new Error("fixture reservation missing");
  return { input, item, first };
}
it("accepts the exact complete current reservation set for an explicitly selected rule", () => {
  expect(evaluateIntactReservationPaymentRule(fixture().input)).toBe(true);
});
it.each(["Release", "Consume"])("rejects actual %s transitions", (action) => {
  const { input, first } = fixture();
  let reservation = first.reservation;
  if (action === "Consume")
    reservation = advanceInventoryReservation(reservation, {
      reservationReference: reservation.reservationReference,
      binding: reservation.binding,
      expectedVersion: reservation.version,
      action: "StartProduction",
      quantity: null,
      occurredAt: input.observedAt,
    });
  reservation = advanceInventoryReservation(reservation, {
    reservationReference: reservation.reservationReference,
    binding: reservation.binding,
    expectedVersion: reservation.version,
    action,
    quantity: "0.1",
    occurredAt: input.observedAt,
  });
  expect(
    evaluateIntactReservationPaymentRule({
      ...input,
      reservations: [{ ...first, reservation }, ...input.reservations.slice(1)],
    }),
  ).toBe(false);
});
it.each(["missing", "duplicate", "wrongAccount"])("rejects %s reservation coverage", (kind) => {
  const { input, first } = fixture();
  const reservations =
    kind === "missing"
      ? input.reservations.slice(1)
      : kind === "duplicate"
        ? [first, first]
        : [
            { ...first, accountReference: input.record.orderReference },
            ...input.reservations.slice(1),
          ];
  expect(evaluateIntactReservationPaymentRule({ ...input, reservations })).toBe(false);
});
it.each(["missing", "duplicate", "foreign", "unit", "inactive", "future"])(
  "rejects %s current Item",
  (kind) => {
    const { input, item } = fixture();
    const changed =
      kind === "foreign"
        ? { ...item, tenantReference: input.record.storeReference }
        : kind === "unit"
          ? { ...item, baseUnit: { ...item.baseUnit, displayPrecision: 1 } }
          : kind === "inactive"
            ? transitionInventoryItem(item, "Inactive", {
                expectedVersion: item.aggregateVersion,
                hasOpenWork: true,
                hasNonZeroStock: true,
                occurredAt: input.observedAt,
                actorReference: input.record.actorReference,
              })
            : kind === "future"
              ? { ...item, updatedAt: "2026-09-11T10:01:00.000Z" }
              : item;
    const items = kind === "missing" ? [] : kind === "duplicate" ? [item, item] : [changed];
    expect(evaluateIntactReservationPaymentRule({ ...input, items })).toBe(false);
  },
);
it.each(["NotTracked", "ZeroDemand", "Deferred"])(
  "handles explicit %s disposition",
  (disposition) => {
    const { input, item } = fixture();
    const record = {
      ...input.record,
      reservationSet: null,
      items: input.record.items.map((required) => ({
        ...required,
        disposition,
        stockTrackingEnabled: disposition !== "NotTracked",
        quantity: disposition === "ZeroDemand" ? "0" : required.quantity,
        deferredActionCode: disposition === "Deferred" ? "AcceptOrder" : null,
      })),
    };
    const currentItem =
      disposition === "NotTracked"
        ? { ...item, trackingPolicy: { ...item.trackingPolicy, stockTrackingEnabled: false } }
        : item;
    expect(
      evaluateIntactReservationPaymentRule({
        ...input,
        record,
        items: [currentItem],
        reservations: [],
      }),
    ).toBe(disposition !== "Deferred");
  },
);
