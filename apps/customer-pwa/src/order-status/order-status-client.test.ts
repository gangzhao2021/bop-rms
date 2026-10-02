import { afterEach, describe, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createHttpOrderStatusClient } from "./order-status-client.js";
import { createOrderStatusController } from "./order-status-controller.js";

const id = (n: number) => `018f7a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function payload() {
  return {
    schemaVersion: 1,
    status: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: id(2),
      projectedAt: "2026-08-11T14:00:00.000Z",
      freshnessStatus: "Fresh",
      order: {
        orderReference: id(1),
        orderNumber: "1001",
        orderType: "Pickup",
        canonicalPhase: "Submitted",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfilledAt: null,
        eta: null,
        submittedAt: "2026-08-11T13:55:00.000Z",
        batches: [
          {
            orderBatchReference: id(3),
            submittedAt: "2026-08-11T13:55:00.000Z",
            items: [
              {
                orderItemReference: id(4),
                displayName: "Synthetic bowl",
                quantity: 1,
                lineTotal: { amountMinor: "2598", currencyCode: "CAD" },
              },
            ],
          },
        ],
      },
    },
  };
}
function firstMoney(body: ReturnType<typeof payload>) {
  const item = body.status.order.batches[0]?.items[0];
  if (!item) throw new Error("missing fixture item");
  return item.lineTotal;
}
function responder(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}
afterEach(() => setCustomerCsrfCredential(null));

describe("customer order status HTTP client", () => {
  it.each([false, true])(
    "clears accepted order data on context replacement, offline=%s",
    async (offline) => {
      setCustomerCsrfCredential("a".repeat(43));
      const controller = createOrderStatusController(
        id(1),
        createHttpOrderStatusClient(responder(payload())),
      );
      const unsubscribe = controller.subscribe(() => undefined);
      try {
        await controller.load();
        expect(controller.getState().status).toBe("ready");
        if (offline) controller.setOnline(false);
        setCustomerCsrfCredential("b".repeat(43));
        expect(controller.getState()).toEqual({ status: "permission-denied" });
        controller.setOnline(false);
        expect(controller.getState()).toEqual({ status: "offline", view: null });
      } finally {
        unsubscribe();
        controller.dispose();
      }
    },
  );

  it("loads the exact same-origin order with current session and lossless money", async () => {
    setCustomerCsrfCredential("a".repeat(43));
    const body = payload();
    firstMoney(body).amountMinor = "9223372036854775807";
    const request = responder(body);
    const result = await createHttpOrderStatusClient(request).load(id(1));
    expect(result).toMatchObject({
      order: { batches: [{ items: [{ lineTotal: { amountMinor: 9223372036854775807n } }] }] },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(`/api/v1/orders/${id(1)}/status`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", "x-csrf-token": "a".repeat(43) },
      signal: expect.any(AbortSignal),
    });
  });

  it.each(["-0", "01", "1e3", "1.0", "9223372036854775808", "-9223372036854775809", 2598])(
    "rejects malformed or lossy money %s",
    async (amount) => {
      setCustomerCsrfCredential("a".repeat(43));
      const body = payload();
      Object.assign(firstMoney(body), { amountMinor: amount });
      await expect(createHttpOrderStatusClient(responder(body)).load(id(1))).rejects.toMatchObject({
        code: "service_unavailable",
      });
    },
  );

  it.each(["binding", "extra-root", "extra-money"] as const)("rejects %s", async (kind) => {
    setCustomerCsrfCredential("a".repeat(43));
    const body = payload();
    if (kind === "binding") body.status.order.orderReference = id(99);
    if (kind === "extra-root") Object.assign(body, { privateData: "unexpected" });
    if (kind === "extra-money") Object.assign(firstMoney(body), { extra: true });
    await expect(createHttpOrderStatusClient(responder(body)).load(id(1))).rejects.toMatchObject({
      code: "service_unavailable",
    });
  });

  it("does not request without current session credentials", async () => {
    const request = responder(payload());
    await expect(createHttpOrderStatusClient(request).load(id(1))).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403])("maps revoked access %s without exposing the body", async (status) => {
    setCustomerCsrfCredential("a".repeat(43));
    await expect(
      createHttpOrderStatusClient(responder({ error: "internal" }, status)).load(id(1)),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("discards a response when session context changes while body is loading", async () => {
    setCustomerCsrfCredential("a".repeat(43));
    const response = new Response();
    vi.spyOn(response, "json").mockImplementation(async () => {
      setCustomerCsrfCredential("b".repeat(43));
      return payload();
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(createHttpOrderStatusClient(request).load(id(1))).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("reports realtime unavailable without opening another transport", () => {
    const request = responder(payload());
    const callbacks = { onOpen: vi.fn(), onHint: vi.fn(), onError: vi.fn() };
    createHttpOrderStatusClient(request).subscribe(id(1), callbacks)();
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    expect(callbacks.onHint).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("order status source wire money", () => {
  it.each(["2598", "9223372036854775808", 2598])(
    "decodes only strict payment money %s",
    async (amountMinor) => {
      setCustomerCsrfCredential("a".repeat(43));
      const body = payload();
      Object.assign(body.status, {
        sources: {
          checkedAt: "2026-08-11T14:00:00.000Z",
          kitchen: null,
          payments: [
            {
              status: "Succeeded",
              occurredAt: "2026-08-11T13:56:00.000Z",
              amount: { amountMinor, currencyCode: "CAD" },
              freshnessStatus: "Fresh",
            },
          ],
        },
      });
      const result = createHttpOrderStatusClient(responder(body)).load(id(1));
      if (amountMinor === "2598") {
        await expect(result).resolves.toMatchObject({
          sources: { payments: [{ amount: { amountMinor: 2598n } }] },
        });
      } else await expect(result).rejects.toMatchObject({ code: "service_unavailable" });
    },
  );
});
