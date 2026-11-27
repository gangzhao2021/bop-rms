import { describe, expect, it } from "vitest";
import { CheckoutSessionError, parseCheckoutSession } from "../domain/checkout-session.js";

const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T15:00:00.000Z";
const until = "2026-08-02T15:05:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
function fixture(quoteVersion = 1) {
  const binding = {
    brandReference: id(1),
    storeReference: id(2),
    cartReference: id(3),
    cartVersion: 4,
    quoteReference: id(4),
    orderType: "Pickup",
    sourceChannel: "Qr",
  };
  return {
    schemaVersion: 1,
    checkoutSessionReference: id(10),
    createOperationReference: id(11),
    submissionReference: id(12),
    paymentOperationReference: id(13),
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(5),
      validationIntentHash: hash,
      guestSessionReference: id(6),
      quoteVersion,
      quoteInputDigest: hash,
      catalogLines: [
        {
          cartItemReference: id(7),
          sellableReference: id(8),
          menuVersionReference: id(9),
          productVersionReference: id(14),
          validatedAt: at,
        },
      ],
      fulfillment: {
        ...binding,
        status: "Accepted",
        evidenceReference: id(15),
        evidenceVersion: 1,
        evidenceDigest: hash,
        checkedAt: at,
        validUntil: until,
      },
      validatedAt: at,
      validUntil: until,
    },
  };
}
describe("Checkout Session historical binding", () => {
  it.each([1, 2])("retains exact quote version %s and stable operation references", (version) => {
    const input = fixture(version);
    const result = parseCheckoutSession(input);
    expect(result.validation.quoteVersion).toBe(version);
    expect(result.submissionReference).toBe(input.submissionReference);
    input.validation.cartVersion = 99;
    expect(result.validation.cartVersion).toBe(4);
    expect(Object.isFrozen(result)).toBe(true);
    // Reading original history does not consult wall-clock time or renew validity.
    expect(parseCheckoutSession(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it.each(["2026-08-02T14:59:59.999Z", until])(
    "rejects creation outside validity: %s",
    (createdAt) => {
      expect(() => parseCheckoutSession({ ...fixture(), createdAt })).toThrow(CheckoutSessionError);
    },
  );
  it("rejects aliased session and submission identities", () => {
    const input = fixture();
    input.submissionReference = input.checkoutSessionReference;
    expect(() => parseCheckoutSession(input)).toThrow(CheckoutSessionError);
  });
  it("rejects unsupported quote versions and foreign fulfillment", () => {
    expect(() => parseCheckoutSession(fixture(3))).toThrow(CheckoutSessionError);
    const input = fixture();
    input.validation.fulfillment.storeReference = id(90);
    expect(() => parseCheckoutSession(input)).toThrow(CheckoutSessionError);
  });
  it("rejects extra fields and accessors without executing them", () => {
    expect(() => parseCheckoutSession({ ...fixture(), clientSecret: "invalid" })).toThrow(
      CheckoutSessionError,
    );
    let reads = 0;
    const input = fixture();
    Object.defineProperty(input, "validation", {
      enumerable: true,
      get() {
        reads++;
        return {};
      },
    });
    expect(() => parseCheckoutSession(input)).toThrow(CheckoutSessionError);
    expect(reads).toBe(0);
  });
});
