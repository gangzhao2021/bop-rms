import { expect, it, vi } from "vitest";
import {
  cancelledItemsRefund,
  createCurrentOrderQueueClient,
  CurrentOrderQueueError,
  isAwaitingAcceptance,
  ordersAwaitingAcceptance,
  parseCurrentOrderDetail,
  parseCurrentOrderQueue,
} from "./current-order-queue-client.js";
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const row = (n = 1) => ({
  orderReference: id(n),
  orderNumber: "ORD-1001",
  orderType: "Pickup",
  sourceChannel: "Web",
  submittedAt: "2026-09-14T00:00:00.000Z",
  observedAt: "2026-09-14T00:01:00.000Z",
  initialBatchReference: id(90),
  batches: [
    {
      orderBatchReference: id(90),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  currentPhase: "Accepted",
  currentVersion: 2,
});
it("preserves current version and validates newest-first pagination", () => {
  // WP-2423: newest first; the next page continues with older Orders.
  const items = Array.from({ length: 50 }, (_, i) => row(60 - i));
  expect(
    parseCurrentOrderQueue({ items, nextAfterOrderReference: id(11) }).items[0]?.currentVersion,
  ).toBe(2);
  expect(() => parseCurrentOrderQueue({ items, nextAfterOrderReference: id(12) })).toThrow();
  expect(() =>
    parseCurrentOrderQueue({ items: [row(1), row(2)], nextAfterOrderReference: null }),
  ).toThrow();
  expect(() =>
    parseCurrentOrderQueue({ items: [row(2)], nextAfterOrderReference: null }, id(1)),
  ).toThrow();
});
it("WP-2423 (2026-10-16 v15): a full page with earlier-day Orders holding stock still reads", () => {
  // The v15 answer that blanked the Orders page: 50 Orders of the page with a next page, plus 18
  // Orders of earlier days whose stock is still set aside (listed first, under today).
  const dated = (n: number, businessDate: string) => ({
    ...row(n),
    businessDate,
    listedBusinessDate: businessDate,
    heldStock: null,
  });
  const page = Array.from({ length: 50 }, (_, i) => dated(200 - i, "2026-10-14"));
  const held = Array.from({ length: 18 }, (_, i) => ({
    ...dated(300 + i, "2026-09-20"),
    listedBusinessDate: "2026-10-15",
    heldStock: {
      since: "2026-09-20T04:09:28.342Z",
      state: "Ended",
      orderBatchReference: id(90),
      productionStarted: false,
    },
  }));
  const next = id(151);
  const view = parseCurrentOrderQueue({
    earlierDayItems: held,
    items: page,
    nextAfterOrderReference: next,
  });
  expect(view.items).toHaveLength(68);
  expect(view.items.slice(0, 18).every((item) => item.heldStock?.state === "Ended")).toBe(true);
  expect(view.items[18]?.orderReference).toBe(id(200));
  expect(view.nextAfterOrderReference).toBe(next);
  // An older server mixed them in one list (as captured on v15): still read, not blanked.
  expect(
    parseCurrentOrderQueue({ items: [...held, ...page], nextAfterOrderReference: next }).items,
  ).toHaveLength(68);
  // ... including a page it shortened by leaving earlier-day Orders out of it.
  expect(
    parseCurrentOrderQueue({
      items: [...held, ...page.slice(0, 47)],
      nextAfterOrderReference: id(154),
    }).items,
  ).toHaveLength(65);
  // Genuinely broken answers still fail: a short page with a next page, a next page that does not
  // continue after the page, an Order listed twice, earlier-day Orders on a later page.
  for (const broken of [
    { earlierDayItems: held, items: page.slice(0, 49), nextAfterOrderReference: id(152) },
    { earlierDayItems: held, items: page, nextAfterOrderReference: id(150) },
    { earlierDayItems: [page[0]], items: page, nextAfterOrderReference: next },
    { earlierDayItems: held.concat(held[0] ?? []), items: page, nextAfterOrderReference: next },
  ])
    expect(() => parseCurrentOrderQueue(broken)).toThrow();
  expect(() =>
    parseCurrentOrderQueue(
      { earlierDayItems: held, items: page, nextAfterOrderReference: null },
      id(400),
    ),
  ).toThrow();
  expect(
    parseCurrentOrderQueue(
      { earlierDayItems: [], items: page, nextAfterOrderReference: null },
      id(400),
    ).items,
  ).toHaveLength(50);
});
it.each([
  { ...row(), canRequestAcceptance: true },
  { ...row(), canRequestAcceptance: "true" },
  { ...row(), canRequestAcceptance: true, currentPhase: "Submitted", currentVersion: 2 },
  { ...row(), currentVersion: null },
  { ...row(), guestSessionReference: id(99) },
  { ...row(), currentPhase: "Invented" },
  { ...row(), currentVersion: 1.5 },
  { ...row(), observedAt: "2026-09-13T00:00:00.000Z" },
])("rejects inconsistent or private fields", (item) => {
  expect(() => parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null })).toThrow();
});
it("keeps unresolved states explicit", () => {
  const parsed = parseCurrentOrderQueue({
    items: [{ ...row(), currentVersion: null, currentPhase: null }],
    nextAfterOrderReference: null,
  });
  expect(parsed.items[0]?.currentPhase).toBeNull();
});
it("uses same-origin no-store GET and only cursor in URL", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ items: [row(1)], nextAfterOrderReference: null }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  await createCurrentOrderQueueClient(fetcher).load(id(2), new AbortController().signal);
  expect(fetcher).toHaveBeenCalledWith(
    "/merchant/orders?after=" + id(2),
    expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    }),
  );
});
it("discards response after cancellation", async () => {
  const context = new AbortController();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    context.abort();
    return new Response(JSON.stringify({ items: [], nextAfterOrderReference: null }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  });
  await expect(
    createCurrentOrderQueueClient(fetcher).load(null, context.signal),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("sanitizes denied responses", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private", { status: 403 }));
  await expect(
    createCurrentOrderQueueClient(fetcher).load(null, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "PermissionDenied",
    message: "Current orders could not be loaded",
  });
});

it.each(
  [
    [
      {
        orderBatchReference: id(90),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: true,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    [
      {
        orderBatchReference: id(90),
        sequence: 2,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    [row().batches[0], row().batches[0]],
  ].map((batches) => ({ batches })),
)("rejects inconsistent batch sequence or capability", ({ batches }) => {
  expect(() =>
    parseCurrentOrderQueue({ items: [{ ...row(), batches }], nextAfterOrderReference: null }),
  ).toThrow();
});

it.each(["InProgress", "Ready"])(
  "preserves %s and server-owned additional-batch capability",
  (currentPhase) => {
    for (const canRequestAcceptance of [false, true]) {
      const item = {
        ...row(),
        orderType: "DineIn",
        currentPhase,
        currentVersion: 5,
        batches: [
          ...row().batches,
          {
            orderBatchReference: id(91),
            sequence: 2,
            acceptanceStatus: "NotAccepted",
            canRequestAcceptance,
            canCancel: false,
            staffCancellation: null,
            canCancelItems: false,
          },
        ],
      };
      const parsed = parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null })
        .items[0];
      expect(parsed?.currentPhase).toBe(currentPhase);
      expect(parsed?.canRequestAcceptance).toBe(false);
      expect(parsed?.batches[1]?.canRequestAcceptance).toBe(canRequestAcceptance);
    }
  },
);

it.each(["Fulfilled", "Rejected", "Cancelled"])(
  "rejects additional acceptance in terminal %s",
  (currentPhase) => {
    const item = {
      ...row(),
      currentPhase,
      batches: [
        ...row().batches,
        {
          orderBatchReference: id(91),
          sequence: 2,
          acceptanceStatus: "NotAccepted",
          canRequestAcceptance: true,
          canCancel: false,
          staffCancellation: null,
          canCancelItems: false,
        },
      ],
    };
    expect(() =>
      parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }),
    ).toThrow();
  },
);

it.each(["Accepted", "InProgress", "Ready"])(
  "rejects initial-batch acceptance after %s even with forged version one",
  (currentPhase) => {
    const item = {
      ...row(),
      currentPhase,
      currentVersion: 1,
      batches: [
        { ...row().batches[0], acceptanceStatus: "NotAccepted", canRequestAcceptance: true },
      ],
    };
    expect(() =>
      parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }),
    ).toThrow();
  },
);

it.each([
  ["a later round awaiting payment", "NotAccepted", "Submitted"],
  ["a later round cancelled", "Cancelled", "Submitted"],
  ["a later round accepted first", "Accepted", "Accepted"],
])(
  "WP-2423 (v15 order 7): a table's paid first round stays acceptable with %s",
  (_case, laterStatus, currentPhase) => {
    const item = {
      ...row(),
      orderType: "DineIn",
      currentPhase,
      currentVersion: 3,
      batches: [
        { ...row().batches[0], acceptanceStatus: "NotAccepted", canRequestAcceptance: true },
        {
          orderBatchReference: id(91),
          sequence: 2,
          acceptanceStatus: laterStatus,
          canRequestAcceptance: false,
          canCancel: false,
          staffCancellation: null,
          canCancelItems: false,
        },
      ],
    };
    const parsed = parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null });
    expect(parsed.items[0]?.batches[0]?.canRequestAcceptance).toBe(true);
    const order = parsed.items[0];
    if (!order) throw new Error("fixture");
    expect(isAwaitingAcceptance(order)).toBe(true);
    expect(ordersAwaitingAcceptance(parsed)).toBe(1);
    // A pickup order's only round is never acceptable once something else changed the Order.
    expect(() =>
      parseCurrentOrderQueue({
        items: [{ ...item, orderType: "Pickup", batches: [item.batches[0]] }],
        nextAfterOrderReference: null,
      }),
    ).toThrow();
  },
);

it("preserves cancelled Batch and refuses a contradictory acceptance action", () => {
  const item = {
    ...row(),
    orderType: "DineIn",
    batches: [
      ...row().batches,
      {
        orderBatchReference: id(91),
        sequence: 2,
        acceptanceStatus: "Cancelled",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
  };
  expect(
    parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }).items[0]?.batches[1]
      ?.acceptanceStatus,
  ).toBe("Cancelled");
  expect(() =>
    parseCurrentOrderQueue({
      items: [
        { ...item, batches: [item.batches[0], { ...item.batches[1], canRequestAcceptance: true }] },
      ],
      nextAfterOrderReference: null,
    }),
  ).toThrow();
});

it("accepts terminal cancellation without actionable batches but refuses empty live phases", () => {
  const cancelled = { ...row(), orderType: "DineIn", currentPhase: "Cancelled", batches: [] };
  expect(
    parseCurrentOrderQueue({ items: [cancelled], nextAfterOrderReference: null }).items[0],
  ).toMatchObject({
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Cancelled",
    currentVersion: 2,
    batches: [],
    canRequestAcceptance: false,
  });
  for (const currentPhase of ["Submitted", "Accepted", "InProgress", "Ready", "Fulfilled"])
    expect(() =>
      parseCurrentOrderQueue({
        items: [{ ...cancelled, currentPhase }],
        nextAfterOrderReference: null,
      }),
    ).toThrow();
  expect(() =>
    parseCurrentOrderQueue({
      items: [{ ...cancelled, canRequestAcceptance: true }],
      nextAfterOrderReference: null,
    }),
  ).toThrow();
});
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const line = (n: number) => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(90),
  name: "Mocha — Regular (12 oz)",
  options: [{ name: "Oat milk", quantity: 1 }],
  quantity: 1,
  customerNote: n === 1 ? "No whipped cream" : null,
  unitPrice: money("600"),
  subtotal: money("600"),
  discount: money("0"),
  tax: money("78"),
  fee: money("0"),
  total: money("678"),
  canCancel: false,
  cancellation: null as unknown,
});
const detail = () => ({
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order: row(1),
  lines: {
    items: [line(1)],
    totals: {
      subtotal: money("600"),
      discount: money("0"),
      tax: money("78"),
      fee: money("0"),
      total: money("678"),
    },
  },
});
it("WP-2423: reads one order's detail with its lines and refuses a different order", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(detail()), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    }),
  );
  const parsed = await createCurrentOrderQueueClient(fetcher).loadDetail(
    id(1),
    new AbortController().signal,
  );
  expect(fetcher).toHaveBeenCalledWith("/merchant/orders/detail?order=" + id(1), expect.anything());
  expect(parsed.order.orderNumber).toBe("ORD-1001");
  expect(parsed.lines.items[0]?.options).toEqual([{ name: "Oat milk", quantity: 1 }]);
  expect(parsed.lines.totals.total).toEqual(money("678"));
  expect(() => parseCurrentOrderDetail(detail(), id(2))).toThrow();
  expect(() =>
    parseCurrentOrderDetail(
      { ...detail(), lines: { ...detail().lines, items: [{ ...line(1), total: 6.78 }] } },
      id(1),
    ),
  ).toThrow();
  const missing = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 404 }));
  await expect(
    createCurrentOrderQueueClient(missing).loadDetail(id(1), new AbortController().signal),
  ).rejects.toMatchObject({ code: "NotFound" });
});
it("WP-2423 Q1: accepts an acceptance deadline only on a paid pickup still awaiting acceptance", () => {
  const awaiting = {
    ...row(),
    currentPhase: "Submitted",
    currentVersion: 1,
    canRequestAcceptance: true,
    batches: [{ ...row().batches[0], acceptanceStatus: "NotAccepted", canRequestAcceptance: true }],
    acceptBy: "2026-09-14T00:30:00.000Z",
    awaitingPayment: false,
  };
  expect(
    parseCurrentOrderQueue({ items: [awaiting], nextAfterOrderReference: null }).items[0]?.acceptBy,
  ).toBe("2026-09-14T00:30:00.000Z");
  for (const item of [
    { ...awaiting, orderType: "DineIn" },
    { ...row(), acceptBy: "2026-09-14T00:30:00.000Z" },
    { ...awaiting, acceptBy: "2026-09-13T23:59:00.000Z" },
    { ...awaiting, acceptBy: "soon" },
    { ...awaiting, acceptBy: undefined },
  ])
    expect(() =>
      parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }),
    ).toThrow();
});
it("WP-2423 Q9-G1: reads a held order (paid during an outage) and refuses contradictions", () => {
  const hold = {
    holdReference: "0190fa46-0000-7000-8000-0000000000a1",
    orderBatchReference: row().batches[0]?.orderBatchReference,
    heldAt: "2026-09-14T00:31:00.000Z",
    lapsedDeadline: "2026-09-14T00:30:00.000Z",
    storeLastSeenAt: "2026-09-14T00:10:00.000Z",
    decideBy: null,
    refundChosen: false,
    canRefund: true,
  };
  const held = {
    ...row(),
    currentPhase: "Submitted",
    currentVersion: 1,
    canRequestAcceptance: true,
    batches: [{ ...row().batches[0], acceptanceStatus: "NotAccepted", canRequestAcceptance: true }],
    acceptBy: null,
    acceptanceHold: hold,
    awaitingPayment: false,
  };
  expect(
    parseCurrentOrderQueue({ items: [held], nextAfterOrderReference: null }).items[0]
      ?.acceptanceHold,
  ).toEqual(hold);
  const resumed = {
    ...held,
    acceptBy: "2026-09-14T01:15:00.000Z",
    acceptanceHold: { ...hold, decideBy: "2026-09-14T01:15:00.000Z" },
  };
  expect(
    parseCurrentOrderQueue({ items: [resumed], nextAfterOrderReference: null }).items[0]
      ?.acceptanceHold?.decideBy,
  ).toBe("2026-09-14T01:15:00.000Z");
  expect(
    parseCurrentOrderQueue({
      items: [{ ...row(), acceptanceHold: null }],
      nextAfterOrderReference: null,
    }).items[0]?.acceptanceHold,
  ).toBeNull();
  for (const item of [
    { ...held, orderType: "DineIn" },
    { ...held, acceptBy: "2026-09-14T01:15:00.000Z" },
    { ...held, acceptanceHold: { ...hold, refundChosen: true } },
    { ...held, acceptanceHold: { ...hold, storeLastSeenAt: "2026-09-14T00:40:00.000Z" } },
    { ...held, acceptanceHold: { ...hold, extra: 1 } },
  ])
    expect(() =>
      parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }),
    ).toThrow();
});
it("WP-2423 Q6: reads staff cancellation and refuses inconsistent cancel capability", () => {
  const cancellation = {
    reasonCode: "CUSTOMER_REQUEST",
    cancelledAt: "2026-09-14T00:00:30.000Z",
    refundStatus: "Pending",
  };
  const batch = row().batches[0];
  const cancellable = { ...row(), batches: [{ ...batch, canCancel: true }] };
  expect(
    parseCurrentOrderQueue({ items: [cancellable], nextAfterOrderReference: null }).items[0]
      ?.batches[0]?.canCancel,
  ).toBe(true);
  const pickup = {
    ...row(),
    currentPhase: "Cancelled",
    currentVersion: 3,
    batches: [{ ...batch, staffCancellation: cancellation }],
  };
  // An older server without the refund method refunds online.
  expect(
    parseCurrentOrderQueue({ items: [pickup], nextAfterOrderReference: null }).items[0]?.batches[0]
      ?.staffCancellation,
  ).toEqual({ ...cancellation, refundMethod: "Online", refundAmountMinor: null });
  // WP-2423 Q7: a counter order paid on the card machine is refunded on the machine.
  const machine = { ...cancellation, refundMethod: "CardMachine", refundAmountMinor: "1280" };
  expect(
    parseCurrentOrderQueue({
      items: [
        {
          ...pickup,
          sourceChannel: "Pos",
          counter: {
            recordedAfterOutage: true,
            paidOnCardMachine: {
              amountMinor: "1280",
              takenAt: "2026-09-14T00:00:10.000Z",
              recordedAfterOutage: true,
              refundedMinor: "0",
            },
          },
          batches: [{ ...batch, staffCancellation: machine }],
        },
      ],
      nextAfterOrderReference: null,
    }).items[0],
  ).toMatchObject({
    counter: { recordedAfterOutage: true, paidOnCardMachine: { amountMinor: "1280" } },
    batches: [{ staffCancellation: machine }],
  });
  for (const bad of [
    { ...cancellation, refundMethod: "CardMachine", refundAmountMinor: null },
    { ...cancellation, refundMethod: "Online", refundAmountMinor: "1280" },
    { ...cancellation, refundMethod: "Cash", refundAmountMinor: "1" },
  ])
    expect(() =>
      parseCurrentOrderQueue({
        items: [{ ...pickup, batches: [{ ...batch, staffCancellation: bad }] }],
        nextAfterOrderReference: null,
      }),
    ).toThrow(CurrentOrderQueueError);
  // A counter record belongs to a counter (Pos) order only.
  expect(() =>
    parseCurrentOrderQueue({
      items: [{ ...row(), counter: { recordedAfterOutage: false, paidOnCardMachine: null } }],
      nextAfterOrderReference: null,
    }),
  ).toThrow(CurrentOrderQueueError);
  const dining = {
    ...row(),
    orderType: "DineIn",
    batches: [
      { ...batch, acceptanceStatus: "Cancelled", staffCancellation: cancellation },
      {
        ...batch,
        orderBatchReference: id(91),
        sequence: 2,
        canCancel: true,
      },
    ],
  };
  const parsedDining = parseCurrentOrderQueue({
    items: [dining],
    nextAfterOrderReference: null,
  }).items[0];
  expect(parsedDining?.batches[0]?.staffCancellation?.reasonCode).toBe("CUSTOMER_REQUEST");
  expect(parsedDining?.batches[1]?.canCancel).toBe(true);
  for (const item of [
    // Already cancelled batches cannot be cancelled again.
    { ...pickup, batches: [{ ...pickup.batches[0], canCancel: true }] },
    // A pickup cancelled by the Store is a cancelled order.
    { ...pickup, currentPhase: "Accepted" },
    // A dine-in batch cancelled by the Store is a cancelled batch.
    {
      ...dining,
      batches: [{ ...dining.batches[0], acceptanceStatus: "Accepted" }, dining.batches[1]],
    },
    { ...cancellable, batches: [{ ...cancellable.batches[0], canCancel: "true" }] },
    { ...cancellable, currentPhase: "Fulfilled" },
    { ...cancellable, pickupNotCollected: true },
    { ...cancellable, batches: [{ ...cancellable.batches[0], acceptanceStatus: "NotAccepted" }] },
    { ...pickup, batches: [{ ...batch, staffCancellation: { ...cancellation, reasonCode: "X" } }] },
    {
      ...pickup,
      batches: [{ ...batch, staffCancellation: { ...cancellation, refundStatus: "Failed" } }],
    },
    {
      ...pickup,
      batches: [{ ...batch, staffCancellation: { ...cancellation, actorName: "Sam" } }],
    },
    {
      ...pickup,
      batches: [
        {
          ...batch,
          staffCancellation: { ...cancellation, cancelledAt: "2026-09-13T23:00:00.000Z" },
        },
      ],
    },
    { ...row(), batches: [{ ...batch, staffCancellation: undefined }] },
  ])
    expect(() =>
      parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }),
    ).toThrow();
});
it("WP-2423 Q6 step 2: reads item cancellation capability and cancelled lines", () => {
  const batch = { ...row().batches[0], canCancelItems: true };
  const cancelled = {
    reasonCode: "SOLD_OUT",
    cancelledAt: "2026-09-14T00:00:40.000Z",
    refundStatus: "Pending",
    refund: money("452"),
  };
  const value = (items: unknown[], batches: unknown[] = [batch]) => ({
    ...detail(),
    order: { ...row(1), batches },
    lines: { ...detail().lines, items },
  });
  const parsed = parseCurrentOrderDetail(
    value([
      { ...line(1), canCancel: true },
      { ...line(2), cancellation: cancelled },
      {
        ...line(3),
        cancellation: {
          ...cancelled,
          refundStatus: "Refunded",
          refund: money("678"),
          cancellationReference: id(700),
        },
      },
    ]),
    id(1),
  );
  expect(parsed.order.batches[0]?.canCancelItems).toBe(true);
  expect(parsed.lines.items[0]?.canCancel).toBe(true);
  expect(parsed.lines.items[1]?.cancellation).toEqual({
    ...cancelled,
    cancellationReference: null,
  });
  expect(parsed.lines.items[2]?.cancellation?.cancellationReference).toBe(id(700));
  expect(cancelledItemsRefund(parsed.lines.items)).toEqual(money("1130"));
  expect(cancelledItemsRefund(parseCurrentOrderDetail(detail(), id(1)).lines.items)).toBeNull();
  for (const invalid of [
    // A cancellable line needs a batch that offers item cancellation, and vice versa.
    value([{ ...line(1), canCancel: true }], [row().batches[0]]),
    value([line(1)]),
    // A cancelled line cannot be cancelled again.
    value([{ ...line(1), canCancel: true, cancellation: cancelled }]),
    value([
      { ...line(1), canCancel: "true" },
      { ...line(2), canCancel: true },
    ]),
    value([
      { ...line(1), canCancel: true },
      { ...line(2), cancellation: { ...cancelled, refundStatus: "Failed" } },
    ]),
    value([
      { ...line(1), canCancel: true },
      { ...line(2), cancellation: { ...cancelled, reasonCode: "X" } },
    ]),
    value([
      { ...line(1), canCancel: true },
      { ...line(2), cancellation: { ...cancelled, refund: money("-1") } },
    ]),
    value([
      { ...line(1), canCancel: true },
      {
        ...line(2),
        cancellation: { ...cancelled, refund: { amountMinor: "1", currencyCode: "USD" } },
      },
    ]),
    value([
      { ...line(1), canCancel: true },
      { ...line(2), cancellation: { ...cancelled, cancelledAt: "2026-09-13T23:00:00.000Z" } },
    ]),
    value([
      { ...line(1), canCancel: true },
      { ...line(2), cancellation: { ...cancelled, actorName: "Sam" } },
    ]),
    value([
      { ...line(1), canCancel: true },
      { ...line(2), cancellation: { ...cancelled, cancellationReference: "not-a-reference" } },
    ]),
    value([{ ...line(1), canCancel: true, cancellation: undefined }]),
  ])
    expect(() => parseCurrentOrderDetail(invalid, id(1))).toThrow();
  // Items of a batch the Store cancelled as a whole, or not yet accepted, cannot be offered.
  for (const item of [
    {
      ...row(),
      currentPhase: "Cancelled",
      currentVersion: 3,
      batches: [
        {
          ...batch,
          staffCancellation: {
            reasonCode: "SOLD_OUT",
            cancelledAt: "2026-09-14T00:00:30.000Z",
            refundStatus: "Pending",
          },
        },
      ],
    },
    { ...row(), batches: [{ ...batch, acceptanceStatus: "NotAccepted" }] },
    { ...row(), batches: [{ ...batch, canCancelItems: "true" }] },
    { ...row(), batches: [{ ...row().batches[0], canCancelItems: undefined }] },
  ])
    expect(() =>
      parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }),
    ).toThrow();
});
it("WP-2423: reads an unpaid dine-in round's payment due and refuses malformed or contradictory values", () => {
  const batch = row().batches[0];
  const failed = { status: "Failed", cancelsAt: "2026-09-14T00:30:00.000Z" };
  const dining = (paymentDue: unknown, overrides: Record<string, unknown> = {}) => ({
    ...row(),
    orderType: "DineIn",
    currentPhase: "Accepted",
    batches: [
      batch,
      {
        ...batch,
        orderBatchReference: id(91),
        sequence: 2,
        acceptanceStatus: "NotAccepted",
        paymentDue,
        ...overrides,
      },
    ],
  });
  const parse = (item: unknown) =>
    parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }).items[0]?.batches[1]
      ?.paymentDue;
  expect(parse(dining(failed))).toEqual(failed);
  expect(parse(dining({ status: "Awaiting", cancelsAt: null }))).toEqual({
    status: "Awaiting",
    cancelsAt: null,
  });
  // WP-2423 item 5: a round with no payment started has its cancellation time.
  expect(parse(dining({ status: "Awaiting", cancelsAt: failed.cancelsAt }))).toEqual({
    status: "Awaiting",
    cancelsAt: failed.cancelsAt,
  });
  expect(parse(dining(null))).toBeNull();
  // Older servers without the key read as nothing due.
  expect(
    parseCurrentOrderQueue({ items: [row()], nextAfterOrderReference: null }).items[0]?.batches[0]
      ?.paymentDue,
  ).toBeNull();
  for (const invalid of [
    dining(undefined),
    dining({ status: "Failed", cancelsAt: null }),
    dining({ status: "Awaiting", cancelsAt: "2026-09-13T23:59:00.000Z" }),
    dining({ status: "Pending", cancelsAt: null }),
    dining({ ...failed, extra: true }),
    dining({ status: "Failed", cancelsAt: "2026-09-14T00:30:00Z" }),
    // The deadline cannot precede the order.
    dining({ status: "Failed", cancelsAt: "2026-09-13T23:59:00.000Z" }),
    // Only an unpaid, not accepted, not cancelled dine-in round has a payment due.
    { ...dining(failed), orderType: "Pickup" },
    dining(failed, { acceptanceStatus: "Accepted" }),
    dining(failed, { acceptanceStatus: "Cancelled" }),
    dining(failed, { canRequestAcceptance: true }),
  ])
    expect(() =>
      parseCurrentOrderQueue({ items: [invalid], nextAfterOrderReference: null }),
    ).toThrow();
});

it("WP-2423 Q7 slice 2: reads a round staff entered for the table and its card-machine payment", () => {
  const batch = row().batches[0];
  const dining = (staffRound: unknown, orderType = "DineIn") => ({
    ...row(),
    orderType,
    currentPhase: "Accepted",
    batches: [
      batch,
      {
        ...batch,
        orderBatchReference: id(92),
        sequence: 2,
        acceptanceStatus: "NotAccepted",
        paymentDue: { status: "Awaiting", cancelsAt: null },
        staffRound,
      },
    ],
  });
  const parse = (item: unknown) =>
    parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }).items[0]?.batches[1]
      ?.staffRound;
  expect(parse(dining({ recordedAfterOutage: false, paidOnCardMachine: null }))).toEqual({
    recordedAfterOutage: false,
    paidOnCardMachine: null,
    amountDueMinor: null,
  });
  // WP-2423 D5: what to charge while unpaid, so Orders can record the card-machine payment.
  expect(
    parse(dining({ recordedAfterOutage: false, paidOnCardMachine: null, amountDueMinor: "2486" })),
  ).toEqual({ recordedAfterOutage: false, paidOnCardMachine: null, amountDueMinor: "2486" });
  const paid = {
    recordedAfterOutage: true,
    paidOnCardMachine: { amountMinor: "2560", takenAt: "2026-09-14T00:10:00.000Z" },
  };
  // An older server without the machine refunds reads as nothing refunded.
  expect(parse(dining(paid))).toEqual({
    ...paid,
    paidOnCardMachine: { ...paid.paidOnCardMachine, refundedMinor: "0" },
    amountDueMinor: null,
  });
  // WP-2423: what was refunded on the machine for the round.
  const refunded = {
    ...paid,
    paidOnCardMachine: { ...paid.paidOnCardMachine, refundedMinor: "2560" },
  };
  expect(parse(dining(refunded))).toEqual({ ...refunded, amountDueMinor: null });
  expect(parse(dining(null))).toBeNull();
  // Older servers without the key read as no staff round.
  expect(
    parseCurrentOrderQueue({ items: [row()], nextAfterOrderReference: null }).items[0]?.batches[0]
      ?.staffRound,
  ).toBeNull();
  for (const invalid of [
    dining({ recordedAfterOutage: "no", paidOnCardMachine: null }),
    dining({
      ...paid,
      paidOnCardMachine: { amountMinor: "25.60", takenAt: paid.paidOnCardMachine.takenAt },
    }),
    dining({ ...paid, extra: true }),
    dining({ ...paid, paidOnCardMachine: { ...paid.paidOnCardMachine, refundedMinor: "2561" } }),
    dining({ ...paid, paidOnCardMachine: { ...paid.paidOnCardMachine, refundedMinor: "1.5" } }),
    dining({ ...paid, amountDueMinor: "100" }),
    dining({ recordedAfterOutage: false, paidOnCardMachine: null, amountDueMinor: "0" }),
    dining({ recordedAfterOutage: false, paidOnCardMachine: null, amountDueMinor: "1.5" }),
    dining(paid, "Pickup"),
  ])
    expect(() =>
      parseCurrentOrderQueue({ items: [invalid], nextAfterOrderReference: null }),
    ).toThrow();
});

it("WP-2423 Q10: admits the pickup customer's contact on the detail and refuses anything else", () => {
  const pickup = { ...detail(), order: { ...row(1), orderType: "Pickup" } };
  const contact = {
    status: "Available",
    name: "Synthetic Guest",
    channel: "Phone",
    value: "+14165550123",
  };
  expect(
    parseCurrentOrderDetail({ ...pickup, pickupContact: contact }, id(1)).pickupContact,
  ).toEqual(contact);
  expect(
    parseCurrentOrderDetail(
      { ...pickup, pickupContact: { status: "Removed", removedAt: "2026-11-10T08:00:00.000Z" } },
      id(1),
    ).pickupContact,
  ).toEqual({ status: "Removed", removedAt: "2026-11-10T08:00:00.000Z" });
  expect(
    parseCurrentOrderDetail({ ...pickup, pickupContact: { status: "NotGiven" } }, id(1))
      .pickupContact,
  ).toEqual({ status: "NotGiven" });
  for (const invalid of [
    { ...contact, value: "416-555-0123" },
    { ...contact, channel: "Email", value: "not-an-email" },
    { ...contact, guestSessionReference: id(9) },
    { status: "Removed", removedAt: "yesterday" },
    { status: "NotGiven", name: "x" },
  ])
    expect(() => parseCurrentOrderDetail({ ...pickup, pickupContact: invalid }, id(1))).toThrow();
  const withoutField: Record<string, unknown> = { ...pickup };
  delete withoutField.pickupContact;
  expect(() => parseCurrentOrderDetail(withoutField, id(1))).toThrow();
  expect(() =>
    parseCurrentOrderDetail(
      { ...pickup, order: { ...row(1), orderType: "DineIn" }, pickupContact: contact },
      id(1),
    ),
  ).toThrow();
});

it("WP-2423: reads what an online order was paid and its refund position on the detail", () => {
  const paidOnline = { amountMinor: "1130", currencyCode: "CAD" };
  const queue = (item: object) =>
    parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null });
  expect(queue({ ...row(), paidOnline }).items[0]?.paidOnline).toEqual(paidOnline);
  expect(queue({ ...row(), paidOnline: null }).items[0]?.paidOnline).toBeNull();
  // An older server without the key reads as not known.
  expect(queue(row()).items[0]?.paidOnline).toBeNull();
  for (const bad of [
    { amountMinor: "0", currencyCode: "CAD" },
    { amountMinor: "11.30", currencyCode: "CAD" },
    { amountMinor: 1130, currencyCode: "CAD" },
    { amountMinor: "1130", currencyCode: "USD" },
    { amountMinor: "1130", currencyCode: "CAD", refundedMinor: "0" },
  ])
    expect(() => queue({ ...row(), paidOnline: bad })).toThrow(CurrentOrderQueueError);
  // A counter order's payment is its card-machine payment, never an online one.
  expect(() =>
    queue({
      ...row(),
      sourceChannel: "Pos",
      counter: { recordedAfterOutage: false, paidOnCardMachine: null },
      paidOnline,
    }),
  ).toThrow(CurrentOrderQueueError);
  const paid = { ...detail(), order: { ...row(1), paidOnline } };
  expect(parseCurrentOrderDetail(paid, id(1)).paymentPosition).toBeNull();
  const position = { refundedMinor: "500", refundPendingMinor: "130" };
  expect(
    parseCurrentOrderDetail({ ...paid, paymentPosition: position }, id(1)).paymentPosition,
  ).toEqual(position);
  for (const bad of [
    { refundedMinor: "1000", refundPendingMinor: "131" },
    { refundedMinor: "-1", refundPendingMinor: "0" },
    { refundedMinor: "0" },
  ])
    expect(() => parseCurrentOrderDetail({ ...paid, paymentPosition: bad }, id(1))).toThrow();
  // No refund position without an online payment.
  expect(() =>
    parseCurrentOrderDetail(
      { ...detail(), paymentPosition: { refundedMinor: "0", refundPendingMinor: "0" } },
      id(1),
    ),
  ).toThrow();
});

it("WP-2423 D4: an older table's Order with a round today is listed first under today", () => {
  const view = parseCurrentOrderQueue({
    items: [
      // Opened Sun Oct 11 (an older reference), a round today: outside the newest-first sequence.
      { ...row(3), businessDate: "2026-10-11", listedBusinessDate: "2026-10-15" },
      { ...row(9), businessDate: "2026-10-15", listedBusinessDate: "2026-10-15" },
      { ...row(4), businessDate: "2026-10-14", listedBusinessDate: "2026-10-14" },
    ],
    nextAfterOrderReference: null,
  });
  expect(
    view.items.map((item) => [item.orderReference, item.businessDate, item.listedBusinessDate]),
  ).toEqual([
    [id(3), "2026-10-11", "2026-10-15"],
    [id(9), "2026-10-15", "2026-10-15"],
    [id(4), "2026-10-14", "2026-10-14"],
  ]);
  // An older server: listed under its own day.
  const older = parseCurrentOrderQueue({
    items: [{ ...row(9), businessDate: "2026-10-15" }],
    nextAfterOrderReference: null,
  });
  expect(older.items[0]?.listedBusinessDate).toBe("2026-10-15");
  // Out of sequence without being listed on a later day is still refused.
  expect(() =>
    parseCurrentOrderQueue({
      items: [
        { ...row(3), businessDate: "2026-10-15", listedBusinessDate: "2026-10-15" },
        { ...row(9), businessDate: "2026-10-15", listedBusinessDate: "2026-10-15" },
      ],
      nextAfterOrderReference: null,
    }),
  ).toThrow();
});
