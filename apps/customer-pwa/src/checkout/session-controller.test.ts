import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCheckoutSessionController } from "./session-controller.js";
import { CheckoutSessionClientError } from "./session-client.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
const id = (n: number) => "01909999-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const selected = {
  cartReference: id(1),
  cartVersion: 3,
  quoteReference: id(2),
  quoteVersion: 1 as const,
};
const session = {
  ...selected,
  checkoutSessionReference: id(3),
  createdAt: "2026-09-11T21:00:00.000Z",
};
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => setCustomerCsrfCredential(null));
it("deduplicates clicks and retains original key/selection after response loss", async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new CheckoutSessionClientError("unknown"))
    .mockResolvedValue(session);
  const key = vi.fn(() => id(4));
  const c = createCheckoutSessionController({ create }, key);
  const first = c.start(selected),
    second = c.start({ ...selected, cartVersion: 4 });
  expect(first).toBe(second);
  await first;
  expect(c.getState()).toEqual({ status: "unknown", canRetry: true });
  await c.retry();
  expect(c.getState()).toEqual({ status: "ready", session });
  expect(key).toHaveBeenCalledTimes(1);
  expect(create.mock.calls).toEqual([
    [selected, id(4)],
    [selected, id(4)],
  ]);
});
it("does not start offline and refuses old session retry after revocation", async () => {
  const create = vi.fn().mockRejectedValue(new CheckoutSessionClientError("unknown"));
  const c = createCheckoutSessionController({ create }, () => id(4));
  c.setOnline(false);
  await c.start(selected);
  expect(create).not.toHaveBeenCalled();
  c.setOnline(true);
  expect(c.getState()).toEqual({ status: "idle" });
  expect(create).not.toHaveBeenCalled();
  await c.start(selected);
  setCustomerCsrfCredential(null);
  await c.retry();
  expect(c.getState()).toEqual({ status: "denied", canRetry: false });
  expect(create).toHaveBeenCalledTimes(1);
});
