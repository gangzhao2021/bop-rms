import { expect, it, vi } from "vitest";
import { parseCheckoutSession } from "@rms/ordering";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import type { ConsumerTransaction } from "@bop/eventing";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";
import { createCustomerAdditionalDiningSessionClock } from "./customer-additional-dining-session-clock.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), order: vi.fn(), link: vi.fn(), clock: vi.fn() }));
vi.mock("./customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read: mocks.read }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresAdditionalDiningBatchHistoryReader: () => ({
    resolveSubmission: mocks.order,
    resolveCapacityLink: mocks.link,
  }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: () => ({ loadSubmission: mocks.clock }),
}));
async function fixture() {
  const at = "2026-09-11T10:00:00.000Z";
  const f = orderSubmissionFixture(at);
  const r = (await f.orderService().create(f.orderInput)).record;
  const b = r.order.batches[0];
  const prepared = parseDiningCheckoutCommitment(
    await f.options.preparation.submissions.loadSubmission(r.submissionReference),
  );
  const clock = parseDiningCheckoutCommitment({
    ...prepared,
    state: "PaymentPending",
    orderingLinkedAt: at,
    paymentRequestedAt: at,
    capacityExpiresAt: "2026-09-11T10:30:00.000Z",
  });
  const binding = {
    brandReference: r.order.brandReference,
    storeReference: r.order.storeReference,
    cartReference: b.sourceCartReference,
    cartVersion: b.sourceCartVersion,
    quoteReference: b.quoteReference,
    orderType: "DineIn",
    sourceChannel: "Qr",
  };
  const session = parseCheckoutSession({
    schemaVersion: 1,
    checkoutSessionReference: id(951),
    createOperationReference: id(952),
    submissionReference: r.submissionReference,
    paymentOperationReference: clock.paymentOperationReference,
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(953),
      validationIntentHash: "sha256:" + "a".repeat(64),
      guestSessionReference: r.guestSessionReference,
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
        validUntil: "2026-09-11T10:05:00.000Z",
      },
      validatedAt: at,
      validUntil: "2026-09-11T10:05:00.000Z",
    },
  });
  const order = {
    orderReference: r.order.orderReference,
    brandReference: r.order.brandReference,
    storeReference: r.order.storeReference,
    guestSessionReference: r.guestSessionReference,
    diningSessionReference: r.order.diningSessionReference,
    originalOrderCreatedAt: r.createdAt,
    expectedOrderVersion: 1,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: b,
    items: r.items,
  };
  mocks.read.mockReset().mockResolvedValue(session);
  mocks.order.mockReset().mockResolvedValue(order);
  mocks.link.mockReset().mockResolvedValue(diningOrderCapacityLinkFromHistory(clock));
  mocks.clock.mockReset().mockResolvedValue(clock);
  const tx: ConsumerTransaction = { query: async () => ({ rows: [], rowCount: 0 }) };
  const authorize = vi.fn(async () => true);
  const scope = {
    tenantReference: r.order.brandReference,
    brandReference: r.order.brandReference,
    storeReference: r.order.storeReference,
  };
  const service = createCustomerAdditionalDiningSessionClock({
    scope,
    // Authorization implementation is mocked; only its configured scope is read here.
    access: { scope } as unknown as CustomerCheckoutSessionAuthorizationOptions,
    transactions: { run: async (work) => work(tx) },
    authorizeHistory: authorize,
    now: () => "2026-09-11T11:00:00.000Z",
  });
  return { service, session, clock, authorize };
}
it("returns the original sealed clock even after expiry without restarting it", async () => {
  const f = await fixture();
  const first = await f.service.preparePaymentClock({});
  expect(first.clock).toEqual(f.clock);
  expect(await f.service.preparePaymentClock({})).toEqual(first);
});
it("rejects absent additional history", async () => {
  const f = await fixture();
  mocks.order.mockResolvedValue(null);
  await expect(f.service.preparePaymentClock({})).rejects.toMatchObject({
    code: "INTENT_CONFLICT",
  });
});
it("rejects an unsealed commitment", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue({
    ...f.clock,
    state: "Prepared",
    orderingLinkedAt: null,
    paymentRequestedAt: null,
    capacityExpiresAt: null,
  });
  await expect(f.service.preparePaymentClock({})).rejects.toThrow();
});
it("rejects a changed authorized session before returning history", async () => {
  const f = await fixture();
  mocks.read
    .mockResolvedValueOnce(f.session)
    .mockResolvedValue({ ...f.session, paymentOperationReference: id(959) });
  await expect(f.service.preparePaymentClock({})).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});
it("rejects revoked history authority before returning", async () => {
  const f = await fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.service.preparePaymentClock({})).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
});

it("recovers sealed expired history without reopening or extending its clock", async () => {
  const f = await fixture();
  const expired = parseDiningCheckoutCommitment({ ...f.clock, state: "Expired" });
  mocks.clock.mockResolvedValue(expired);
  const result = await f.service.preparePaymentClock({});
  expect(result.clock).toEqual(expired);
  expect(result.clock.paymentRequestedAt).toBe(f.clock.paymentRequestedAt);
  expect(result.clock.capacityExpiresAt).toBe(f.clock.capacityExpiresAt);
});
it("rejects expired preparations that never acquired a permanent payment clock", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue({
    ...f.clock,
    state: "Expired",
    orderingLinkedAt: null,
    paymentRequestedAt: null,
    capacityExpiresAt: null,
  });
  await expect(f.service.preparePaymentClock({})).rejects.toMatchObject({
    code: "INTENT_CONFLICT",
  });
});
it("still rejects changed linkage in sealed expired history", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue({
    ...f.clock,
    state: "Expired",
    paymentOperationReference: id(959),
  });
  await expect(f.service.preparePaymentClock({})).rejects.toMatchObject({
    code: "INTENT_CONFLICT",
  });
});
