// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CheckoutDetailsForm,
  pickupContactValueValid,
  type CheckoutDetailsFormHandle,
} from "./CheckoutDetailsForm.js";
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
beforeEach(() => {
  setCustomerCsrfCredential("c".repeat(43));
  // jsdom has no layout: the marked field is still brought into view in a browser.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
  document.body.replaceChildren();
});

it("M111: the phone rule matches what the Store can call or text", () => {
  expect(pickupContactValueValid("Phone", "613 555 0123")).toBe(true);
  expect(pickupContactValueValid("Phone", "+44 20 7946 0958")).toBe(true);
  expect(pickupContactValueValid("Phone", "555")).toBe(false);
  expect(pickupContactValueValid("Email", "name@example.com")).toBe(true);
  expect(pickupContactValueValid("Email", "name@example")).toBe(false);
});

it("M111: a contact the Store can't use is marked on its field, described and focused, and not saved", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/bff/customer/checkout-details/current")
      return json({
        schemaVersion: 1,
        checkout: {
          cartReference: selection.cartReference,
          cartVersion: selection.cartVersion,
          orderType: "Pickup",
          details: null,
        },
      });
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
  });
  vi.stubGlobal("fetch", fetch);
  const container = document.createElement("div");
  document.body.append(container);
  const form = createRef<CheckoutDetailsFormHandle>();
  await act(async () => {
    createRoot(container).render(
      <CheckoutDetailsForm ref={form} selection={selection} now={() => Date.parse(at)} />,
    );
  });
  for (let index = 0; index < 10; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
  const input = container.querySelector<HTMLInputElement>('input[type="tel"]');
  expect(input).not.toBeNull();
  const calls = fetch.mock.calls.length;
  let saved: unknown = "pending";
  await act(async () => {
    saved = await form.current?.save();
  });
  expect(saved).toBeNull();
  expect(fetch.mock.calls.length).toBe(calls);
  expect(input?.getAttribute("aria-invalid")).toBe("true");
  const described = input?.getAttribute("aria-describedby");
  expect(described).toBe("pickup-contact-error");
  expect(document.getElementById(described ?? "")?.textContent).toContain(
    "Enter a mobile number like 613 555 0123",
  );
  expect(document.activeElement).toBe(input);
});
