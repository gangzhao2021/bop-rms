import { renderToStaticMarkup } from "react-dom/server";
import { setLanguageForTest } from "./i18n/i18n.js";
import { expect, it } from "vitest";
import {
  readCurrentOrders,
  refreshedOrderState,
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
  orderChannel,
  orderChannelLabel,
  orderPhaseLabel,
  orderTypeLabel,
  paymentDueText,
  paymentDueTier,
  storeCancelledBatches,
  unpaidCancelledBatches,
  unpaidCancelledTotal,
  orderRefundRows,
  orderAgeText,
  orderAmountTaken,
  orderStatusTone,
  ordersSummary,
  orderLabel,
  orderItemsText,
  orderWho,
  orderWhen,
  handoverReady,
} from "./CurrentOrderQueuePage.js";
import {
  ordersAwaitingAcceptance,
  parseCurrentOrderDetail,
  parseCurrentOrderQueue,
} from "./current-order-queue-client.js";
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
  // Orders v2: the one order opens in the panel beside its row.
  expect(render(item)).toContain('class="order-row" data-open="true"');
  expect(render(item)).toContain('<aside class="order-panel"');
  // Owner 2026-10-26: no internal round counts ("1 accepted") on the row.
  expect(render(item)).not.toContain("1 accepted");
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
  ).toContain("No orders yet");
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
    filterCurrentOrderItems(view.items, { ...all, channel: "TableQr", phase: "Unavailable" }),
  ).toHaveLength(1);
  // DEC-ORDER-CHANNEL-LABEL: no "Website" channel beside "Online"; a table's Web order is its guests'.
  expect(
    filterCurrentOrderItems(view.items, { ...all, channel: "Web", phase: "Unavailable" }),
  ).toHaveLength(0);
});

it("Owner 2026-10-25: Today keeps the business day and earlier orders that still need staff", () => {
  const base = currentOrderQueueFixture().items[0];
  if (base === undefined) throw new Error("fixture");
  // Only the facts the filter reads; the rest is the fixture's order.
  const order = (n: string, listed: string, held = false) => ({
    ...base,
    orderNumber: n,
    listedBusinessDate: listed,
    heldStock: held ? { state: "Open" } : null,
    batches: base.batches.map((batch) => ({ ...batch, canRequestAcceptance: false })),
  });
  const items = [
    order("T-1", "2026-10-25"),
    order("Y-1", "2026-10-24"),
    order("Y-2", "2026-10-24", true),
  ];
  const all = { orderNumber: "", type: "All", channel: "All", phase: "All" };
  const today = { ...all, day: "Today" as const, today: "2026-10-25" };
  const shown = (filters: Parameters<typeof filterCurrentOrderItems>[1]) =>
    filterCurrentOrderItems(items as never, filters).map((item) => item.orderNumber);
  expect(shown({ ...all, day: "All", today: "2026-10-25" })).toEqual(["T-1", "Y-1", "Y-2"]);
  expect(shown(today)).toEqual(["T-1", "Y-2"]);
  // An exact order number finds the order on any day.
  expect(shown({ ...today, orderNumber: "y-1" })).toEqual(["Y-1"]);
  // While the business day is not known yet, nothing is hidden.
  expect(shown({ ...today, today: null })).toHaveLength(3);
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
  expect(html).toContain("Round cancelled");
  expect(html).not.toContain("Not accepted");
  // v15 1fc58e90 ⑧: rounds read in staff words; a pickup order's one batch reads as the order.
  expect(html).toContain("Round 1 · First round");
  expect(html).toContain("Round 2 · Added round");
  expect(html).not.toMatch(/Initial|Additional/u);
  const pickup = {
    ...view,
    items: view.items.map((item) => ({
      ...item,
      orderType: "Pickup" as const,
      batches: item.batches.slice(0, 1),
    })),
  };
  const pickupHtml = renderToStaticMarkup(<CurrentOrderQueueRows view={pickup} />);
  // The panel already names the order, so a pickup's one batch has no second heading.
  expect(pickupHtml).toContain('aria-label="Order"');
  expect(pickupHtml).not.toContain("<h3>Order</h3>");
  expect(pickupHtml).not.toContain("Round 1");
  expect(pickupHtml).not.toContain("Round 1");
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
          tip: money("237"),
        },
      }}
    />,
  );
  expect(html).toContain("2 ×");
  expect(html).toContain("Oat milk · Extra shot × 2");
  expect(html).toContain("Note: Extra hot");
  expect(html).not.toContain("Discount");
  // WP-2423 (3cd0f8dd M1): the tip the payment carried, and a total equal to what was paid.
  expect(html).toContain("<dt>Tip</dt><dd>$2.37</dd>");
  expect(html).toContain("<dt>Total</dt><dd>$18.19</dd>");
  const untipped = (tip: { amountMinor: string; currencyCode: string } | null) =>
    renderToStaticMarkup(
      <CurrentOrderLines
        lines={{
          items: [],
          totals: {
            subtotal: money("1400"),
            discount: money("0"),
            tax: money("182"),
            fee: money("0"),
            total: money("1582"),
            tip,
          },
        }}
      />,
    );
  for (const tip of [null, money("0")]) {
    expect(untipped(tip)).not.toContain("Tip");
    expect(untipped(tip)).toContain("<dt>Total</dt><dd>$15.82</dd>");
  }
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

it("WP-2423 UI refresh: a row reads the order's age, status tone and amount taken from its own data", () => {
  const at = Date.parse("2026-10-10T12:00:00.000Z");
  const by = (minutes: number) => new Date(at + minutes * 60_000).toISOString();
  const waiting = {
    orderReference: "01909968-0000-7000-8000-000000000021",
    orderNumber: "21",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-10T11:48:00.000Z",
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
    paidOnline: { amountMinor: "1130", currencyCode: "CAD" },
    currentPhase: "Submitted",
    currentVersion: 1,
  };
  const one = (value: object) => {
    const item = parseCurrentOrderQueue({ items: [value], nextAfterOrderReference: null }).items[0];
    if (item === undefined) throw new Error("no order");
    return item;
  };
  const order = one(waiting);
  expect(orderAgeText(order, at)).toBe("12 min");
  expect(orderAgeText(order, at + 60 * 60_000)).toBe("1 h 12 min");
  expect(orderAgeText(order, Date.parse(waiting.submittedAt) + 10_000)).toBe("Just now");
  // Waiting for acceptance is a warning, then danger in the last five minutes.
  expect(orderStatusTone(order, at)).toBe("warning");
  expect(orderStatusTone(order, at + 4 * 60_000)).toBe("danger");
  expect(orderAmountTaken(order)).toEqual({ amountMinor: "1130", currencyCode: "CAD" });
  const finished = one({
    ...waiting,
    canRequestAcceptance: false,
    acceptBy: null,
    currentPhase: "Fulfilled",
    currentVersion: 3,
    batches: [{ ...waiting.batches[0], acceptanceStatus: "Accepted", canRequestAcceptance: false }],
  });
  expect(orderAgeText(finished, at)).toBeNull();
  expect(orderStatusTone(finished, at)).toBe("done");
  expect(orderStatusTone({ ...finished, currentPhase: "Cancelled" }, at)).toBe("cancelled");
  // Orders v2: the ready tone follows the phase, not its words, so it holds in Chinese too.
  setLanguageForTest("zh-Hans");
  expect(orderStatusTone({ ...finished, currentPhase: "Ready" }, at)).toBe("ready");
  setLanguageForTest("en");
  expect(orderAmountTaken(one({ ...waiting, paidOnline: null }))).toBeNull();
  const html = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={parseCurrentOrderQueue({ items: [waiting], nextAfterOrderReference: null })}
      now={at}
    />,
  );
  expect(html).toContain('<span class="order-workbench-age" data-tone="warning">12 min</span>');
  expect(html).toContain('data-tone="warning" data-phase="Submitted"');
  // A plain online payment is the amount alone; only exceptions get words under it.
  expect(html).toContain(
    '<span class="order-workbench-amount"><span class="order-row__money">$11.30</span></span>',
  );
  // The order number is the row's heading and the button that opens it.
  expect(html).toMatch(/<h3 class="order-row__number"><button[^>]*>21<\/button><\/h3>/u);
  // No payment recorded is said, never shown as a made-up amount.
  expect(
    renderToStaticMarkup(
      <CurrentOrderQueueRows
        view={parseCurrentOrderQueue({
          items: [{ ...waiting, paidOnline: null }],
          nextAfterOrderReference: null,
        })}
        now={at}
      />,
    ),
  ).toContain("No payment recorded");
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
  expect(diningHtml).toContain("Round 2 cancelled · refunded");
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
it("46940b76 L2: lists every refund on the order so they add up to what was refunded", () => {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" as const });
  const lines = {
    items: [
      {
        cancellation: {
          refund: money("608"),
        },
      },
    ],
    totals: { total: money("1785") },
  } as unknown as Parameters<typeof orderRefundRows>[1];
  const cancellation = {
    reasonCode: "SOLD_OUT",
    cancelledAt: "2026-10-17T22:05:00.000Z",
    refundStatus: "Refunded",
    refundMethod: "Online",
    refundAmountMinor: "1177",
  } as const;
  const order = (staffCancellation: unknown, orderType = "Pickup") =>
    ({
      orderType,
      batches: [{ sequence: 1, staffCancellation }],
    }) as unknown as Parameters<typeof orderRefundRows>[0];
  const position = { refundedMinor: "1785", refundPendingMinor: "0" };
  // Order 23 of the 46940b76 run: one item cancelled, then the rest of the order.
  expect(orderRefundRows(order(cancellation), lines, position)).toEqual([
    { label: "Cancelled items refund", amount: money("608") },
    { label: "Order cancellation refund", amount: money("1177") },
    { label: "Total refunded", amount: money("1785") },
  ]);
  // A refund at the customer's request on top is listed too; a dine-in round is named.
  expect(
    orderRefundRows(order(cancellation, "DineIn"), lines, {
      refundedMinor: "2000",
      refundPendingMinor: "100",
    }).map((row) => [row.label, row.amount?.amountMinor]),
  ).toEqual([
    ["Cancelled items refund", "608"],
    ["Round 1 cancellation refund", "1177"],
    ["Other refunds", "315"],
    ["Total refunded", "2100"],
  ]);
  // Before Payment opens the cancellation's refund its amount is not guessed.
  expect(
    orderRefundRows(order({ ...cancellation, refundAmountMinor: null }), lines, position),
  ).toEqual([
    { label: "Cancelled items refund", amount: money("608") },
    { label: "Order cancellation refund", amount: null },
  ]);
  const html = renderToStaticMarkup(
    <CurrentOrderLines
      lines={
        parseCurrentOrderDetailFixtureLines() as Parameters<typeof CurrentOrderLines>[0]["lines"]
      }
      refundRows={orderRefundRows(order(cancellation), lines, position)}
    />,
  );
  expect(html).toMatch(/Cancelled items refund<\/dt><dd>−\$6\.08<\/dd>/u);
  expect(html).toMatch(/Order cancellation refund<\/dt><dd>−\$11\.77<\/dd>/u);
  expect(html).toMatch(/Total refunded<\/dt><dd>−\$17\.85<\/dd>/u);
});
function parseCurrentOrderDetailFixtureLines() {
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  return {
    items: [],
    totals: {
      subtotal: money("1576"),
      discount: money("0"),
      tax: money("0"),
      fee: money("0"),
      total: money("1576"),
      tip: money("209"),
    },
  };
}
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
  expect(failed).toContain("Round 2: Payment failed · will be cancelled automatically at 20:30");
  expect(failed).toMatch(
    /<p class="order-workbench-closed" role="note"><span class="order-accept-by" data-tier="urgent">Payment failed · will be cancelled automatically at 20:30<\/span>/u,
  );
  expect(failed).toContain("Don&#x27;t prepare it; it will not be charged.");
  expect(failed).not.toContain("Acceptance: Not accepted");
  // Plain words, never internal codes.
  // Owner 2026-10-26: the type and channel are said once (row and panel header), not repeated.
  expect(failed).not.toContain("<dt>Order type</dt>");
  expect(failed).toContain("Dine-in · Table QR code");
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
  expect(awaiting).toContain('data-tier="warning">Round 2: Awaiting payment');
  expect(awaiting).toContain("the guest has not paid for this round");
  // After the System cancelled it: not paid, nothing charged; not mistaken for a store cancellation.
  const cancelled = render({ acceptanceStatus: "Cancelled" });
  expect(cancelled).toContain("Round cancelled · not paid.");
  expect(cancelled).toContain(
    "never went to the kitchen and its items went back to stock. Nothing was charged for it in the system.",
  );
  expect(cancelled).not.toContain("Payment failed");
  // Owner 2026-10-26: the row says "2 rounds", not internal counts; the round itself says why.
  expect(cancelled).toContain("2 rounds");
  expect(cancelled).not.toContain("1 cancelled");
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
  // WP-2423 item 5: a round with no payment started is cancelled at its deadline; staff are warned.
  const due = { status: "Awaiting" as const, cancelsAt: "2026-09-14T00:30:00.000Z" };
  const at = (iso: string) => Date.parse(iso);
  expect(paymentDueText(due, "UTC", at("2026-09-14T00:05:00.000Z"), true)).toBe(
    "Entered by staff · record the card-machine payment by 00:30 or it is cancelled",
  );
  expect(paymentDueText(due, "UTC", at("2026-09-14T00:24:30.000Z"), true)).toBe(
    "Entered by staff · record the card-machine payment by 00:30 (6 min left) or it is cancelled",
  );
  expect(paymentDueText(due, "UTC", at("2026-09-14T00:05:00.000Z"))).toBe(
    "Not paid · cancelled automatically at 00:30 unless paid",
  );
  expect(paymentDueText(due, "UTC", at("2026-09-14T00:30:00.000Z"), true)).toBe(
    "Not paid in time · being cancelled automatically",
  );
  expect(paymentDueText({ status: "Awaiting", cancelsAt: null }, "UTC", undefined, true)).toBe(
    "Entered by staff · awaiting card-machine payment",
  );
  // WP-2423 abandoned payment: 5 minutes past the deadline the card provider still couldn't
  // confirm the guest's online payment; staff check with the guest.
  expect(paymentDueText(due, "UTC", at("2026-09-14T00:35:00.000Z"))).toBe(
    "Card payment not confirmed by the card provider (due 00:30) · ask the guest if they were charged; if not, cancel the round (a later charge is refunded automatically)",
  );
  expect(paymentDueText(due, "UTC", at("2026-09-14T00:35:00.000Z"), true)).toBe(
    "Not paid in time · being cancelled automatically",
  );
  expect(paymentDueTier(due, at("2026-09-14T00:05:00.000Z"))).toBe("warning");
  expect(paymentDueTier(due, at("2026-09-14T00:21:00.000Z"))).toBe("urgent");
  expect(paymentDueTier({ status: "Failed", cancelsAt: due.cancelsAt })).toBe("urgent");
  expect(orderTypeLabel.DineIn).toBe("Dine-in");
  expect(["Online", "TableQr", "Web", "Pos", "Api", "Kiosk"].map(orderChannelLabel)).toEqual([
    "Online",
    "Table QR code",
    "Online",
    "Counter",
    "Partner integration",
    "Other",
  ]);
  expect(orderChannelLabel("Staff")).toBe("Taken by staff");
});

it("WP-2423: a table order whose first round staff entered is listed and filtered as taken by staff", () => {
  const batch = (sequence: number, staff: boolean) => ({
    sequence,
    staffRound: staff
      ? { recordedAfterOutage: false, paidOnCardMachine: null, amountDueMinor: null }
      : null,
  });
  type Order = Parameters<typeof orderChannel>[0];
  const order = (orderType: string, batches: unknown[]) =>
    ({ orderType, sourceChannel: "Qr", batches }) as unknown as Order;
  expect(orderChannel(order("DineIn", [batch(1, true), batch(2, false)]))).toBe("Staff");
  // Guests opened the table by QR code; a later staff round keeps its own "Entered by staff".
  expect(orderChannel(order("DineIn", [batch(1, false), batch(2, true)]))).toBe("TableQr");
  // DEC-ORDER-CHANNEL-LABEL: a pickup order the customer placed from the Store's start page is
  // online, not a table QR code; a counter order stays Counter.
  expect(orderChannel(order("Pickup", [batch(1, false)]))).toBe("Online");
  expect(
    orderChannel({ ...order("Pickup", [batch(1, false)]), sourceChannel: "Web" } as Order),
  ).toBe("Online");
  expect(
    orderChannel({ ...order("Pickup", [batch(1, false)]), sourceChannel: "Pos" } as Order),
  ).toBe("Pos");
  // Guests ordering at a table from the Store's web page are still the table's own guests.
  expect(
    orderChannel({ ...order("DineIn", [batch(1, false)]), sourceChannel: "Web" } as Order),
  ).toBe("TableQr");
  const items = [
    order("DineIn", [batch(1, true)]),
    order("DineIn", [batch(1, false)]),
  ] as unknown as Parameters<typeof filterCurrentOrderItems>[0];
  const all = { orderNumber: "", type: "All", channel: "All", phase: "All" };
  expect(filterCurrentOrderItems(items, { ...all, channel: "Staff" })).toEqual([items[0]]);
  expect(filterCurrentOrderItems(items, { ...all, channel: "TableQr" })).toEqual([items[1]]);
  expect(filterCurrentOrderItems(items, { ...all, channel: "Online" })).toEqual([]);
});

it("WP-2423: a dine-in order whose items were all served reads Served, not Ready", () => {
  expect(orderPhaseLabel({ orderType: "DineIn", currentPhase: "Fulfilled" })).toBe("Served");
  expect(orderPhaseLabel({ orderType: "DineIn", currentPhase: "Ready" })).toBe("Ready");
  expect(orderPhaseLabel({ orderType: "Pickup", currentPhase: "Fulfilled" })).toBe("Picked up");
  expect(orderPhaseLabel({ orderType: "DineIn", currentPhase: "InProgress" })).toBe("In progress");
  expect(orderPhaseLabel({ orderType: "DineIn", currentPhase: null })).toBe(
    "Status not loaded · refresh",
  );
});

it("WP-2423 v15 2026-10-18: an accepted pickup reads what the kitchen shows on the detail", () => {
  expect(
    orderPhaseLabel({ orderType: "Pickup", currentPhase: "Accepted", kitchenPhase: "Ready" }),
  ).toBe("Ready for pickup");
  expect(
    orderPhaseLabel({ orderType: "Pickup", currentPhase: "Accepted", kitchenPhase: "InProgress" }),
  ).toBe("In progress");
  expect(
    orderPhaseLabel({ orderType: "Pickup", currentPhase: "Accepted", kitchenPhase: null }),
  ).toBe("Accepted");
  // Handed over wins over the kitchen.
  expect(
    orderPhaseLabel({ orderType: "Pickup", currentPhase: "Fulfilled", kitchenPhase: "Ready" }),
  ).toBe("Picked up");
  const accepted = currentOrderQueueFixture().items[2];
  if (accepted === undefined) throw new Error("fixture");
  const read = (kitchenPhase: unknown, extra: Record<string, unknown> = {}) =>
    parseCurrentOrderQueue({
      items: [{ ...accepted, ...extra, kitchenPhase }],
      nextAfterOrderReference: null,
    }).items[0]?.kitchenPhase;
  expect(read("Ready")).toBe("Ready");
  expect(read(null)).toBeNull();
  expect(
    parseCurrentOrderQueue({ items: [accepted], nextAfterOrderReference: null }).items[0]
      ?.kitchenPhase,
  ).toBeNull();
  // Only an accepted pickup carries it, with a kitchen state the page knows.
  expect(() => read("Completed")).toThrow();
  expect(() => read("Ready", { orderType: "DineIn" })).toThrow();
});

it("WP-2423 (2026-10-18): a table whose dish the kitchen is remaking reads Being remade", () => {
  expect(
    orderPhaseLabel({ orderType: "DineIn", currentPhase: "Ready", remakingItemCount: 1 }),
  ).toBe("Being remade");
  expect(
    orderPhaseLabel({ orderType: "DineIn", currentPhase: "Fulfilled", remakingItemCount: 1 }),
  ).toBe("Being remade");
  expect(
    orderPhaseLabel({ orderType: "DineIn", currentPhase: "InProgress", remakingItemCount: 1 }),
  ).toBe("In progress");
  expect(
    orderPhaseLabel({ orderType: "DineIn", currentPhase: "Ready", remakingItemCount: 0 }),
  ).toBe("Ready");
  const table = currentOrderQueueFixture().items.find((item) => item.orderType === "DineIn");
  if (table === undefined) throw new Error("fixture");
  const read = (remakingItemCount: unknown, extra: Record<string, unknown> = {}) =>
    parseCurrentOrderQueue({
      items: [{ ...table, ...extra, remakingItemCount }],
      nextAfterOrderReference: null,
    }).items[0]?.remakingItemCount;
  expect(read(2)).toBe(2);
  // An older server sends none: nothing is being remade as far as the list knows.
  expect(
    parseCurrentOrderQueue({ items: [table], nextAfterOrderReference: null }).items[0]
      ?.remakingItemCount,
  ).toBe(0);
  expect(() => read(-1)).toThrow();
  expect(() => read(1.5)).toThrow();
  expect(() => read(1, { orderType: "Pickup" })).toThrow();
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
  expect(text(order(), position("1130"))).toBe("Paid online $11.30 · refunded in full");
  expect(text(order(), position("0", "1130"))).toBe("Paid online $11.30 · refund in progress");
  expect(text(order(), position("500", "630"))).toBe(
    "Paid online $11.30 · partly refunded, refund in progress",
  );
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
  ).toBe("Paid online $11.30 · refunded in full");
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
  expect(text(cancelled("Pending"))).toBe("Paid online $11.30 · refund in progress");
  expect(text(cancelled("Refunded"))).toBe("Paid online $11.30 · refunded in full");
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
  // The row shows the amount alone; the panel says how it was paid.
  expect(html).toContain('<span class="order-row__money">$11.30</span>');
  expect(html).not.toContain('class="order-row__paid"');
  expect(html).toContain('<ul class="order-panel__payment"><li>Paid online $11.30</li></ul>');
  // A refund is an exception, so the row says it under the amount.
  expect(
    renderToStaticMarkup(
      <CurrentOrderQueueRows
        view={parse(order())}
        paymentPositions={new Map([[order().orderReference as string, position("1130")]])}
      />,
    ),
  ).toContain('<span class="order-row__paid">refunded in full</span>');
  // Orders v3: one date style — weekday and date, the year when not this year, then the time.
  expect(html).toContain("Wed, Oct 14, 2026 22:08");
  expect(html).not.toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u);
  const single = renderToStaticMarkup(
    <CurrentOrderQueueRows single view={parse(order())} paymentPosition={position("500")} />,
  );
  expect(single).toContain("Paid online $11.30 · partly refunded");
});

it("WP-2423 follow-up: counts a table whose later round awaits acceptance as one waiting order", () => {
  const fixture = currentOrderQueueFixture();
  const [ready, awaiting, accepted] = fixture.items;
  if (!ready || !awaiting?.batches[0] || !accepted?.batches[0]) throw new Error("fixture");
  const firstRound = { ...accepted.batches[0], canCancel: false };
  const laterRound = "018f7600-0000-7000-8000-000000000032";
  const table = {
    ...accepted,
    orderReference: "018f7600-0000-7000-8000-000000000031",
    orderType: "DineIn" as const,
    batches: [
      firstRound,
      {
        ...firstRound,
        orderBatchReference: laterRound,
        sequence: 2,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: true,
      },
    ],
    canRequestAcceptance: false,
  };
  const view = parseCurrentOrderQueue({ ...fixture, items: [table, ready, awaiting] }, null);
  expect(awaitingBatchReferences(view)).toEqual(
    new Set([laterRound, awaiting.batches[0].orderBatchReference]),
  );
  expect(ordersAwaitingAcceptance(view)).toBe(2);
});

it("WP-2423 v15 DEMO-02: an order whose every round was cancelled and refunded reads refunded in full", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const cancellation = (
    refundMethod: "Online" | "CardMachine",
    refundAmountMinor: string | null,
  ) => ({
    reasonCode: "SOLD_OUT",
    cancelledAt: "2026-10-15T02:30:00.000Z",
    refundStatus: "Refunded",
    refundMethod,
    refundAmountMinor,
  });
  const round = (n: number, extra: object) => ({
    orderBatchReference: id(90 + n),
    sequence: n,
    acceptanceStatus: "Cancelled",
    canRequestAcceptance: false,
    canCancel: false,
    canCancelItems: false,
    paymentDue: null,
    staffRound: null,
    ...extra,
  });
  const machineRound = (n: number) =>
    round(n, {
      staffCancellation: cancellation("CardMachine", "1500"),
      staffRound: {
        recordedAfterOutage: false,
        paidOnCardMachine: { amountMinor: "1500", takenAt: "2026-10-15T02:20:00.000Z" },
      },
    });
  // Online rounds refunded online; card-machine rounds refunded on the machine and recorded.
  const view = parseCurrentOrderQueue({
    items: [
      {
        orderReference: id(1),
        orderNumber: "DEMO-02",
        orderType: "DineIn",
        sourceChannel: "Qr",
        submittedAt: "2026-10-15T02:08:00.000Z",
        observedAt: "2026-10-15T02:40:00.000Z",
        initialBatchReference: id(91),
        batches: [
          round(1, { staffCancellation: cancellation("Online", null) }),
          machineRound(2),
          round(3, { staffCancellation: cancellation("Online", null) }),
          machineRound(4),
        ],
        canRequestAcceptance: false,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        paidOnline: { amountMinor: "10707", currencyCode: "CAD" },
        currentPhase: "Cancelled",
        currentVersion: 6,
      },
    ],
    nextAfterOrderReference: null,
  });
  const order = view.items[0];
  if (order === undefined) throw new Error("no order");
  // Without Payment's totals, card-machine rounds are not part of the online payment.
  expect(onlinePaymentText(order)).toBe("Paid online $107.07 · refunded in full");
  // Payment's totals decide when known: everything paid online was refunded.
  const full = { refundedMinor: "10707", refundPendingMinor: "0" };
  expect(onlinePaymentText(order, full)).toBe("Paid online $107.07 · refunded in full");
  // The list header uses the totals read for an opened order instead of the per-round guess.
  const listed = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={view}
      paymentPositions={new Map([[id(1), { refundedMinor: "5000", refundPendingMinor: "0" }]])}
    />,
  );
  expect(listed).toContain("Paid online $107.07 · partly refunded");
  expect(listed).not.toContain("Paid online $107.07 · refunded in full");
  const listedFull = renderToStaticMarkup(
    <CurrentOrderQueueRows view={view} paymentPositions={new Map([[id(1), full]])} />,
  );
  expect(listedFull).toContain("Paid online $107.07 · refunded in full");
  expect(listedFull).not.toContain("partly refunded");
});

it("WP-2423: an opened order stays open and in place when the page refreshes after an action", async () => {
  const fixture = parseCurrentOrderQueue(currentOrderQueueFixture());
  const [first, second] = fixture.items;
  if (!first || !second) throw new Error("fixture");
  // The page keeps the opened orders; rows rendered again after a refresh keep them open.
  const html = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={fixture}
      expanded={{ opened: new Set([second.orderReference]), setOpened: () => undefined }}
      detail={(order, open) => (open ? <p>{"open:" + order.orderNumber}</p> : null)}
    />,
  );
  const entries = html.split('<li class="order-row"').slice(1);
  expect(entries).toHaveLength(fixture.items.length);
  expect(entries[0]?.startsWith(' data-open="true"')).toBe(false);
  expect(entries[1]?.startsWith(' data-open="true"')).toBe(true);
  expect(html).toContain("open:" + second.orderNumber);
  expect(html).not.toContain("open:" + first.orderNumber);
  // A reread in place never passes through Loading (which unmounts the rows) and keeps the detail.
  const loading = { kind: "Loading" } as const;
  expect(refreshedOrderState(loading, { view: fixture })).toBe(loading);
  const detail = { view: fixture } as unknown as Parameters<
    typeof refreshedOrderState
  >[1]["detail"];
  const ready = { kind: "Ready", view: fixture, detail } as Parameters<
    typeof refreshedOrderState
  >[0];
  const next = parseCurrentOrderQueue({
    items: [currentOrderQueueFixture().items[0]],
    nextAfterOrderReference: null,
  });
  expect(refreshedOrderState(ready, { view: next })).toEqual({ kind: "Ready", view: next, detail });
  // The same read as the page's own: the list page, or the one order with its detail.
  const calls: string[] = [];
  const client = {
    load: (after: string | null) => {
      calls.push("list:" + String(after));
      return Promise.resolve(fixture);
    },
    loadDetail: (reference: string) => {
      calls.push("detail:" + reference);
      return Promise.resolve({ view: next } as never);
    },
  };
  const signal = new AbortController().signal;
  await expect(readCurrentOrders(client, "cursor", undefined, signal)).resolves.toEqual({
    view: fixture,
  });
  await expect(readCurrentOrders(client, null, first.orderReference, signal)).resolves.toEqual({
    view: next,
    detail: { view: next },
  });
  expect(calls).toEqual(["list:cursor", "detail:" + first.orderReference]);
});

it("WP-2423: a list row reads its refund position with the list, so it agrees with the detail", () => {
  const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
  const order = (extra: object = {}) => ({
    orderReference: id(1),
    orderNumber: "9",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-15T02:08:00.000Z",
    observedAt: "2026-10-15T02:09:00.000Z",
    initialBatchReference: id(91),
    batches: [
      {
        orderBatchReference: id(91),
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
    paidOnline: { amountMinor: "1130", currencyCode: "CAD" },
    currentPhase: "Accepted",
    currentVersion: 2,
    ...extra,
  });
  const parse = (value: object) =>
    parseCurrentOrderQueue({ items: [value], nextAfterOrderReference: null });
  // An item cancelled and refunded online: no batch was cancelled, only Payment knows the refund.
  const view = parse(order({ paymentPosition: { refundedMinor: "350", refundPendingMinor: "0" } }));
  expect(view.items[0]?.paymentPosition).toEqual({ refundedMinor: "350", refundPendingMinor: "0" });
  const rows = renderToStaticMarkup(<CurrentOrderQueueRows view={view} timeZone="UTC" />);
  expect(rows).toContain("Paid online $11.30 · partly refunded");
  // The same row before the refund, and from an older server without the field.
  expect(parse(order({ paymentPosition: null })).items[0]?.paymentPosition).toBeNull();
  expect(parse(order()).items[0]?.paymentPosition).toBeNull();
  expect(
    renderToStaticMarkup(<CurrentOrderQueueRows view={parse(order())} timeZone="UTC" />),
  ).not.toContain("refunded");
  // The detail's own read wins on the order's page; an opened row's read fills a row without one.
  const single = renderToStaticMarkup(
    <CurrentOrderQueueRows
      single
      view={parse(order())}
      timeZone="UTC"
      paymentPosition={{ refundedMinor: "1130", refundPendingMinor: "0" }}
    />,
  );
  expect(single).toContain("Paid online $11.30 · refunded in full");
  const opened = renderToStaticMarkup(
    <CurrentOrderQueueRows
      view={parse(order())}
      timeZone="UTC"
      paymentPositions={new Map([[id(1), { refundedMinor: "0", refundPendingMinor: "350" }]])}
    />,
  );
  expect(opened).toContain("Paid online $11.30 · refund in progress");
  // A position needs an online payment and never exceeds it.
  expect(() =>
    parse(
      order({
        paidOnline: null,
        paymentPosition: { refundedMinor: "1", refundPendingMinor: "0" },
      }),
    ),
  ).toThrow();
  expect(() =>
    parse(order({ paymentPosition: { refundedMinor: "1000", refundPendingMinor: "131" } })),
  ).toThrow();
  expect(() =>
    parse(order({ paymentPosition: { refundedMinor: "1.5", refundPendingMinor: "0" } })),
  ).toThrow();
});

it("Orders v2: the header line counts today's orders apart from earlier-day orders still listed", () => {
  const fixture = parseCurrentOrderQueue(currentOrderQueueFixture());
  const [first, second] = fixture.items;
  if (!first || !second) throw new Error("fixture");
  const view = {
    ...fixture,
    items: [
      { ...first, listedBusinessDate: "2026-10-26", heldStock: null },
      {
        ...second,
        businessDate: "2026-10-24",
        listedBusinessDate: "2026-10-26",
        heldStock: {
          since: "2026-10-24T23:00:00.000Z",
          state: "Open" as const,
          orderBatchReference: second.initialBatchReference,
          productionStarted: true,
        },
      },
    ],
  };
  expect(ordersSummary(view, "2026-10-26", 0)).toBe("1 order today · 1 from earlier days");
  expect(ordersSummary(view, "2026-10-26", 2)).toBe(
    "1 order today · 2 to accept · 1 from earlier days",
  );
  expect(ordersSummary(view, null, 1)).toBe("2 orders on this page · 1 to accept");
});

it("Orders v3: a row says what, who and which day, and an accepted pickup's next step is the handoff", () => {
  const fixture = parseCurrentOrderQueue(currentOrderQueueFixture());
  const [, , accepted] = fixture.items;
  if (!accepted) throw new Error("fixture");
  // Numbers restart each business day: an earlier day's order carries its date.
  expect(orderLabel({ orderNumber: "1", businessDate: "2026-10-24" }, "2026-10-26")).toBe(
    "10/24 · 1",
  );
  expect(orderLabel({ orderNumber: "4", businessDate: "2026-10-26" }, "2026-10-26")).toBe("4");
  const summary = {
    items: [
      { name: "Latte", option: "Small", quantity: 1 },
      { name: "Mocha", option: null, quantity: 2 },
      { name: "Water", option: null, quantity: 1 },
    ],
    lineCount: 4,
    pickupName: "TEST Sam",
    tableLabel: null,
  };
  expect(orderItemsText(summary)).toBe("1× Latte (Small), 2× Mocha +2 more");
  expect(orderItemsText(null)).toBeNull();
  // Who: the pickup name, else the table, else how it came in — never a phone or email.
  expect(orderWho({ ...accepted, summary })).toBe("TEST Sam");
  expect(
    orderWho({
      ...accepted,
      orderType: "DineIn",
      summary: { ...summary, pickupName: null, tableLabel: "12" },
    }),
  ).toBe("Table 12");
  expect(orderWho({ ...accepted, summary: null })).toBe("Online");
  // One date style: the time today, else weekday and date (the year only when not this year).
  expect(orderWhen("2026-10-26T19:02:00.000Z", "America/Toronto", "2026-10-26")).toBe("15:02");
  expect(orderWhen("2026-10-25T00:00:00.000Z", "America/Toronto", "2026-10-26")).toBe(
    "Sat, Oct 24 20:00",
  );
  expect(orderWhen("2025-10-25T00:00:00.000Z", "America/Toronto", "2026-10-26")).toBe(
    "Fri, Oct 24, 2025 20:00",
  );
  // An accepted, paid pickup is handed over on Pickup; one waiting to be accepted is not.
  const now = Date.parse("2026-08-12T12:00:00.000Z");
  // Live check 2026-10-26: not while the kitchen is still making it.
  expect(handoverReady(accepted, now)).toBe(false);
  expect(handoverReady({ ...accepted, kitchenPhase: "InProgress" }, now)).toBe(false);
  const ready = { ...accepted, kitchenPhase: "Ready" as const };
  expect(handoverReady(ready, now)).toBe(true);
  expect(handoverReady({ ...accepted, currentPhase: "Ready" }, now)).toBe(true);
  expect(handoverReady({ ...ready, currentPhase: "Submitted" }, now)).toBe(false);
  expect(handoverReady({ ...ready, awaitingPayment: true }, now)).toBe(false);
  expect(handoverReady({ ...ready, orderType: "DineIn" }, now)).toBe(false);
  // The tabs count it where the kitchen has it.
  const items = [accepted, ready, { ...accepted, kitchenPhase: "InProgress" as const }];
  const count = (phase: string) =>
    filterCurrentOrderItems(items, { orderNumber: "", type: "All", channel: "All", phase }).length;
  expect([count("Accepted"), count("InProgress"), count("Ready")]).toEqual([1, 1, 1]);
});
