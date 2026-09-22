import { expect, it, vi } from "vitest";
import { parseCheckoutSession } from "@rms/ordering";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import type { ConsumerTransaction } from "@bop/eventing";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { orderSubmissionFixture, id } from "../test-support/dining-order-submission-fixture.js";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";
import { createCustomerAdditionalDiningSessionTipSelection } from "./customer-session-tip-selection.js";
import type { createPersistentAdditionalDiningTipSelection } from "./customer-dining-tip-selection-composition.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
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

vi.mock("./customer-dining-tip-selection-composition.js", async (original) => ({
  ...(await original<typeof import("./customer-dining-tip-selection-composition.js")>()),
  createPersistentAdditionalDiningTipSelection: (
    options: Parameters<typeof createPersistentAdditionalDiningTipSelection>[0],
  ) => ({
    select: async (input: { submissionReference: string }) => {
      await options.preparation.submissions.loadSubmission(input.submissionReference);
      return mocks.select(input);
    },
  }),
}));
async function fixture(quoteVersion: 1 | 2 = 1, configuredVersion: 1 | 2 = quoteVersion) {
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
      quoteVersion,
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

  const selection = {
    selectionReference: id(961),
    paymentOperationReference: session.paymentOperationReference,
    submissionReference: session.submissionReference,
    cartReference: b.sourceCartReference,
    cartVersion: b.sourceCartVersion,
    quoteReference: b.quoteReference,
    guestSessionReference: r.guestSessionReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    tip: { amountMinor: 100n, currencyCode: "CAD" },
    selectedAt: at,
  };
  mocks.select.mockReset().mockResolvedValue({ status: "Created", record: selection });
  const service = createCustomerAdditionalDiningSessionTipSelection(
    { scope } as unknown as CustomerCheckoutSessionAuthorizationOptions,
    {
      quoteVersion: configuredVersion,
      preparation: {
        ...f.options.preparation,
        submissions: { ...f.options.preparation.submissions, loadSubmission: mocks.clock },
      },
      transactions: {
        run: async <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
      },
      authorizeOrder: authorize,
      tip: {},
    } as unknown as Parameters<typeof createPersistentAdditionalDiningTipSelection>[0],
    { orderReference: r.order.orderReference, expectedOrderVersion: 2 },
  );
  const input = {
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: session.checkoutSessionReference,
    selectionReference: selection.selectionReference,
    tip: selection.tip,
  };
  return { service, input, clock, session, order };
}

it("forwards server-bound parent and session-derived identifiers to persistent selection", async () => {
  const f = await fixture();
  const result = await f.service.select(f.input);
  expect(result.session).toEqual(f.session);
  expect(mocks.select).toHaveBeenCalledWith(
    expect.objectContaining({
      orderReference: f.order.orderReference,
      expectedOrderVersion: 2,
      submissionReference: f.session.submissionReference,
      selectionReference: f.input.selectionReference,
    }),
  );
});
it("rejects another payment operation before the selection write", async () => {
  const f = await fixture();
  mocks.clock.mockResolvedValue({ ...f.clock, paymentOperationReference: id(962) });
  await expect(f.service.select(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  expect(mocks.select).not.toHaveBeenCalled();
});
it("does not accept browser-supplied parent fields", async () => {
  const f = await fixture();
  await expect(f.service.select({ ...f.input, orderReference: id(963) })).rejects.toMatchObject({
    code: "INPUT_INVALID",
  });
  expect(mocks.select).not.toHaveBeenCalled();
});

it("accepts a configured quote-v2 session with the server-selected v2 adapter", async () => {
  const f = await fixture(2);
  expect((await f.service.select(f.input)).session.validation.quoteVersion).toBe(2);
  expect(mocks.select).toHaveBeenCalledOnce();
});
it("rejects a session quote version different from server configuration before selection", async () => {
  const f = await fixture(2, 1);
  await expect(f.service.select(f.input)).rejects.toMatchObject({ code: "INTENT_CONFLICT" });
  expect(mocks.select).not.toHaveBeenCalled();
});
