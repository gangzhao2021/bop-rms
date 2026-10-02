import { expect, it, vi } from "vitest";
import { createKitchenBoardClient } from "./kitchen-board-client.js";
import { parseKitchenBoardView, parseKitchenWorkItemDetailView } from "./kitchen-board.js";
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-19T12:00:00.000Z";
const item = (n = 1) => ({
  workItemReference: id(n),
  ticketReference: id(2),
  orderReference: id(3),
  orderItemReference: id(4),
  stationReference: id(5),
  localizedDisplayNames: { "en-CA": "Synthetic rice" },
  selectedOptions: [
    {
      optionReference: id(40),
      quantity: 2,
      localizedNames: { "en-CA": "Extra mushrooms" },
    },
  ],
  status: "Queued",
  requiredQuantity: 2,
  completedQuantity: 0,
  workItemCreatedAt: at,
  acceptedAt: null,
  orderItemReadyAt: null,
  ticketAggregateVersion: "9007199254740993",
  workItemVersion: "1",
});
const metadata = {
  storeReference: id(99),
  operatorStatus: "Unverified",
  projectionName: "kitchen_work_queue_v1",
  projectionVersion: 1,
  projectionGenerationReference: id(6),
  projectedAt: at,
  partial: false,
  stale: false,
  freshnessStatus: "Fresh",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function setup() {
  const fetcher = vi.fn<typeof fetch>();
  const client = createKitchenBoardClient({
    csrf: "a".repeat(43),
    storeLabel: "Training Store",
    storeReference: id(99),
    fetcher,
  });
  return { client, fetcher };
}
it("uses private same-origin transport and preserves versions without fabricating missing facts", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(response({ ...metadata, items: [item()], nextCursor: null }));
  const view = parseKitchenBoardView(await f.client.loadQueue());
  expect(view.items[0]?.execution?.ticketVersion).toBe("9007199254740993");
  expect(view.items[0]?.allergenCue).toBe("Unavailable");
  expect(view.items[0]?.exceptionStatus).toBe("Unavailable");
  expect(view.items[0]?.stationLabel).toBeNull();
  expect(view.items[0]?.selectedOptions).toEqual([{ displayName: "Extra mushrooms", quantity: 2 }]);
  expect(view.operatorStatus).toBe("Unverified");
  expect(f.fetcher.mock.calls[0]?.[0]).toBe("/merchant/kitchen/query");
  expect(f.fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "X-BOP-CSRF": "a".repeat(43) },
  });
});
it("applies exact Order and Ticket references only in the authorized query body", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(response({ ...metadata, items: [], nextCursor: null }));
  await f.client.loadQueue({ kind: "Order", reference: id(3) });
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
    kind: "List",
    filters: {
      orderReference: id(3),
      ticketReference: null,
      workItemReference: null,
    },
  });
  f.fetcher.mockResolvedValue(response({ ...metadata, items: [], nextCursor: null }));
  await f.client.loadQueue({ kind: "Ticket", reference: id(2) });
  expect(JSON.parse(String(f.fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    filters: { orderReference: null, ticketReference: id(2) },
  });
  await expect(
    f.client.loadQueue({ kind: "Order", reference: "not-a-reference" }),
  ).rejects.toThrow();
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("reads matching detail and rejects mismatched reference", async () => {
  const f = setup();
  f.fetcher.mockImplementation(async () => response({ ...metadata, item: item() }));
  const detail = parseKitchenWorkItemDetailView(await f.client.loadWorkItem(id(1)));
  expect(detail.item.displayName).toBe("Synthetic rice");
  expect(detail.item.selectedOptions).toEqual([{ displayName: "Extra mushrooms", quantity: 2 }]);
  expect(JSON.stringify(detail.item)).not.toContain(id(40));
  expect(detail.projectedAt).toBe(metadata.projectedAt);
  expect(detail.operatorStatus).toBe("Unverified");
  await expect(f.client.loadWorkItem(id(9))).rejects.toMatchObject({ code: "Unavailable" });
});
it("combines only pages from the same generation", async () => {
  const f = setup();
  const cursor = {
    projectionGenerationReference: id(6),
    afterCreatedAt: at,
    afterWorkItemReference: id(1),
  };
  f.fetcher
    .mockResolvedValueOnce(response({ ...metadata, items: [item()], nextCursor: cursor }))
    .mockResolvedValueOnce(response({ ...metadata, items: [item(10)], nextCursor: null }));
  expect(parseKitchenBoardView(await f.client.loadQueue()).items.length).toBe(2);
  f.fetcher
    .mockResolvedValueOnce(response({ ...metadata, items: [item()], nextCursor: cursor }))
    .mockResolvedValueOnce(
      response({
        ...metadata,
        projectionGenerationReference: id(99),
        items: [item(10)],
        nextCursor: null,
      }),
    );
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Conflict" });
});
it.each([
  [403, "PermissionDenied"],
  [404, "NotFound"],
  [409, "Conflict"],
  [503, "Unavailable"],
] as const)("maps status %s without exposing response details", async (status, code) => {
  const f = setup();
  f.fetcher.mockResolvedValue(response({ private: "not shown" }, status));
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code });
});
it("rejects unsafe versions, repeated rows, missing cache policy and incomplete coverage", async () => {
  const f = setup();
  f.fetcher.mockResolvedValueOnce(
    response({
      ...metadata,
      items: [{ ...item(), ticketAggregateVersion: 9007199254740992 }],
      nextCursor: null,
    }),
  );
  await expect(f.client.loadQueue()).rejects.toThrow();
  f.fetcher.mockResolvedValueOnce(
    response({ ...metadata, items: [item(), item()], nextCursor: null }),
  );
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
  f.fetcher.mockResolvedValueOnce(
    new Response("{}", { headers: { "Content-Type": "application/json" } }),
  );
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
  f.fetcher.mockResolvedValueOnce(
    response({ ...metadata, partial: true, items: [], nextCursor: null }),
  );
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
});
it("fails closed when the projection's modifier snapshot is missing or malformed", async () => {
  const f = setup();
  const missing = { ...item() };
  Reflect.deleteProperty(missing, "selectedOptions");
  f.fetcher.mockResolvedValueOnce(response({ ...metadata, items: [missing], nextCursor: null }));
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
  f.fetcher.mockResolvedValueOnce(
    response({
      ...metadata,
      items: [
        {
          ...item(),
          selectedOptions: [
            {
              optionReference: id(40),
              quantity: 0,
              localizedNames: { "en-CA": "Extra mushrooms" },
            },
          ],
        },
      ],
      nextCursor: null,
    }),
  );
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
});
it("treats failed network reads as offline and never replays automatically", async () => {
  const f = setup();
  f.fetcher.mockRejectedValue(new TypeError("network"));
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Offline" });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it("bounds reads instead of silently truncating a larger queue", async () => {
  const f = setup();
  let page = 10;
  f.fetcher.mockImplementation(async () => {
    const current = page++;
    return response({
      ...metadata,
      items: [item(current)],
      nextCursor: {
        projectionGenerationReference: id(6),
        afterCreatedAt: at,
        afterWorkItemReference: id(current),
      },
    });
  });
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.fetcher).toHaveBeenCalledTimes(4);
});

it("rejects a response for a different selected Store", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(
    response({ ...metadata, storeReference: id(98), items: [item()], nextCursor: null }),
  );
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
});
