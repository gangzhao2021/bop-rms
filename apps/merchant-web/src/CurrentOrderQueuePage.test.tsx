import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  CurrentOrderDetails,
  CurrentOrderLines,
  orderMoney,
  CurrentOrderQueueRows,
  storeTime,
  filterCurrentOrderItems,
  acceptanceWindow,
  awaitingBatchReferences,
} from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
it("renders actual Accepted version and visibly unresolved state without fabricated summaries", () => {
  const item = {
    orderReference: "01909968-0000-7000-8000-000000000001",
    orderNumber: "ORD-1001",
    orderType: "Pickup",
    sourceChannel: "Web",
    submittedAt: "2026-09-14T00:00:00.000Z",
    observedAt: "2026-09-14T00:01:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000090",
    batches: [
      {
        orderBatchReference: "01909968-0000-7000-8000-000000000090",
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
      },
    ],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Accepted",
    currentVersion: 2,
  };
  const render = (value: unknown) =>
    renderToStaticMarkup(
      <CurrentOrderQueueRows
        view={parseCurrentOrderQueue({ items: [value], nextAfterOrderReference: null })}
      />,
    );
  expect(render(item)).toContain("Accepted");
  expect(render(item)).not.toContain("Current version");
  expect(render(item)).toContain('class="order-workbench-entry" open=""');
  expect(render(item)).toContain("1 accepted");
  expect(render(item)).toContain("00:00 UTC");
  expect(render(item)).not.toContain("guestSession");
  expect(render({ ...item, currentPhase: null, currentVersion: null })).toContain(
    "Status unavailable",
  );
});
it("renders an empty page explicitly", () => {
  expect(
    renderToStaticMarkup(
      <CurrentOrderQueueRows view={{ items: [], nextAfterOrderReference: null }} />,
    ),
  ).toContain("No orders on this page");
});

it("filters only by exact public order number and fields present on the current queue item", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const item = (
    n: number,
    orderNumber: string,
    orderType: "Pickup" | "DineIn",
    phase: string | null,
  ) => ({
    orderReference: id(n),
    orderNumber,
    orderType,
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
      },
    ],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: phase,
    currentVersion: phase === null ? null : 2,
  });
  const view = parseCurrentOrderQueue({
    items: [item(2, "ORD-10010", "DineIn", null), item(1, "ORD-1001", "Pickup", "Accepted")],
    nextAfterOrderReference: null,
  });
  const all = { orderNumber: "", type: "All", channel: "All", phase: "All" };
  expect(filterCurrentOrderItems(view.items, { ...all, orderNumber: " ord-1001 " })).toHaveLength(
    1,
  );
  expect(filterCurrentOrderItems(view.items, { ...all, type: "DineIn" })).toHaveLength(1);
  expect(
    filterCurrentOrderItems(view.items, { ...all, channel: "Web", phase: "Unavailable" }),
  ).toHaveLength(1);
});

it("labels a cancelled additional Batch distinctly from unaccepted work", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const view = parseCurrentOrderQueue({
    items: [
      {
        orderReference: id(1),
        orderNumber: "ORD-1001",
        orderType: "DineIn",
        sourceChannel: "Web",
        submittedAt: "2026-09-14T00:00:00.000Z",
        observedAt: "2026-09-14T00:01:00.000Z",
        initialBatchReference: id(2),
        batches: [
          {
            orderBatchReference: id(2),
            sequence: 1,
            acceptanceStatus: "Accepted",
            canRequestAcceptance: false,
          },
          {
            orderBatchReference: id(3),
            sequence: 2,
            acceptanceStatus: "Cancelled",
            canRequestAcceptance: false,
          },
        ],
        canRequestAcceptance: false,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        currentPhase: "Ready",
        currentVersion: 8,
      },
    ],
    nextAfterOrderReference: null,
  });
  const html = renderToStaticMarkup(<CurrentOrderQueueRows view={view} />);
  expect(html).toContain("Batch cancelled");
  expect(html).not.toContain("Not accepted");
});

it("keeps payments accessible on cancelled Dining without offering unavailable serving, preserving fulfilled history", () => {
  const order = {
    orderReference: "01909968-0000-7000-8000-000000000001",
    orderNumber: "ORD-1001",
    orderType: "DineIn",
    sourceChannel: "Web",
    submittedAt: "2026-09-14T00:00:00.000Z",
    observedAt: "2026-09-14T00:01:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000090",
    batches: [],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Cancelled",
    currentVersion: 2,
  };
  const item = parseCurrentOrderQueue({ items: [order], nextAfterOrderReference: null }).items[0];
  if (!item) throw new Error("missing synthetic order");
  const render = (currentPhase: string) =>
    renderToStaticMarkup(
      <CurrentOrderDetails
        order={{ ...item, currentPhase }}
        csrf="synthetic"
        locked={false}
        onBusy={() => undefined}
      />,
    );
  expect(render("Cancelled")).toContain("Payments and refunds");
  expect(render("Cancelled")).not.toContain("View serving progress");
  expect(render("Accepted")).toContain("View serving progress");
  expect(render("Fulfilled")).toContain("View serving progress");
});

it("WP-2423: shows order times in the Store's time zone", () => {
  expect(storeTime("2026-10-08T01:30:00.000Z", "America/Toronto")).toBe("21:30");
  expect(storeTime("2026-10-08T01:30:00.000Z", "America/Toronto", true)).toBe("2026-10-07 21:30");
  expect(storeTime("2026-10-08T01:30:00.000Z", undefined)).toBe("01:30 UTC");
});

it("WP-2423: shows what was ordered with options, notes and totals", () => {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const html = renderToStaticMarkup(
    <CurrentOrderLines
      lines={{
        items: [
          {
            orderItemReference: "a",
            orderBatchReference: "b",
            batchKnown: true,
            name: "Latte — Regular (12 oz)",
            options: [
              { name: "Oat milk", quantity: 1 },
              { name: "Extra shot", quantity: 2 },
            ],
            quantity: 2,
            customerNote: "Extra hot",
            unitPrice: money("700"),
            subtotal: money("1400"),
            discount: money("0"),
            tax: money("182"),
            fee: money("0"),
            total: money("1582"),
          },
        ],
        totals: {
          subtotal: money("1400"),
          discount: money("0"),
          tax: money("182"),
          fee: money("0"),
          total: money("1582"),
        },
      }}
    />,
  );
  expect(html).toContain("2 ×");
  expect(html).toContain("Oat milk · Extra shot × 2");
  expect(html).toContain("Note: Extra hot");
  expect(html).toContain("$15.82");
  expect(html).not.toContain("Discount");
  expect(orderMoney({ amountMinor: "5", currencyCode: "CAD" })).toBe("$0.05");
  expect(orderMoney({ amountMinor: "500", currencyCode: "JPY" })).toBe("JPY 500");
});

it("WP-2423: shows a paid order that was not accepted in time as expired and refunded, never acceptable", () => {
  const expired = {
    orderReference: "01909968-0000-7000-8000-000000000013",
    orderNumber: "13",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-08T19:07:59.000Z",
    observedAt: "2026-10-08T23:51:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000091",
    batches: [
      {
        orderBatchReference: "01909968-0000-7000-8000-000000000091",
        sequence: 1,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: false,
      },
    ],
    canRequestAcceptance: false,
    unfulfillable: "CapacityExpired",
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Submitted",
    currentVersion: 1,
  };
  const view = parseCurrentOrderQueue({ items: [expired], nextAfterOrderReference: null });
  const html = renderToStaticMarkup(<CurrentOrderQueueRows view={view} />);
  expect(html).toContain("Expired · refunded");
  expect(html).toContain('data-phase="Expired"');
  expect(html).toContain("Not accepted before its preparation slot expired.");
  const filters = { orderNumber: "", type: "All", channel: "All" };
  expect(filterCurrentOrderItems(view.items, { ...filters, phase: "Expired" })).toHaveLength(1);
  expect(filterCurrentOrderItems(view.items, { ...filters, phase: "Submitted" })).toHaveLength(0);
  // The client refuses an acceptance offer for such an order.
  expect(() =>
    parseCurrentOrderQueue({
      items: [{ ...expired, canRequestAcceptance: true }],
      nextAfterOrderReference: null,
    }),
  ).toThrow();
  expect(() =>
    parseCurrentOrderQueue({
      items: [
        {
          ...expired,
          batches: [{ ...expired.batches[0], canRequestAcceptance: true }],
        },
      ],
      nextAfterOrderReference: null,
    }),
  ).toThrow();
});

it("WP-2423: shows a pickup the Store closed as not collected", () => {
  const order = {
    orderReference: "01909968-0000-7000-8000-000000000004",
    orderNumber: "4",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-08T16:08:00.000Z",
    observedAt: "2026-10-09T05:00:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000092",
    batches: [
      {
        orderBatchReference: "01909968-0000-7000-8000-000000000092",
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
      },
    ],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: true,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Accepted",
    currentVersion: 2,
  };
  const view = parseCurrentOrderQueue({ items: [order], nextAfterOrderReference: null });
  const html = renderToStaticMarkup(<CurrentOrderQueueRows view={view} />);
  expect(html).toContain("Not collected");
  expect(html).toContain('data-phase="NotCollected"');
  expect(html).toContain("not refunded automatically");
  const filters = { orderNumber: "", type: "All", channel: "All" };
  expect(filterCurrentOrderItems(view.items, { ...filters, phase: "NotCollected" })).toHaveLength(
    1,
  );
  expect(filterCurrentOrderItems(view.items, { ...filters, phase: "Accepted" })).toHaveLength(0);
});

it("WP-2423 Q1: grades the acceptance window and shows it only while the order can be accepted", () => {
  const at = Date.parse("2026-10-10T12:00:00.000Z");
  const by = (minutes: number) => new Date(at + minutes * 60_000).toISOString();
  expect(acceptanceWindow(null, at)).toBeNull();
  expect(acceptanceWindow(by(25), at)).toEqual({ minutes: 25, tier: "ok" });
  expect(acceptanceWindow(by(10), at)).toEqual({ minutes: 10, tier: "warning" });
  expect(acceptanceWindow(by(4.5), at)).toEqual({ minutes: 5, tier: "urgent" });
  expect(acceptanceWindow(by(0), at)).toEqual({ minutes: 0, tier: "lapsed" });
  const order = {
    orderReference: "01909968-0000-7000-8000-000000000021",
    orderNumber: "21",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-10T11:50:00.000Z",
    observedAt: "2026-10-10T11:59:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000092",
    batches: [
      {
        orderBatchReference: "01909968-0000-7000-8000-000000000092",
        sequence: 1,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: true,
      },
    ],
    canRequestAcceptance: true,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: by(8),
    awaitingPayment: false,
    currentPhase: "Submitted",
    currentVersion: 1,
  };
  const view = parseCurrentOrderQueue({ items: [order], nextAfterOrderReference: null });
  expect([...awaitingBatchReferences(view)]).toEqual(["01909968-0000-7000-8000-000000000092"]);
  const html = renderToStaticMarkup(<CurrentOrderQueueRows view={view} now={at} />);
  expect(html).toContain('data-tier="warning"');
  expect(html).toContain("Accept within 8 min");
  expect(
    renderToStaticMarkup(<CurrentOrderQueueRows view={view} now={at + 9 * 60_000} />),
  ).toContain("Acceptance window ended · refund pending");
  // Without acceptance authority there is nothing for this person to act on.
  const readOnly = parseCurrentOrderQueue({
    items: [
      {
        ...order,
        canRequestAcceptance: false,
        batches: [{ ...order.batches[0], canRequestAcceptance: false }],
      },
    ],
    nextAfterOrderReference: null,
  });
  expect(renderToStaticMarkup(<CurrentOrderQueueRows view={readOnly} now={at} />)).not.toContain(
    "Accept within",
  );
});

it("WP-2423 Q1: shows an unpaid submission as awaiting payment, never acceptable or counted", () => {
  const unpaid = {
    orderReference: "01909968-0000-7000-8000-000000000031",
    orderNumber: "31",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-10T11:50:00.000Z",
    observedAt: "2026-10-10T11:59:00.000Z",
    initialBatchReference: "01909968-0000-7000-8000-000000000093",
    batches: [
      {
        orderBatchReference: "01909968-0000-7000-8000-000000000093",
        sequence: 1,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: false,
      },
    ],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: true,
    currentPhase: "Submitted",
    currentVersion: 1,
  };
  const view = parseCurrentOrderQueue({ items: [unpaid], nextAfterOrderReference: null });
  const html = renderToStaticMarkup(<CurrentOrderQueueRows view={view} now={Date.now()} />);
  expect(html).toContain('data-phase="AwaitingPayment"');
  expect(html).toContain("Awaiting payment");
  expect(awaitingBatchReferences(view).size).toBe(0);
  const filters = { orderNumber: "", type: "All", channel: "All" };
  expect(
    filterCurrentOrderItems(view.items, { ...filters, phase: "AwaitingPayment" }),
  ).toHaveLength(1);
  expect(filterCurrentOrderItems(view.items, { ...filters, phase: "Submitted" })).toHaveLength(0);
  for (const item of [
    { ...unpaid, canRequestAcceptance: true },
    { ...unpaid, batches: [{ ...unpaid.batches[0], canRequestAcceptance: true }] },
    { ...unpaid, acceptBy: "2026-10-10T12:20:00.000Z" },
    { ...unpaid, currentPhase: "Accepted", currentVersion: 2 },
  ])
    expect(() =>
      parseCurrentOrderQueue({ items: [item], nextAfterOrderReference: null }),
    ).toThrow();
});
