import { afterEach, describe, expect, it, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createHttpReceiptClient } from "./receipt-client.js";
import { createReceiptController } from "./receipt-controller.js";
const id = (n: number) => "018f8a00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function payload() {
  const amount = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  return {
    orderReference: id(1),
    freshnessStatus: "Fresh",
    deliveryStatus: "Unavailable",
    supportEligible: true,
    cancellationEligible: false,
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: "2026-08-12T14:00:00.000Z",
        reasonCode: null,
        snapshot: {
          receiptReference: id(3),
          operatingEntityDisplayName: "Synthetic Operating Entity",
          storeDisplayName: "Synthetic Store",
          orderNumber: "1001",
          issuedAt: "2026-08-12T14:00:00.000Z",
          locale: "en-CA",
          lines: [
            {
              lineReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: amount("1000"),
            },
          ],
          subtotal: amount("1000"),
          tax: amount("130"),
          tip: amount("0"),
          total: amount("1130"),
          paymentStatus: "Paid",
          refundedTotal: amount("0"),
        },
      },
    ],
  };
}

afterEach(() => setCustomerCsrfCredential(null));
const response = () =>
  new Response(JSON.stringify({ schemaVersion: 1, receipt: payload() }), {
    headers: { "content-type": "application/json" },
  });
describe("receipt HTTP client and context", () => {
  it("loads through the real controller with current credentials and lossless money", async () => {
    setCustomerCsrfCredential("a".repeat(43));
    const request = vi.fn<typeof fetch>().mockResolvedValue(response());
    const controller = createReceiptController(id(1), createHttpReceiptClient(request));
    await controller.load();
    expect(controller.getState()).toMatchObject({
      status: "ready",
      view: { records: [{ snapshot: { total: { amountMinor: 1130n } } }] },
    });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/v1/orders/" + id(1) + "/receipt", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", "x-csrf-token": "a".repeat(43) },
      signal: expect.any(AbortSignal),
    });
  });
  it("does not request without a current credential", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(createHttpReceiptClient(request).load(id(1))).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(request).not.toHaveBeenCalled();
  });
  it("clears an accepted receipt immediately when context changes, including offline data", async () => {
    setCustomerCsrfCredential("a".repeat(43));
    const controller = createReceiptController(
      id(1),
      createHttpReceiptClient(vi.fn<typeof fetch>().mockResolvedValue(response())),
    );
    const unsubscribe = controller.subscribe(() => undefined);
    try {
      await controller.load();
      expect(controller.getState().status).toBe("ready");
      setCustomerCsrfCredential("b".repeat(43));
      expect(controller.getState()).toEqual({ status: "permission-denied" });
      controller.setOnline(false);
      expect(controller.getState()).toEqual({ status: "offline", view: null });
    } finally {
      unsubscribe();
    }
  });
  it("rejects a response if the context changes while its body is read", async () => {
    setCustomerCsrfCredential("a".repeat(43));
    const pending = response();
    vi.spyOn(pending, "json").mockImplementation(async () => {
      setCustomerCsrfCredential("b".repeat(43));
      return { schemaVersion: 1, receipt: payload() };
    });
    await expect(
      createHttpReceiptClient(vi.fn<typeof fetch>().mockResolvedValue(pending)).load(id(1)),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});
