import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("../../packages/rms/ordering/src/index.ts", async (original) => ({
  ...(await original()),
  createConfiguredCheckoutValidationService: () => ({ validate: mocks.validate }),
}));
vi.mock("../../packages/bop/identity/src/index.ts", () => ({
  GuestSessionService: class {
    async authorize() {
      return {};
    }
  },
}));
vi.mock("../../packages/rms/payment/src/index.ts", () => ({
  createPostgresPaymentTipSelectionStore: () => ({}),
}));
vi.mock("../../apps/api/dist/customer-checkout-session-authorization.js", () => ({
  createCustomerCheckoutSessionAuthorization: () => ({
    authorize: async () => ({}),
    authorizeInTransaction: async () => true,
  }),
}));
vi.mock("../../apps/api/dist/customer-additional-dining-history-authorization.js", () => ({
  createCustomerAdditionalDiningHistoryAuthorization: () => ({}),
}));
vi.mock("./pilot-order-sources.mjs", () => ({ createInternalOrderSourceOptions: () => ({}) }));
vi.mock("./pilot-checkout.mjs", () => ({
  createInternalCheckout: () => ({ checkoutPorts: () => ({}) }),
}));
import { CheckoutValidationError } from "../../packages/rms/ordering/src/index.ts";
import { createInternalAdditionalSubmission } from "./pilot-additional-submission.mjs";

afterEach(() => {
  vi.restoreAllMocks();
  mocks.validate.mockReset();
});

const at = "2026-11-11T12:00:00.000Z";
const later = "2026-11-11T12:30:00.000Z";
const validation = {
  validationReference: "validation",
  guestSessionReference: "guest",
  brandReference: "brand",
  storeReference: "store",
  cartReference: "cart",
  cartVersion: 3,
  quoteReference: "quote",
  quoteVersion: 2,
  quoteInputDigest: "digest",
  orderType: "DineIn",
  sourceChannel: "CUSTOMER_PWA",
  validUntil: later,
  catalogLines: [{ itemReference: "dish", unitPriceMinor: "1200", validatedAt: at }],
};

async function validateCurrent(fresh, observedAt = at) {
  const scope = { brandReference: "brand", storeReference: "store" };
  const { submission } = await createInternalAdditionalSubmission(
    {
      scope,
      transactions: { run: async () => undefined },
      now: () => at,
      credentials: { reference: () => "ref" },
    },
    { accessOptions: { binding: () => ({}) } },
    { identity: () => ({ session: {} }), preparation: {} },
    {
      createOptions: async () => ({ inventoryOptions: { scope }, policies: {}, clock: {} }),
    },
    {},
    { sessionCredential: "s", csrfCredential: "c" },
    {
      orderReference: "order",
      session: { submissionReference: "submission", validation },
    },
  );
  if (fresh instanceof Error) mocks.validate.mockRejectedValue(fresh);
  else mocks.validate.mockResolvedValue(fresh);
  return submission.runtime.validateCurrent(
    {},
    { orderReference: "order" },
    { ...scope, cartReference: "cart", cartVersion: 3, quoteReference: "quote", validUntil: later },
    { observedAt },
  );
}

it("an unchanged menu passes the current check", async () => {
  await expect(
    validateCurrent({ ...validation, catalogLines: [{ ...validation.catalogLines[0] }] }),
  ).resolves.toBeUndefined();
});

/**
 * WP-2423 staff-wording-and-expected-refusals (review of 2ea4f62d): the menu moved on (a price
 * changed) or the checkout window lapsed while the guest decided on another round. The guest is
 * told the menu changed and the cart prices again, as a refusal, never "unavailable, try again";
 * nothing is logged as an error here (the payment's catch logs the one information line).
 */
it.each([
  [
    "a price changed",
    { ...validation, catalogLines: [{ ...validation.catalogLines[0], unitPriceMinor: "1300" }] },
  ],
  ["the checkout window lapsed", { ...validation, validUntil: at }],
])("%s: the round is refused as 'the menu changed', not an error", async (_case, fresh) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(validateCurrent(fresh)).rejects.toMatchObject({
    name: "CheckoutValidationError",
    code: "CHECKOUT_REQUOTE_REQUIRED",
  });
  expect(error).not.toHaveBeenCalled();
});

it("a dish that ran out is passed on as itself, not logged as an error", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const refusal = new CheckoutValidationError("CHECKOUT_STOCK_SHORT");
  await expect(validateCurrent(refusal)).rejects.toBe(refusal);
  expect(error).not.toHaveBeenCalled();
});

it("a real failure of the current check is still logged as an error", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(validateCurrent({ ...validation }, "2026-11-11T12:05:00.000Z")).rejects.toThrow(
    "ADDITIONAL_CLOCK_AHEAD",
  );
  expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({
    event: "INTERNAL_ADDITIONAL_CURRENT_UNAVAILABLE",
    code: "ADDITIONAL_CLOCK_AHEAD",
  });
});
