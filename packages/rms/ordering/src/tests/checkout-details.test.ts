import { expect, it } from "vitest";
import { parseCheckoutDetailsSnapshot } from "../domain/checkout-details.js";
const id = (n: number) => "01909999-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  return {
    schemaVersion: 1,
    detailsReference: id(1),
    detailsVersion: 1,
    guestSessionReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    cartReference: id(5),
    cartVersion: 3,
    quoteReference: id(6),
    quoteVersion: 2,
    orderType: "Pickup",
    pickupContact: { name: "Synthetic guest", channel: "Phone", value: "+12025550123" },
    receipt: { choice: "InSession", email: null },
    policies: [
      {
        documentReference: id(7),
        documentVersion: 2,
        documentDigest: "sha256:" + "a".repeat(64),
        purposeCode: "ORDER_TERMS",
      },
    ],
    recordedAt: "2026-09-11T00:00:00.000Z",
  };
}
it("preserves an immutable original Pickup detail snapshot without marketing or verification claims", () => {
  const input = fixture(),
    parsed = parseCheckoutDetailsSnapshot(input);
  input.pickupContact.name = "Changed";
  input.policies.forEach((policy) => {
    policy.documentVersion = 3;
  });
  expect(parsed.pickupContact?.name).toBe("Synthetic guest");
  expect(parsed.policies[0]?.documentVersion).toBe(2);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.pickupContact)).toBe(true);
  expect(Object.isFrozen(parsed.receipt)).toBe(true);
  expect(Object.isFrozen(parsed.policies)).toBe(true);
  expect(parsed).not.toHaveProperty("marketingConsent");
  expect(parsed).not.toHaveProperty("emailVerified");
});
it("permits anonymous Dining with an in-session receipt and no policy requirements", () => {
  expect(
    parseCheckoutDetailsSnapshot({
      ...fixture(),
      orderType: "DineIn",
      pickupContact: null,
      policies: [],
    }).pickupContact,
  ).toBeNull();
});
it("records a transactional email request separately from pickup contact", () => {
  const parsed = parseCheckoutDetailsSnapshot({
    ...fixture(),
    receipt: { choice: "TransactionalEmail", email: "receipt@example.invalid" },
  });
  expect(parsed.receipt).toEqual({
    choice: "TransactionalEmail",
    email: "receipt@example.invalid",
  });
  expect(parsed.pickupContact?.channel).toBe("Phone");
});
it.each([
  { pickupContact: null },
  { orderType: "DineIn" },
  { cartVersion: 0 },
  { quoteVersion: 3 },
  { receipt: { choice: "InSession", email: "unexpected@example.invalid" } },
  { receipt: { choice: "TransactionalEmail", email: null } },
  {
    receipt: {
      choice: "TransactionalEmail",
      email: "unsafe" + String.fromCharCode(10) + "@example.invalid",
    },
  },
  { marketingConsent: true },
  { recordedAt: "invalid" },
])("rejects malformed or unrelated detail without exposing private input", (change) => {
  expect(() => parseCheckoutDetailsSnapshot({ ...fixture(), ...change })).toThrow(
    "checkout details are unavailable",
  );
});
it("rejects duplicate policy documents and accessor execution", () => {
  const input = fixture();
  expect(() =>
    parseCheckoutDetailsSnapshot({ ...input, policies: [...input.policies, ...input.policies] }),
  ).toThrow();
  let reads = 0;
  Object.defineProperty(input, "pickupContact", {
    enumerable: true,
    get() {
      reads += 1;
      return null;
    },
  });
  expect(() => parseCheckoutDetailsSnapshot(input)).toThrow();
  expect(reads).toBe(0);
});
