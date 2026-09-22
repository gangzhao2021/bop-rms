import { expect, it, vi } from "vitest";
import { createKitchenWorkClient } from "./kitchen-work-client.js";
import { parseKitchenWorkItemView } from "./kitchen-board.js";
import { kitchenItemFixture } from "./kitchen-board.fixtures.js";
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const item = () =>
  parseKitchenWorkItemView({
    ...kitchenItemFixture(),
    execution: {
      orderItemReference: id(4),
      stationReference: id(5),
      ticketVersion: "9007199254740993",
      workItemVersion: "1",
      acceptedAt: null,
      readyAt: null,
    },
  });
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
const success = () => ({
  action: "AcceptKitchenWorkItem",
  ticketReference: item().ticketReference,
  workItemReference: item().workItemReference,
  orderItemReference: id(4),
  ticketVersion: "9007199254740994",
  workItemVersion: "2",
  outcome: "Accepted",
  projectionName: "kitchen_work_queue_v1",
  projectionPending: true,
});
function setup() {
  const fetcher = vi.fn<typeof fetch>(),
    client = createKitchenWorkClient(fetcher);
  const input = {
    action: "AcceptKitchenWorkItem" as const,
    storeReference: id(3),
    item: item(),
    idempotencyKey: id(1),
    correlationReference: id(2),
  };
  return { fetcher, client, input, operation: client.prepare(input) };
}
it("retries the same immutable intent after a lost response without automatic replay", async () => {
  const f = setup();
  f.fetcher
    .mockRejectedValueOnce(new TypeError("lost response"))
    .mockResolvedValueOnce(response(success()));
  await expect(f.operation.execute("a".repeat(43))).rejects.toMatchObject({
    code: "OutcomeUnknown",
  });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  f.input.storeReference = id(99);
  expect(await f.operation.execute("a".repeat(43))).toMatchObject({
    ticketVersion: "9007199254740994",
    projectionPending: true,
  });
  expect(f.fetcher.mock.calls[0]?.[1]?.body).toBe(f.fetcher.mock.calls[1]?.[1]?.body);
  const body = JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({
    authority: "CurrentMerchantSession",
    storeReference: id(3),
    expectedTicketVersion: "9007199254740993",
    idempotencyKey: id(1),
  });
  expect(body).not.toHaveProperty("actorReference");
  expect(body).not.toHaveProperty("brandReference");
});
it.each([
  [403, "PermissionDenied"],
  [404, "NotFound"],
  [409, "Conflict"],
  [422, "PreconditionFailed"],
  [400, "Invalid"],
  [503, "OutcomeUnknown"],
] as const)("maps %s without changing intent", async (status, code) => {
  const f = setup();
  f.fetcher.mockResolvedValueOnce(response({}, status));
  await expect(f.operation.execute("a".repeat(43))).rejects.toMatchObject({ code });
});
it("treats mismatched work, unsafe versions and malformed success as unknown", async () => {
  const f = setup();
  for (const change of [
    { workItemReference: id(99) },
    { ticketVersion: 9007199254740994 },
    { projectionPending: false },
    { outcome: "invented" },
  ]) {
    f.fetcher.mockResolvedValueOnce(response({ ...success(), ...change }));
    await expect(f.operation.execute("a".repeat(43))).rejects.toMatchObject({
      code: "OutcomeUnknown",
    });
  }
});
it("does not submit an aborted or unauthenticated request", async () => {
  const f = setup(),
    controller = new AbortController();
  controller.abort();
  await expect(f.operation.execute("a".repeat(43), controller.signal)).rejects.toMatchObject({
    code: "Invalid",
  });
  await expect(f.operation.execute("bad")).rejects.toMatchObject({ code: "Invalid" });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("builds ready and remaining-quantity completion from exact item versions", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(response({}, 409));
  await expect(
    f.client.prepare({ ...f.input, action: "MarkKitchenOrderItemReady" }).execute("a".repeat(43)),
  ).rejects.toThrow();
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
    workItems: [{ workItemReference: item().workItemReference, expectedWorkItemVersion: "1" }],
  });
  f.fetcher.mockResolvedValue(response({}, 409));
  await expect(
    f.client.prepare({ ...f.input, action: "CompleteKitchenWorkItem" }).execute("a".repeat(43)),
  ).rejects.toThrow();
  expect(JSON.parse(String(f.fetcher.mock.calls[1]?.[1]?.body)).quantityDelta).toBe(2);
});
