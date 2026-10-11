import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  v1: vi.fn(),
  v2: vi.fn(),
  prepare: vi.fn(async () => undefined),
}));
vi.mock("../../packages/bop/identity/src/index.ts", () => ({
  GuestSessionService: vi.fn(),
  createPostgresGuestSessionEntryStore: vi.fn(),
}));
vi.mock("../../packages/rms/ordering/src/index.ts", () => ({
  createPostgresDiningOrderPreparationSource: () => ({
    resolveAdditionalParent: async () => ({ orderVersion: 1 }),
  }),
  parseCartAggregate: (value) => value,
  parseCartQuoteAttachment: mocks.v1,
  parseConfiguredCartQuoteAttachment: mocks.v2,
}));
vi.mock("../../apps/api/dist/customer-additional-dining-preparation.js", () => ({
  createPersistentAdditionalDiningPreparation: () => ({ prepareForOrdering: mocks.prepare }),
}));
vi.mock("./pilot-dining-parent.mjs", () => ({
  createInternalDiningParent: () => ({ resolve: async () => "order" }),
}));
import { createInternalAdditionalCheckout } from "./pilot-additional-checkout.mjs";
afterEach(() => vi.clearAllMocks());

const cart = {
  cartReference: "cart",
  aggregateVersion: 4,
  diningSessionReference: "dining",
  lifecycle: {
    idleExpiresAt: "2026-10-11T23:00:00.000Z",
    absoluteExpiresAt: "2026-10-12T00:00:00.000Z",
  },
};
const quote = {
  quoteReference: "quote",
  cartVersion: 4,
  quoteExpiresAt: "2026-10-11T22:40:00.000Z",
};
async function prepareWith(raw) {
  const service = createInternalAdditionalCheckout(
    {
      scope: { brandReference: "brand", storeReference: "store" },
      now: () => "2026-10-11T22:20:00.000Z",
      transactions: { run: (work) => work({}) },
    },
    {},
    { submissions: { loadSubmission: async () => null }, references: { generate: vi.fn() } },
  );
  await service.prepare(
    {
      sessionCredential: "s",
      csrfCredential: "c",
      allocation: {
        submissionReference: "submission",
        cartReference: "cart",
        cartVersion: 4,
        quoteReference: "quote",
        guestSessionReference: "guest",
        paymentOperationReference: "operation",
      },
    },
    { repository: { loadCart: async () => cart, loadQuote: async () => raw } },
  );
}

it("WP-2423: an additional round reads a configured (version 2) quote with the version 2 parser", async () => {
  mocks.v2.mockReturnValue(quote);
  await prepareWith({ quoteVersion: 2 });
  expect(mocks.v2).toHaveBeenCalledWith({ quoteVersion: 2 });
  expect(mocks.v1).not.toHaveBeenCalled();
  expect(mocks.prepare).toHaveBeenCalledOnce();
});

it("still reads a version 1 quote with the version 1 parser", async () => {
  mocks.v1.mockReturnValue(quote);
  await prepareWith({ quoteVersion: 1 });
  expect(mocks.v1).toHaveBeenCalledOnce();
  expect(mocks.v2).not.toHaveBeenCalled();
});
