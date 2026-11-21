import { createGuestSession } from "@bop/identity";
import { expect, it, vi } from "vitest";
import {
  createCheckoutDetailsReadService,
  type CheckoutDetailsReadPorts,
} from "../application/checkout-details-read-service.js";
import { parseCheckoutDetailsSnapshot } from "../domain/checkout-details.js";
import { fixture, id } from "./configured-cart-quote.fixture.js";
function setup(dining = false) {
  const f = fixture(dining),
    q = f.quote;
  const guest = createGuestSession({
    sessionReference: id(65),
    version: 1,
    status: "Active",
    brandReference: f.cart.brandReference,
    storeReference: f.cart.storeReference,
    publicStoreReference: id(80),
    publicTableReference: dining ? id(81) : null,
    channel: dining ? "DineIn" : "Pickup",
    locale: "en-CA",
    qrReference: id(82),
    qrRevocationVersion: 1,
    diningState: dining ? "DiningBound" : "ContextOnly",
    diningSessionReference: dining ? id(67) : null,
    diningParticipantReference: dining ? id(68) : null,
    createdAt: f.observedAt,
    lastSeenAt: f.observedAt,
    idleExpiresAt: "2026-08-02T20:00:00.000Z",
    absoluteExpiresAt: "2026-08-03T16:00:00.000Z",
    orderClosedAt: null,
    closureExpiresAt: null,
    rotatedFromGuestSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });

  const details = parseCheckoutDetailsSnapshot({
    schemaVersion: 1,
    detailsReference: id(90),
    detailsVersion: 2,
    guestSessionReference: String(guest.sessionReference),
    brandReference: f.cart.brandReference,
    storeReference: f.cart.storeReference,
    cartReference: f.cart.cartReference,
    cartVersion: f.cart.aggregateVersion,
    quoteReference: q.quoteReference,
    quoteVersion: 2,
    orderType: dining ? "DineIn" : "Pickup",
    pickupContact: dining
      ? null
      : { name: "Synthetic guest", channel: "Phone", value: "+12025550123" },
    receipt: { choice: "InSession", email: null },
    policies: [],
    recordedAt: f.observedAt,
  });
  const authorize = vi
    .fn<CheckoutDetailsReadPorts["authorization"]["authorize"]>()
    .mockResolvedValue(guest);
  const loadCart = vi
    .fn<CheckoutDetailsReadPorts["repository"]["loadCart"]>()
    .mockResolvedValue(f.cart);
  const loadLatest = vi
    .fn<CheckoutDetailsReadPorts["repository"]["loadLatest"]>()
    .mockResolvedValue(details);
  const service = createCheckoutDetailsReadService({
    now: () => f.observedAt,
    authorization: { authorize },
    repository: { loadCart, loadLatest },
  });
  const input = { cartReference: f.cart.cartReference, cartVersion: f.cart.aggregateVersion };
  return { f, guest, details, service, input, authorize, loadCart, loadLatest };
}
it.each([false, true])("reads exact current Guest details for Dining=%s", async (mode) => {
  const f = setup(mode);
  expect(await f.service.read(f.input)).toEqual({
    ...f.input,
    orderType: mode ? "DineIn" : "Pickup",
    details: f.details,
  });
  expect(f.loadLatest).toHaveBeenCalledWith(
    f.input.cartReference,
    String(f.guest.sessionReference),
  );
});
it("returns absence without creating or acknowledging anything", async () => {
  const f = setup();
  f.loadLatest.mockResolvedValue(null);
  expect((await f.service.read(f.input)).details).toBeNull();
});
it("retains the saved Cart version when the current Cart is newer", async () => {
  const f = setup();
  const next = { ...f.f.cart, aggregateVersion: f.f.cart.aggregateVersion + 1 };
  f.loadCart.mockResolvedValue(next);
  const result = await f.service.read({ ...f.input, cartVersion: next.aggregateVersion });
  expect(result.details?.cartVersion).toBe(f.details.cartVersion);
  expect(result.cartVersion).toBe(next.aggregateVersion);
});
it.each(["brandReference", "storeReference", "guestSessionReference", "cartReference"] as const)(
  "refuses foreign %s in a repository result",
  async (field) => {
    const f = setup(true);
    f.loadLatest.mockResolvedValue({ ...f.details, [field]: id(99) });
    await expect(f.service.read(f.input)).rejects.toMatchObject({
      code: "CART_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("denies revoked authority after the private read", async () => {
  const f = setup();
  f.loadLatest.mockImplementation(async () => {
    f.authorize.mockResolvedValue(null);
    return f.details;
  });
  await expect(f.service.read(f.input)).rejects.toMatchObject({ code: "CART_PERMISSION_DENIED" });
});
it("rejects a Cart change during the read", async () => {
  const f = setup();
  f.loadCart
    .mockResolvedValueOnce(f.f.cart)
    .mockResolvedValue({ ...f.f.cart, aggregateVersion: f.input.cartVersion + 1 });
  await expect(f.service.read(f.input)).rejects.toMatchObject({ code: "CART_VERSION_CONFLICT" });
});
it("rejects stale expected version before reading private details", async () => {
  const f = setup();
  await expect(
    f.service.read({ ...f.input, cartVersion: f.input.cartVersion + 1 }),
  ).rejects.toMatchObject({ code: "CART_VERSION_CONFLICT" });
  expect(f.loadLatest).not.toHaveBeenCalled();
});
