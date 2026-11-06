import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkoutLoadFailureState,
  paymentStartFailureState,
  SessionPaymentPage,
} from "./SessionPaymentPage.js";
import { checkoutReturnFor } from "./checkout-return.js";
import { SessionPaymentClientError } from "./session-payment-client.js";
import { CheckoutSessionClientError } from "../checkout/session-client.js";
import type { CartView } from "../cart/types.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.each([
  ["1", "https://127.0.0.1:4443", true],
  ["0", "https://127.0.0.1:4443", false],
  ["1", "https://customer.invalid", false],
  ["1", "http://127.0.0.1:4443", false],
])("restricts simulation branding to explicit local configuration", (flag, origin, enabled) => {
  vi.stubEnv("VITE_BOP_INTERNAL_SIMULATED_PAYMENT", flag);
  vi.stubGlobal("window", { location: { origin } });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <SessionPaymentPage />
    </MemoryRouter>,
  );
  expect(html.includes("DEMO payment")).toBe(enabled);
  expect(html.includes("No real money is charged.")).toBe(enabled);
  expect(html).not.toContain("Payment confirmed");
});

it.each([
  [new CheckoutSessionClientError("denied"), "denied"],
  [new CheckoutSessionClientError("invalid"), "denied"],
  [new CheckoutSessionClientError("conflict"), "denied"],
  [new CheckoutSessionClientError("unknown"), "retry"],
  [new CheckoutSessionClientError("checkout_in_progress"), "retry"],
  [new TypeError("Failed to fetch"), "retry"],
  [new DOMException("timeout", "TimeoutError"), "retry"],
] as const)("WP-2423 Q10: classifies a checkout load failure %# as %s", (error, expected) => {
  expect(checkoutLoadFailureState(error)).toBe(expected);
});

const failure = (code: SessionPaymentClientError["code"]) => new SessionPaymentClientError(code);
describe("WP-2423 item 2: what a failed payment start may say", () => {
  it.each([
    ["store_closed", "closed"],
    ["items_short", "items_short"],
    ["tips_off", "tips_off"],
    ["not_ready", "expired"],
    ["requote_required", "requote_required"],
    ["invalid", "start_failed"],
    ["unknown", "start_failed"],
    ["denied", "denied"],
    ["conflict", "denied"],
    ["pay_later_table", "table_pays_later"],
    // Who knows what the result page knows: never a claim about money.
    ["already_paid", "unknown"],
    ["window_ended", "unknown"],
    ["retry_pending", "unknown"],
  ] as const)("before any card was offered, %s shows %s", (code, expected) => {
    expect(paymentStartFailureState(failure(code), false)).toBe(expected);
  });

  it("a thrown error that isn't the client's is an ordinary failure to start", () => {
    expect(paymentStartFailureState(new TypeError("Failed to fetch"), false)).toBe("start_failed");
    expect(paymentStartFailureState(new TypeError("Failed to fetch"), true)).toBe("unknown");
  });

  // Only these panels (or nothing at all) can follow a card: none says it wasn't charged.
  it.each([
    "store_closed",
    "items_short",
    "tips_off",
    "not_ready",
    "requote_required",
    "invalid",
    "unknown",
    "already_paid",
    "window_ended",
    "retry_limit",
    "retry_pending",
    "pay_first_table",
  ] as const)("once a card was offered, %s only says to check the result", (code) => {
    expect(paymentStartFailureState(failure(code), true)).toBe("unknown");
  });

  it("the checkout having ended, or the table paying at the end, stays what it is", () => {
    expect(paymentStartFailureState(failure("denied"), true)).toBe("denied");
    expect(paymentStartFailureState(failure("conflict"), true)).toBe("denied");
    expect(paymentStartFailureState(failure("pay_later_table"), true)).toBe("table_pays_later");
  });
});

describe("WP-2423 item 2: going back after a payment didn't start", () => {
  const cart = (items: readonly unknown[]) => ({ cart: { items } }) as unknown as CartView;
  it("a pickup guest goes back to the cart", () => {
    expect(checkoutReturnFor(false, cart([]))).toBe("cart");
    expect(checkoutReturnFor(false, null)).toBe("cart");
    expect(checkoutReturnFor(false, "unread")).toBe("cart");
  });
  it("a table whose cart was emptied by the placed round goes to the table page", () => {
    expect(checkoutReturnFor(true, cart([{}]))).toBe("cart");
    expect(checkoutReturnFor(true, cart([]))).toBe("table-saved");
    expect(checkoutReturnFor(true, null)).toBe("table-saved");
    expect(checkoutReturnFor(true, "unread")).toBe("table");
  });
});
