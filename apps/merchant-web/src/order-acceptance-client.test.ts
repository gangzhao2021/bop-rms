import { expect, it, vi } from "vitest";
import { createOrderAcceptanceClient } from "./order-acceptance-client.js";
const id = "01909968-0000-7000-8000-000000000001";
const command = {
  acceptanceReference: id,
  operationReference: id,
  orderReference: id,
  orderBatchReference: id,
  expectedOrderVersion: 1,
};
const csrf = "a".repeat(43);
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

it("retries an uncertain response with the exact original operation and no URL authority", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("private transport"))
    .mockResolvedValueOnce(response({ status: "AlreadyCommitted", acceptedOrderVersion: 2 }));
  const mutable = { ...command };
  const operation = createOrderAcceptanceClient(fetcher).prepare(mutable);
  mutable.expectedOrderVersion = 9;
  await expect(operation.execute(csrf)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  expect(await operation.execute(csrf)).toEqual({
    status: "AlreadyCommitted",
    acceptedOrderVersion: 2,
  });
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toBe("/merchant/orders/accept");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify(command),
    });
  }
});
it("rejects extra authority fields before sending", () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(() =>
    createOrderAcceptanceClient(fetcher).prepare({
      ...command,
      actorReference: id,
    } as typeof command),
  ).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  { status: "Created", acceptedOrderVersion: 3 },
  { status: "Created", acceptedOrderVersion: 2, sourceDigest: "private" },
  { status: "Pending", acceptedOrderVersion: 2 },
])("never confirms an invalid server result", async (value) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value));
  await expect(
    createOrderAcceptanceClient(fetcher).prepare(command).execute(csrf),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
it.each([
  [403, "PermissionDenied"],
  [409, "Conflict"],
  [503, "OutcomeUnknown"],
] as const)("maps status %s without echoing private response", async (status, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private", { status }));
  await expect(
    createOrderAcceptanceClient(fetcher).prepare(command).execute(csrf),
  ).rejects.toMatchObject({ code, message: "Order acceptance could not be confirmed" });
});
it("discards late success after context cancellation", async () => {
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort();
    return response({ status: "Created", acceptedOrderVersion: 2 });
  });
  await expect(
    createOrderAcceptanceClient(fetcher).prepare(command).execute(csrf, controller.signal),
  ).rejects.toMatchObject({ code: "OutcomeUnknown" });
});
