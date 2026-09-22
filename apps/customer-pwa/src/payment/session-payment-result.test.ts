import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createSessionPaymentResultClient,
  type SessionPaymentResult,
} from "./session-payment-result-client.js";
import { createSessionPaymentResultController } from "./session-payment-result-controller.js";
import {
  setCustomerCsrfCredential,
  setCheckoutSessionReference,
} from "../session/customer-transaction-context.js";
const id = (n: number) => "01909999-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const success: SessionPaymentResult = {
  checkoutSessionReference: id(1),
  paymentIntentReference: id(2),
  orderReference: id(3),
  status: "Succeeded",
  total: { amountMinor: "238", currency: "CAD" },
};
beforeEach(() => {
  setCustomerCsrfCredential("c".repeat(43));
  setCheckoutSessionReference(id(1));
});
afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
});
it("uses a no-store CSRF GET with no operation mutation or request body", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { schemaVersion: 1, payment: success },
        { headers: { "cache-control": "no-store" } },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  expect(await createSessionPaymentResultClient().read(id(1))).toEqual(success);
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/checkout-sessions/" + id(1) + "/payment-result");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "GET",
    cache: "no-store",
    headers: { "x-csrf-token": "c".repeat(43) },
  });
  expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
});
it("rejects cached, malformed, cross-session and out-of-range result claims", async () => {
  for (const [payment, cache] of [
    [success, ""],
    [{ ...success, checkoutSessionReference: id(9) }, "no-store"],
    [{ ...success, extra: true }, "no-store"],
    [{ ...success, paymentIntentReference: null }, "no-store"],
    [{ ...success, total: { amountMinor: "9223372036854775808", currency: "CAD" } }, "no-store"],
  ] as const) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ schemaVersion: 1, payment }, { headers: { "cache-control": cache } }),
        ),
    );
    await expect(createSessionPaymentResultClient().read(id(1))).rejects.toMatchObject({
      code: "unknown",
    });
  }
});
it("preserves pending/unknown/failed and rejects responses after credential replacement", async () => {
  for (const status of ["Pending", "Unknown", "Failed"] as const) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { schemaVersion: 1, payment: { ...success, status } },
            { headers: { "cache-control": "no-store" } },
          ),
        ),
    );
    expect((await createSessionPaymentResultClient().read(id(1))).status).toBe(status);
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      setCustomerCsrfCredential(null);
      return Response.json(
        { schemaVersion: 1, payment: success },
        { headers: { "cache-control": "no-store" } },
      );
    }),
  );
  await expect(createSessionPaymentResultClient().read(id(1))).rejects.toThrow();
});
it("deduplicates reads, discards in-flight offline results and requires explicit refresh", async () => {
  let resolve!: (value: SessionPaymentResult) => void;
  const read = vi.fn(
    () =>
      new Promise<SessionPaymentResult>((done) => {
        resolve = done;
      }),
  );
  const c = createSessionPaymentResultController({ read });
  const first = c.load();
  expect(c.refresh()).toBe(first);
  await Promise.resolve();
  c.setOnline(false);
  expect(c.getState()).toEqual({ status: "offline" });
  c.setOnline(true);
  expect(read).toHaveBeenCalledTimes(1);
  resolve(success);
  await first;
  expect(c.getState()).toEqual({ status: "unknown" });
  read.mockResolvedValue(success);
  await c.refresh();
  expect(c.getState()).toEqual({ status: "ready", result: success });
  expect(read).toHaveBeenCalledTimes(2);
  setCustomerCsrfCredential(null);
  expect(c.getState()).toEqual({ status: "denied" });
});
it("does not read without a current checkout and never changes session on retry", async () => {
  setCheckoutSessionReference(null);
  const read = vi.fn().mockResolvedValue(success);
  const c = createSessionPaymentResultController({ read });
  await c.load();
  expect(c.getState()).toEqual({ status: "missing" });
  setCheckoutSessionReference(id(9));
  await c.refresh();
  expect(read).not.toHaveBeenCalled();
});

it("uses an explicit reconciliation POST with no tip or new payment identity", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json(
        { schemaVersion: 1, payment: success },
        { headers: { "cache-control": "no-store" } },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  expect(await createSessionPaymentResultClient().reconcile(id(1))).toEqual(success);
  expect(fetch.mock.calls[0]?.[0]).toBe(
    "/api/v1/checkout-sessions/" + id(1) + "/payment-reconciliation",
  );
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    body: "{}",
    headers: { "x-csrf-token": "c".repeat(43), "content-type": "application/json" },
  });
});
it("loads read-only and reconciles only on explicit refresh, deduplicating refresh calls", async () => {
  const read = vi.fn().mockResolvedValue({ ...success, status: "Unknown" }),
    reconcile = vi.fn().mockResolvedValue(success);
  const c = createSessionPaymentResultController({ read, reconcile });
  await c.load();
  expect(read).toHaveBeenCalledTimes(1);
  expect(reconcile).not.toHaveBeenCalled();
  const first = c.refresh();
  expect(c.refresh()).toBe(first);
  await first;
  expect(reconcile).toHaveBeenCalledExactlyOnceWith(id(1));
  expect(c.getState()).toEqual({ status: "ready", result: success });
});
