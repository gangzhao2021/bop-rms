import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createDiningProgressClient,
  parseDiningProgress,
  servableQuantity,
} from "./dining-progress-client.js";
import { DiningProgressView } from "./DiningOrderProgress.js";
import { readyToServe, serveLines } from "./DiningServeReadyAction.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
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
  expect(html).toContain("Round 1");
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
    // WP-2423 item 2: a missing order is told apart from a connection problem.
    code:
      status === 401 || status === 403
        ? "PermissionDenied"
        : status === 404
          ? "NotFound"
          : "Unavailable",
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
  expect(html).toContain("Table closing");
  expect(action).not.toHaveBeenCalled();
});
it.each([
  { sessionPhase: "Cancelled" },
  { sessionPhase: undefined },
  { diningSessionReference: "invalid" },
])("rejects unavailable session state %j", (change) => {
  expect(() => parseDiningProgress({ ...view(), ...change }, id(1))).toThrow();
});

it("v15 2026-10-16: speaks store time and staff words, and shows each line's options and note", () => {
  const parsed = parseDiningProgress(
    {
      ...view(),
      items: [
        {
          ...item,
          phase: "InProgress",
          options: [
            { name: "Small (8 oz)", quantity: 1 },
            { name: "Extra shot", quantity: 2 },
          ],
          customerNote: "Cup 3",
        },
      ],
    },
    id(1),
  );
  const html = renderToStaticMarkup(
    <StoreTimeZoneContext.Provider value="America/Toronto">
      <DiningProgressView view={parsed} />
    </StoreTimeZoneContext.Provider>,
  );
  expect(html).toContain("Checked Sep 20, 7:00 AM");
  expect(html).toContain("Table open");
  expect(html).toContain("Being made · Ordered 3");
  expect(html).toContain("Small (8 oz) · Extra shot × 2");
  expect(html).toContain("Note: Cup 3");
  // The exact instant stays in the machine attributes only, never in the visible text.
  expect(html.replace(/<[^>]*>/gu, "")).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  expect(html).not.toContain("InProgress");
  expect(html).not.toContain("Active");
});
it("v15 2026-10-16: rejects malformed options or notes, and reads a line without them", () => {
  for (const change of [
    { options: [{ name: "", quantity: 1 }], customerNote: null },
    { options: [{ name: "Small", quantity: 0 }], customerNote: null },
    { options: "Small", customerNote: null },
    { options: [], customerNote: 3 },
  ])
    expect(() =>
      parseDiningProgress({ ...view(), items: [{ ...item, ...change }] }, id(1)),
    ).toThrow();
  expect(parseDiningProgress(view(), id(1)).items[0]?.details).toBeUndefined();
});
it("v15 2026-10-16: the serve confirmation merges identical lines without a note only", () => {
  const line = (n: number, name: string, options: string[], note: string | null, round = 1) => ({
    ...item,
    orderItemReference: id(100 + n),
    itemOrdinal: n,
    batchSequence: round,
    displayName: name,
    orderedQuantity: 1,
    deliveredQuantity: 0,
    remainingQuantity: 1,
    options: options.map((name) => ({ name, quantity: 1 })),
    customerNote: note,
  });
  const parsed = parseDiningProgress(
    {
      ...view(),
      items: [
        line(1, "Flat White", ["Small (8 oz)"], null),
        line(2, "Flat White", ["Small (8 oz)"], "Cup 3"),
        line(3, "Flat White", ["Small (8 oz)"], null),
        line(4, "Flat White", ["Large (12 oz)"], null),
        line(5, "Flat White", ["Small (8 oz)"], null),
        { ...item, orderItemReference: id(106), itemOrdinal: 6, displayName: "Flat White" },
      ],
    },
    id(1),
  );
  expect(
    serveLines(parsed.items, false).map((entry) => [
      entry.quantity,
      entry.name,
      entry.options,
      entry.note,
    ]),
  ).toEqual([
    [3, "Flat White", "Small (8 oz)", null],
    [1, "Flat White", "Small (8 oz)", "Cup 3"],
    [1, "Flat White", "Large (12 oz)", null],
    // Options unknown: never merged with another line.
    [2, "Flat White", "", null],
  ]);
  // By table, rounds stay apart.
  const rounds = parseDiningProgress(
    {
      ...view(),
      items: [line(1, "Tea", [], null, 1), line(2, "Tea", [], null, 2)],
    },
    id(1),
  );
  expect(serveLines(rounds.items, true).map((entry) => entry.quantity)).toEqual([1, 1]);
  expect(serveLines(rounds.items, false).map((entry) => entry.quantity)).toEqual([2]);
});
it("WP-2423 (2026-10-18): a line the kitchen is remaking says so plainly and is not offered for serving", () => {
  const parsed = parseDiningProgress(
    {
      ...view(),
      items: [
        { ...item, remakingQuantity: 2 },
        { ...item, orderItemReference: id(4), displayName: "Second meal", remakingQuantity: 0 },
      ],
    },
    id(1),
  );
  const html = renderToStaticMarkup(<DiningProgressView view={parsed} />);
  expect(html).toContain("Remaking — kitchen is making it again");
  expect(html).toContain("(2 of them)");
  expect(html).toContain("tell the guest it&#x27;s being remade");
  expect(html.match(/Remaking —/gu)).toHaveLength(1);
  expect(html).toContain("Being remade · Ordered 3");
  expect(html).toContain("Ready to serve · Ordered 3");
  expect(readyToServe(parsed).map((line) => line.displayName)).toEqual(["Second meal"]);
  // Part of a line: what is left less the remade portions.
  const partial = parseDiningProgress(
    { ...view(), items: [{ ...item, remakingQuantity: 1 }] },
    id(1),
  );
  expect(servableQuantity(partial.items[0] as (typeof partial.items)[number])).toBe(1);
  expect(serveLines(readyToServe(partial), false)).toMatchObject([{ quantity: 1 }]);
  // An older source without the field: nothing is being remade.
  expect(servableQuantity(parseDiningProgress(view(), id(1)).items[0] as never)).toBe(2);
  expect(() =>
    parseDiningProgress({ ...view(), items: [{ ...item, remakingQuantity: 4 }] }, id(1)),
  ).toThrow();
});
