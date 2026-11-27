import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ validate: vi.fn(), standing: vi.fn() }));
vi.mock("../../packages/rms/catalog/src/index.ts", () => ({
  confirmCatalogSaleStillCurrent: mocks.standing,
}));
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
  mocks.standing.mockReset();
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
  catalogLines: [
    {
      itemReference: "dish",
      sellableReference: "sellable",
      menuVersionReference: "menu-v1",
      unitPriceMinor: "1200",
      validatedAt: at,
    },
  ],
};
const link = {
  brandReference: "brand",
  storeReference: "store",
  cartReference: "cart",
  cartVersion: 3,
  quoteReference: "quote",
  validUntil: later,
};

/**
 * One later round's current check as the submission runtime runs it: the pre-check before the
 * write transaction, then the write's re-check on that transaction ("tx").
 */
async function currentCheck(
  fresh,
  { observedAt = at, standing = "Current", precheck = true } = {},
) {
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
    { catalogScope: { menuReference: "menu", channelCode: "CUSTOMER_PWA" } },
    { sessionCredential: "s", csrfCredential: "c" },
    {
      orderReference: "order",
      session: { submissionReference: "submission", validation },
    },
  );
  if (fresh instanceof Error) mocks.validate.mockRejectedValue(fresh);
  else mocks.validate.mockResolvedValue(fresh);
  mocks.standing.mockResolvedValue(standing);
  const snapshot = { orderReference: "order", batch: { submissionReference: "submission" } };
  if (precheck) await submission.runtime.prepareCurrent({ snapshot, capacityLink: link });
  return submission.runtime.validateCurrent("tx", snapshot, link, {
    observedAt,
    cart: {
      cartReference: "cart",
      aggregateVersion: 3,
      items: [{ optionSelections: [{ optionReference: "less-spicy", quantity: 1 }] }],
    },
  });
}
const validateCurrent = (fresh, observedAt = at) => currentCheck(fresh, { observedAt });

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

/**
 * WP-2423 (rush-connection-hold, later rounds): the write transaction does not read the menu again
 * in snapshots of its own; it asks Catalog, on that transaction, whether what the pre-check read is
 * still in effect: the same menu release, the round's dishes and its chosen choices still on sale.
 */
it("the write re-checks on its own transaction what the pre-check read, and opens no snapshot", async () => {
  await expect(currentCheck({ ...validation })).resolves.toBeUndefined();
  expect(mocks.validate).toHaveBeenCalledTimes(1);
  expect(mocks.standing).toHaveBeenCalledTimes(1);
  expect(mocks.standing).toHaveBeenCalledWith("tx", {
    brandReference: "brand",
    storeReference: "store",
    menuReference: "menu",
    channelCode: "CUSTOMER_PWA",
    orderTypeCode: "DINE_IN",
    observedAt: at,
    menuVersionReferences: ["menu-v1"],
    sellableReferences: ["sellable"],
    optionReferences: ["less-spicy"],
  });
});

it("a dish or choice marked sold out after the pre-check is refused as a dish that ran out", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const standing of ["SoldOut", "Unavailable"])
    await expect(currentCheck({ ...validation }, { standing })).rejects.toMatchObject({
      name: "OrderCreationError",
      code: "ORDER_CREATE_STOCK_SHORT",
    });
  expect(error).not.toHaveBeenCalled();
});

it("a menu listed again after the pre-check prices the cart again", async () => {
  await expect(currentCheck({ ...validation }, { standing: "MenuChanged" })).rejects.toMatchObject({
    name: "CheckoutValidationError",
    code: "CHECKOUT_REQUOTE_REQUIRED",
  });
});

it("a write without this round's pre-check is refused", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await expect(currentCheck({ ...validation }, { precheck: false })).rejects.toThrow(
    "ADDITIONAL_CURRENT_DENIED",
  );
  expect(mocks.standing).not.toHaveBeenCalled();
  expect(JSON.parse(error.mock.calls[0][0])).toMatchObject({ code: "ADDITIONAL_CURRENT_DENIED" });
});
