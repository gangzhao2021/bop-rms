import { describe, expect, it } from "vitest";
import {
  createOrderItemSnapshots,
  encodeOrderItemSnapshot,
  decodeOrderItemSnapshot,
  OrderItemSnapshotCodecError,
} from "../index.js";
import { orderSnapshotInput } from "./order-item-snapshot.fixture.js";
function snapshot() {
  const item = createOrderItemSnapshots(orderSnapshotInput())[0];
  if (item === undefined) throw new Error("fixture");
  return item;
}
describe("Order Item JSONB snapshot representation", () => {
  it("roundtrips all original immutable fields with decimal money strings", () => {
    const original = snapshot();
    const encoded = encodeOrderItemSnapshot(original);
    const wire = JSON.parse(encoded);
    expect(wire.pricing.total.amountMinor).toBe("2260");
    const decoded = decodeOrderItemSnapshot(wire);
    expect(decoded).toEqual(original);
    expect(Object.isFrozen(decoded.pricing.taxComponents)).toBe(true);
  });
  it("preserves monetary precision above Number.MAX_SAFE_INTEGER", () => {
    const original = snapshot();
    const fee = 9007199254740993n;
    const large = {
      ...original,
      pricing: {
        ...original.pricing,
        fee: { amountMinor: fee, currencyCode: "CAD" },
        total: { amountMinor: fee + 2260n, currencyCode: "CAD" },
      },
    };
    const encoded = encodeOrderItemSnapshot(large);
    expect(encoded).toContain('"amountMinor":"9007199254740993"');
    expect(decodeOrderItemSnapshot(JSON.parse(encoded)).pricing.fee.amountMinor).toBe(fee);
  });
  it.each([1130, "01", "+1", "1e3", "-0", "9223372036854775808", "-9223372036854775809", null])(
    "rejects invalid money representation %j",
    (value) => {
      const wire = JSON.parse(encodeOrderItemSnapshot(snapshot()));
      wire.pricing.fee.amountMinor = value;
      expect(() => decodeOrderItemSnapshot(wire)).toThrow(OrderItemSnapshotCodecError);
    },
  );
  it.each(["getter", "toJSON", "sparse", "iterator", "cycle", "extra", "oversize"])(
    "rejects executable or malformed %s without invoking hooks",
    (kind) => {
      const original = snapshot();
      let executed = 0;
      const value = { ...original };
      if (kind === "getter")
        Object.defineProperty(value, "pricing", {
          enumerable: true,
          get() {
            executed++;
            return original.pricing;
          },
        });
      if (kind === "toJSON")
        Object.assign(value, {
          toJSON() {
            executed++;
            return {};
          },
        });
      if (kind === "sparse")
        Object.assign(value, { pricing: { ...original.pricing, taxComponents: new Array(1) } });
      if (kind === "iterator") {
        const options = [...original.catalog.options];
        Object.defineProperty(options, Symbol.iterator, {
          value() {
            executed++;
            return [][Symbol.iterator]();
          },
        });
        Object.assign(value, { catalog: { ...original.catalog, options } });
      }
      if (kind === "cycle") Object.assign(value, { customerNote: value });
      if (kind === "extra") Object.assign(value, { extra: true });
      if (kind === "oversize")
        Object.assign(value, { customerNote: "x".repeat(16 * 1024 * 1024 + 1) });
      expect(() => encodeOrderItemSnapshot(value)).toThrow(OrderItemSnapshotCodecError);
      expect(executed).toBe(0);
    },
  );
  it("does not reconstruct a legacy partial snapshot", () => {
    expect(() =>
      decodeOrderItemSnapshot({
        catalog: {},
        pricing: { total: { amountMinor: "1", currencyCode: "CAD" } },
      }),
    ).toThrow(OrderItemSnapshotCodecError);
  });
  it("requires parsed JSONB and never accepts bigint in wire input", () => {
    expect(() => decodeOrderItemSnapshot(encodeOrderItemSnapshot(snapshot()))).toThrow(
      OrderItemSnapshotCodecError,
    );
    expect(() => decodeOrderItemSnapshot(snapshot())).toThrow(OrderItemSnapshotCodecError);
  });
});
