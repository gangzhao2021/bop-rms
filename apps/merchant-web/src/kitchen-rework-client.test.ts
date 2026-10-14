import { describe, expect, it, vi } from "vitest";
import { notReadyOffered } from "./KitchenRework.js";
import {
  createKitchenReworkClient,
  kitchenReworkBadge,
  KitchenReworkClientError,
} from "./kitchen-rework-client.js";

const id = (n: number) => "018f0f58-767a-7f3b-a1d0-" + n.toString(16).padStart(12, "0");
const csrf = "a".repeat(43);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const view = {
  reworkReference: id(1),
  originalWorkItemReference: id(2),
  orderReference: id(3),
  orderItemReference: id(4),
  reasonCode: "CUSTOMER_RETURNED",
  note: null,
  quantity: 1,
  wasteApplies: true,
  status: "Queued",
  version: 1,
  createdAt: "2026-10-14T12:00:00.000Z",
  startedAt: null,
  completedAt: null,
  displayName: "Noodle bowl",
  selectedOptions: [],
  orderLabel: { orderNumber: "7", orderType: "Pickup", tableLabel: null },
  customerNote: null,
  allergens: { status: "Unavailable" },
};

describe("WP-2423 Q26 kitchen rework client", () => {
  it("reads the Store's remakes and refuses another Store's answer", async () => {
    const fetcher = vi.fn(async () =>
      json({ storeReference: id(9), observedAt: view.createdAt, canRework: true, items: [view] }),
    );
    const client = createKitchenReworkClient({ csrf, storeReference: id(9), fetcher });
    const board = await client.load();
    expect(board.items[0]).toMatchObject({
      reasonCode: "CUSTOMER_RETURNED",
      displayName: "Noodle bowl",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/merchant/kitchen/rework/query",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    await expect(
      createKitchenReworkClient({ csrf, storeReference: id(8), fetcher }).load(),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
  });
  it("hides remakes where the source does not offer them", async () => {
    const client = createKitchenReworkClient({
      csrf,
      storeReference: id(9),
      fetcher: vi.fn(async () => new Response("", { status: 404 })),
    });
    await expect(client.load()).rejects.toMatchObject({ code: "NotOffered" });
  });
  it("sends one body per intent and names a closed correction window", async () => {
    const body = {
      action: "CreateKitchenRework" as const,
      idempotencyKey: id(20),
      originalWorkItemReference: id(2),
      reasonCode: "NOT_READY" as const,
      note: null,
      quantity: 1,
      correlationReference: id(21),
    };
    const fetcher = vi.fn(async () => json({ error: "KITCHEN_REWORK_WINDOW_CLOSED" }, 422));
    const client = createKitchenReworkClient({ csrf, storeReference: id(9), fetcher });
    await expect(client.execute(body)).rejects.toMatchObject({ code: "WindowClosed" });
    expect(
      JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toEqual(body);
    fetcher.mockImplementation(async () => {
      throw new TypeError("network");
    });
    await expect(client.execute(body)).rejects.toBeInstanceOf(KitchenReworkClientError);
    await expect(client.execute(body)).rejects.toMatchObject({ code: "OutcomeUnknown" });
  });
  it("words each reason for staff and offers 'not ready yet' only within two minutes", () => {
    expect(kitchenReworkBadge("WRONG_ITEM")).toBe("Remake · Made wrong");
    expect(kitchenReworkBadge("NOT_READY")).toBe("Back in progress · Marked done too early");
    const item = {
      execution: { readyAt: "2026-10-14T12:00:00.000Z" },
    } as unknown as Parameters<typeof notReadyOffered>[0];
    expect(notReadyOffered(item, "2026-10-14T12:01:59.000Z")).toBe(true);
    expect(notReadyOffered(item, "2026-10-14T12:02:01.000Z")).toBe(false);
  });
});
