import { expect, it } from "vitest";
import { allocateOrdinaryRefund } from "../domain/ordinary-refund-allocation.js";
const id = (n: number) => "01909981-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  return {
    sourceReference: id(1),
    sourceDigest: "sha256:" + "a".repeat(64),
    currencyCode: "CAD",
    tipAmountMinor: 5n,
    serviceChargeAmountMinor: 7n,
    serviceChargeTaxAmountMinor: 1n,
    items: [
      {
        orderItemReference: id(2),
        quantity: 3,
        netAmountMinor: 100n,
        taxAmountMinor: 13n,
        occupiedUnitOrdinals: [] as number[],
        refundQuantity: 3,
      },
      {
        orderItemReference: id(3),
        quantity: 2,
        netAmountMinor: 50n,
        taxAmountMinor: 7n,
        occupiedUnitOrdinals: [] as number[],
        refundQuantity: 2,
      },
    ],
  };
}
it("conserves original components across unit partials and full remainder", () => {
  const f = fixture();
  const full = allocateOrdinaryRefund(f);
  expect(full.amountMinor).toBe(183n);
  const totals = new Map<string, bigint>();
  for (let round = 0; round < 3; round++) {
    const partial = allocateOrdinaryRefund({
      ...f,
      items: f.items.map((item) => ({
        ...item,
        occupiedUnitOrdinals: Array.from(
          { length: Math.min(round, item.quantity) },
          (_, index) => index + 1,
        ),
        refundQuantity: round < item.quantity ? 1 : 0,
      })),
    });
    for (const item of partial.items)
      totals.set(
        item.orderItemReference,
        (totals.get(item.orderItemReference) ?? 0n) + item.amountMinor,
      );
  }
  for (const item of full.items) expect(totals.get(item.orderItemReference)).toBe(item.amountMinor);
});
it("keeps original weights and tie ordering independent of input order", () => {
  const f = fixture();
  expect(allocateOrdinaryRefund({ ...f, items: [...f.items].reverse() })).toEqual(
    allocateOrdinaryRefund(f),
  );
});
it("handles zero-net lines and all-zero-net quantity fallback deterministically", () => {
  const f = fixture();
  f.items = f.items.map((item) => ({ ...item, netAmountMinor: 0n, taxAmountMinor: 0n }));
  const result = allocateOrdinaryRefund(f);
  expect(result.zeroNetWeighting).toBe("Quantity");
  expect(result.amountMinor).toBe(13n);
  const zero = allocateOrdinaryRefund({
    ...f,
    tipAmountMinor: 0n,
    serviceChargeAmountMinor: 0n,
    serviceChargeTaxAmountMinor: 0n,
  });
  expect(zero.amountMinor).toBe(0n);
  const mixed = fixture();
  mixed.items = mixed.items.map((item, index) =>
    index === 0 ? { ...item, netAmountMinor: 0n, taxAmountMinor: 0n } : item,
  );
  expect(allocateOrdinaryRefund(mixed).items[0]?.amountMinor).toBe(0n);
});
it.each([-1, 0.5, 4])("rejects invalid/excess quantity %s", (refundQuantity) => {
  const f = fixture();
  f.items = f.items.map((item) => ({ ...item, refundQuantity }));
  expect(() => allocateOrdinaryRefund(f)).toThrow();
});
it("rejects duplicate lines, negative money and non-CAD input", () => {
  const f = fixture();
  expect(() => allocateOrdinaryRefund({ ...f, items: [...f.items, ...f.items] })).toThrow();
  expect(() => allocateOrdinaryRefund({ ...f, tipAmountMinor: -1n })).toThrow();
  expect(() => allocateOrdinaryRefund({ ...f, currencyCode: "USD" })).toThrow();
});
it("allocates only the unoccupied remainder without losing fractional cents", () => {
  const f = fixture();
  const first = allocateOrdinaryRefund({
    ...f,
    items: f.items.map((item) => ({ ...item, refundQuantity: 1 })),
  });
  const rest = allocateOrdinaryRefund({
    ...f,
    items: f.items.map((item) => ({
      ...item,
      occupiedUnitOrdinals: [1],
      refundQuantity: item.quantity - 1,
    })),
  });
  expect(first.amountMinor + rest.amountMinor).toBe(allocateOrdinaryRefund(f).amountMinor);
});

it("reclaims an early released unit without shifting cents from later occupied units", () => {
  const f = fixture();
  const line = f.items[0];
  if (!line) throw new Error("fixture");
  const original = {
    ...f,
    tipAmountMinor: 0n,
    serviceChargeAmountMinor: 0n,
    serviceChargeTaxAmountMinor: 0n,
    items: [{ ...line, netAmountMinor: 2n, taxAmountMinor: 1n, refundQuantity: 1 }],
  };
  const later = allocateOrdinaryRefund({
    ...original,
    items: [{ ...original.items[0], occupiedUnitOrdinals: [1] }],
  });
  expect(later.items[0]?.refundUnitOrdinals).toEqual([2]);
  const reclaimed = allocateOrdinaryRefund({
    ...original,
    items: [{ ...original.items[0], occupiedUnitOrdinals: [2] }],
  });
  expect(reclaimed.items[0]?.refundUnitOrdinals).toEqual([1]);
  expect(reclaimed.amountMinor).toBe(0n);
  const last = allocateOrdinaryRefund({
    ...original,
    items: [{ ...original.items[0], occupiedUnitOrdinals: [1, 2] }],
  });
  expect(last.items[0]?.refundUnitOrdinals).toEqual([3]);
  expect(later.amountMinor + reclaimed.amountMinor + last.amountMinor).toBe(3n);
});
it.each([[1, 1], [0], [4], [1.5]].map((occupiedUnitOrdinals) => ({ occupiedUnitOrdinals })))(
  "rejects invalid occupied positions %j",
  ({ occupiedUnitOrdinals }) => {
    const f = fixture();
    f.items = f.items.map((item) => ({ ...item, occupiedUnitOrdinals, refundQuantity: 1 }));
    expect(() => allocateOrdinaryRefund(f)).toThrow();
  },
);
