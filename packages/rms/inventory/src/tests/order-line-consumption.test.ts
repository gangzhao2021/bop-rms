import { describe, expect, it } from "vitest";
import {
  advanceInventoryReservation,
  createInventoryReservation,
  type InventoryReservation,
} from "../domain/inventory-reservation.js";
import { planOrderLineKitchenEffects } from "../domain/order-line-consumption.js";

const id = (n: number) => "01909a02-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const line = id(30);
const at = (minute: number) => `2026-10-07T10:${String(minute).padStart(2, "0")}:00.000Z`;
const reserved = (quantity: string, n = 1, cartItemReference = line) =>
  createInventoryReservation({
    reservationReference: id(n),
    unit: {
      unitCode: "KG",
      dimension: "Mass",
      displayPrecision: 2,
      ledgerPrecision: 4,
      roundingMode: "HalfEven",
    },
    quantity,
    occurredAt: at(0),
    binding: {
      tenantReference: id(2),
      brandReference: id(3),
      storeReference: id(4),
      stockSiteReference: id(5),
      locationReference: id(6),
      itemReference: id(7),
      lotReference: null,
      submissionReference: id(8),
      cartReference: id(9),
      cartVersion: 1,
      quoteReference: id(10),
      demandReference: id(11),
      demandDigest: "sha256:" + "a".repeat(64),
      cartItemReference,
    },
  });
const apply = (
  reservation: InventoryReservation,
  effects: ReturnType<typeof planOrderLineKitchenEffects>,
) =>
  effects.reduce((value, effect) => {
    expect(effect.expectedReservationVersion).toBe(value.version);
    return effect.reservation;
  }, reservation);

describe("planOrderLineKitchenEffects", () => {
  it("locks the line on Start and consumes proportionally, completing exactly at the end", () => {
    let r = reserved("1");
    const start = planOrderLineKitchenEffects({
      cartItemReference: line,
      reservations: [{ accountReference: id(20), reservation: r }],
      kitchen: { kind: "Start" },
      occurredAt: at(1),
    });
    expect(start.map((e) => e.action)).toEqual(["StartProduction"]);
    r = apply(r, start);
    const progress = (completedQuantity: number, minute: number) => {
      const effects = planOrderLineKitchenEffects({
        cartItemReference: line,
        reservations: [{ accountReference: id(20), reservation: r }],
        kitchen: { kind: "Progress", completedQuantity, requiredQuantity: 3 },
        occurredAt: at(minute),
      });
      r = apply(r, effects);
      return effects.map((e) => [e.action, e.quantity]);
    };
    expect(progress(1, 2)).toEqual([["Consume", "0.3333"]]);
    expect(progress(1, 3)).toEqual([]);
    expect(progress(2, 4)).toEqual([["Consume", "0.3333"]]);
    expect(progress(3, 5)).toEqual([["Consume", "0.3334"]]);
    expect(r.consumedQuantity).toBe("1");
    expect(r.remainingQuantity).toBe("0");
    expect(progress(3, 6)).toEqual([]);
  });
  it("starts production implicitly when progress arrives before Start", () => {
    const effects = planOrderLineKitchenEffects({
      cartItemReference: line,
      reservations: [{ accountReference: id(20), reservation: reserved("0.5") }],
      kitchen: { kind: "Progress", completedQuantity: 1, requiredQuantity: 1 },
      occurredAt: at(1),
    });
    expect(effects.map((e) => [e.action, e.quantity, e.expectedReservationVersion])).toEqual([
      ["StartProduction", null, 1],
      ["Consume", "0.5", 2],
    ]);
  });
  it("consumes only what was not released and skips settled reservations", () => {
    const partial = advanceInventoryReservation(reserved("1"), {
      reservationReference: id(1),
      binding: reserved("1").binding,
      expectedVersion: 1,
      action: "Release",
      quantity: "0.25",
      occurredAt: at(1),
    });
    const effects = planOrderLineKitchenEffects({
      cartItemReference: line,
      reservations: [
        { accountReference: id(20), reservation: partial },
        {
          accountReference: id(21),
          reservation: advanceInventoryReservation(reserved("0.2", 2), {
            reservationReference: id(2),
            binding: reserved("0.2", 2).binding,
            expectedVersion: 1,
            action: "Release",
            quantity: "0.2",
            occurredAt: at(1),
          }),
        },
      ],
      kitchen: { kind: "Progress", completedQuantity: 1, requiredQuantity: 1 },
      occurredAt: at(2),
    });
    expect(effects.map((e) => [e.accountReference, e.action, e.quantity])).toEqual([
      [id(20), "StartProduction", null],
      [id(20), "Consume", "0.75"],
    ]);
  });
  it("rejects reservations of another line, legacy reservations and impossible progress", () => {
    const base = {
      kitchen: { kind: "Start" } as const,
      occurredAt: at(1),
      cartItemReference: line,
    };
    expect(() =>
      planOrderLineKitchenEffects({
        ...base,
        reservations: [{ accountReference: id(20), reservation: reserved("1", 1, id(31)) }],
      }),
    ).toThrow();
    expect(() =>
      planOrderLineKitchenEffects({
        cartItemReference: line,
        reservations: [{ accountReference: id(20), reservation: reserved("1") }],
        kitchen: { kind: "Progress", completedQuantity: 4, requiredQuantity: 3 },
        occurredAt: at(1),
      }),
    ).toThrow();
  });
});
