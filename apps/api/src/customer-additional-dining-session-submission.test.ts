import { expect, it, vi } from "vitest";
import { parseCheckoutSession } from "@rms/ordering";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import type { ConsumerTransaction } from "@bop/eventing";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";
import { createCustomerAdditionalDiningSessionSubmission } from "./customer-additional-dining-session-submission.js";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  submitCheckout: vi.fn(),
  source: vi.fn(),
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
  createPostgresAdditionalDiningBatchHistoryReader: () => ({
    resolveSubmission: mocks.order,
    resolveCapacityLink: mocks.link,
  }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: () => ({ loadSubmission: mocks.clock }),
}));

vi.mock("./customer-additional-dining-submission-runtime.js", () => ({
  createCustomerAdditionalDiningSubmissionRuntime: () => ({
    submit: mocks.submit,
    submitCheckout: mocks.submitCheckout,
  }),
}));
vi.mock("./customer-order-source-composition.js", () => ({
  createCustomerOrderSourceComposition: () => ({ load: mocks.source }),
  createCustomerConfiguredOrderSourceComposition: () => ({ load: mocks.source }),
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

  mocks.submit.mockReset().mockResolvedValue({ status: "Existing", snapshot: order });
  mocks.submitCheckout.mockReset().mockResolvedValue({ status: "Created", snapshot: order });
  mocks.source.mockReset().mockResolvedValue({ cart: {}, lines: [] });
  const nextItemReference = vi.fn(() => id(970));
  const options = {
    access: { scope } as unknown as CustomerCheckoutSessionAuthorizationOptions,
    runtime: {
      ...scope,
      inventory: { scope },
      transactions: { run: async <T>(work: (t: ConsumerTransaction) => Promise<T>) => work(tx) },
    },
    source: { scope, clock: { now: () => "2026-09-11T10:01:00.000Z" } },
    historyAuthorization: authorize,
    parent: {
      orderReference: order.orderReference,
      originalOrderCreatedAt: order.originalOrderCreatedAt,
      expectedOrderVersion: 1,
      batchSequence: 2,
    },
    nextItemReference,
  } as unknown as Parameters<typeof createCustomerAdditionalDiningSessionSubmission>[0];
  const service = createCustomerAdditionalDiningSessionSubmission(options);
  const input = {
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: session.checkoutSessionReference,
    tipSelectionReference: id(971),
  };
  return { service, input, clock, session, order, nextItemReference, prepared };
}

it("replays original history without current source reads, commitment reads or item allocation", async () => {
  const f = await fixture();
  const result = await f.service.create(f.input);
  expect(result.status).toBe("AlreadyCreated");
  expect(result.record).toEqual(f.order);
  expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ snapshot: f.order }));
  expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.clock).not.toHaveBeenCalled();
  expect(f.nextItemReference).not.toHaveBeenCalled();
});
it("loads actual-source composition before constructing a fresh checkout submission", async () => {
  const f = await fixture();
  mocks.order.mockResolvedValue(null);
  mocks.clock.mockResolvedValue(f.prepared);
  const result = await f.service.create(f.input);
  expect(result.status).toBe("Created");
  expect(mocks.source).toHaveBeenCalledWith({ evidence: f.session.validation });
  expect(mocks.submitCheckout).toHaveBeenCalledWith(
    expect.objectContaining({
      tipSelectionReference: f.input.tipSelectionReference,
      checkout: expect.objectContaining({
        submissionReference: f.session.submissionReference,
        submittedAt: "2026-09-11T10:01:00.000Z",
        snapshot: expect.objectContaining({
          snapshotCapturedAt: f.session.validation.validatedAt,
        }),
      }),
    }),
  );
  expect(mocks.submit).not.toHaveBeenCalled();
});
it("rejects a fresh commitment for another operation before reading sources or submitting", async () => {
  const f = await fixture();
  mocks.order.mockResolvedValue(null);
  mocks.clock.mockResolvedValue({ ...f.prepared, paymentOperationReference: id(972) });
  await expect(f.service.create(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  expect(mocks.source).not.toHaveBeenCalled();
  expect(mocks.submitCheckout).not.toHaveBeenCalled();
});
it("rechecks session authority after recovering original history", async () => {
  const f = await fixture();
  mocks.read.mockResolvedValueOnce(f.session).mockRejectedValueOnce(new Error("revoked"));
  await expect(f.service.create(f.input)).rejects.toThrow("revoked");
});
