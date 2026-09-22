import { expect, it } from "vitest";
import {
  deriveAdditionalPaymentPreparationAmounts,
  derivePaymentPreparationAmounts,
  derivePaymentReceiptAmounts,
} from "@rms/payment";
import { orderSubmissionFixture } from "../test-support/dining-order-submission-fixture.js";
const source = orderSubmissionFixture();
const originalOrder = (await source.orderService().create(source.orderInput)).record;
function fixture() {
  const record = originalOrder;
  const batch = record.order.batches[0];
  const operation = record.order.orderReference.slice(0, -12) + "000000000900";
  return {
    order: record,
    selection: {
      selectionReference: record.order.orderReference.slice(0, -12) + "000000000901",
      paymentOperationReference: operation,
      submissionReference: record.submissionReference,
      cartReference: batch.sourceCartReference,
      cartVersion: batch.sourceCartVersion,
      quoteReference: batch.quoteReference,
      guestSessionReference: record.guestSessionReference,
      brandReference: record.order.brandReference,
      storeReference: record.order.storeReference,
      tip: { amountMinor: 175n, currencyCode: "CAD" },
      selectedAt: record.createdAt,
    },
    paymentOperationReference: operation,
    requestedAt: record.createdAt,
  };
}
it("derives payable allocation from original immutable line totals plus explicit tip", () => {
  const f = fixture(),
    amounts = derivePaymentPreparationAmounts(f);
  const original = f.order.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
  expect(amounts.orderAllocation.amountMinor).toBe(original);
  expect(amounts.total.amountMinor).toBe(original + 175n);
  expect(Object.isFrozen(amounts)).toBe(true);
  expect(
    derivePaymentPreparationAmounts({
      ...f,
      selection: {
        ...f.selection,
        tip: { amountMinor: 0n, currencyCode: "CAD" },
      },
    }).total.amountMinor,
  ).toBe(original);
});
it.each([
  "paymentOperationReference",
  "submissionReference",
  "guestSessionReference",
  "brandReference",
  "storeReference",
  "cartReference",
  "quoteReference",
])("rejects a foreign tip %s", (field) => {
  const f = fixture();
  expect(() =>
    derivePaymentPreparationAmounts({
      ...f,
      selection: {
        ...f.selection,
        [field]: f.paymentOperationReference.slice(0, -12) + "000000000999",
      },
    }),
  ).toThrow();
});
it("rejects another Cart version and missing selection", () => {
  const f = fixture();
  expect(() =>
    derivePaymentPreparationAmounts({
      ...f,
      selection: { ...f.selection, cartVersion: f.selection.cartVersion + 1 },
    }),
  ).toThrow();
  expect(() => derivePaymentPreparationAmounts({ ...f, selection: null })).toThrow();
});
it("does not attach a later choice or Order to an earlier original Payment instant", () => {
  const f = fixture();
  const earlier = new Date(Date.parse(f.requestedAt) - 1000).toISOString();
  const later = new Date(Date.parse(f.requestedAt) + 1000).toISOString();
  expect(() => derivePaymentPreparationAmounts({ ...f, requestedAt: earlier })).toThrow();
  expect(() =>
    derivePaymentPreparationAmounts({ ...f, selection: { ...f.selection, selectedAt: later } }),
  ).toThrow();
});
it("rejects a total outside the persisted bigint range without rounding", () => {
  const f = fixture();
  expect(() =>
    derivePaymentPreparationAmounts({
      ...f,
      selection: {
        ...f.selection,
        tip: { amountMinor: 9223372036854775807n, currencyCode: "CAD" },
      },
    }),
  ).toThrow();
});
it("does not accept a replacement current total or invoke an input getter", () => {
  const f = fixture();
  expect(() =>
    derivePaymentPreparationAmounts({ ...f, total: { amountMinor: 1n, currencyCode: "CAD" } }),
  ).toThrow();
  let read = false;
  Object.defineProperty(f, "selection", {
    enumerable: true,
    get() {
      read = true;
      return null;
    },
  });
  expect(() => derivePaymentPreparationAmounts(f)).toThrow();
  expect(read).toBe(false);
});

it("preserves actual frozen receipt components including discount and fee", () => {
  const f = fixture();
  const first = f.order.items[0];
  if (!first) throw new Error("missing synthetic line");
  const adjusted = {
    ...f,
    order: {
      ...f.order,
      items: [
        {
          ...first,
          pricing: {
            ...first.pricing,
            discount: { amountMinor: 100n, currencyCode: "CAD" },
            fee: { amountMinor: 25n, currencyCode: "CAD" },
            total: { amountMinor: first.pricing.total.amountMinor - 75n, currencyCode: "CAD" },
          },
        },
        ...f.order.items.slice(1),
      ],
    },
  };
  const amounts = derivePaymentReceiptAmounts(adjusted, 1);
  expect(amounts.discount.amountMinor).toBe(100n);
  expect(amounts.fee.amountMinor).toBe(25n);
  expect(amounts.tax.amountMinor).toBe(derivePaymentReceiptAmounts(f, 1).tax.amountMinor);
  expect(amounts.total.amountMinor).toBe(
    derivePaymentPreparationAmounts(f).total.amountMinor - 75n,
  );
  expect(amounts.tip.amountMinor).toBe(175n);
  expect(Object.hasOwn(amounts, "paymentStatus")).toBe(false);
});
it("receipt monetary history requires the original bound tip and rejects source replacement", () => {
  const f = fixture();
  expect(() =>
    derivePaymentReceiptAmounts(
      { ...f, selection: { ...f.selection, cartVersion: f.selection.cartVersion + 1 } },
      1,
    ),
  ).toThrow();
  expect(() => derivePaymentReceiptAmounts({ ...f, total: 1n }, 1)).toThrow();
  expect(derivePaymentReceiptAmounts(f, 1).total).toEqual(derivePaymentPreparationAmounts(f).total);
});

function additionalAmountsFixture() {
  const f = fixture();
  const r = f.order;
  return {
    submission: {
      orderReference: r.order.orderReference,
      brandReference: r.order.brandReference,
      storeReference: r.order.storeReference,
      diningSessionReference: r.order.diningSessionReference,
      guestSessionReference: r.guestSessionReference,
      originalOrderCreatedAt: r.createdAt,
      expectedOrderVersion: 3,
      batchSequence: 2,
      snapshotVersion: 1,
      batch: r.order.batches[0],
      items: r.items,
    },
    selection: f.selection,
    paymentOperationReference: f.paymentOperationReference,
    requestedAt: f.requestedAt,
  };
}
it("derives only additional submission item totals and its own selected tip", () => {
  const f = additionalAmountsFixture();
  const amounts = deriveAdditionalPaymentPreparationAmounts(f);
  expect(amounts.total.amountMinor).toBe(
    f.submission.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n) +
      f.selection.tip.amountMinor,
  );
});
it.each(["submissionReference", "quoteReference", "paymentOperationReference"])(
  "rejects additional tip selection from another %s",
  (field) => {
    const f = additionalAmountsFixture();
    expect(() =>
      deriveAdditionalPaymentPreparationAmounts({
        ...f,
        selection: {
          ...f.selection,
          [field]: f.paymentOperationReference.slice(0, -12) + "000000000999",
        },
      }),
    ).toThrow();
  },
);
it("rejects additional amount before batch submission or outside bigint range", () => {
  const f = additionalAmountsFixture();
  expect(() =>
    deriveAdditionalPaymentPreparationAmounts({
      ...f,
      requestedAt: new Date(Date.parse(f.requestedAt) - 1).toISOString(),
    }),
  ).toThrow();
  expect(() =>
    deriveAdditionalPaymentPreparationAmounts({
      ...f,
      selection: {
        ...f.selection,
        tip: { amountMinor: 9223372036854775807n, currencyCode: "CAD" },
      },
    }),
  ).toThrow();
});
