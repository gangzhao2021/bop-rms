import { expect, it, vi } from "vitest";
import { parseCheckoutSession } from "@rms/ordering";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import type { ConsumerTransaction } from "@bop/eventing";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";
import { createCustomerPersistentAdditionalDiningPayment } from "./customer-persistent-additional-dining-payment.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  parent: vi.fn(),
  payment: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  order: vi.fn(),
  link: vi.fn(),
  clock: vi.fn(),
}));
vi.mock("./customer-checkout-session-read.js", () => ({
  createCustomerCheckoutSessionRead: () => ({ read: mocks.read }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresDiningOrderPreparationSource: () => ({ resolveAdditionalParent: mocks.parent }),
  createPostgresAdditionalDiningBatchHistoryReader: () => ({
    resolveSubmission: mocks.order,
    resolveCapacityLink: mocks.link,
  }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: () => ({ loadSubmission: mocks.clock }),
}));

vi.mock("./customer-additional-dining-payment-composition.js", () => ({
  createCustomerAdditionalDiningPaymentComposition: (options: unknown) => {
    mocks.payment(options);
    return { create: mocks.create };
  },
}));
vi.mock("./customer-additional-dining-session-preparation.js", () => ({
  createCustomerAdditionalDiningSessionPreparation: () => ({ prepare: mocks.prepare }),
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

  mocks.parent.mockReset().mockResolvedValue({
    ...scope,
    diningSessionReference: order.diningSessionReference,
    orderReference: order.orderReference,
    orderVersion: 3,
    nextBatchSequence: 2,
    originalOrderCreatedAt: order.originalOrderCreatedAt,
  });
  mocks.payment.mockReset();
  mocks.create.mockReset().mockResolvedValue({ status: "Created" });
  mocks.prepare.mockReset().mockResolvedValue({ record: prepared, session });
  const service = createCustomerPersistentAdditionalDiningPayment({
    targetOrderReference: order.orderReference,
    submission: {
      access: { scope } as unknown as CustomerCheckoutSessionAuthorizationOptions,
      runtime: {
        ...scope,
        inventory: { scope },
        transactions: { run: async <T>(work: (t: ConsumerTransaction) => Promise<T>) => work(tx) },
      },
      source: { scope, clock: { now: () => at } },
      historyAuthorization: authorize,
    },
    tip: { preparation: { scope }, authorizeOrder: authorize },
    payment: {},
  } as unknown as Parameters<typeof createCustomerPersistentAdditionalDiningPayment>[0]);
  const input = {
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: session.checkoutSessionReference,
    selectionReference: id(975),
    tip: { amountMinor: 0n, currencyCode: "CAD" },
  };
  return { service, input, clock, session, order, prepared, tx };
}

it("restores saved parent facts without requiring a currently eligible parent Order", async () => {
  const f = await fixture();
  await f.service.create(f.input);
  expect(mocks.payment).toHaveBeenCalledWith(
    expect.objectContaining({
      submission: expect.objectContaining({
        parent: {
          orderReference: f.order.orderReference,
          originalOrderCreatedAt: f.order.originalOrderCreatedAt,
          expectedOrderVersion: f.order.expectedOrderVersion,
          batchSequence: f.order.batchSequence,
        },
      }),
    }),
  );
  expect(mocks.parent).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.clock).not.toHaveBeenCalled();
});
it("uses current owner parent facts for a fresh prepared submission", async () => {
  const f = await fixture();
  mocks.order.mockResolvedValue(null);
  mocks.clock.mockResolvedValue(f.prepared);
  await f.service.create(f.input);
  expect(mocks.parent).toHaveBeenCalledWith(
    expect.objectContaining({
      transaction: f.tx,
      orderReference: f.order.orderReference,
      diningSessionReference: f.order.diningSessionReference,
    }),
  );
  expect(mocks.payment).toHaveBeenCalledWith(
    expect.objectContaining({
      submission: expect.objectContaining({
        parent: expect.objectContaining({
          expectedOrderVersion: 3,
          batchSequence: 2,
        }),
      }),
    }),
  );
});
it("does not enter Payment when current parent is ineligible", async () => {
  const f = await fixture();
  mocks.order.mockResolvedValue(null);
  mocks.clock.mockResolvedValue(f.prepared);
  mocks.parent.mockResolvedValue(null);
  await expect(f.service.create(f.input)).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  expect(mocks.create).not.toHaveBeenCalled();
});
it("does not enter Payment after session access is revoked during parent resolution", async () => {
  const f = await fixture();
  mocks.read.mockResolvedValueOnce(f.session).mockRejectedValueOnce(new Error("revoked"));
  await expect(f.service.create(f.input)).rejects.toThrow("revoked");
  expect(mocks.create).not.toHaveBeenCalled();
});

it("prepares a missing first commitment before resolving parent and entering Payment", async () => {
  const f = await fixture();
  mocks.order.mockResolvedValue(null);
  mocks.clock.mockResolvedValue(null);
  await f.service.create(f.input);
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    Number(mocks.parent.mock.invocationCallOrder[0]),
  );
  expect(mocks.parent.mock.invocationCallOrder[0]).toBeLessThan(
    Number(mocks.create.mock.invocationCallOrder[0]),
  );
});
it("does not enter Payment if first preparation fails", async () => {
  const f = await fixture();
  mocks.order.mockResolvedValue(null);
  mocks.clock.mockResolvedValue(null);
  mocks.prepare.mockRejectedValue(new Error("unavailable"));
  await expect(f.service.create(f.input)).rejects.toThrow("unavailable");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("rejects invalid tip before creating a first commitment", async () => {
  const f = await fixture();
  await expect(
    f.service.create({ ...f.input, tip: { amountMinor: -1n, currencyCode: "CAD" } }),
  ).rejects.toThrow();
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
