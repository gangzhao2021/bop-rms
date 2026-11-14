import { CheckoutSessionServiceError } from "@rms/ordering";
import { DiningCheckoutHeldError } from "@rms/dining";
import { expect, it } from "vitest";
import {
  checkoutHoldRetrySeconds,
  createCustomerDiningCheckoutHold,
  rethrowCheckoutHeld,
} from "./customer-checkout-hold.js";

const at = "2026-08-02T16:00:00.000Z";
it("bounds the wait between one second and an hour", () => {
  expect(checkoutHoldRetrySeconds("2026-08-02T16:00:00.200Z", at)).toBe(1);
  expect(checkoutHoldRetrySeconds("2026-08-02T15:59:00.000Z", at)).toBe(1);
  expect(checkoutHoldRetrySeconds("2026-08-02T16:04:00.001Z", at)).toBe(241);
  expect(checkoutHoldRetrySeconds("2026-08-02T19:00:00.000Z", at)).toBe(3600);
});
it("turns a Dining hold refusal into the checkout-session refusal and rethrows anything else", () => {
  const held = new DiningCheckoutHeldError("2026-08-02T16:10:00.000Z" as never);
  expect(() => rethrowCheckoutHeld(held)).toThrow(
    expect.objectContaining({
      constructor: CheckoutSessionServiceError,
      code: "CHECKOUT_IN_PROGRESS",
      heldUntil: "2026-08-02T16:10:00.000Z",
    }),
  );
  const other = new Error("synthetic");
  expect(() => rethrowCheckoutHeld(other)).toThrow(other);
});

it("WP-2423 shared-table-checkout (a): another phone's live choice of dishes holds the cart version like a checkout (checkout_scope_held)", async () => {
  const id = (n: number) => "01902520-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
  const queries: string[] = [];
  let scopeRow: Record<string, unknown> | null = null;
  const transactions = {
    run: async <T>(work: (tx: never) => Promise<T>) =>
      work({
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.includes("rms_dining.dining_session")) return { rows: [] };
          if (sql.includes("FROM rms_ordering.dining_checkout_scope s"))
            return { rows: scopeRow === null ? [] : [scopeRow] };
          return { rows: [] };
        },
      } as never),
  };
  const hold = createCustomerDiningCheckoutHold(transactions as never, scope);
  const ask = (participantReference: string) =>
    hold.read({
      diningSessionReference: id(10),
      cartReference: id(11),
      cartVersion: 5,
      participantReference,
      observedAt: at,
    });
  expect(await ask(id(21))).toBeNull();
  scopeRow = {
    scope: id(30),
    choice: "Mine",
    cart: id(11),
    version: 5,
    participant: id(20),
    session: id(22),
    expires_at: "2026-08-02T16:04:00.000Z",
  };
  // Another phone (B) is held until the payer's reservation ends; the payer (A) is not.
  expect(await ask(id(21))).toEqual({ heldUntil: "2026-08-02T16:04:00.000Z" });
  expect(await ask(id(20))).toBeNull();
  // Once the reservation ran out, B asks again in a few seconds (the dishes are being given back).
  scopeRow = { ...scopeRow, expires_at: "2026-08-02T15:59:00.000Z" };
  expect(await ask(id(21))).toEqual({ heldUntil: "2026-08-02T16:00:05.000Z" });
  expect(queries.some((sql) => sql.includes("rms_ordering.dining_checkout_scope"))).toBe(true);
});
