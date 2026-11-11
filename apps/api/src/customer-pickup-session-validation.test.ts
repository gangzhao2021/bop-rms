import { expect, it, vi } from "vitest";
import { AsapCapacityError } from "@rms/fulfillment";

/**
 * WP-2423 (checkout-session-outage, v15 2026-11-11): Test Merchant 2's pickup hour (limit 20) was
 * full — counter orders count against it — so Fulfillment refused every online pickup with
 * ASAP_CAPACITY_INSUFFICIENT, and the guest was told the service was down for ~25 minutes. The
 * session validation now names it PICKUP_FULL (nothing created or charged).
 */
const prepare = vi.fn();
vi.mock("./customer-pickup-checkout-composition.js", () => ({
  createCustomerPickupCheckoutComposition: () => ({ prepare, prepareForOrdering: vi.fn() }),
  pickupOrderCapacityLinkFromHistory: vi.fn(),
}));
vi.mock("@bop/identity", async (load) => {
  const actual = await load<typeof import("@bop/identity")>();
  class GuestSessionService {
    async authorize() {
      return {
        sessionReference: id(6),
        brandReference: id(1),
        storeReference: id(2),
        channel: "Pickup",
        diningState: "ContextOnly",
      };
    }
  }
  return { ...actual, GuestSessionService };
});
const { createCustomerConfiguredPickupSessionValidation } =
  await import("./customer-pickup-session-validation.js");
const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function validate() {
  const request = {
    createOperationReference: id(11),
    cartReference: id(3),
    cartVersion: 4,
    quoteReference: id(4),
    quoteVersion: 2 as const,
  };
  return createCustomerConfiguredPickupSessionValidation({
    preparation: {
      scope: { brandReference: id(1), storeReference: id(2) },
      now: () => "2026-11-11T21:31:34.000Z",
      session: {},
      references: { generate: () => id(30) },
    },
    checkout: {},
  } as never)({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    request,
    allocation: {
      ...request,
      brandReference: id(1),
      storeReference: id(2),
      guestSessionReference: id(6),
      checkoutSessionReference: id(20),
      submissionReference: id(21),
      paymentOperationReference: id(22),
      allocatedAt: "2026-11-11T21:31:34.000Z",
    },
  });
}

it("tells a full pickup hour as PICKUP_FULL, never as the service being down", async () => {
  prepare.mockRejectedValueOnce(new AsapCapacityError("ASAP_CAPACITY_INSUFFICIENT"));
  await expect(validate()).rejects.toMatchObject({
    name: "CheckoutSessionServiceError",
    code: "PICKUP_FULL",
  });
});
it("passes any other capacity failure on as it was", async () => {
  const other = new AsapCapacityError("ASAP_CAPACITY_CONFLICT");
  prepare.mockRejectedValueOnce(other);
  await expect(validate()).rejects.toBe(other);
});
