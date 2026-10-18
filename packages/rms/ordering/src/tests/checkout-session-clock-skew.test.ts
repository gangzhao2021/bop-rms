import { describe, expect, it, vi } from "vitest";
import {
  ORDERING_CLOCK_SKEW_ALLOWANCE_MS,
  orderingInstantNotAfterAcrossClocks,
} from "../domain/cart.js";
import { createPostgresCheckoutSessionStore } from "../infrastructure/persistence/checkout-session-store.js";
import type { CheckoutSessionAuthority } from "../application/checkout-session-service.js";
import type { CartQueryTransactionRunner } from "../infrastructure/persistence/cart-query-store.js";

const brand = "01902423-0000-7000-8000-000000000001",
  store = "01902423-0000-7000-8000-000000000002",
  guest = "01902423-0000-7000-8000-000000000003",
  checkoutSession = "01902423-0000-7000-8000-000000000004";
const shift = (instant: string, milliseconds: number) =>
  new Date(Date.parse(instant) + milliseconds).toISOString();

describe("Checkout authority across the application and database clocks (WP-2423)", () => {
  it("orders instants of two clocks within the skew allowance only", () => {
    const at = "2026-10-16T10:00:00.000Z";
    expect(ORDERING_CLOCK_SKEW_ALLOWANCE_MS).toBe(2000);
    expect(orderingInstantNotAfterAcrossClocks(at, at)).toBe(true);
    expect(orderingInstantNotAfterAcrossClocks(shift(at, 1999), at)).toBe(true);
    expect(orderingInstantNotAfterAcrossClocks(shift(at, 2000), at)).toBe(true);
    expect(orderingInstantNotAfterAcrossClocks(shift(at, 2001), at)).toBe(false);
    expect(() => orderingInstantNotAfterAcrossClocks("not an instant", at)).toThrow();
  });

  /** A Checkout Session read whose database clock is `skew` behind the application clock. */
  async function load(skew: number, validFor = 60_000) {
    const applicationNow = "2026-10-16T10:00:00.500Z",
      databaseNow = shift(applicationNow, -skew);
    const gate = vi.fn(async () => true);
    const runner: CartQueryTransactionRunner = {
      run: async (work) =>
        work({
          query: async (sql: string) =>
            (sql.includes("clock_timestamp()")
              ? { rows: [{ observed_at: databaseNow }], rowCount: 1 }
              : { rows: [], rowCount: 0 }) as never,
        }),
    };
    const authority: CheckoutSessionAuthority = {
      guestSessionReference: guest,
      brandReference: brand,
      storeReference: store,
      checkedAt: applicationNow,
      validUntil: shift(databaseNow, validFor),
      audit: null,
    } as CheckoutSessionAuthority;
    const result = await createPostgresCheckoutSessionStore(
      runner,
      { brandReference: brand, storeReference: store },
      { authorize: gate, audit: () => null },
    ).load(checkoutSession, authority);
    return { result, gate, databaseNow };
  }

  it("accepts an authority observed on an application clock slightly ahead of the database", async () => {
    // Before: the 300 ms skew answered PERMISSION_DENIED (checkedAt after clock_timestamp()).
    const { result, gate, databaseNow } = await load(300);
    expect(result).toBeNull(); // no such Checkout Session: authorized, then not found
    expect(gate).toHaveBeenCalledWith(expect.anything(), expect.anything(), databaseNow);
  });

  it("still refuses an observation beyond the allowance and an expired authority", async () => {
    await expect(load(2500)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    // Expiry is compared on the database clock only, with no allowance.
    await expect(load(0, 0)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
