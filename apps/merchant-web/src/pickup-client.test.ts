import { expect, it, vi } from "vitest";
import { createPickupClient } from "./pickup-client.js";
import { parsePickupQueueView, pickupItemLabel } from "./pickup.js";
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-19T12:00:00.000Z";
const item = () => ({
  fulfillmentReference: id(1),
  orderReference: id(2),
  phase: "Ready",
  readyAt: at,
  aggregateVersion: "9007199254740993",
  publicOrderReference: "A".repeat(22),
  proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-09-19T13:00:00.000Z" },
  items: [
    {
      fulfillmentItemReference: id(3),
      orderedQuantity: 2,
      readyQuantity: 2,
      handedOverQuantity: 0,
    },
  ],
});
const page = () => ({
  source: "CurrentFulfillment",
  storeReference: id(99),
  observedAt: at,
  items: [item()],
  nextAfterFulfillmentReference: null,
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
function setup() {
  const fetcher = vi.fn<typeof fetch>();
  return {
    fetcher,
    client: createPickupClient({
      csrf: "a".repeat(43),
      storeReference: id(99),
      storeLabel: "Training Store",
      fetcher,
    }),
  };
}
it("maps actual versions and quantities without inventing missing display or safety facts", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(response(page()));
  const view = parsePickupQueueView(await f.client.loadQueue());
  expect(view.items[0]).toMatchObject({
    publicOrderNumber: null,
    packageCount: null,
    allergenCue: "Unavailable",
    exceptionStatus: "Unavailable",
    proofReadiness: "Ready",
    execution: {
      aggregateVersion: "9007199254740993",
      items: [{ orderedQuantity: 2, handedOverQuantity: 0 }],
    },
  });
  expect(f.fetcher.mock.calls[0]?.[1]).toMatchObject({
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "X-BOP-CSRF": "a".repeat(43) },
  });
});
it("requests one scoped page and preserves an advancing empty page after concurrent completions", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(
    response({ ...page(), items: [], nextAfterFulfillmentReference: id(3) }),
  );
  const view = parsePickupQueueView(
    await f.client.loadQueue({ afterFulfillmentReference: id(1), includeCompleted: true }),
  );
  expect(view.nextAfterFulfillmentReference).toBe(id(3));
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toEqual({
    afterFulfillmentReference: id(1),
    limit: 50,
    includeCompleted: true,
  });
});
it("rejects another Store, unsafe versions, duplicate records and nonadvancing cursor", async () => {
  const f = setup();
  // Another Store's answer is a scope loss, so the screen clears instead of keeping stale data.
  f.fetcher.mockResolvedValueOnce(response({ ...page(), storeReference: id(98) }));
  await expect(
    f.client.loadQueue({ afterFulfillmentReference: id(1), includeCompleted: false }),
  ).rejects.toMatchObject({ code: "PermissionDenied" });
  for (const value of [
    { ...page(), items: [{ ...item(), aggregateVersion: 9007199254740992 }] },
    { ...page(), items: [item(), item()] },
    { ...page(), nextAfterFulfillmentReference: id(1) },
  ]) {
    f.fetcher.mockResolvedValueOnce(response(value));
    await expect(
      f.client.loadQueue({ afterFulfillmentReference: id(1), includeCompleted: false }),
    ).rejects.toMatchObject({ code: "Unavailable" });
  }
});
it("does not mark an expired proof ready", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(
    response({ ...page(), items: [{ ...item(), proof: { ...item().proof, expiresAt: at } }] }),
  );
  // WP-2423: an expired proof is not ready; staff check the customer in person instead.
  expect(parsePickupQueueView(await f.client.loadQueue()).items[0]?.proofReadiness).toBe("Expired");
});
it.each([
  [403, "PermissionDenied"],
  [404, "NotFound"],
  [409, "Conflict"],
  [503, "Unavailable"],
] as const)("maps %s without response leakage", async (status, code) => {
  const f = setup();
  f.fetcher.mockResolvedValue(response({ private: "not displayed" }, status));
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code });
});
it("does not automatically replay failed reads", async () => {
  const f = setup();
  f.fetcher.mockRejectedValue(new TypeError("network"));
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Offline" });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it("preserves configured workstation without inventing one when absent", async () => {
  const f = setup();
  f.fetcher.mockResolvedValueOnce(response(page()));
  expect(parsePickupQueueView(await f.client.loadQueue()).workstation).toBeNull();
  const workstation = { deviceReference: id(10), pickupLocationReference: id(11) };
  f.fetcher.mockResolvedValueOnce(response({ ...page(), workstation }));
  expect(parsePickupQueueView(await f.client.loadQueue()).workstation).toEqual(workstation);
  f.fetcher.mockResolvedValueOnce(
    response({ ...page(), workstation: { ...workstation, completionAllowed: true } }),
  );
  await expect(f.client.loadQueue()).rejects.toMatchObject({ code: "Unavailable" });
});
it("WP-2423: shows the Store's order number on the pickup card when the server gives one", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(
    response({
      ...page(),
      items: [
        { ...item(), orderNumber: "15" },
        { ...item(), fulfillmentReference: id(4), orderNumber: "<b>" },
      ],
    }),
  );
  const view = parsePickupQueueView(await f.client.loadQueue());
  expect(view.items.map((card) => card.publicOrderNumber)).toEqual(["15", null]);
});
it("WP-2423: a still-valid code locked after five wrong codes reads as Locked (check in person)", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(
    response({ ...page(), items: [{ ...item(), codeChecksLocked: true }] }),
  );
  expect(parsePickupQueueView(await f.client.loadQueue()).items[0]?.proofReadiness).toBe("Locked");
  f.fetcher.mockResolvedValue(
    response({
      ...page(),
      observedAt: "2026-09-19T13:00:00.000Z",
      items: [{ ...item(), codeChecksLocked: true }],
    }),
  );
  // Once the code has expired anyway, it reads as expired.
  expect(parsePickupQueueView(await f.client.loadQueue()).items[0]?.proofReadiness).toBe("Expired");
});
it("WP-2423: carries the counter order mark so the card offers the in-person handover", async () => {
  const f = setup();
  f.fetcher.mockResolvedValue(
    response({
      ...page(),
      items: [
        { ...item(), proof: null, takenAtCounter: true },
        { ...item(), fulfillmentReference: id(4), orderReference: id(5), takenAtCounter: false },
      ],
    }),
  );
  const view = parsePickupQueueView(await f.client.loadQueue());
  expect(view.items[0]).toMatchObject({ proofReadiness: "NotIssued", takenAtCounter: true });
  expect(view.items[1]).toMatchObject({ proofReadiness: "Ready" });
  expect(view.items[1]).not.toHaveProperty("takenAtCounter");
});
it("WP-2423: keeps each item's name and options for the handoff and refuses unsafe names", async () => {
  const named = () => ({
    ...item(),
    items: [
      {
        ...item().items[0],
        name: "Latte",
        options: [
          { name: "Oat milk", quantity: 1 },
          { name: "Extra shot", quantity: 2 },
        ],
      },
    ],
  });
  const f = setup();
  f.fetcher.mockResolvedValue(response({ ...page(), items: [named()] }));
  const view = parsePickupQueueView(await f.client.loadQueue());
  const line = view.items[0]?.execution?.items[0];
  expect(line).toMatchObject({ name: "Latte" });
  expect(line && pickupItemLabel(line, 0)).toBe("Latte (Oat milk, 2 × Extra shot)");
  // Unnamed items (an older server, or a snapshot that could not be read) keep a position.
  expect(pickupItemLabel({}, 1)).toBe("Item 2");
  const g = setup();
  const unsafe = named();
  (unsafe.items[0] as { name: string }).name = "Latte\u0000";
  g.fetcher.mockResolvedValue(response({ ...page(), items: [unsafe] }));
  await expect(g.client.loadQueue()).rejects.toThrow();
});
