import { expect, it, vi } from "vitest";
import { parseCheckoutSession } from "@rms/ordering";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import type { ConsumerTransaction } from "@bop/eventing";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";
import { createCustomerAdditionalDiningSessionPreparation } from "./customer-additional-dining-session-preparation.js";
import type { createPersistentAdditionalDiningPreparation } from "./customer-additional-dining-preparation.js";

const mocks = vi.hoisted(() => ({
  parent: vi.fn(),
  cart: vi.fn(),
  prepare: vi.fn(),
  preparationOptions: vi.fn(),
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
  createPostgresCartQueryStore: () => ({ load: mocks.cart }),
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

vi.mock("./customer-additional-dining-preparation.js", () => ({
  createPersistentAdditionalDiningPreparation: (
    options: Parameters<typeof createPersistentAdditionalDiningPreparation>[0],
  ) => {
    mocks.preparationOptions(options);
    return { prepareForOrdering: mocks.prepare };
  },
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

  mocks.parent.mockReset().mockResolvedValue({ orderVersion: 3 });
  mocks.cart
    .mockReset()
    .mockResolvedValue(
      await f.options.checkout.repository.loadCart(session.validation.cartReference),
    );
  mocks.prepare.mockReset().mockResolvedValue({ status: "Created", record: prepared });
  mocks.preparationOptions.mockReset();
  const service = createCustomerAdditionalDiningSessionPreparation({
    scope,
    access: { scope } as unknown as CustomerCheckoutSessionAuthorizationOptions,
    preparation: {
      preparation: f.options.preparation,
      transactions: { run: async (work) => work(tx) },
      authorizeOrder: authorize,
    },
    orderReference: order.orderReference,
  });
  const input = {
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: session.checkoutSessionReference,
  };
  return { service, input, clock, session, prepared, order };
}

it("recovers an existing original commitment without fresh Cart/parent preparation", async () => {
  const f = await fixture();
  expect((await f.service.prepare(f.input)).record).toEqual(f.clock);
  expect(mocks.cart).not.toHaveBeenCalled();
  expect(mocks.parent).not.toHaveBeenCalled();
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("prepares first additional commitment with session operation and deadline", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue(null);
  expect((await f.service.prepare(f.input)).record).toEqual(f.prepared);
  const opts = mocks.preparationOptions.mock.calls[0]?.[0] as Parameters<
    typeof createPersistentAdditionalDiningPreparation
  >[0];
  expect(opts.preparation.references.generate("PaymentOperation")).toBe(
    f.session.paymentOperationReference,
  );
  expect(mocks.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      orderReference: f.order.orderReference,
      expectedOrderVersion: 3,
      intent: {
        submissionReference: f.session.submissionReference,
        cartReference: f.session.validation.cartReference,
        cartVersion: f.session.validation.cartVersion,
        quoteReference: f.session.validation.quoteReference,
        sourceValidUntil: f.session.validation.validUntil,
      },
    }),
  );
});
it("rejects ineligible current parent before creating any commitment", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue(null);
  mocks.parent.mockResolvedValue(null);
  await expect(f.service.prepare(f.input)).rejects.toMatchObject({
    code: "DEPENDENCY_UNAVAILABLE",
  });
  expect(mocks.prepare).not.toHaveBeenCalled();
});
it("rejects an existing commitment bound to another payment operation", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue({ ...f.clock, paymentOperationReference: id(978) });
  await expect(f.service.prepare(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  expect(mocks.prepare).not.toHaveBeenCalled();
});
