import { expect, it, vi } from "vitest";
import { parseAdditionalDiningBatchSnapshot, parseCheckoutSession } from "@rms/ordering";
import { createPaymentIntentCreationService } from "@rms/payment";
import { createCustomerPersistentAdditionalDiningPayment } from "./customer-persistent-additional-dining-payment.js";
import { fixture as diningFixture } from "../test-support/dining-order-submission-fixture.js";
import { orderWriteFixture } from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import {
  at,
  id,
  refs,
  harness,
  command,
  preparation,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
const mocks = vi.hoisted(() => ({ read: vi.fn(), history: vi.fn(), unexpected: vi.fn() }));
vi.mock("./customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read: mocks.read }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresAdditionalDiningBatchHistoryReader: () => ({
    resolveSubmission: mocks.history,
    resolveCapacityLink: mocks.unexpected,
  }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: () => ({ loadSubmission: mocks.unexpected }),
}));
async function fixture(denied = false) {
  mocks.read.mockReset();
  mocks.history.mockReset();
  mocks.unexpected.mockReset();
  mocks.unexpected.mockImplementation(() => {
    throw new Error("recovery must not prepare");
  });
  const f = orderWriteFixture({ dineIn: true, at }),
    r = f.request.record,
    b = r.order.batches[0];
  const replacements = new Map<string, string>([
    [r.order.brandReference, refs.brand],
    [r.order.storeReference, refs.store],
    [r.order.orderReference, refs.order],
    [b.orderBatchReference, refs.batch],
    [r.submissionReference, refs.submission],
    [b.sourceCartReference, refs.cart],
    [b.quoteReference, refs.quote],
    [r.guestSessionReference, refs.session],
  ]);
  function map(value: unknown): unknown {
    if (typeof value === "string") return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(map);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, map(child)]));
    return value;
  }
  const snapshot = parseAdditionalDiningBatchSnapshot(
    map({
      orderReference: r.order.orderReference,
      brandReference: r.order.brandReference,
      storeReference: r.order.storeReference,
      diningSessionReference: r.order.diningSessionReference,
      guestSessionReference: r.guestSessionReference,
      originalOrderCreatedAt: at,
      expectedOrderVersion: 2,
      batchSequence: 2,
      snapshotVersion: 1,
      batch: b,
      items: r.items,
    }),
  );
  const session = parseCheckoutSession({
    schemaVersion: 1,
    checkoutSessionReference: id(31),
    createOperationReference: id(32),
    submissionReference: refs.submission,
    paymentOperationReference: refs.operation,
    validation: map(f.request.checkoutValidationEvidence),
    createdAt: at,
  });
  const original = await createPaymentIntentCreationService(
    harness({
      prepared: preparation({ committedAt: at, sourceCartVersion: b.sourceCartVersion }),
    }).ports,
  ).create(command({ tipSelectionReference: id(30), expectedCartVersion: b.sourceCartVersion }));
  const h = harness({ prior: original.record, denied, clockNow: "2026-08-03T17:00:00.000Z" });
  mocks.read.mockResolvedValue(session);
  mocks.history.mockResolvedValue(snapshot);
  const scope = { brandReference: refs.brand, storeReference: refs.store };
  const tenantScope = { ...scope, tenantReference: id(40) };
  const prep = {
    ...diningFixture().options,
    scope,
    now: () => "2026-08-03T17:00:00.000Z",
    submissions: { loadSubmission: mocks.unexpected },
    references: { generate: mocks.unexpected },
  };
  const options = {
    targetOrderReference: refs.order,
    submission: {
      access: { scope },
      runtime: {
        ...scope,
        inventory: { scope: tenantScope },
        transactions: { run: mocks.unexpected },
        identity: () => prep,
      },
      source: { scope, clock: { now: prep.now } },
      historyAuthorization: mocks.unexpected,
      nextItemReference: mocks.unexpected,
    },
    tip: { preparation: prep, authorizeOrder: mocks.unexpected, tip: { audit: mocks.unexpected } },
    payment: {
      inventory: { load: mocks.unexpected },
      history: h.ports.repository,
      nextPreparationReference: mocks.unexpected,
      payment: () => h.ports,
    },
  } as unknown as Parameters<typeof createCustomerPersistentAdditionalDiningPayment>[0];
  return {
    service: createCustomerPersistentAdditionalDiningPayment(options),
    h,
    original,
    input: {
      sessionCredential: "s".repeat(43),
      csrfCredential: "c".repeat(43),
      checkoutSessionReference: session.checkoutSessionReference,
      selectionReference: id(30),
      tip: { amountMinor: 200n, currencyCode: "CAD" },
    },
  };
}
it("recovers through real session/parent/Payment adapters after expiry with no new preparation or Provider call", async () => {
  const f = await fixture();
  const result = await f.service.create(f.input);
  expect(result.status).toBe("AlreadyCreated");
  expect(result.record).toEqual(f.original.record);
  expect(f.h.providerCalls()).toBe(0);
  expect(mocks.unexpected).not.toHaveBeenCalled();
});
it("preserves current Payment authorization on the fully assembled recovery path", async () => {
  const f = await fixture(true);
  await expect(f.service.create(f.input)).rejects.toMatchObject({
    code: "PAYMENT_INTENT_PERMISSION_DENIED",
  });
  expect(f.h.providerCalls()).toBe(0);
  expect(mocks.unexpected).not.toHaveBeenCalled();
});
