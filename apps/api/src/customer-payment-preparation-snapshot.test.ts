import { parseDiningCheckoutCommitment } from "@rms/dining";
import { expect, it } from "vitest";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { finalValidationFixture } from "../../../packages/rms/inventory/src/tests/submission-final-validation.fixture.js";
import { buildCustomerPaymentPreparationSnapshot } from "./customer-payment-preparation-snapshot.js";
async function fixture() {
  const at = "2026-09-11T10:00:00.000Z";
  const f = orderSubmissionFixture(at);
  const r = (await f.orderService().create(f.orderInput)).record;
  const b = r.order.batches[0];
  const prepared = await f.options.preparation.submissions.loadSubmission(r.submissionReference);
  if (!prepared) throw new Error("missing synthetic commitment");
  const capacity = {
    ...parseDiningCheckoutCommitment(prepared),
    state: "PaymentPending",
    orderingLinkedAt: at,
    paymentRequestedAt: at,
    capacityExpiresAt: "2026-09-11T10:30:00.000Z",
  };
  const original = finalValidationFixture();
  const replacements = new Map<string, string>([
    [original.tenantReference, r.order.brandReference],
    [original.brandReference, r.order.brandReference],
    [original.storeReference, r.order.storeReference],
    [original.orderReference, r.order.orderReference],
    [original.submissionReference, r.submissionReference],
    [original.cartReference, b.sourceCartReference],
    [original.quoteReference, b.quoteReference],
    [original.actorReference, r.guestSessionReference],
  ]);
  const inventory: unknown = JSON.parse(
    JSON.stringify(original, (key, value: unknown) =>
      key === "cartVersion"
        ? b.sourceCartVersion
        : typeof value === "string"
          ? (replacements.get(value) ?? value)
          : value,
    ),
  );
  const order = {
    orderReference: r.order.orderReference,
    brandReference: r.order.brandReference,
    storeReference: r.order.storeReference,
    diningSessionReference: r.order.diningSessionReference,
    guestSessionReference: r.guestSessionReference,
    originalOrderCreatedAt: r.createdAt,
    expectedOrderVersion: 1,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: b,
    items: r.items,
  };
  return {
    options: {
      scope: {
        tenantReference: r.order.brandReference,
        brandReference: r.order.brandReference,
        storeReference: r.order.storeReference,
      },
      owner: "Dining" as const,
      quoteVersion: 1 as const,
      submissionKind: "Additional" as const,
    },
    value: {
      preparationReference: id(901),
      order,
      capacity,
      inventory,
      selection: {
        selectionReference: id(902),
        paymentOperationReference: capacity.paymentOperationReference,
        submissionReference: r.submissionReference,
        cartReference: b.sourceCartReference,
        cartVersion: b.sourceCartVersion,
        quoteReference: b.quoteReference,
        guestSessionReference: r.guestSessionReference,
        brandReference: r.order.brandReference,
        storeReference: r.order.storeReference,
        tip: { amountMinor: 100n, currencyCode: "CAD" },
        selectedAt: at,
      },
    },
  };
}
it("preserves the persisted additional payment clock exactly on repeated snapshot builds", async () => {
  const f = await fixture();
  const result = buildCustomerPaymentPreparationSnapshot(f.options, f.value);
  expect(result.committedAt).toBe(f.value.capacity.paymentRequestedAt);
  expect(result.capacityExpiresAt).toBe(f.value.capacity.capacityExpiresAt);
  expect(buildCustomerPaymentPreparationSnapshot(f.options, f.value)).toEqual(result);
});
it("rejects a tip selected after the already-started batch clock", async () => {
  const f = await fixture();
  expect(() =>
    buildCustomerPaymentPreparationSnapshot(f.options, {
      ...f.value,
      selection: { ...f.value.selection, selectedAt: "2026-09-11T10:00:01.000Z" },
    }),
  ).toThrow();
});
it("rejects another capacity Batch and missing inventory", async () => {
  const f = await fixture();
  expect(() =>
    buildCustomerPaymentPreparationSnapshot(f.options, {
      ...f.value,
      capacity: { ...f.value.capacity, orderBatchReference: id(999) },
    }),
  ).toThrow();
  expect(() =>
    buildCustomerPaymentPreparationSnapshot(f.options, { ...f.value, inventory: null }),
  ).toThrow();
});

it("does not turn recoverable expired clock history into new payment preparation", async () => {
  const f = await fixture();
  expect(() =>
    buildCustomerPaymentPreparationSnapshot(f.options, {
      ...f.value,
      capacity: { ...f.value.capacity, state: "Expired" },
    }),
  ).toThrow();
});
