import { expect, it } from "vitest";
import { validateCheckoutDetailsPolicy } from "../application/checkout-details-policy.js";
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

const at = "2026-09-11T00:00:00.000Z";
const until = "2026-09-11T00:01:00.000Z";
function policy() {
  const details = parseCheckoutDetailsSnapshot(fixture());
  return {
    brandReference: details.brandReference,
    storeReference: details.storeReference,
    orderType: details.orderType,
    checkedAt: at,
    validUntil: until,
    required: details.policies,
  };
}
it("returns the exact bounded current policy interval", () => {
  expect(
    validateCheckoutDetailsPolicy(parseCheckoutDetailsSnapshot(fixture()), policy(), at, at),
  ).toEqual({ checkedAt: at, validUntil: until });
});
it.each([
  null,
  { ...policy(), storeReference: id(99) },
  { ...policy(), brandReference: id(99) },
  { ...policy(), orderType: "DineIn" },
  { ...policy(), checkedAt: "2026-09-10T23:59:59.000Z" },
  { ...policy(), validUntil: at },
  { ...policy(), required: [] },
  { ...policy(), required: [{ ...policy().required[0], documentVersion: 3 }] },
  {
    ...policy(),
    required: [{ ...policy().required[0], documentDigest: "sha256:" + "b".repeat(64) }],
  },
  { ...policy(), required: [{ ...policy().required[0], purposeCode: "OTHER_TERMS" }] },
])("refuses missing, mismatched or stale policy evidence", (value) => {
  expect(() =>
    validateCheckoutDetailsPolicy(parseCheckoutDetailsSnapshot(fixture()), value, at, at),
  ).toThrow();
});
it.each([until, "2026-09-10T23:59:59.000Z"])(
  "refuses expiry or clock reversal after policy lookup",
  (observed) => {
    expect(() =>
      validateCheckoutDetailsPolicy(
        parseCheckoutDetailsSnapshot(fixture()),
        policy(),
        at,
        observed,
      ),
    ).toThrow();
  },
);
