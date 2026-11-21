import { afterEach, it, expect, vi } from "vitest";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import { createHttpPickupCodeClient } from "./pickup-code-client.js";
const id = "0190fa48-0000-7000-8000-000000000001";
afterEach(() => setCustomerCsrfCredential(null));
it("requires current credentials without sending a request", async () => {
  const request = vi.fn();
  await expect(createHttpPickupCodeClient(request).load(id)).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect(request).not.toHaveBeenCalled();
});
it("uses a bounded no-store same-session GET without secrets in URL", async () => {
  setCustomerCsrfCredential("A".repeat(43));
  const request = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ schemaVersion: 1, status: "NotReady", orderReference: id }), {
      status: 200,
    }),
  );
  await createHttpPickupCodeClient(request).load(id);
  expect(request).toHaveBeenCalledWith(
    `/api/v1/orders/${id}/pickup-code`,
    expect.objectContaining({
      method: "GET",
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      headers: expect.objectContaining({ "x-csrf-token": "A".repeat(43) }),
    }),
  );
});
it("discards a response if Guest context changes during parsing", async () => {
  setCustomerCsrfCredential("A".repeat(43));
  const request = vi.fn().mockResolvedValue({
    status: 200,
    json: async () => {
      setCustomerCsrfCredential("B".repeat(43));
      return { status: "Ready" };
    },
  });
  await expect(createHttpPickupCodeClient(request).load(id)).rejects.toMatchObject({
    code: "permission_denied",
  });
});
it("maps failure without echoing response bodies", async () => {
  setCustomerCsrfCredential("A".repeat(43));
  const request = vi
    .fn()
    .mockResolvedValue(new Response("sensitive provider detail", { status: 503 }));
  await expect(createHttpPickupCodeClient(request).load(id)).rejects.toMatchObject({
    code: "service_unavailable",
    message: "Pickup proof is unavailable.",
  });
});
