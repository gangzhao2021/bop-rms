import { describe, expect, it } from "vitest";
import {
  advanceInventoryReservation,
  createInventoryReservation,
  parseInventoryReservation,
} from "../domain/inventory-reservation.js";
import { calculateReservationBalance } from "../domain/reservation-balance.js";

const id = (n: number) => "018f8800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T12:00:00.000Z";
const next = "2026-09-11T12:01:00.000Z";
const source = () => ({
  reservationReference: id(1),
  binding: {
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    stockSiteReference: id(5),
    locationReference: id(6),
    itemReference: id(7),
    lotReference: id(8),
    submissionReference: id(9),
    cartReference: id(10),
    cartVersion: 3,
    quoteReference: id(11),
    demandReference: id(12),
    demandDigest: "sha256:" + "a".repeat(64),
  },
  unit: {
    unitCode: "KG",
    dimension: "Mass",
    displayPrecision: 2,
    ledgerPrecision: 6,
    roundingMode: "HalfEven",
  },
  quantity: "0.3",
  occurredAt: at,
});
const command = (change: Record<string, unknown> = {}) => ({
  reservationReference: id(1),
  binding: source().binding,
  expectedVersion: 1,
  action: "Release",
  quantity: "0.1",
  occurredAt: next,
  ...change,
});
describe("Inventory reservation lifecycle", () => {
  it("conserves original quantity across partial release and consumption", () => {
    const original = createInventoryReservation(source());
    const released = advanceInventoryReservation(original, command());
    const consumed = advanceInventoryReservation(
      released,
      command({ expectedVersion: 2, action: "Consume", quantity: "0.2" }),
    );
    expect(consumed).toMatchObject({
      originalQuantity: "0.3",
      remainingQuantity: "0",
      releasedQuantity: "0.1",
      consumedQuantity: "0.2",
      version: 3,
    });
    expect(original).toMatchObject({ remainingQuantity: "0.3", releasedQuantity: "0", version: 1 });
    expect(parseInventoryReservation(consumed)).toEqual(consumed);
    expect(Object.isFrozen(consumed)).toBe(true);
    expect(Object.isFrozen(consumed.binding)).toBe(true);
    expect(Object.isFrozen(consumed.unit)).toBe(true);
    expect(() =>
      advanceInventoryReservation(
        consumed,
        command({ expectedVersion: 3, action: "Consume", quantity: "0.1" }),
      ),
    ).toThrow();
  });
  it("never releases after production starts, but permits owner-directed consumption", () => {
    const original = createInventoryReservation(source());
    const started = advanceInventoryReservation(
      original,
      command({ action: "StartProduction", quantity: null }),
    );
    expect(started.productionStartedAt).toBe(next);
    expect(started.remainingQuantity).toBe("0.3");
    expect(() =>
      advanceInventoryReservation(started, command({ expectedVersion: 2 })),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_RESERVATION_RELEASE_DENIED" }));
    expect(() =>
      advanceInventoryReservation(
        started,
        command({ expectedVersion: 2, action: "StartProduction", quantity: null }),
      ),
    ).toThrow();
    const consumed = advanceInventoryReservation(
      started,
      command({ expectedVersion: 2, action: "Consume", quantity: "0.3" }),
    );
    expect(consumed.productionStartedAt).toBe(next);
    expect(consumed.consumedQuantity).toBe("0.3");
  });
  it("composes with balance arithmetic without consuming another held reservation", () => {
    const original = createInventoryReservation(source());
    const reserve = calculateReservationBalance({
      action: "Reserve",
      quantity: original.originalQuantity,
      unit: original.unit,
      before: {
        onHand: "1",
        reserved: "0.4",
        available: "0.6",
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: 7,
      },
      expectedVersion: 7,
      negativeStockPolicy: "Block",
    });
    expect(reserve.requiredControl).toBe("None");
    const consumed = advanceInventoryReservation(
      original,
      command({ action: "Consume", quantity: "0.3" }),
    );
    const balance = calculateReservationBalance({
      action: "ConsumeReserved",
      quantity: consumed.consumedQuantity,
      unit: consumed.unit,
      before: reserve.after,
      expectedVersion: 8,
      negativeStockPolicy: "Block",
    });
    expect(balance.after).toMatchObject({ onHand: "0.7", reserved: "0.4", available: "0.3" });
    expect(consumed.remainingQuantity).toBe("0");
    expect(() =>
      advanceInventoryReservation(original, command({ action: "Consume", quantity: "0.4" })),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_RESERVATION_QUANTITY_EXCEEDED" }));
  });
  it.each(Object.keys(source().binding))("rejects a different %s binding", (field) => {
    const changed = {
      ...source().binding,
      [field]:
        field === "cartVersion"
          ? 4
          : field === "demandDigest"
            ? "sha256:" + "b".repeat(64)
            : id(99),
    };
    expect(() =>
      advanceInventoryReservation(
        createInventoryReservation(source()),
        command({ binding: changed }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_RESERVATION_BINDING_MISMATCH" }));
  });
  it("requires the exact reservation and version even with identical source binding", () => {
    const original = createInventoryReservation(source());
    expect(() =>
      advanceInventoryReservation(original, command({ reservationReference: id(99) })),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_RESERVATION_BINDING_MISMATCH" }));
    expect(() =>
      advanceInventoryReservation(original, command({ expectedVersion: 2 })),
    ).toThrowError(expect.objectContaining({ code: "INVENTORY_RESERVATION_CONFLICT" }));
  });
  it("rejects backward time and exhausted versions", () => {
    const original = createInventoryReservation(source());
    expect(() =>
      advanceInventoryReservation(original, command({ occurredAt: "2026-09-11T11:59:59.999Z" })),
    ).toThrow();
    expect(() =>
      advanceInventoryReservation(
        { ...original, version: Number.MAX_SAFE_INTEGER },
        command({ expectedVersion: Number.MAX_SAFE_INTEGER }),
      ),
    ).toThrow();
  });
  it.each(["0", "-1", "0.0000001", "1e2", 0.3])("rejects invalid quantity %s", (quantity) => {
    expect(() => createInventoryReservation({ ...source(), quantity })).toThrow();
    expect(() =>
      advanceInventoryReservation(createInventoryReservation(source()), command({ quantity })),
    ).toThrow();
  });
  it("validates precision without rounding and does not retain mutable input", () => {
    const input = source();
    expect(() =>
      createInventoryReservation({ ...input, unit: { ...input.unit, ledgerPrecision: 0 } }),
    ).toThrow();
    const result = createInventoryReservation(input);
    input.binding.storeReference = id(99);
    input.unit.unitCode = "G";
    expect(result.binding.storeReference).toBe(id(4));
    expect(result.unit.unitCode).toBe("KG");
  });
  it("rejects inconsistent stored quantities and impossible initial history", () => {
    const original = createInventoryReservation(source());
    expect(() => parseInventoryReservation({ ...original, consumedQuantity: "0.2" })).toThrow();
    expect(() => parseInventoryReservation({ ...original, productionStartedAt: next })).toThrow();
    expect(() =>
      parseInventoryReservation({ ...original, releasedQuantity: "0.1", remainingQuantity: "0.2" }),
    ).toThrow();
    expect(() => parseInventoryReservation({ ...original, updatedAt: next })).toThrow();
  });
  it("rejects foreign fields and accessors without invoking them", () => {
    const input = source();
    expect(() => createInventoryReservation({ ...input, approved: true })).toThrow();
    Object.defineProperty(input.binding, "storeReference", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    expect(() => createInventoryReservation(input)).toThrowError(
      expect.objectContaining({ code: "INVENTORY_RESERVATION_INVALID" }),
    );
  });
});
describe("WP-2423 per-Order-line reservations", () => {
  const line = id(30);
  const perLine = () => ({
    ...source(),
    binding: { ...source().binding, cartItemReference: line },
  });
  it("creates schema 2 when the Order line is bound and keeps it through transitions", () => {
    const reserved = createInventoryReservation(perLine());
    expect(reserved.schemaVersion).toBe(2);
    expect(reserved.binding.cartItemReference).toBe(line);
    const started = advanceInventoryReservation(reserved, {
      reservationReference: id(1),
      binding: reserved.binding,
      expectedVersion: 1,
      action: "StartProduction",
      quantity: null,
      occurredAt: next,
    });
    expect(started.binding.cartItemReference).toBe(line);
    expect(() =>
      advanceInventoryReservation(started, {
        reservationReference: id(1),
        binding: started.binding,
        expectedVersion: 2,
        action: "Release",
        quantity: "0.1",
        occurredAt: next,
      }),
    ).toThrow(expect.objectContaining({ code: "INVENTORY_RESERVATION_RELEASE_DENIED" }));
  });
  it("keeps schema 1 history readable and rejects mixed shapes", () => {
    const legacy = createInventoryReservation(source());
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.binding).not.toHaveProperty("cartItemReference");
    expect(() =>
      parseInventoryReservation({
        ...legacy,
        binding: { ...legacy.binding, cartItemReference: line },
      }),
    ).toThrow(expect.objectContaining({ code: "INVENTORY_RESERVATION_INVALID" }));
    const lined = createInventoryReservation(perLine());
    const withoutLine: Record<string, unknown> = { ...lined.binding };
    delete withoutLine.cartItemReference;
    expect(() => parseInventoryReservation({ ...lined, binding: withoutLine })).toThrow(
      expect.objectContaining({ code: "INVENTORY_RESERVATION_INVALID" }),
    );
  });
  it("rejects a transition that changes the bound Order line", () => {
    const reserved = createInventoryReservation(perLine());
    expect(() =>
      advanceInventoryReservation(reserved, {
        reservationReference: id(1),
        binding: { ...reserved.binding, cartItemReference: id(31) },
        expectedVersion: 1,
        action: "Consume",
        quantity: "0.1",
        occurredAt: next,
      }),
    ).toThrow(expect.objectContaining({ code: "INVENTORY_RESERVATION_BINDING_MISMATCH" }));
  });
});
