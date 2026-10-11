import { expect, it, vi } from "vitest";
import {
  cancelledItemsRefund,
  createCurrentOrderQueueClient,
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
  expect(
    parseCurrentOrderQueue({ items: [pickup], nextAfterOrderReference: null }).items[0]?.batches[0]
      ?.staffCancellation,
  ).toEqual(cancellation);
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
