import { expect, it, vi } from "vitest";
import { checkoutText } from "../journey/messages.js";
import { createCheckoutSessionController } from "./session-controller.js";
import { CheckoutSessionClientError } from "./session-client.js";
import { checkoutSessionAlert } from "./session-message.js";

it("never turns a lost connection into a checkout refusal", async () => {
  const create = vi.fn();
  const c = createCheckoutSessionController({ create }, () => "key");
  // The guest goes offline on the checkout page before continuing (v15 aa3d9fac D1).
  c.setOnline(false);
  expect(c.getState()).toEqual({ status: "offline", canRetry: false });
  expect(checkoutSessionAlert(c.getState(), true)).toBeNull();
  expect(checkoutSessionAlert(c.getState(), false)).toBe(checkoutText.offline);
  expect(checkoutSessionAlert({ status: "offline", canRetry: true }, true)).toBeNull();
  c.setOnline(true);
  expect(c.getState()).toEqual({ status: "idle" });
  expect(create).not.toHaveBeenCalled();
});

it("keeps the refusal text for real server refusals only", () => {
  for (const status of ["denied", "conflict", "invalid"] as const)
    expect(checkoutSessionAlert({ status, canRetry: false }, false)).toBe(
      checkoutText.checkoutRefused,
    );
  expect(checkoutSessionAlert({ status: "unknown", canRetry: true }, false)).toBe(
    checkoutText.checkoutUnconfirmed,
  );
  expect(checkoutSessionAlert({ status: "store_closed", canRetry: true }, false)).toBe(
    checkoutText.storeClosed,
  );
  for (const status of ["idle", "pending"] as const)
    expect(checkoutSessionAlert({ status }, false)).toBeNull();
});

it("maps a server conflict through the controller to the refusal text", async () => {
  const create = vi.fn().mockRejectedValue(new CheckoutSessionClientError("conflict"));
  const c = createCheckoutSessionController({ create }, () => "key");
  await c.start({
    cartReference: "c",
    cartVersion: 1,
    quoteReference: "q",
    quoteVersion: 1,
  });
  expect(checkoutSessionAlert(c.getState(), false)).toBe(checkoutText.checkoutRefused);
});
