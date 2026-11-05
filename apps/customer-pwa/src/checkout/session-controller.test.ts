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
it("WP-2423 Q4: lets a customer retry the same checkout once the Store reopens", async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new CheckoutSessionClientError("store_closed"))
    .mockResolvedValue(session);
  const c = createCheckoutSessionController({ create }, () => id(5));
  await c.start(selected);
  expect(c.getState()).toEqual({ status: "store_closed", canRetry: true });
  await c.retry();
  expect(c.getState()).toEqual({ status: "ready", session });
  expect(create.mock.calls).toEqual([
    [selected, id(5)],
    [selected, id(5)],
  ]);
});
it("WP-2423: waits out another guest's checkout and retries with a new operation", async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new CheckoutSessionClientError("checkout_in_progress", 90))
    .mockResolvedValue(session);
  let n = 6;
  const c = createCheckoutSessionController({ create }, () => id(n++));
  await c.start(selected);
  expect(c.getState()).toEqual({
    status: "checkout_in_progress",
    canRetry: true,
    retryAfterSeconds: 90,
  });
  await c.retry();
  expect(c.getState()).toEqual({ status: "ready", session });
  expect(create.mock.calls).toEqual([
    [selected, id(6)],
    [selected, id(7)],
  ]);
});
it("WP-2423: keeps a short item's answer (no retry of the same cart; the guest changes it)", async () => {
  const line = { cartItemReference: id(70), available: 1, sharedStock: false };
  const create = vi
    .fn()
    .mockRejectedValueOnce(new CheckoutSessionClientError("item_short", null, line));
  const c = createCheckoutSessionController({ create }, () => id(5));
  await c.start(selected);
  expect(c.getState()).toEqual({ status: "item_short", canRetry: false, line });
  await c.retry();
  expect(create).toHaveBeenCalledTimes(1);
});
it("WP-2423: a menu update makes a new checkout for the new price, never a retry of the old", async () => {
  const create = vi
    .fn()
    .mockRejectedValueOnce(new CheckoutSessionClientError("requote_required"))
    .mockResolvedValue({ ...session, quoteReference: id(8) });
  const keys = [id(5), id(6)];
  const c = createCheckoutSessionController({ create }, () => keys.shift() ?? id(7));
  await c.start(selected);
  expect(c.getState()).toEqual({ status: "requote_required", canRetry: false });
  await c.retry();
  expect(create).toHaveBeenCalledTimes(1);
  c.reset();
  expect(c.getState()).toEqual({ status: "idle" });
  const priced = { ...selected, quoteReference: id(8) };
  await c.start(priced);
  expect(c.getState()).toEqual({ status: "ready", session: { ...session, quoteReference: id(8) } });
  expect(create.mock.calls).toEqual([
    [selected, id(5)],
    [priced, id(6)],
  ]);
});
it("WP-2423: after a send the old price needs, the page can begin again from a ready checkout", async () => {
  const create = vi.fn().mockResolvedValue(session);
  const keys = [id(5), id(6)];
  const c = createCheckoutSessionController({ create }, () => keys.shift() ?? id(7));
  await c.start(selected);
  expect(c.getState()).toEqual({ status: "ready", session });
  c.reset();
  expect(c.getState()).toEqual({ status: "idle" });
  await c.start(selected);
  expect(create.mock.calls).toEqual([
    [selected, id(5)],
    [selected, id(6)],
  ]);
});
