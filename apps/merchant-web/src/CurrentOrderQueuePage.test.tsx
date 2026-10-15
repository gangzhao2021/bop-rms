import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  CurrentOrderDetails,
  CurrentOrderLines,
  formatContactPhone,
  PickupContactPanel,
  orderMoney,
  CurrentOrderQueueRows,
  onlinePaymentText,
  storeTime,
  filterCurrentOrderItems,
  acceptanceWindow,
  awaitingBatchReferences,
  orderChannelLabel,
  orderTypeLabel,
  paymentDueText,
  storeCancelledBatches,
  unpaidCancelledBatches,
  unpaidCancelledTotal,
} from "./CurrentOrderQueuePage.js";
import { parseCurrentOrderDetail, parseCurrentOrderQueue } from "./current-order-queue-client.js";
import { AcceptanceHoldNotice, acceptanceHoldText } from "./AcceptanceHoldActions.js";
import { currentOrderQueueFixture } from "./current-order-queue.fixtures.js";
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
    "Status not loaded · refresh",
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
            canCancel: false,
            staffCancellation: null,
            canCancelItems: false,
          },
          {
            orderBatchReference: id(3),
            sequence: 2,
            acceptanceStatus: "Cancelled",
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
  expect(storeTime("2026-10-08T01:30:00.000Z", "America/Toronto", true)).toBe(
    "Oct 7, 2026, 9:30 PM",
  );
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
            canCancel: false,
            cancellation: null,
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
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
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
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
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
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
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
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
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

it("WP-2423 Q6: offers cancellation only where allowed and shows the Store's cancellation", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const batch = {
    orderBatchReference: id(90),
    sequence: 1,
    acceptanceStatus: "Accepted",
    canRequestAcceptance: false,
    canCancel: false,
    staffCancellation: null as null | Record<string, string>,
    canCancelItems: false,
  };
  const pickup = {
    orderReference: id(1),
    orderNumber: "ORD-1001",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-11T12:00:00.000Z",
    observedAt: "2026-10-11T12:10:00.000Z",
    initialBatchReference: id(90),
    batches: [
      {
        ...batch,
        staffCancellation: {
          reasonCode: "SOLD_OUT",
          cancelledAt: "2026-10-11T12:05:00.000Z",
          refundStatus: "Pending",
        },
      },
    ],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Cancelled",
    currentVersion: 4,
  };
  const pickupHtml = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={parseCurrentOrderQueue({ items: [pickup], nextAfterOrderReference: null })}
    />,
  );
  expect(pickupHtml).toContain('data-phase="Cancelled"');
  expect(pickupHtml).toContain("Cancelled by store · refund pending");
  expect(pickupHtml).toContain("Reason: Sold out");
  expect(pickupHtml).toContain("is being refunded in full");
  const dining = {
    ...pickup,
    orderReference: id(2),
    orderType: "DineIn",
    currentPhase: "InProgress",
    batches: [
      { ...batch },
      {
        ...batch,
        orderBatchReference: id(91),
        sequence: 2,
        acceptanceStatus: "Cancelled",
        staffCancellation: {
          reasonCode: "CUSTOMER_REQUEST",
          cancelledAt: "2026-10-11T12:06:00.000Z",
          refundStatus: "Refunded",
        },
      },
      { ...batch, orderBatchReference: id(92), sequence: 3, canCancel: true },
    ],
  };
  const view = parseCurrentOrderQueue({ items: [dining], nextAfterOrderReference: null });
  const diningHtml = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={view}
      action={(_order, row) => (row.canCancel ? `cancel:${row.sequence}` : null)}
    />,
  );
  expect(diningHtml).toContain("Batch 2 cancelled · refunded");
  expect(diningHtml).toContain("Reason: Customer request");
  expect(diningHtml).toContain("was refunded in full");
  expect(diningHtml).toContain("cancel:3");
  expect(diningHtml).not.toContain("cancel:1");
  expect(diningHtml).not.toContain("cancel:2");
  expect(diningHtml).not.toContain("SOLD_OUT");
});

it("WP-2423 Q6 step 2: marks cancelled items, their refund and the refund total", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const line = (n: number, name: string, cancellation: unknown = null) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(90),
    name,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money("1000"),
    subtotal: money("1000"),
    discount: money("0"),
    tax: money("130"),
    fee: money("0"),
    total: money("1130"),
    canCancel: false,
    cancellation,
  });
  const pending = {
    reasonCode: "SOLD_OUT",
    cancelledAt: "2026-10-11T12:04:00.000Z",
    refundStatus: "Pending",
    refund: money("1130"),
    cancellationReference: id(700),
  };
  const { lines } = parseCurrentOrderDetail(
    {
      screenId: "OPS-ORDER-DETAIL",
      pickupContact: null,
      order: {
        orderReference: id(1),
        orderNumber: "ORD-1001",
        orderType: "Pickup",
        sourceChannel: "Qr",
        submittedAt: "2026-10-11T12:00:00.000Z",
        observedAt: "2026-10-11T12:05:00.000Z",
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
        currentPhase: "InProgress",
        currentVersion: 5,
      },
      lines: {
        items: [
          line(1, "Synthetic rice bowl"),
          line(2, "Synthetic tea", pending),
          line(3, "Synthetic juice", pending),
          line(4, "Synthetic cake", {
            ...pending,
            refundStatus: "Refunded",
            refund: money("565"),
            cancellationReference: id(701),
          }),
        ],
        totals: {
          subtotal: money("4000"),
          discount: money("0"),
          tax: money("520"),
          fee: money("0"),
          total: money("4520"),
        },
      },
    },
    id(1),
  );
  const html = renderToStaticMarkup(
    <CurrentOrderLines
      lines={lines}
      refundCheck={{ orderReference: id(1), csrf: "synthetic", onChecked: () => undefined }}
    />,
  );
  expect(html.match(/class="order-line-cancelled"/gu)).toHaveLength(3);
  expect(html).toContain("Cancelled · refund pending · $11.30");
  expect(html).toContain("Cancelled · refunded · $5.65");
  expect(html).toContain("Reason: Sold out");
  // One check per pending cancellation; none for a completed refund.
  expect(html.match(/Check refund/gu)).toHaveLength(1);
  // The original total stays; the cancelled items' refund is shown beside it.
  expect(html).toContain("$45.20");
  expect(html).toMatch(/Cancelled items refund<\/dt><dd>−\$28\.25<\/dd>/u);
  // Without a refund check context (or a cancellation reference) no button is offered.
  expect(renderToStaticMarkup(<CurrentOrderLines lines={lines} />)).not.toContain("Check refund");
  // A batch the store cancelled whole marks its remaining lines too.
  const whole = renderToStaticMarkup(
    <CurrentOrderLines lines={lines} cancelledBatches={new Set([id(90)])} />,
  );
  expect(whole.match(/class="order-line-cancelled"/gu)).toHaveLength(4);
  expect(whole).toContain("Cancelled by store");
  // A round whose payment failed is not cancelled yet: its lines say not to prepare it.
  const failed = renderToStaticMarkup(
    <CurrentOrderLines lines={lines} failedPaymentBatches={new Set([id(90)])} />,
  );
  expect(failed.match(/Payment failed · don&#x27;t prepare/gu)).toHaveLength(1);
});
const unpaidId = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
it("WP-2423: warns staff before an unpaid dine-in round is cancelled and says so in plain words", () => {
  const base = {
    orderBatchReference: unpaidId(90),
    sequence: 1,
    acceptanceStatus: "Accepted",
    canRequestAcceptance: false,
    canCancel: false,
    staffCancellation: null,
    canCancelItems: false,
    paymentDue: null,
  };
  const order = (second: Record<string, unknown>) => ({
    orderReference: unpaidId(1),
    orderNumber: "ORD-1007",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-09-14T00:00:00.000Z",
    observedAt: "2026-09-14T00:10:00.000Z",
    initialBatchReference: unpaidId(90),
    batches: [base, { ...base, orderBatchReference: unpaidId(91), sequence: 2, ...second }],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    currentPhase: "Accepted",
    currentVersion: 3,
  });
  const render = (second: Record<string, unknown>, now = Date.parse("2026-09-14T00:10:00.000Z")) =>
    renderToStaticMarkup(
      <CurrentOrderQueueRows
        view={parseCurrentOrderQueue({ items: [order(second)], nextAfterOrderReference: null })}
        timeZone="America/Toronto"
        now={now}
      />,
    );
  const failed = render({
    acceptanceStatus: "NotAccepted",
    paymentDue: { status: "Failed", cancelsAt: "2026-09-14T00:30:00.000Z" },
  });
  // In the summary row and in the round itself, as a warning, with the Store-local time.
  expect(failed).toContain("Batch 2: Payment failed · will be cancelled automatically at 20:30");
  expect(failed).toMatch(
    /<p class="order-workbench-closed" role="note"><span class="order-accept-by" data-tier="urgent">Payment failed · will be cancelled automatically at 20:30<\/span>/u,
  );
  expect(failed).toContain("Don&#x27;t prepare it; it will not be charged.");
  expect(failed).not.toContain("Acceptance: Not accepted");
  // Plain words, never internal codes.
  expect(failed).toContain("<dt>Order type</dt><dd>Dine-in</dd>");
  expect(failed).toContain("<dt>Channel</dt><dd>QR code</dd>");
  expect(failed).toContain("Dine-in · QR code");
  expect(failed).not.toMatch(/>DineIn<|>Qr</u);
  // Once the time has passed the round reads as being cancelled.
  expect(
    render(
      {
        acceptanceStatus: "NotAccepted",
        paymentDue: { status: "Failed", cancelsAt: "2026-09-14T00:30:00.000Z" },
      },
      Date.parse("2026-09-14T00:31:00.000Z"),
    ),
  ).toContain("Payment failed · being cancelled automatically");
  const awaiting = render({
    acceptanceStatus: "NotAccepted",
    paymentDue: { status: "Awaiting", cancelsAt: null },
  });
  expect(awaiting).toContain('data-tier="warning">Batch 2: Awaiting payment');
  expect(awaiting).toContain("the guest has not paid for this round");
  // After the System cancelled it: not paid, nothing charged; not mistaken for a store cancellation.
  const cancelled = render({ acceptanceStatus: "Cancelled" });
  expect(cancelled).toContain("Batch cancelled · not paid.");
  expect(cancelled).toContain("Nothing was charged for it.");
  expect(cancelled).not.toContain("Payment failed");
  expect(cancelled).toContain("1 cancelled");
});
it("WP-2423: lines of a round cancelled for a failed payment are marked and not owed", () => {
  const line = (n: number, batch: number, amount: string) => ({
    orderItemReference: unpaidId(200 + n),
    orderBatchReference: unpaidId(batch),
    name: "Synthetic dish " + n,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: { amountMinor: "1000", currencyCode: "CAD" },
    subtotal: { amountMinor: "1000", currencyCode: "CAD" },
    discount: { amountMinor: "0", currencyCode: "CAD" },
    tax: { amountMinor: "130", currencyCode: "CAD" },
    fee: { amountMinor: "0", currencyCode: "CAD" },
    total: { amountMinor: amount, currencyCode: "CAD" },
    canCancel: false,
    cancellation: null,
  });
  const batch = {
    orderBatchReference: unpaidId(90),
    sequence: 1,
    acceptanceStatus: "Accepted",
    canRequestAcceptance: false,
    canCancel: false,
    staffCancellation: null,
    canCancelItems: false,
    paymentDue: null,
  };
  const detail = parseCurrentOrderDetail(
    {
      screenId: "OPS-ORDER-DETAIL",
      pickupContact: null,
      order: {
        orderReference: unpaidId(1),
        orderNumber: "ORD-1007",
        orderType: "DineIn",
        sourceChannel: "Qr",
        submittedAt: "2026-09-14T00:00:00.000Z",
        observedAt: "2026-09-14T00:40:00.000Z",
        initialBatchReference: unpaidId(90),
        batches: [
          batch,
          {
            ...batch,
            orderBatchReference: unpaidId(91),
            sequence: 2,
            acceptanceStatus: "Cancelled",
          },
        ],
        canRequestAcceptance: false,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        currentPhase: "Accepted",
        currentVersion: 4,
      },
      lines: {
        items: [line(1, 90, "1130"), line(2, 91, "1130")],
        totals: {
          subtotal: { amountMinor: "2000", currencyCode: "CAD" },
          discount: { amountMinor: "0", currencyCode: "CAD" },
          tax: { amountMinor: "260", currencyCode: "CAD" },
          fee: { amountMinor: "0", currencyCode: "CAD" },
          total: { amountMinor: "2260", currencyCode: "CAD" },
        },
      },
    },
    unpaidId(1),
  );
  const unpaid = unpaidCancelledBatches(detail.view);
  expect([...unpaid]).toEqual([unpaidId(91)]);
  expect(storeCancelledBatches(detail.view).size).toBe(0);
  const html = renderToStaticMarkup(
    <CurrentOrderLines
      lines={detail.lines}
      cancelledBatches={storeCancelledBatches(detail.view)}
      unpaidCancelledBatches={unpaid}
    />,
  );
  expect(html.match(/class="order-line-cancelled"/gu)).toHaveLength(1);
  expect(html).toContain("Cancelled · not paid");
  expect(html).not.toContain("Cancelled by store");
  // The original total stays; the cancelled unpaid round is taken off beside it.
  expect(html).toMatch(/<dt>Total<\/dt><dd>\$22\.60<\/dd>/u);
  expect(html).toMatch(/Cancelled unpaid rounds<\/dt><dd>−\$11\.30<\/dd>/u);
  expect(html).toMatch(/Total after cancelled rounds<\/dt><dd>\$11\.30<\/dd>/u);
  expect(unpaidCancelledTotal(detail.lines, new Set())).toBeNull();
  // Without unpaid cancelled rounds nothing extra is shown.
  expect(renderToStaticMarkup(<CurrentOrderLines lines={detail.lines} />)).not.toContain(
    "Cancelled unpaid rounds",
  );
});
it("WP-2423: words an unpaid round's payment state for staff", () => {
  expect(paymentDueText({ status: "Awaiting", cancelsAt: null }, "UTC")).toBe("Awaiting payment");
  expect(paymentDueText({ status: "Failed", cancelsAt: "2026-09-14T00:30:00.000Z" }, "UTC")).toBe(
    "Payment failed · will be cancelled automatically at 00:30",
  );
  expect(orderTypeLabel.DineIn).toBe("Dine-in");
  expect(["Qr", "Web", "Pos", "Api", "Kiosk"].map(orderChannelLabel)).toEqual([
    "QR code",
    "Website",
    "Counter",
    "Partner integration",
    "Other",
  ]);
});

it("WP-2423 Q10: shows who the pickup is for and how to reach them, only from the detail", () => {
  const phone = renderToStaticMarkup(
    <PickupContactPanel
      contact={{
        status: "Available",
        name: "Synthetic Guest",
        channel: "Phone",
        value: "+14165550123",
      }}
    />,
  );
  expect(phone).toContain("Pickup for Synthetic Guest");
  expect(phone).toContain('href="tel:+14165550123"');
  expect(phone).toContain("Call (416) 555-0123");
  const email = renderToStaticMarkup(
    <PickupContactPanel
      contact={{
        status: "Available",
        name: "Synthetic Guest",
        channel: "Email",
        value: "guest@example.test",
      }}
    />,
  );
  expect(email).toContain('href="mailto:guest@example.test"');
  const removed = renderToStaticMarkup(
    <PickupContactPanel
      contact={{ status: "Removed", removedAt: "2026-11-10T12:00:00.000Z" }}
      timeZone="America/Toronto"
    />,
  );
  expect(removed).toContain("contact was removed on Nov 10, 2026");
  expect(renderToStaticMarkup(<PickupContactPanel contact={{ status: "NotGiven" }} />)).toContain(
    "No contact was given",
  );
  expect(renderToStaticMarkup(<PickupContactPanel contact={null} />)).toBe("");
  expect(formatContactPhone("+442071234567")).toBe("+442071234567");
});

it("WP-2423 Q9-G1: shows orders paid during an outage for a decision with accept and refund", () => {
  const fixture = currentOrderQueueFixture();
  const base = fixture.items[1];
  if (base === undefined) throw new Error("fixture");
  const hold = {
    holdReference: "0190fa46-0000-7000-8000-0000000000a1",
    orderBatchReference: base.batches[0]?.orderBatchReference ?? "",
    heldAt: "2026-08-12T11:31:00.000Z",
    lapsedDeadline: "2026-08-12T11:30:00.000Z",
    storeLastSeenAt: "2026-08-12T11:10:00.000Z",
    decideBy: null as string | null,
    refundChosen: false,
    canRefund: true,
  };
  const view = parseCurrentOrderQueue({
    items: [{ ...base, orderType: "Pickup", sourceChannel: "Web", acceptanceHold: hold }],
    nextAfterOrderReference: null,
  });
  const order = view.items[0];
  const parsed = order?.acceptanceHold;
  if (!parsed) throw new Error("fixture");
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  expect(acceptanceHoldText(parsed, now)).toBe("Paid during an outage · decide");
  expect(acceptanceHoldText({ ...parsed, decideBy: "2026-08-12T12:10:00.000Z" }, now)).toBe(
    "Paid during an outage · decide within 10 min",
  );
  expect(acceptanceHoldText({ ...parsed, decideBy: "2026-08-12T11:59:00.000Z" }, now)).toBe(
    "Decision time ended · refund pending",
  );
  const notice = renderToStaticMarkup(
    <AcceptanceHoldNotice view={view} onShow={() => undefined} />,
  );
  expect(notice).toContain("Paid during an outage — decide");
  expect(notice).toContain("1 online order was paid while the store was offline.");
  expect(
    filterCurrentOrderItems(view.items, {
      orderNumber: "",
      type: "All",
      channel: "All",
      phase: "OutageHeld",
    }),
  ).toHaveLength(1);
  const rows = renderToStaticMarkup(<CurrentOrderQueueRows view={view} now={now} timeZone="UTC" />);
  expect(rows).toContain("Paid during an outage · decide");
  expect(rows).not.toContain("Acceptance window ended");
  expect(rows).not.toMatch(/hold_?id|holdReference/u);
});

it("WP-2423: says an online order is paid, and what happened to the payment", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const batch = (n: number, extra: object = {}) => ({
    orderBatchReference: id(90 + n),
    sequence: n,
    acceptanceStatus: "Accepted",
    canRequestAcceptance: false,
    canCancel: false,
    staffCancellation: null,
    canCancelItems: false,
    ...extra,
  });
  const order = (extra: object = {}) => ({
    orderReference: id(1),
    orderNumber: "9",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-15T02:08:00.000Z",
    observedAt: "2026-10-15T02:09:00.000Z",
    initialBatchReference: id(91),
    batches: [batch(1)],
    canRequestAcceptance: false,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    paidOnline: { amountMinor: "1130", currencyCode: "CAD" },
    currentPhase: "Accepted",
    currentVersion: 2,
    ...extra,
  });
  const parse = (value: object) =>
    parseCurrentOrderQueue({ items: [value], nextAfterOrderReference: null });
  const text = (value: object, position?: Parameters<typeof onlinePaymentText>[1]) => {
    const item = parse(value).items[0];
    if (item === undefined) throw new Error("no order");
    return onlinePaymentText(item, position);
  };
  expect(text(order())).toBe("Paid online $11.30");
  expect(text(order({ paidOnline: null }))).toBeNull();
  // Refunds Payment reports on the order detail.
  const position = (refundedMinor: string, refundPendingMinor = "0") => ({
    refundedMinor,
    refundPendingMinor,
  });
  expect(text(order(), position("0"))).toBe("Paid online $11.30");
  expect(text(order(), position("500"))).toBe("Paid online $11.30 · partly refunded");
  expect(text(order(), position("1130"))).toBe("Paid online $11.30 · refunded");
  expect(text(order(), position("0", "1130"))).toBe("Paid online $11.30 · refund pending");
  // On the list: refunds the queue itself shows.
  expect(
    text(
      order({
        unfulfillable: "CapacityExpired",
        currentPhase: "Submitted",
        currentVersion: 1,
        batches: [batch(1, { acceptanceStatus: "NotAccepted" })],
      }),
    ),
  ).toBe("Paid online $11.30 · refunded");
  const cancellation = (refundStatus: string) => ({
    reasonCode: "SOLD_OUT",
    cancelledAt: "2026-10-15T02:10:00.000Z",
    refundStatus,
  });
  const cancelled = (refundStatus: string) =>
    order({
      currentPhase: "Cancelled",
      currentVersion: 3,
      batches: [batch(1, { staffCancellation: cancellation(refundStatus) })],
    });
  expect(text(cancelled("Pending"))).toBe("Paid online $11.30 · refund pending");
  expect(text(cancelled("Refunded"))).toBe("Paid online $11.30 · refunded");
  const dining = order({
    orderType: "DineIn",
    paidOnline: { amountMinor: "2260", currencyCode: "CAD" },
    batches: [
      batch(1),
      batch(2, { acceptanceStatus: "Cancelled", staffCancellation: cancellation("Refunded") }),
    ],
  });
  expect(text(dining)).toBe("Paid online $22.60 · partly refunded");
  // Rendered in the row and the detail, in plain words with store-time dates.
  const html = renderToStaticMarkup(
    <CurrentOrderQueueRows view={parse(order())} timeZone="America/Toronto" />,
  );
  expect(html).toContain(
    '<span class="order-counter-paid order-online-paid">Paid online $11.30</span>',
  );
  expect(html).toContain("<dt>Payment</dt><dd>Paid online $11.30</dd>");
  expect(html).toContain("Oct 14, 2026, 10:08 PM");
  expect(html).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u);
  const single = renderToStaticMarkup(
    <CurrentOrderQueueRows single view={parse(order())} paymentPosition={position("500")} />,
  );
  expect(single).toContain("Paid online $11.30 · partly refunded");
});
