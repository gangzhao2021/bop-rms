import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import {
  createCheckoutDetailsClient,
  createCheckoutDetailsController,
  CheckoutDetailsClientError,
  type CheckoutDetailsDraft,
} from "./details-client.js";
const id = (n: number) => "01909995-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const draft: CheckoutDetailsDraft = {
  detailsReference: id(1),
  expectedVersion: 0,
  cartReference: id(2),
  cartVersion: 3,
  quoteReference: id(3),
  quoteVersion: 2,
  orderType: "Pickup",
  pickupContact: { name: "Synthetic guest", channel: "Phone", value: "+12025550123" },
  receipt: { choice: "InSession", email: null },
  policies: [],
};
const acknowledgement = {
  operationReference: id(4),
  detailsReference: id(1),
  detailsVersion: 1,
  cartReference: id(2),
  cartVersion: 3,
  quoteReference: id(3),
  quoteVersion: 2 as const,
  orderType: "Pickup" as const,
  receiptChoice: "InSession" as const,
  recordedAt: "2026-09-11T00:00:00.000Z",
};
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
});
const response = (
  payload: unknown = { schemaVersion: 1, details: acknowledgement },
  status = 201,
) => new Response(JSON.stringify(payload), { status });
it.each([200, 201])("accepts only the matching saved acknowledgement (%s)", async (status) => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response(undefined, status));
  vi.stubGlobal("fetch", fetch);
  expect(await createCheckoutDetailsClient().save(draft, id(4))).toEqual(acknowledgement);
  expect(fetch).toHaveBeenCalledWith(
    "/bff/customer/checkout-details",
    expect.objectContaining({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      headers: expect.objectContaining({
        "idempotency-key": id(4),
        "x-csrf-token": "c".repeat(43),
      }),
    }),
  );
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).not.toHaveProperty("orderType");
});
it.each([
  { detailsVersion: 2 },
  { operationReference: id(99) },
  { cartVersion: 4 },
  { quoteVersion: 1 },
  { receiptChoice: "TransactionalEmail" },
  { orderType: "DineIn" },
  { email: "private@example.invalid" },
  { recordedAt: "invalid" },
])("keeps mismatched or private acknowledgement uncertain", async (change) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ schemaVersion: 1, details: { ...acknowledgement, ...change } })),
  );
  await expect(createCheckoutDetailsClient().save(draft, id(4))).rejects.toMatchObject({
    code: "unknown",
  });
});
it.each([
  ["details_request_invalid", 400, "invalid"],
  ["details_not_found", 404, "denied"],
  ["details_version_conflict", 409, "conflict"],
  ["details_policy_changed", 422, "policy"],
  ["details_requote_required", 422, "requote"],
  ["details_validation_failed", 422, "invalid"],
  ["details_service_unavailable", 503, "unknown"],
])("trusts only the closed matching error response", async (code, status, expected) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response(
        {
          schemaVersion: 1,
          error: { code, messageKey: "customer.checkout." + String(code).slice(8) },
        },
        Number(status),
      ),
    ),
  );
  await expect(createCheckoutDetailsClient().save(draft, id(4))).rejects.toMatchObject({
    code: expected,
  });
});
it("preserves the original private draft and operation for foreground retry only", async () => {
  const save = vi
    .fn()
    .mockRejectedValueOnce(new CheckoutDetailsClientError("unknown"))
    .mockResolvedValue(acknowledgement);
  const keys = vi.fn(() => id(4));
  const controller = createCheckoutDetailsController({ save }, keys);
  const input = structuredClone(draft);
  await controller.save(input);
  Object.assign(input.pickupContact ?? {}, { name: "Changed" });
  controller.setOnline(false);
  controller.setOnline(true);
  expect(save).toHaveBeenCalledOnce();
  await controller.retry();
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
  expect(save.mock.calls[1]).toEqual([draft, id(4)]);
  expect(keys).toHaveBeenCalledOnce();
  expect(controller.getState()).toEqual({ status: "saved", acknowledgement });
  expect(JSON.stringify(controller.getState())).not.toContain("+12025550123");
});
it("does not send or generate an operation offline", async () => {
  const save = vi.fn(),
    keys = vi.fn(() => id(4));
  const controller = createCheckoutDetailsController({ save }, keys);
  controller.setOnline(false);
  await controller.save(draft);
  controller.setOnline(true);
  expect(save).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});
it("coalesces pending saves and hides results after context replacement", async () => {
  let finish: (value: typeof acknowledgement) => void = () => undefined;
  const save = vi.fn(
    () =>
      new Promise<typeof acknowledgement>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = createCheckoutDetailsController({ save }, () => id(4));
  const first = controller.save(draft),
    second = controller.save(draft);
  expect(first).toBe(second);
  await Promise.resolve();
  setCustomerCsrfCredential("d".repeat(43));
  finish(acknowledgement);
  await first;
  expect(controller.getState()).toEqual({ status: "denied", canRetry: false });
  await controller.retry();
  expect(save).toHaveBeenCalledOnce();
});
it("rejects invalid contact before any request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    createCheckoutDetailsClient().save({ ...draft, pickupContact: null }, id(4)),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(fetch).not.toHaveBeenCalled();
});
