import { expect, it } from "vitest";
import { prepareDiningCartReplacement } from "../domain/dining-cart-replacement.js";
import { expireCartLifecycle, terminateCartLifecycle } from "../domain/cart-lifecycle.js";
import { parseOrderingInstant } from "../domain/cart.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const at = "2026-09-13T12:00:00.000Z";
const id = (n: number) => "0190ed92-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture(abandoned = false) {
  const f = orderWriteFixture({ at, dineIn: true });
  if (!f.cart.lifecycle) throw new Error("missing fixture lifecycle");
  const observedAt = abandoned ? parseOrderingInstant(at) : f.cart.lifecycle.absoluteExpiresAt;
  const lifecycle = abandoned
    ? terminateCartLifecycle(f.cart.lifecycle, { status: "Abandoned", terminalAt: observedAt })
    : expireCartLifecycle(f.cart.lifecycle, observedAt);
  return {
    previousCart: {
      ...f.cart,
      aggregateVersion: f.cart.aggregateVersion + 1,
      updatedAt: observedAt,
      lifecycle,
    },
    expectedCartVersion: f.cart.aggregateVersion + 1,
    brandReference: f.cart.brandReference,
    storeReference: f.cart.storeReference,
    diningSessionReference: f.cart.diningSessionReference,
    guestSessionReference: id(1),
    participantReference: id(2),
    observedAt,
    creation: {
      cartReference: id(3),
      sourceChannel: f.cart.sourceChannel,
      policy: {
        policyVersionReference: id(4),
        policyDigest: "sha256:" + "a".repeat(64),
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86400,
        validFrom: observedAt,
        validUntil: new Date(Date.parse(observedAt) + 86400000).toISOString(),
      },
    },
  };
}
it.each([false, true])(
  "creates an empty successor without changing terminal history (abandoned=%s)",
  (abandoned) => {
    const input = fixture(abandoned),
      prior = JSON.stringify(input);
    expect(input.previousCart.items.length).toBeGreaterThan(0);
    const result = prepareDiningCartReplacement(input);
    expect(result.cart.cartReference).toBe(id(3));
    expect(result.cart.aggregateVersion).toBe(1);
    expect(result.cart.items).toEqual([]);
    expect(result.cart.lifecycle?.status).toBe("Active");
    expect(result.previousCartReference).toBe(input.previousCart.cartReference);
    expect(result.previousCartVersion).toBe(input.expectedCartVersion);
    expect(result.cart.diningSessionReference).toBe(input.diningSessionReference);
    expect(JSON.stringify(input)).toBe(prior);
  },
);
it("cannot implicitly expire or revive an Active predecessor, even after its deadline", () => {
  const input = fixture(),
    f = orderWriteFixture({ at, dineIn: true });
  expect(() =>
    prepareDiningCartReplacement({
      ...input,
      previousCart: f.cart,
      expectedCartVersion: f.cart.aggregateVersion,
    }),
  ).toThrow();
});
it.each(["brandReference", "storeReference", "diningSessionReference"])(
  "rejects foreign %s",
  (field) => {
    expect(() => prepareDiningCartReplacement({ ...fixture(), [field]: id(99) })).toThrow();
  },
);
it("rejects stale version, legacy lifecycle, future terminal time and future observation history", () => {
  const input = fixture();
  for (const change of [
    { expectedCartVersion: input.expectedCartVersion - 1 },
    { previousCart: { ...input.previousCart, lifecycle: null } },
    { observedAt: at },
    { previousCart: { ...input.previousCart, updatedAt: "2099-01-01T00:00:00.000Z" } },
  ])
    expect(() => prepareDiningCartReplacement({ ...input, ...change })).toThrow();
});
it("rejects old Cart identity, channel changes and expired replacement policy", () => {
  const input = fixture();
  for (const creation of [
    { ...input.creation, cartReference: input.previousCart.cartReference },
    { ...input.creation, sourceChannel: input.creation.sourceChannel === "Qr" ? "Web" : "Qr" },
    {
      ...input.creation,
      policy: {
        ...input.creation.policy,
        validFrom: "2020-01-01T00:00:00.000Z",
        validUntil: input.observedAt,
      },
    },
  ])
    expect(() => prepareDiningCartReplacement({ ...input, creation })).toThrow();
});
it("rejects injected authority and unrecognized inputs", () => {
  expect(() => prepareDiningCartReplacement({ ...fixture(), paymentClear: true })).toThrow();
});
