import { expect, it, vi } from "vitest";

/**
 * WP-2423 (pickup-capacity-and-retry, v15 TM2 2026-11-11 23:11Z): a guest told the pickup hour was
 * full waited more than 5 minutes (the price hold) and pressed Retry checkout. The capacity source
 * refused the expired price as GUEST_SESSION_UNAVAILABLE, which the guest saw as a 503 loop. It now
 * says the price is no longer held (CHECKOUT_QUOTE_EXPIRED), so the page prices the order again.
 */
const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const now = "2026-11-11T23:11:45.000Z";
const quote = { quoteReference: id(4), quoteExpiresAt: "2026-11-11T23:06:00.000Z" };
const latest = vi.fn();
const resolveCart = vi.fn(() => {
  throw new Error("cart source refused");
});
vi.mock("@rms/ordering", async (load) => {
  const actual = await load<typeof import("@rms/ordering")>();
  return {
    ...actual,
    createPostgresCartQueryStore: () => ({ load: async () => ({ aggregateVersion: 4 }) }),
    createPostgresConfiguredCartQuoteReader: () => ({ loadLatest: latest }),
    createPostgresCartQuoteReader: () => ({ loadLatest: latest }),
    createPostgresOrderCreationQueryStore: () => ({}),
    resolveConfiguredPickupCapacityCartSource: resolveCart,
    resolvePickupCapacityCartSource: resolveCart,
  };
});
vi.mock("@rms/fulfillment", async (load) => {
  const actual = await load<typeof import("@rms/fulfillment")>();
  return { ...actual, createPostgresCurrentPickupCapacityStore: () => ({}) };
});
const { createCustomerConfiguredPickupCapacitySources, isQuoteExpired } =
  await import("./customer-pickup-capacity-sources.js");

const resolve = () =>
  createCustomerConfiguredPickupCapacitySources({
    scope: { brandReference: id(1), storeReference: id(2) },
    orderingTransactions: {} as never,
    capacityTransactions: {} as never,
    unitPolicy: { resolve: async () => ({}) },
    now: () => now,
  }).resolve({
    guestSessionReference: id(6),
    cartReference: id(3),
    cartVersion: 4,
    quoteReference: id(4),
    submissionReference: id(21),
    observedAt: now,
  });

it("says the checkout's price is no longer held, so the page prices the order again", async () => {
  latest.mockResolvedValueOnce(quote);
  const refused = await resolve().catch((error: unknown) => error);
  expect(isQuoteExpired(refused)).toBe(true);
});
it("keeps any other refusal as the guest session being unavailable", async () => {
  latest.mockResolvedValueOnce({ ...quote, quoteExpiresAt: "2026-11-11T23:15:00.000Z" });
  await expect(resolve()).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
  // A newer price for the cart (asked in another tab) is not this checkout's price.
  latest.mockResolvedValueOnce({ ...quote, quoteReference: id(5) });
  await expect(resolve()).rejects.toMatchObject({ code: "GUEST_SESSION_UNAVAILABLE" });
});
