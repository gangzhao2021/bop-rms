import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDiningProgressClient, parseDiningProgress } from "./dining-progress-client.js";
import { DiningProgressView } from "./DiningOrderProgress.js";
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const item = {
  displayName: "DEMO meal",
  batchSequence: 1,
  itemOrdinal: 1,
  orderItemReference: id(2),
  orderBatchReference: id(3),
  phase: "Ready",
  orderedQuantity: 3,
  deliveredQuantity: 1,
  remainingQuantity: 2,
  itemServiceVersion: 1,
};
const view = () => ({
  orderReference: id(1),
  tableLabel: "T1",
  sessionVersion: 2,
  diningSessionReference: id(55),
  sessionPhase: "Active",
  tableAssignmentVersion: 3,
  closureStatus: "Open",
  closureVersion: 0,
  currentOrderVersion: 4,
  orderVersion: 3,
  phase: "Ready",
  observedAt: "2026-09-20T11:00:00.000Z",
  items: [{ ...item }],
});
it("shows partial service honestly and excludes private response fields", () => {
  const parsed = parseDiningProgress({ ...view(), guestSessionReference: "private" }, id(1));
  const html = renderToStaticMarkup(<DiningProgressView view={parsed} />);
  expect(html).toContain("DEMO meal");
  expect(html).toContain("Table T1");
  expect(html).toContain("Batch 1");
  expect(html).toContain("Served 1");
  expect(html).toContain("Remaining 2");
  expect(html).not.toContain("private");
  expect(html).not.toContain(id(2));
});
it.each([
  { deliveredQuantity: 4 },
  { remainingQuantity: 1 },
  { phase: "Fulfilled" },
  { orderedQuantity: 1.5 },
  { itemServiceVersion: -1 },
])("rejects inconsistent item quantities/version %j", (change) => {
  expect(() =>
    parseDiningProgress({ ...view(), items: [{ ...item, ...change }] }, id(1)),
  ).toThrow();
});
it("rejects another Order and duplicate items", () => {
  expect(() => parseDiningProgress(view(), id(9))).toThrow();
  expect(() => parseDiningProgress({ ...view(), items: [item, item] }, id(1))).toThrow();
});
it("sends only Order reference using protected no-store POST", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(view()), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
  );
  await createDiningProgressClient(fetcher).load(id(1), "A".repeat(43));
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/dining/order-progress",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: JSON.stringify({ orderReference: id(1) }),
    }),
  );
});
it.each([401, 403, 404, 503])("handles HTTP %i without displaying payload", async (status) => {
  const client = createDiningProgressClient(vi.fn(async () => new Response("private", { status })));
  await expect(client.load(id(1), "A".repeat(43))).rejects.toMatchObject({
    code: status === 401 || status === 403 ? "PermissionDenied" : "Unavailable",
  });
});
it("rejects cacheable responses and already-aborted requests", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(JSON.stringify(view()), { headers: { "content-type": "application/json" } }),
  );
  const client = createDiningProgressClient(fetcher);
  await expect(client.load(id(1), "A".repeat(43))).rejects.toThrow();
  fetcher.mockClear();
  const controller = new AbortController();
  controller.abort();
  await expect(client.load(id(1), "A".repeat(43), controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([null, "", "x\nsecret"])("rejects unavailable or invalid table label %j", (tableLabel) => {
  expect(() => parseDiningProgress({ ...view(), tableLabel }, id(1))).toThrow();
});

it("renders closed history without invoking serving actions", () => {
  const parsed = parseDiningProgress(
    { ...view(), closureStatus: "Closed", closureVersion: 1 },
    id(1),
  );
  const action = vi.fn(() => <button>Serve</button>);
  const html = renderToStaticMarkup(<DiningProgressView view={parsed} action={action} />);
  expect(html).toContain("Order closed. Serving history is read-only.");
  expect(html).toContain("DEMO meal");
  expect(action).not.toHaveBeenCalled();
});
it.each([
  { closureStatus: undefined },
  { closureStatus: "Unknown" },
  { closureStatus: "Closed", closureVersion: 0 },
  { closureVersion: -1 },
  { currentOrderVersion: 0 },
])("rejects missing or invalid closure state %j", (change) => {
  expect(() => parseDiningProgress({ ...view(), ...change }, id(1))).toThrow();
});

it("shows actual Closing phase and does not invoke serving controls", () => {
  const parsed = parseDiningProgress({ ...view(), sessionPhase: "Closing" }, id(1));
  const action = vi.fn(() => <button>Serve</button>);
  const html = renderToStaticMarkup(<DiningProgressView view={parsed} action={action} />);
  expect(html).toContain("Closing");
  expect(action).not.toHaveBeenCalled();
});
it.each([
  { sessionPhase: "Cancelled" },
  { sessionPhase: undefined },
  { diningSessionReference: "invalid" },
])("rejects unavailable session state %j", (change) => {
  expect(() => parseDiningProgress({ ...view(), ...change }, id(1))).toThrow();
});
