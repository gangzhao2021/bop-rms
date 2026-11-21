// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CheckoutDetailsForm } from "./CheckoutDetailsForm.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) => "01909992-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T00:00:00.000Z",
  until = "2026-09-11T00:05:00.000Z";
const selection = {
  cartReference: id(1),
  cartVersion: 2,
  quoteReference: id(3),
  quoteVersion: 1 as const,
  orderType: "Pickup" as const,
  quoteExpiresAt: until,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
  document.body.replaceChildren();
});

it("WP-2423 live minor 24: details answering that the cart moved make the page read the cart again", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      // Another tab ordered this cart: its version moved, so its details answer "changed".
      if (path === "/bff/customer/checkout-details/current")
        return json(
          {
            schemaVersion: 1,
            error: {
              code: "details_version_conflict",
              messageKey: "customer.checkout.version_conflict",
            },
          },
          409,
        );
      if (path === "/bff/customer/checkout-details/policy")
        return json({
          schemaVersion: 1,
          policy: {
            cartReference: selection.cartReference,
            cartVersion: selection.cartVersion,
            orderType: "Pickup",
            checkedAt: at,
            validUntil: until,
            documents: [],
          },
        });
      return json({ schemaVersion: 1, error: { code: "unknown" } }, 503);
    }),
  );
  const changed = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <CheckoutDetailsForm
        selection={selection}
        now={() => Date.parse(at)}
        onCheckoutChanged={changed}
      />,
    );
  });
  for (let index = 0; index < 10; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
  expect(changed).toHaveBeenCalledTimes(1);
});

it("WP-2423 live minor 24: a details read that is only busy does not read the cart again", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json(
        {
          schemaVersion: 1,
          error: {
            code: "details_service_unavailable",
            messageKey: "customer.checkout.service_unavailable",
          },
        },
        503,
      ),
    ),
  );
  const changed = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <CheckoutDetailsForm
        selection={selection}
        now={() => Date.parse(at)}
        onCheckoutChanged={changed}
      />,
    );
  });
  for (let index = 0; index < 10; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
  expect(container.textContent).toContain("Reload");
  expect(changed).not.toHaveBeenCalled();
});
