import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { checkoutLoadFailureState, SessionPaymentPage } from "./SessionPaymentPage.js";
import { CheckoutSessionClientError } from "../checkout/session-client.js";
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
