import { expect, it, vi } from "vitest";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import { parseCheckoutSession } from "@rms/ordering";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { finalValidationFixture } from "../../../packages/rms/inventory/src/tests/submission-final-validation.fixture.js";
import {
  refs,
  harness,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
import { createCustomerSessionPaymentIntent } from "./customer-session-payment-intent.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
const read = vi.hoisted(() => vi.fn());
vi.mock("./customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read }),
}));
async function fixture() {
  const at = "2026-08-03T15:00:00.000Z";
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
    capacityExpiresAt: "2026-08-03T15:30:00.000Z",
  };
  const original = finalValidationFixture();
  const replacements = new Map<string, string>([
    [original.observedAt, at],
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

async function assembled(missingInventory = false) {
  const original = await fixture();
  const o = original.value.order,
    b = o.batch;
  const replacements = new Map<string, string>([
    [o.brandReference, refs.brand],
    [o.storeReference, refs.store],
    [o.orderReference, refs.order],
    [b.orderBatchReference, refs.batch],
    [b.submissionReference, refs.submission],
    [b.sourceCartReference, refs.cart],
    [b.quoteReference, refs.quote],
    [o.guestSessionReference, refs.session],
    [original.value.capacity.paymentOperationReference, refs.operation],
  ]);
  function map(value: unknown): unknown {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(map);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, map(child)]));
    return value;
  }
  const f = map(original) as typeof original,
    at = f.value.capacity.paymentRequestedAt;
  const binding = {
    brandReference: refs.brand,
    storeReference: refs.store,
    cartReference: refs.cart,
    cartVersion: b.sourceCartVersion,
    quoteReference: refs.quote,
    orderType: "DineIn",
    sourceChannel: "Qr",
  };
  const session = parseCheckoutSession({
    schemaVersion: 1,
    checkoutSessionReference: id(951),
    createOperationReference: id(952),
    submissionReference: refs.submission,
    paymentOperationReference: refs.operation,
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(953),
      validationIntentHash: "sha256:" + "a".repeat(64),
      guestSessionReference: refs.session,
      quoteVersion: 1,
      quoteInputDigest: "sha256:" + "b".repeat(64),
      catalogLines: [
        {
          cartItemReference: id(954),
          sellableReference: id(955),
          menuVersionReference: id(956),
          productVersionReference: id(957),
          validatedAt: at,
        },
      ],
      fulfillment: {
        ...binding,
        status: "Accepted",
        evidenceReference: id(958),
        evidenceVersion: 1,
        evidenceDigest: "sha256:" + "c".repeat(64),
        checkedAt: at,
        validUntil: "2026-08-03T15:05:00.000Z",
      },
      validatedAt: at,
      validUntil: "2026-08-03T15:05:00.000Z",
    },
  });
  read.mockReset().mockResolvedValue(session);
  const h = harness(),
    steps: string[] = [];
  const service = createCustomerSessionPaymentIntent({
    submissionKind: "Additional",
    access: { scope: f.options.scope } as unknown as CustomerCheckoutSessionAuthorizationOptions,
    tenantReference: f.options.scope.tenantReference,
    tips: {
      select: async () => {
        steps.push("tip");
        return { status: "Created", record: f.value.selection, session };
      },
    },
    orders: {
      create: async () => {
        steps.push("submit");
        return { status: "Created", record: f.value.order, session };
      },
      preparePaymentClock: async () => {
        steps.push("clock");
        return { order: f.value.order, clock: f.value.capacity, session };
      },
    },
    inventory: { load: async () => (missingInventory ? null : f.value.inventory) },
    history: h.ports.repository,
    nextPreparationReference: () => f.value.preparationReference,
    payment: () => h.ports,
  });
  return {
    service,
    f,
    h,
    steps,
    input: {
      sessionCredential: "s".repeat(43),
      csrfCredential: "c".repeat(43),
      checkoutSessionReference: session.checkoutSessionReference,
      selectionReference: f.value.selection.selectionReference,
      tip: f.value.selection.tip,
    },
  };
}
it("creates Payment using actual additional amount/Inventory/clock snapshot and recovers without duplicate Provider", async () => {
  const f = await assembled();
  const result = await f.service.create(f.input);
  expect(f.steps).toEqual(["tip", "submit", "clock"]);
  const amount =
    f.f.value.order.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n) +
    f.f.value.selection.tip.amountMinor;
  expect(result.record.intent.preparation.total.amountMinor).toBe(amount);
  expect(result.record.intent.preparation.committedAt).toBe(f.f.value.capacity.paymentRequestedAt);
  expect(f.h.providerCalls()).toBe(1);
  const recovered = await f.service.create(f.input);
  expect(recovered.record).toEqual(result.record);
  expect(f.steps).toEqual(["tip", "submit", "clock"]);
  expect(f.h.providerCalls()).toBe(1);
});
it("rejects missing actual Inventory evidence before calling Provider", async () => {
  const f = await assembled(true);
  await expect(f.service.create(f.input)).rejects.toThrow();
  expect(f.h.providerCalls()).toBe(0);
});
