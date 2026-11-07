import { expect, it, vi } from "vitest";
import { checkoutText } from "../journey/messages.js";
import { createCheckoutSessionController } from "./session-controller.js";
import { CheckoutSessionClientError } from "./session-client.js";
import { checkoutSessionAlert } from "./session-message.js";
import { markCheckoutCardOffered } from "../session/customer-transaction-context.js";

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
  for (const status of ["denied", "invalid"] as const)
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
  // The page prices the cart again and says so itself.
  expect(checkoutSessionAlert({ status: "requote_required", canRetry: false }, false)).toBeNull();
  expect(
    checkoutSessionAlert({ status: "already_ordered", canRetry: false, placedOrder: null }, false),
  ).toBeNull();
});

it("maps a server conflict through the controller to the cart that changed", async () => {
  const create = vi.fn().mockRejectedValue(new CheckoutSessionClientError("conflict"));
  const c = createCheckoutSessionController({ create }, () => "key");
  await c.start({
    cartReference: "c",
    cartVersion: 1,
    quoteReference: "q",
    quoteVersion: 1,
  });
  expect(checkoutSessionAlert(c.getState(), false)).toBe(checkoutText.checkoutCartChanged);
  expect(checkoutText.checkoutCartChanged).not.toContain("scan");
});

it("WP-2423 item 2: an unconfirmed checkout says this order wasn't charged only before any card", () => {
  const unconfirmed = checkoutSessionAlert({ status: "unknown", canRetry: true }, false);
  expect(unconfirmed).toBe(checkoutText.checkoutUnconfirmed);
  expect(unconfirmed).toContain("This order hasn’t been charged.");
  markCheckoutCardOffered();
  const after = checkoutSessionAlert({ status: "unknown", canRetry: true }, false);
  expect(after).toBe(checkoutText.checkoutUnconfirmedAfterCard);
  expect(after).not.toContain("charged");
});
