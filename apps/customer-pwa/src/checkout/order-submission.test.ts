import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import {
  createOrderSubmissionClient,
  createOrderSubmissionController,
  OrderSubmissionError,
  type SubmissionSelection,
  type SubmittedOrder,
} from "./order-submission.js";
const id = (n: number) => "01909999-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const selected: SubmissionSelection = {
  cartReference: id(1),
  cartVersion: 3,
  quoteReference: id(2),
  quoteVersion: 2,
  orderType: "Pickup",
  total: { amountMinor: "113", currency: "CAD" },
};
const order: SubmittedOrder = {
  ...selected,
  orderReference: id(3),
  submissionReference: id(4),
  orderNumber: "20260911-000001",
  phase: "Submitted",
  paymentStatus: "NotReported",
};
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
});
function response(value: unknown = { schemaVersion: 1, order }, status = 201) {
  return new Response(JSON.stringify(value), { status });
}
it.each([200, 201])("accepts HTTP %s only for the exact original unpaid order", async (status) => {
  const fetch = vi.fn(async () => response(undefined, status));
  vi.stubGlobal("fetch", fetch);
  expect(await createOrderSubmissionClient().submit(selected, id(4))).toEqual(order);
  expect(fetch).toHaveBeenCalledWith(
    "/api/v1/orders",
    expect.objectContaining({
      method: "POST",
      cache: "no-store",
      redirect: "error",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      body: JSON.stringify({ cartReference: id(1), cartVersion: 3, quoteReference: id(2) }),
      headers: expect.objectContaining({
        "idempotency-key": id(4),
        "x-csrf-token": "c".repeat(43),
      }),
    }),
  );
});
it.each([
  { submissionReference: id(8) },
  { cartReference: id(8) },
  { cartVersion: 4 },
  { quoteReference: id(8) },
  { quoteVersion: 1 },
  { orderType: "DineIn" },
  { total: { amountMinor: "114", currency: "CAD" } },
  { paymentStatus: "Paid" },
  { guestSessionReference: id(8) },
])("keeps mismatched or private response uncertain: %j", async (change) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response({ schemaVersion: 1, order: { ...order, ...change } })),
  );
  await expect(createOrderSubmissionClient().submit(selected, id(4))).rejects.toMatchObject({
    code: "unknown",
  });
});
it.each([
  ["order_not_found", 404, "denied"],
  ["order_version_conflict", 409, "conflict"],
  ["order_idempotency_conflict", 409, "conflict"],
  ["order_requote_required", 422, "requote"],
  ["order_request_invalid", 400, "invalid"],
  ["order_service_unavailable", 503, "unknown"],
] as const)("maps %s without trusting arbitrary errors", async (code, status, expected) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response(
        { schemaVersion: 1, error: { code, messageKey: "customer.order." + code.slice(6) } },
        status,
      ),
    ),
  );
  await expect(createOrderSubmissionClient().submit(selected, id(4))).rejects.toMatchObject({
    code: expected,
  });
});
it("retains immutable selection and the same operation after a lost response", async () => {
  const submit = vi
    .fn()
    .mockRejectedValueOnce(new OrderSubmissionError("unknown"))
    .mockResolvedValue(order);
  const keys = vi.fn(() => id(4));
  const controller = createOrderSubmissionController({ submit }, keys);
  const input = { ...selected, total: { ...selected.total } };
  await controller.submit(input);
  input.cartVersion = 9;
  input.total.amountMinor = "900";
  expect(controller.getState()).toEqual({ status: "unknown", canRetry: true });
  await controller.retry();
  expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
  expect(submit.mock.calls[1]).toEqual([selected, id(4)]);
  expect(keys).toHaveBeenCalledOnce();
  expect(controller.getState()).toEqual({ status: "submitted", order });
  await controller.submit(selected);
  await controller.retry();
  expect(submit).toHaveBeenCalledTimes(2);
});
it("coalesces concurrent submission and never replays on reconnect", async () => {
  let resolve: (value: SubmittedOrder) => void = () => undefined;
  const submit = vi.fn(
    () =>
      new Promise<SubmittedOrder>((yes) => {
        resolve = yes;
      }),
  );
  const controller = createOrderSubmissionController({ submit }, () => id(4));
  const first = controller.submit(selected),
    second = controller.submit(selected);
  expect(first).toBe(second);
  await Promise.resolve();
  controller.setOnline(false);
  controller.setOnline(true);
  expect(submit).toHaveBeenCalledOnce();
  resolve(order);
  await first;
  expect(controller.getState().status).toBe("submitted");
});
it("does not generate an operation or send while offline", async () => {
  const submit = vi.fn(),
    keys = vi.fn(() => id(4));
  const controller = createOrderSubmissionController({ submit }, keys);
  controller.setOnline(false);
  await controller.submit(selected);
  controller.setOnline(true);
  expect(submit).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
});
it("refuses replay and hides the result after session replacement", async () => {
  const submit = vi.fn().mockResolvedValue(order);
  const controller = createOrderSubmissionController({ submit }, () => id(4));
  await controller.submit(selected);
  setCustomerCsrfCredential("d".repeat(43));
  expect(controller.getState()).toEqual({ status: "denied", canRetry: false });
  await controller.retry();
  expect(submit).toHaveBeenCalledOnce();
});
it("discards a result arriving in a different Guest context", async () => {
  let resolve: (value: Response) => void = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((yes) => {
          resolve = yes;
        }),
    ),
  );
  const result = createOrderSubmissionClient().submit(selected, id(4));
  setCustomerCsrfCredential("d".repeat(43));
  resolve(response());
  await expect(result).rejects.toMatchObject({ code: "unknown" });
});
it("bounds a stalled submission and leaves it uncertain", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
  const result = createOrderSubmissionClient().submit(selected, id(4));
  const rejected = expect(result).rejects.toMatchObject({ code: "unknown" });
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});
