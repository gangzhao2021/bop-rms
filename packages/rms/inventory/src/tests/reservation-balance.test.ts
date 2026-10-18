import { describe, expect, it } from "vitest";
import { calculateReservationBalance } from "../domain/reservation-balance.js";

const input = () => ({
  action: "Reserve",
  quantity: "0.1",
  unit: {
    unitCode: "KG",
    dimension: "Mass",
    displayPrecision: 2,
    ledgerPrecision: 6,
    roundingMode: "HalfEven",
  },
  before: {
    onHand: "0.3",
    reserved: "0",
    available: "0.3",
    inTransit: "2",
    unitCode: "KG",
    ledgerVersion: 1,
  },
  expectedVersion: 1,
  negativeStockPolicy: "Block",
});
describe("reservation balance arithmetic", () => {
  it("reserves, releases and consumes exact base quantities without losing fractions", () => {
    const first = calculateReservationBalance(input());
    const second = calculateReservationBalance({
      ...input(),
      before: first.after,
      expectedVersion: 2,
      quantity: "0.2",
    });
    expect(second.after).toMatchObject({
      onHand: "0.3",
      reserved: "0.3",
      available: "0",
      inTransit: "2",
    });
    const released = calculateReservationBalance({
      ...input(),
      action: "Release",
      before: second.after,
      expectedVersion: 3,
      quantity: "0.1",
    });
    expect(released.after).toMatchObject({ onHand: "0.3", reserved: "0.2", available: "0.1" });
    const consumed = calculateReservationBalance({
      ...input(),
      action: "ConsumeReserved",
      before: released.after,
      expectedVersion: 4,
      quantity: "0.2",
    });
    expect(consumed.after).toMatchObject({
      onHand: "0.1",
      reserved: "0",
      available: "0.1",
      ledgerVersion: 5,
    });
    expect(consumed.requiredControl).toBe("None");
    expect(first.before.reserved).toBe("0");
    expect(Object.isFrozen(first.after)).toBe(true);
    expect(Object.isFrozen(first.before)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });
  it("consumes unreserved stock without releasing a different reservation", () => {
    const result = calculateReservationBalance({
      ...input(),
      action: "ConsumeUnreserved",
      before: { ...input().before, reserved: "0.2", available: "0.1" },
    });
    expect(result.after).toMatchObject({ onHand: "0.2", reserved: "0.2", available: "0" });
  });
  it("keeps quantities above binary floating-point integer precision exact", () => {
    const result = calculateReservationBalance({
      ...input(),
      quantity: "0.000001",
      before: {
        ...input().before,
        onHand: "9007199254740993.000001",
        available: "9007199254740993.000001",
      },
    });
    expect(result.after.available).toBe("9007199254740993");
  });
  it.each([
    ["Block", "Block"],
    ["ManagerOverride", "ManagerOverrideAndExceptionRequired"],
    ["AllowWithWarning", "ExceptionRequired"],
  ])("requires explicit %s controls for insufficient stock", (policy, control) => {
    for (const action of ["Reserve", "ConsumeUnreserved"]) {
      const result = calculateReservationBalance({
        ...input(),
        action,
        quantity: "0.4",
        negativeStockPolicy: policy,
      });
      expect(result.requiredControl).toBe(control);
      expect(result.after.available).toBe("-0.1");
    }
  });
  it.each(["Release", "ConsumeReserved"])(
    "cannot %s another quantity beyond reserved balance",
    (action) => {
      expect(() => calculateReservationBalance({ ...input(), action })).toThrowError(
        expect.objectContaining({ code: "INVENTORY_RESERVATION_QUANTITY_EXCEEDED" }),
      );
    },
  );
  it("rejects a stale expected balance version", () => {
    expect(() => calculateReservationBalance({ ...input(), expectedVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "INVENTORY_BALANCE_CONFLICT" }),
    );
  });
  it.each(["0", "-0", "-0.000000", "-1", "0.0000001", "1e3", " 1", "01", 0.1, null])(
    "rejects invalid quantity %s without rounding",
    (quantity) => {
      expect(() => calculateReservationBalance({ ...input(), quantity })).toThrow();
    },
  );
  it("requires the configured ledger precision for every balance and delta", () => {
    expect(() =>
      calculateReservationBalance({ ...input(), unit: { ...input().unit, ledgerPrecision: 0 } }),
    ).toThrow();
    expect(() =>
      calculateReservationBalance({
        ...input(),
        quantity: "1",
        unit: { ...input().unit, ledgerPrecision: 0 },
      }),
    ).toThrow();
  });
  it.each([
    { available: "5" },
    { reserved: "-1" },
    { inTransit: "-1" },
    { unitCode: "G" },
    { ledgerVersion: Number.MAX_SAFE_INTEGER },
  ])("refuses inconsistent or unrepresentable balance %s", (change) => {
    expect(() =>
      calculateReservationBalance({ ...input(), before: { ...input().before, ...change } }),
    ).toThrow();
  });
  it("does not infer a policy or accept an override flag", () => {
    expect(() =>
      calculateReservationBalance({ ...input(), negativeStockPolicy: undefined }),
    ).toThrow();
    expect(() => calculateReservationBalance({ ...input(), overrideAuthorized: true })).toThrow();
  });
  it("does not invoke accessor input", () => {
    const value = input();
    Object.defineProperty(value, "quantity", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    expect(() => calculateReservationBalance(value)).toThrowError(
      expect.objectContaining({ code: "INVENTORY_BALANCE_INVALID" }),
    );
  });
});
