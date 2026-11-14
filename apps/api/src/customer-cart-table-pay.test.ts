import { describe, expect, it } from "vitest";
import { tablePayReturnable } from "./customer-cart-table-pay.js";

describe("WP-2423 shared-table-checkout (a): which phone gives the waiting dishes back", () => {
  const base = { waiting: 2, cart: true, held: false } as const;
  it("another phone may once the round was sent or the payer's reservation ran out", () => {
    expect(tablePayReturnable({ ...base, live: null })).toBe(true);
    expect(tablePayReturnable({ ...base, live: { thisPhone: false, reserved: false } })).toBe(true);
    expect(tablePayReturnable({ ...base, live: { thisPhone: false, reserved: true } })).toBe(false);
    expect(tablePayReturnable({ ...base, held: true, live: null })).toBe(false);
    expect(tablePayReturnable({ ...base, waiting: 0, live: null })).toBe(false);
  });
  it("never the payer's own phone while its choice is on the cart, even after it ran out", () => {
    expect(tablePayReturnable({ ...base, live: { thisPhone: true, reserved: false } })).toBe(false);
    expect(tablePayReturnable({ ...base, live: { thisPhone: true, reserved: true } })).toBe(false);
  });
});
