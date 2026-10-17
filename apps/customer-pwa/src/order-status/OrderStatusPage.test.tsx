import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import {
  OrderStatusPage,
  VisitEndedNotice,
  isOrderSettled,
  orderMoneySummary,
} from "./OrderStatusPage.js";
import type { OrderStatusController } from "./order-status-controller.js";
import type { OrderStatusState, OrderStatusView } from "./types.js";
import { endSentence, formatClockTime } from "../journey/format.js";
import { findInternalText, staticText } from "../../e2e/internal-text-patterns.js";

const id = (n: number) => `018f7a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function controller(state: OrderStatusState): OrderStatusController {
  return {
    getState: () => state,
    load: async () => undefined,
    refresh: async () => undefined,
    setOnline: () => undefined,
    dispose: () => undefined,
    subscribe: () => () => undefined,
  };
}

function readyState(
  freshnessStatus: "Fresh" | "Stale" | "Rebuilding" | "Failed" = "Fresh",
): OrderStatusState {
  return {
    status: "ready",
    realtime: "unavailable",
    refreshing: false,
    view: {
      projectionName: "ordering_order_status_v1",
      projectionVersion: 1,
      sourceCheckpoint: id(2),
      projectedAt: "2026-08-11T14:00:00.000Z",
      freshnessStatus,
      order: {
        orderReference: id(1),
        orderNumber: "1001",
        orderType: "Pickup",
        canonicalPhase: "Submitted",
        paymentStatus: "NotReported",
        kitchenStatus: "Unavailable",
        fulfillmentStatus: "Unavailable",
        fulfilledAt: null,
        eta: null,
        submittedAt: "2026-08-11T13:55:00.000Z",
        batches: [
          {
            orderBatchReference: id(3),
            submittedAt: "2026-08-11T13:55:00.000Z",
            items: [
              {
                orderItemReference: id(4),
                displayName: "Synthetic bowl",
                quantity: 2,
                lineTotal: { amountMinor: 2598n, currencyCode: "CAD" },
              },
            ],
          },
        ],
      },
    },
  };
}

function render(state: OrderStatusState): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/orders/${id(1)}`]}>
      <Routes>
        <Route
          path="/orders/:orderReference"
          element={<OrderStatusPage controller={controller(state)} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("CUST-ORDER-STATUS screen contract", () => {
  it("renders only admitted status facts and links to the authorized receipt route", () => {
    const html = render(readyState());
    expect(html).toContain("Order submitted");
    expect(html).toContain("2 × Synthetic bowl");
    expect(html).toContain("$25.98");
    expect(html).toContain("Kitchen status");
    expect(html).toContain("Not started yet");
    // No payment result was read: the row is left out rather than shown as unavailable.
    expect(html).not.toContain("<dt>Payment</dt>");
    expect(html).toContain("Your pickup code appears here as soon as your order is ready.");
    expect(html).not.toContain("Show pickup code");
    expect(html).toContain("View receipt and support");
    expect(html).not.toContain("Ready for pickup");
  });

  it("tells a paid guest the kitchen hasn't started yet, in their words", () => {
    const state = readyState();
    if (state.status !== "ready") throw new Error("fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        sources: {
          checkedAt: "2026-08-11T14:00:00.000Z",
          kitchen: null,
          payments: [
            {
              status: "Succeeded",
              occurredAt: "2026-08-11T13:56:00.000Z",
              amount: { amountMinor: 2598n, currencyCode: "CAD" },
              freshnessStatus: "Fresh",
            },
          ],
        },
      },
    });
    expect(html).toContain("<dt>Kitchen status</dt><dd>Not started yet</dd>");
    expect(html).toContain("Payment received $25.98");
    expect(findInternalText([staticText(html)])).toEqual([]);
  });

  it("leaves the kitchen row out once a not-started order was cancelled", () => {
    const state = readyState();
    if (state.status !== "ready") throw new Error("fixture");
    const html = render({
      ...state,
      view: { ...state.view, order: { ...state.view.order, canonicalPhase: "Cancelled" } },
    });
    expect(html).not.toContain("Kitchen status");
    expect(findInternalText([staticText(html)])).toEqual([]);
  });

  it("makes stale projection evidence explicit", () => {
    const html = render(readyState("Stale"));
    expect(html).toContain("Status may be delayed");
    expect(html).toContain("The details below may be out of date.");
    expect(html).not.toContain("Projection state");
  });

  it.each([
    ["Rebuilding", "We’re updating your order status."],
    ["Failed", "We couldn’t update your order status."],
  ] as const)("explains %s without exposing projection internals", (freshness, message) => {
    const html = render(readyState(freshness));
    expect(html).toContain(message);
    expect(html).not.toContain("Projection");
  });

  it("describes collection without implying financial closure", () => {
    const state = readyState();
    if (state.status !== "ready") throw new Error("fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        order: {
          ...state.view.order,
          canonicalPhase: "Fulfilled",
          fulfillmentStatus: "Completed",
          fulfilledAt: "2026-08-11T14:00:00.000Z",
        },
      },
    });
    expect(html).toContain("Order collected");
    expect(html).not.toContain("Order completed");
    expect(html).not.toContain("Show pickup code");
  });

  it.each([{ status: "unavailable" }, { status: "offline", view: null }] as const)(
    "offers manual recovery in $status",
    (state) => {
      expect(render(state)).toContain("Try loading status");
    },
  );

  it.each([
    [{ status: "loading" }, "Loading order status"],
    [{ status: "invalid-reference" }, "Order link is invalid"],
    [{ status: "permission-denied" }, "Your visit on this phone has ended"],
    [{ status: "not-found" }, "We can’t show this order here yet"],
    [{ status: "feature-disabled" }, "Order tracking is disabled"],
    [{ status: "unavailable" }, "Order status isn’t available"],
    [{ status: "offline", view: null }, "You’re offline"],
  ] as const)("renders the bounded state %#", (state, message) => {
    expect(render(state)).toContain(message);
  });
});

describe("independently sourced customer updates", () => {
  it("renders individual payment evidence and kitchen progress without whole-order payment claims", () => {
    const state = readyState();
    if (state.status !== "ready") throw new Error("fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        sources: {
          checkedAt: "2026-08-11T14:00:00.000Z",
          kitchen: {
            batches: [
              {
                orderBatchReference: id(3),
                status: "InProgress",
                updatedAt: "2026-08-11T13:59:00.000Z",
              },
            ],
          },
          payments: [
            {
              status: "Succeeded",
              occurredAt: "2026-08-11T13:56:00.000Z",
              amount: { amountMinor: 2598n, currencyCode: "CAD" },
              freshnessStatus: "Stale",
            },
            {
              status: "Failed",
              occurredAt: "2026-08-11T13:57:00.000Z",
              amount: null,
              freshnessStatus: "Fresh",
            },
          ],
        },
      },
    });
    expect(html).toContain("Preparing");
    expect(html).toContain("Payment received $25.98");
    expect(html).toContain("This payment update may be out of date");
    expect(html).not.toContain("Paid ");
    expect(html).not.toContain("Ready for pickup");
  });
});

it("preserves a ready batch without claiming all batches ready", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const original = state.view.order.batches[0];
  if (!original) throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      order: {
        ...state.view.order,
        batches: [original, { ...original, orderBatchReference: id(30) }],
      },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: {
          batches: [
            {
              orderBatchReference: original.orderBatchReference,
              status: "Ready",
              updatedAt: "2026-08-11T14:00:00.000Z",
            },
          ],
        },
        payments: null,
      },
    },
  });
  expect(html).toContain("Preparing");
  expect(html).toContain("Not started yet");
  expect(html).toContain(">Ready<");
});

it("shows partial Dining serving without claiming collection or full payment", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      order: { ...state.view.order, orderType: "DineIn" },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: null,
        dining: {
          items: [{ orderItemReference: id(4), orderBatchReference: id(3), servedQuantity: 1 }],
        },
      },
    },
  });
  expect(html).toContain("Served 1 of 2");
  expect(html).not.toContain("Order collected");
  // WP-2423 Q8: a dine-in order leads to the whole table's rounds.
  expect(html).toContain('href="/dine-in/session"');
  expect(html).toContain("See everything your table ordered");
});

it.each([
  [0, "Your order is ready"],
  [1, "Serving your order"],
  [2, "Items served"],
] as const)(
  "reflects Dining served quantity %s without claiming closure",
  (servedQuantity, heading) => {
    const state = readyState("Stale");
    if (state.status !== "ready") throw new Error("fixture");
    const html = render({
      ...state,
      view: {
        ...state.view,
        order: { ...state.view.order, orderType: "DineIn" },
        sources: {
          checkedAt: "2026-08-11T14:00:00.000Z",
          kitchen: {
            batches: [
              {
                orderBatchReference: id(3),
                status: "Ready",
                updatedAt: "2026-08-11T13:59:00.000Z",
              },
            ],
          },
          payments: null,
          dining: {
            items: [{ orderItemReference: id(4), orderBatchReference: id(3), servedQuantity }],
          },
        },
      },
    });
    expect(html).toContain(heading);
    expect(html).toContain("Status may be delayed");
    expect(html).not.toContain("Order submitted");
    expect(html).not.toContain("Order collected");
    expect(html).not.toContain("Order completed");
  },
);

it("does not treat a ready Pickup kitchen as collection", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: {
          batches: [
            { orderBatchReference: id(3), status: "Ready", updatedAt: "2026-08-11T13:59:00.000Z" },
          ],
        },
        payments: null,
      },
    },
  });
  expect(html).toContain("Ready for pickup");
  expect(html).toContain("Checking your pickup code");
  expect(html).not.toContain("Order collected");
});

it("keeps unserved additional batches out of the all-served summary", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const first = state.view.order.batches[0];
  if (!first) throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      order: {
        ...state.view.order,
        orderType: "DineIn",
        batches: [
          first,
          {
            ...first,
            orderBatchReference: id(30),
            items: first.items.map((item) => ({ ...item, orderItemReference: id(40) })),
          },
        ],
      },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: null,
        dining: {
          items: [
            { orderItemReference: id(4), orderBatchReference: id(3), servedQuantity: 2 },
            { orderItemReference: id(40), orderBatchReference: id(30), servedQuantity: 0 },
          ],
        },
      },
    },
  });
  expect(html).toContain("Serving your order");
  expect(html).not.toContain("All listed items have been served.");
});

it.each([
  ["Cancelled", "Order cancelled"],
  ["Rejected", "Order not accepted"],
] as const)("shows %s without a submitted claim", (canonicalPhase, heading) => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const html = render({
    ...state,
    view: { ...state.view, order: { ...state.view.order, canonicalPhase } },
  });
  expect(html).toContain(heading);
  expect(html).not.toContain("Order submitted");
});

const phaseTable = [
  [
    "Pickup",
    "Submitted",
    "Order submitted",
    "We have your order. The store will confirm it shortly.",
    false,
  ],
  [
    "Pickup",
    "Accepted",
    "Order accepted",
    "The store has your order and will start preparing it soon.",
    false,
  ],
  ["Pickup", "In Progress", "Preparing your order", "The kitchen is preparing your order.", false],
  ["Pickup", "Ready", "Ready for pickup", "Your order is ready. Collect it at the counter.", false],
  ["Pickup", "Fulfilled", "Order collected", "Your order has been collected. Enjoy!", true],
  ["Pickup", "Rejected", "Order not accepted", "Your order wasn’t accepted.", true],
  ["Pickup", "Cancelled", "Order cancelled", "Your order has been cancelled.", true],
  [
    "DineIn",
    "Submitted",
    "Order submitted",
    "We have your order. The store will confirm it shortly.",
    false,
  ],
  [
    "DineIn",
    "Accepted",
    "Order accepted",
    "The kitchen has your order and will start preparing it soon.",
    false,
  ],
  ["DineIn", "In Progress", "Preparing your order", "The kitchen is preparing your order.", false],
  [
    "DineIn",
    "Ready",
    "Your order is ready",
    "Your food is ready and will be brought to your table shortly.",
    false,
  ],
  // DEC-PILOT-BATCH-PHASE-01: every remaining item served. The table can still order another
  // round, so the page keeps checking.
  ["DineIn", "Fulfilled", "Items served", "All listed items have been served.", false],
  ["DineIn", "Rejected", "Order not accepted", "Your order wasn’t accepted.", true],
  ["DineIn", "Cancelled", "Order cancelled", "Your order has been cancelled.", true],
] as const;

it.each(phaseTable)(
  "Handoff 24.3: a %s order in phase %s reads %s",
  (orderType, canonicalPhase, heading, lede, settled) => {
    const state = readyState();
    if (state.status !== "ready") throw new Error("fixture");
    const completed = orderType === "Pickup" && canonicalPhase === "Fulfilled";
    const view = {
      ...state.view,
      order: {
        ...state.view.order,
        orderType,
        canonicalPhase,
        fulfillmentStatus: completed ? ("Completed" as const) : ("Unavailable" as const),
        fulfilledAt: completed ? "2026-08-11T13:59:00.000Z" : null,
      },
    };
    const html = render({ ...state, view });
    expect(html).toContain(
      `<h2 id="order-progress-heading">${heading}</h2><p>${lede.replaceAll("'", "&#x27;")}</p>`,
    );
    expect(isOrderSettled(view)).toBe(settled);
    expect(findInternalText([staticText(html)])).toEqual([]);
  },
);

it("tells a pickup guest the store accepted the order while the kitchen ticket is still queued", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      order: { ...state.view.order, canonicalPhase: "Accepted" },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: {
          batches: [
            { orderBatchReference: id(3), status: "Queued", updatedAt: "2026-08-11T13:59:00.000Z" },
          ],
        },
        payments: null,
      },
    },
  });
  expect(html).toContain("Order accepted");
  expect(html).toContain("<dt>Kitchen status</dt><dd>In the queue</dd>");
  expect(html).not.toContain("Order submitted");
  expect(html).toContain("Your pickup code appears here as soon as your order is ready.");
});

it("WP-2423: a pickup closed as not collected reads as not collected even though its phase is Cancelled", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const view = {
    ...state.view,
    order: { ...state.view.order, canonicalPhase: "Cancelled" as const },
    sources: {
      checkedAt: "2026-08-11T14:00:00.000Z",
      kitchen: {
        batches: [
          {
            orderBatchReference: id(3),
            status: "Ready" as const,
            updatedAt: "2026-08-11T13:50:00.000Z",
          },
        ],
      },
      payments: [
        {
          status: "Succeeded" as const,
          occurredAt: "2026-08-11T13:56:00.000Z",
          amount: { amountMinor: 2598n, currencyCode: "CAD" },
          freshnessStatus: "Fresh" as const,
        },
      ],
      pickup: { notCollectedAt: "2026-08-11T13:59:00.000Z" },
    },
  };
  const html = render({ ...state, view });
  expect(html).toContain("Not collected");
  expect(html).toContain("Contact the store about your order or a refund.");
  expect(html).not.toContain("Order cancelled");
  expect(html).not.toContain("Ready for pickup");
  expect(html).not.toContain("pickup code");
  expect(isOrderSettled(view)).toBe(true);
  expect(findInternalText([staticText(html)])).toEqual([]);
});

it("WP-2423: says a pickup was not collected and stops offering the pickup code", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: null,
        pickup: { notCollectedAt: "2026-08-11T13:59:00.000Z" },
      },
    },
  });
  expect(html).toContain("Not collected");
  expect(html).toContain("Contact the store");
  expect(html).not.toContain("pickup code");
  expect(html).not.toContain("Order collected");
});

it("WP-2423 Q12: says an unpaid pickup was cancelled and stops offering the pickup code", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const view = {
    ...state.view,
    sources: {
      checkedAt: "2026-08-11T14:00:00.000Z",
      kitchen: null,
      payments: [],
      pickup: null,
      unpaidCancellation: { cancelledAt: "2026-08-11T13:59:00.000Z" },
    },
  };
  const html = render({ ...state, view });
  expect(html).toContain("Order cancelled");
  expect(html).toContain("Payment wasn’t completed within 30 minutes");
  expect(html).toContain("Not paid");
  expect(html).not.toContain("pickup code");
  expect(html).not.toContain("Order submitted");
  expect(isOrderSettled(view)).toBe(true);
});

it("WP-2423 Q9-G1: says a paid pickup the store couldn't accept is refunded, and when it waits for the store", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const payments = [
    {
      status: "Succeeded" as const,
      occurredAt: "2026-08-11T13:30:00.000Z",
      amount: { amountMinor: 1500n, currencyCode: "CAD" },
      freshnessStatus: "Fresh" as const,
    },
  ];
  const at = (
    storeAcceptance: NonNullable<NonNullable<OrderStatusView["sources"]>["storeAcceptance"]>,
  ): OrderStatusView => ({
    ...state.view,
    sources: {
      checkedAt: "2026-08-11T14:00:00.000Z",
      kitchen: null,
      payments,
      storeAcceptance,
    },
  });
  const refunded = at({
    state: "NotAccepted",
    closedAt: "2026-08-11T13:59:00.000Z",
    refundStatus: "Refunded",
  });
  let html = render({ ...state, view: refunded });
  expect(html).toContain(
    "The store couldn’t accept your order, so your payment was refunded to your original payment method.",
  );
  expect(html).toContain("Refunded $15.00");
  expect(html).not.toContain("Payment received");
  expect(html).not.toContain("pickup code");
  expect(isOrderSettled(refunded)).toBe(true);
  const refunding = at({
    state: "NotAccepted",
    closedAt: "2026-08-11T13:59:00.000Z",
    refundStatus: "Pending",
  });
  html = render({ ...state, view: refunding });
  expect(html).toContain("so your payment is being refunded to your original payment method.");
  expect(html).toContain("Refund pending · $15.00");
  expect(isOrderSettled(refunding)).toBe(false);
  const waiting = at({ state: "AwaitingStore" });
  html = render({ ...state, view: waiting });
  expect(html).toContain(
    "The store hasn’t confirmed your order yet. Please wait or contact the store.",
  );
  expect(html).not.toContain("Hold");
  expect(isOrderSettled(waiting)).toBe(false);
});

it("WP-2423 Q6: says the store cancelled a paid pickup, why, and how the refund is going", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const cancellation = {
    orderBatchReference: id(3),
    cancelledAt: "2026-08-11T13:58:00.000Z",
    reason: "SoldOut" as const,
    refundStatus: "Pending" as const,
  };
  const view = {
    ...state.view,
    order: { ...state.view.order, canonicalPhase: "Cancelled" as const },
    sources: {
      checkedAt: "2026-08-11T14:00:00.000Z",
      kitchen: null,
      payments: [],
      staffCancellations: [cancellation],
    },
  };
  const html = render({ ...state, view });
  expect(html).toContain("Order cancelled by the store");
  expect(html).toContain("An item you ordered sold out.");
  expect(html).toContain("Refund pending — your payment is being returned in full.");
  expect(html).not.toContain("pickup code");
  expect(html).not.toContain("SoldOut");
  expect(isOrderSettled(view)).toBe(true);
  const refunded = render({
    ...state,
    view: {
      ...view,
      sources: {
        ...view.sources,
        staffCancellations: [{ ...cancellation, refundStatus: "Refunded" as const }],
      },
    },
  });
  expect(refunded).toContain("Your payment was refunded in full.");
  // The payment line says where the money is, never "Payment received" after a refund.
  const payments = [
    {
      status: "Succeeded" as const,
      occurredAt: "2026-08-11T13:56:00.000Z",
      amount: { amountMinor: 1280n, currencyCode: "CAD" },
      freshnessStatus: "Fresh" as const,
    },
  ];
  const paidPending = render({
    ...state,
    view: { ...view, sources: { ...view.sources, payments } },
  });
  expect(paidPending).toContain("Refund pending · ");
  expect(paidPending).not.toContain("Payment received");
  const paidRefunded = render({
    ...state,
    view: {
      ...view,
      sources: {
        ...view.sources,
        payments,
        staffCancellations: [{ ...cancellation, refundStatus: "Refunded" as const }],
      },
    },
  });
  expect(paidRefunded).toMatch(/Refunded \$12\.80/u);
  expect(paidRefunded).not.toContain("Payment received");
});

it("WP-2423 Q6: notes a dine-in round the store cancelled without hiding the rest of the order", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const first = state.view.order.batches[0];
  if (!first) throw new Error("fixture");
  const view = {
    ...state.view,
    order: {
      ...state.view.order,
      orderType: "DineIn" as const,
      canonicalPhase: "In Progress" as const,
      batches: [
        first,
        {
          ...first,
          orderBatchReference: id(30),
          items: first.items.map((item) => ({
            ...item,
            orderItemReference: id(31),
            displayName: "Synthetic soup",
          })),
        },
      ],
    },
    sources: {
      checkedAt: "2026-08-11T14:00:00.000Z",
      kitchen: {
        batches: [
          {
            orderBatchReference: id(3),
            status: "InProgress" as const,
            updatedAt: "2026-08-11T13:57:00.000Z",
          },
        ],
      },
      payments: [],
      staffCancellations: [
        {
          orderBatchReference: id(30),
          cancelledAt: "2026-08-11T13:58:00.000Z",
          reason: "CustomerRequest" as const,
          refundStatus: "Refunded" as const,
        },
      ],
    },
  };
  const html = render({ ...state, view });
  expect(html).toContain("Preparing your order");
  expect(html).toContain("This round was cancelled by the store.");
  expect(html).toContain("The store cancelled it at your request.");
  expect(html).toContain("Your payment was refunded in full.");
  expect(html).toContain("Synthetic soup");
  expect(html).not.toContain("Order cancelled by the store");
  expect(isOrderSettled(view)).toBe(false);
});

it("WP-2423 Q6 step 2: marks items the store cancelled and where their refund is", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const first = state.view.order.batches[0];
  const bowl = first?.items[0];
  if (!first || !bowl) throw new Error("fixture");
  const tea = {
    ...bowl,
    orderItemReference: id(5),
    displayName: "Synthetic tea",
    quantity: 1,
    lineTotal: { amountMinor: 400n, currencyCode: "CAD" },
  };
  const juice = { ...tea, orderItemReference: id(6), displayName: "Synthetic juice" };
  const cancellation = {
    orderBatchReference: id(3),
    orderItemReferences: [id(5)],
    cancelledAt: "2026-08-11T13:58:00.000Z",
    reason: "SoldOut" as const,
    refundStatus: "Pending" as const,
    refundAmount: { amountMinor: 452n, currencyCode: "CAD" },
  };
  const view = {
    ...state.view,
    order: {
      ...state.view.order,
      orderType: "DineIn" as const,
      canonicalPhase: "In Progress" as const,
      batches: [{ ...first, items: [bowl, tea, juice] }],
    },
    sources: {
      checkedAt: "2026-08-11T14:00:00.000Z",
      kitchen: {
        batches: [
          {
            orderBatchReference: id(3),
            status: "InProgress" as const,
            updatedAt: "2026-08-11T13:57:00.000Z",
          },
        ],
      },
      payments: [],
      dining: {
        items: [
          { orderItemReference: id(4), orderBatchReference: id(3), servedQuantity: 2 },
          { orderItemReference: id(5), orderBatchReference: id(3), servedQuantity: 0 },
          { orderItemReference: id(6), orderBatchReference: id(3), servedQuantity: 1 },
        ],
      },
      itemCancellations: [cancellation],
    },
  };
  const html = render({ ...state, view });
  expect(html).toContain("order-status__item--cancelled");
  expect(html).toContain("Cancelled · Refund pending $4.52");
  expect(html).toContain(
    "Cancelled items: a refund of $4.52 to your original payment is pending (tax and their share of any tip included).",
  );
  // A cancelled item is not waiting to be served; the round is not cancelled.
  expect(html).toContain("Items served");
  expect(html).not.toContain("This round was cancelled by the store.");
  expect(html).not.toContain("Order cancelled by the store");
  expect(html).not.toContain("SoldOut");
  // The original items total stays; the refund is explained beneath it.
  expect(html).toMatch(/Total including tax<\/span><span>\$33\.98/u);
  const refunded = render({
    ...state,
    view: {
      ...view,
      sources: {
        ...view.sources,
        itemCancellations: [
          {
            ...cancellation,
            orderItemReferences: [id(5), id(6)],
            refundStatus: "Refunded" as const,
            refundAmount: { amountMinor: 904n, currencyCode: "CAD" },
          },
        ],
      },
    },
  });
  // A cancellation of several items refunds them together: the amount is in the summary.
  expect(refunded.match(/Cancelled · Refunded</gu)).toHaveLength(2);
  expect(refunded).toContain(
    "Cancelled items: $9.04 refunded to your original payment (tax and their share of any tip included).",
  );
  // The last item cancelled turns the round into a store cancellation refunded in full, tip included:
  // every line is marked and the item summary's tip note no longer applies.
  const whole = render({
    ...state,
    view: {
      ...view,
      order: { ...view.order, canonicalPhase: "Cancelled" as const },
      sources: {
        ...view.sources,
        itemCancellations: [{ ...cancellation, refundStatus: "Refunded" as const }],
        staffCancellations: [
          {
            orderBatchReference: id(3),
            cancelledAt: "2026-08-11T13:59:00.000Z",
            reason: "SoldOut" as const,
            refundStatus: "Refunded" as const,
          },
        ],
      },
    },
  });
  expect(whole.match(/order-status__item--cancelled/gu)).toHaveLength(3);
  expect(whole).toContain("Your payment was refunded in full.");
  expect(whole).not.toContain("Cancelled items:");
});

describe("WP-2423: a dine-in round whose payment didn't go through", () => {
  function diningView(sources: Record<string, unknown>) {
    const state = readyState();
    if (state.status !== "ready") throw new Error("fixture");
    const first = state.view.order.batches[0];
    if (!first) throw new Error("fixture");
    const item = (n: number) => ({
      orderItemReference: id(n),
      displayName: "Synthetic dish " + n,
      quantity: 1,
      lineTotal: { amountMinor: 1130n, currencyCode: "CAD" },
    });
    const view = {
      ...state.view,
      order: {
        ...state.view.order,
        orderType: "DineIn" as const,
        canonicalPhase: "Accepted" as const,
        batches: [
          { ...first, items: [item(40)] },
          { ...first, orderBatchReference: id(30), items: [item(41)] },
        ],
      },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: {
          batches: [
            {
              orderBatchReference: id(3),
              status: "Ready" as const,
              updatedAt: "2026-08-11T13:57:00.000Z",
            },
          ],
        },
        payments: [
          {
            status: "Succeeded" as const,
            occurredAt: "2026-08-11T13:56:00.000Z",
            amount: { amountMinor: 1130n, currencyCode: "CAD" },
            freshnessStatus: "Fresh" as const,
          },
        ],
        ...sources,
      },
    } as OrderStatusView;
    return { state, view };
  }

  it("says before the deadline that the round will be cancelled, and when", () => {
    const { state, view } = diningView({
      batchPayments: [
        { orderBatchReference: id(3), status: "Succeeded", cancelsAt: null },
        { orderBatchReference: id(30), status: "Failed", cancelsAt: "2026-08-11T14:25:00.000Z" },
      ],
    });
    const html = render({ ...state, view });
    const at = formatClockTime("2026-08-11T14:25:00.000Z");
    // One sentence end, even when the time itself ends with a period ("9:46 p.m.").
    expect(html).toContain(
      `Payment for this round didn’t go through. It will be cancelled at ${endSentence(at)} Ask a staff member if you need help.`,
    );
    expect(html).not.toContain("..");
    // The unpaid round is not waiting to be served and is not counted as owed.
    expect(html).toContain("Not paid");
    expect(html).not.toContain("Served 0 of 1");
    expect(html).toMatch(/Total including tax<\/span><span>\$11\.30<\/span>/u);
    expect(html).toContain("Rounds that weren’t paid aren’t included.");
    // Only the failed round carries the note; the paid round's kitchen state is not hidden by it.
    expect(html.match(/didn’t go through/gu)).toHaveLength(1);
    expect(html).toContain("Your order is ready");
    expect(html).not.toContain("order-status__item--cancelled");
  });

  it("marks an auto-cancelled round, says it was not charged, and leaves it out of the total", () => {
    const { state, view } = diningView({
      batchPayments: [
        { orderBatchReference: id(3), status: "Succeeded", cancelsAt: null },
        { orderBatchReference: id(30), status: "Failed", cancelsAt: null },
      ],
      unpaidCancellations: [
        { orderBatchReference: id(30), cancelledAt: "2026-08-11T13:59:00.000Z" },
      ],
    });
    const html = render({ ...state, view });
    expect(html).toContain(
      "This round was cancelled because its payment didn’t go through. You weren’t charged for it.",
    );
    expect(html.match(/class="order-status__item--cancelled"/gu)).toHaveLength(1);
    expect(html).toContain("Synthetic dish 41");
    // The total agrees with the payment received.
    expect(html).toMatch(/Total including tax<\/span><span>\$11\.30<\/span>/u);
    expect(html).toContain("Payment received $11.30");
    expect(html).toContain("Rounds that weren’t paid aren’t included.");
    expect(html).not.toContain("It will be cancelled at");
    expect(html).not.toContain("cancelled by the store");
    expect(isOrderSettled(view)).toBe(false);
  });

  it("says a round a manager cancelled before anyone paid was cancelled by the store", () => {
    const { state, view } = diningView({
      batchPayments: [
        { orderBatchReference: id(3), status: "Succeeded", cancelsAt: null },
        { orderBatchReference: id(30), status: "Awaiting", cancelsAt: null },
      ],
      unpaidCancellations: [
        { orderBatchReference: id(30), cancelledAt: "2026-08-11T13:59:00.000Z", byStore: true },
      ],
    });
    const html = render({ ...state, view });
    expect(html).toContain("This round was cancelled by the store. Nobody was charged for it.");
    expect(html).not.toContain("didn’t go through");
    expect(html).toMatch(/Total including tax<\/span><span>\$11\.30<\/span>/u);
  });

  it("totals every round's payment and shows served rounds as served while one awaits payment", () => {
    const { state, view: base } = diningView({});
    const [first, second] = base.order.batches;
    if (!first || !second) throw new Error("fixture");
    const third = {
      ...second,
      orderBatchReference: id(31),
      items: second.items.map((item) => ({ ...item, orderItemReference: id(42) })),
    };
    const view = {
      ...base,
      order: { ...base.order, canonicalPhase: "In Progress", batches: [first, second, third] },
      sources: {
        ...base.sources,
        kitchen: {
          batches: [id(30), id(31)].map((orderBatchReference) => ({
            orderBatchReference,
            status: "Ready" as const,
            updatedAt: "2026-08-11T13:57:00.000Z",
          })),
        },
        // One payment per paid round (tip included); the first round's guest hasn't paid yet.
        payments: [646n, 1689n].map((amountMinor) => ({
          status: "Succeeded" as const,
          occurredAt: "2026-08-11T13:56:00.000Z",
          amount: { amountMinor, currencyCode: "CAD" },
          freshnessStatus: "Fresh" as const,
        })),
        batchPayments: [
          { orderBatchReference: id(3), status: "Awaiting", cancelsAt: null },
          { orderBatchReference: id(30), status: "Succeeded", cancelsAt: null },
          { orderBatchReference: id(31), status: "Succeeded", cancelsAt: null },
        ],
        dining: {
          items: [
            { orderItemReference: id(40), orderBatchReference: id(3), servedQuantity: 0 },
            { orderItemReference: id(41), orderBatchReference: id(30), servedQuantity: 1 },
            { orderItemReference: id(42), orderBatchReference: id(31), servedQuantity: 1 },
          ],
        },
      },
    } as OrderStatusView;
    const html = render({ ...state, view });
    expect(html).toContain("Payment received $23.35");
    expect(html).not.toContain("Payment received $6.46");
    expect(html).toContain('<h2 id="order-progress-heading">Waiting for payment</h2>');
    expect(html).toContain("Everything paid for has been served.");
    expect(html).toContain("<dt>Kitchen status</dt><dd>Waiting for payment</dd>");
    expect(html).not.toContain("Preparing");
    expect(html).toContain("<h3>Round 1</h3><p>Waiting for payment</p>");
    expect(html).toContain("<h3>Round 2</h3><p>Served</p>");
    expect(html).toContain("<h3>Round 3</h3><p>Served</p>");
    expect(html).not.toContain("<p>Ready</p>");
    expect(findInternalText([staticText(html)])).toEqual([]);
  });

  it("keeps the kitchen summary on the rounds still being made", () => {
    const { state, view: base } = diningView({
      batchPayments: [
        { orderBatchReference: id(3), status: "Succeeded", cancelsAt: null },
        { orderBatchReference: id(30), status: "Succeeded", cancelsAt: null },
      ],
      kitchen: {
        batches: [
          {
            orderBatchReference: id(3),
            status: "Ready" as const,
            updatedAt: "2026-08-11T13:57:00.000Z",
          },
          {
            orderBatchReference: id(30),
            status: "InProgress" as const,
            updatedAt: "2026-08-11T13:58:00.000Z",
          },
        ],
      },
      dining: {
        items: [
          { orderItemReference: id(40), orderBatchReference: id(3), servedQuantity: 1 },
          { orderItemReference: id(41), orderBatchReference: id(30), servedQuantity: 0 },
        ],
      },
    });
    const html = render({ ...state, view: base });
    expect(html).toContain("<dt>Kitchen status</dt><dd>Preparing</dd>");
    expect(html).toContain("<h3>Round 1</h3><p>Served</p>");
    expect(html).toContain("<h3>Round 2</h3><p>Preparing</p>");
    expect(html).toContain("Serving your order");
  });
});

describe("WP-2423 Q10 plain guidance when the visit has ended", () => {
  it("explains the expired table visit, the way back and the pickup counter, without internal wording", () => {
    const html = render({ status: "permission-denied" });
    expect(html).toContain("Scan the table QR code again");
    expect(html).toContain("the store still has your order");
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(/access denied|browser you used at checkout|session/iu);
    // WP-2423 (v15 3cd0f8dd M5): a guest who left is not told to ask for a table code first.
    expect(html).not.toMatch(/ask a staff member for the table code to continue/iu);
  });
  it("WP-2423 (v15 3cd0f8dd M5): offers the receipt of this order after the visit ended", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <VisitEndedNotice orderReference={id(1)} />
      </MemoryRouter>,
    );
    expect(html).toContain("You can still view and save your receipt on this phone");
    expect(html).toContain(`href="/orders/${id(1)}/receipt"`);
    expect(html).toContain("View your receipt");
  });
  it("says a just-paid order was received while its status is prepared, in plain words", () => {
    const html = render({
      status: "received",
      received: {
        kind: "Received",
        orderReference: id(1),
        orderNumber: "1001",
        orderType: "Pickup",
        submittedAt: "2026-08-11T13:55:00.000Z",
        checkedAt: "2026-08-11T13:55:04.000Z",
      },
    });
    expect(html).toContain("Order received");
    expect(html).toContain("Order 1001 is in");
    expect(html).toContain("this page updates by itself");
    expect(html).toContain("give your order number to a staff member");
    expect(html).not.toContain("We can’t show this order here yet");
    expect(html).not.toContain(id(1));
    expect(findInternalText([staticText(html)])).toEqual([]);
  });
  it("lets a just-paid customer retry instead of a dead end", () => {
    const html = render({ status: "not-found" });
    expect(html).toContain("can take a few seconds to appear");
    expect(html).toContain("Try again");
    expect(html).not.toMatch(/browser you used at checkout|access session/iu);
  });
});

it("WP-2423 Q10: shows how to call and find the Store under the order", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: null,
        storeContact: {
          phone: "+14165550123",
          addressLines: ["DEMO 100 Test Street"],
          locality: "Toronto",
          regionCode: "ON",
          postalCode: "M5V 1A1",
        },
      },
    },
  });
  expect(html).toContain("Contact the store");
  expect(html).toContain('href="tel:+14165550123"');
  expect(html).toContain("Toronto, ON M5V 1A1");
});

it("WP-2423 Q26: a ready pickup with a dish being remade says to wait, not that it is ready", () => {
  const state = readyState();
  if (state.status !== "ready") throw new Error("fixture");
  const html = render({
    ...state,
    view: {
      ...state.view,
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: {
          batches: [
            { orderBatchReference: id(3), status: "Ready", updatedAt: "2026-08-11T13:59:00.000Z" },
          ],
        },
        payments: null,
        remakes: [{ orderItemReference: id(4), quantity: 1 }],
      },
    },
  });
  expect(html).toContain("Remaking part of your order");
  expect(html).toContain("We’re remaking part of your order. We’ll have it ready shortly");
  expect(html).toContain("Being remade");
  expect(html).not.toContain("Your order is ready. Collect it at the counter.");
  // The pickup code stays available.
  expect(html).toContain("Checking your pickup code");
});

describe("WP-2423 D5: item prices before tax, then subtotal, tax and total", () => {
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  function pricedView(): OrderStatusView {
    const state = readyState();
    if (state.status !== "ready") throw new Error("fixture");
    return {
      ...state.view,
      order: {
        ...state.view.order,
        batches: [
          {
            orderBatchReference: id(3),
            submittedAt: "2026-08-11T13:55:00.000Z",
            items: [
              {
                orderItemReference: id(4),
                displayName: "DEMO Latte",
                quantity: 1,
                lineTotal: money(1130n),
              },
              {
                orderItemReference: id(5),
                displayName: "Synthetic muffin",
                quantity: 2,
                lineTotal: money(905n),
              },
            ],
          },
        ],
      },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: [],
        itemPrices: [
          { orderItemReference: id(4), subtotal: money(1000n), tax: money(130n) },
          { orderItemReference: id(5), subtotal: money(801n), tax: money(104n) },
        ],
      },
    } as OrderStatusView;
  }

  it("lists each item at its price before tax and reconciles subtotal + tax to the total", () => {
    const view = pricedView();
    const summary = orderMoneySummary(view, () => true);
    expect(summary.itemAmount(id(4), 1130n)).toBe(1000n);
    expect(summary.itemAmount(id(5), 905n)).toBe(801n);
    expect(summary.subtotal).toBe(1801n);
    expect(summary.tax).toBe(234n);
    expect(summary.adjustments).toBe(0n);
    expect((summary.subtotal ?? 0n) + (summary.tax ?? 0n)).toBe(summary.total);
    expect(summary.total).toBe(2035n);
    const html = render({ status: "ready", realtime: "unavailable", refreshing: false, view });
    expect(html).toMatch(/DEMO Latte<\/span><span class="order-status__item-amount">\$10\.00</u);
    expect(html).toMatch(/Subtotal<\/dt><dd>\$18\.01</u);
    expect(html).toMatch(/Tax<\/dt><dd>\$2\.34</u);
    expect(html).toMatch(/Total<\/span><span>\$20\.35</u);
    expect(html).not.toContain("$11.30");
    expect(html).not.toContain("Discounts and fees");
    expect(html).not.toContain("Items total");
  });

  it("shows each item's chosen options with what they added, and the guest's note (WP-2423)", () => {
    const view = pricedView();
    const sources = view.sources;
    if (!sources) throw new Error("fixture");
    const html = render({
      status: "ready",
      realtime: "unavailable",
      refreshing: false,
      view: {
        ...view,
        sources: {
          ...sources,
          itemPrices: [
            {
              orderItemReference: id(4),
              subtotal: money(1000n),
              tax: money(130n),
              options: [
                { displayName: "Whipped cream", quantity: 1, amount: money(50n) },
                { displayName: "Oat milk", quantity: 1, amount: money(0n) },
              ],
              customerNote: "Less sweet",
            },
            { orderItemReference: id(5), subtotal: money(801n), tax: money(104n) },
          ],
        },
      } as OrderStatusView,
    });
    expect(html).toContain(
      'DEMO Latte<span class="order-status__item-options">Whipped cream +$0.50, Oat milk</span><span class="order-status__item-note">Note: Less sweet</span></span><span class="order-status__item-amount">$10.00</span>',
    );
    // The item price already includes its options: the page still adds up the same way.
    expect(html).toMatch(/Subtotal<\/dt><dd>\$18\.01</u);
    expect(html).not.toMatch(/Synthetic muffin<span/u);
  });

  it("keeps totals including tax when the item prices are not available", () => {
    const view = pricedView();
    const sources = Object.fromEntries(
      Object.entries(view.sources ?? {}).filter(([key]) => key !== "itemPrices"),
    );
    const html = render({
      status: "ready",
      realtime: "unavailable",
      refreshing: false,
      view: { ...view, sources } as OrderStatusView,
    });
    expect(html).toContain("$11.30");
    expect(html).toMatch(/Total including tax<\/span><span>\$20\.35</u);
    expect(html).not.toContain("Subtotal");
  });

  it("adds the paid tip so the total is what was paid, like the receipt (v15 aa3d9fac D2)", () => {
    const view = pricedView();
    const sources = view.sources;
    if (!sources) throw new Error("fixture");
    const tipped = {
      ...view,
      sources: {
        ...sources,
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-08-11T13:56:00.000Z",
            amount: money(2335n),
            freshnessStatus: "Fresh",
          },
        ],
        tips: [{ orderBatchReference: id(3), amount: money(300n) }],
      },
    } as OrderStatusView;
    const summary = orderMoneySummary(tipped, () => true);
    expect(summary.tip).toBe(300n);
    // The receipt's rule: subtotal − discount + tax + fee + tip = total.
    expect(
      (summary.subtotal ?? 0n) + (summary.adjustments ?? 0n) + (summary.tax ?? 0n) + summary.tip,
    ).toBe(summary.total);
    expect(summary.total).toBe(2335n);
    const html = render({
      status: "ready",
      realtime: "unavailable",
      refreshing: false,
      view: tipped,
    });
    expect(html).toMatch(/Tip<\/dt><dd>\$3\.00</u);
    expect(html).toMatch(/Total<\/span><span>\$23\.35</u);
    expect(html).toContain("Payment received $23.35");
    // Without item prices the total still includes the tip, and says so.
    const unpriced = Object.fromEntries(
      Object.entries(tipped.sources ?? {}).filter(([key]) => key !== "itemPrices"),
    );
    const plain = render({
      status: "ready",
      realtime: "unavailable",
      refreshing: false,
      view: { ...tipped, sources: unpriced } as OrderStatusView,
    });
    expect(plain).toMatch(/Tip<\/dt><dd>\$3\.00</u);
    expect(plain).toMatch(/Total including tax and tip<\/span><span>\$23\.35</u);
    expect(plain).not.toContain("Subtotal");
  });

  it("adds each paid dine-in round's tip and leaves out a round that was never paid", () => {
    const view = pricedView();
    const sources = view.sources;
    const first = view.order.batches[0];
    if (!sources || !first) throw new Error("fixture");
    const rounds = {
      ...view,
      order: {
        ...view.order,
        orderType: "DineIn",
        batches: [
          first,
          {
            orderBatchReference: id(6),
            submittedAt: "2026-08-11T13:57:00.000Z",
            items: [
              {
                orderItemReference: id(7),
                displayName: "DEMO Tea",
                quantity: 1,
                lineTotal: money(339n),
              },
            ],
          },
          {
            orderBatchReference: id(8),
            submittedAt: "2026-08-11T13:58:00.000Z",
            items: [
              {
                orderItemReference: id(9),
                displayName: "DEMO Cake",
                quantity: 1,
                lineTotal: money(565n),
              },
            ],
          },
        ],
      },
      sources: {
        ...sources,
        itemPrices: [
          ...(sources.itemPrices ?? []),
          { orderItemReference: id(7), subtotal: money(300n), tax: money(39n) },
          { orderItemReference: id(9), subtotal: money(500n), tax: money(65n) },
        ],
        tips: [
          { orderBatchReference: id(3), amount: money(300n) },
          { orderBatchReference: id(6), amount: money(50n) },
        ],
      },
    } as OrderStatusView;
    // Round 3 (id 8) was never paid: neither its items nor any tip count.
    const summary = orderMoneySummary(rounds, (reference) => reference !== id(8));
    expect(summary.subtotal).toBe(2101n);
    expect(summary.tax).toBe(273n);
    expect(summary.tip).toBe(350n);
    expect(summary.total).toBe(2035n + 339n + 350n);
  });

  it("shows discounts and fees when the frozen items carried any", () => {
    const view = pricedView();
    const sources = view.sources;
    if (!sources) throw new Error("fixture");
    const summary = orderMoneySummary(
      {
        ...view,
        sources: {
          ...sources,
          itemPrices: [
            { orderItemReference: id(4), subtotal: money(1100n), tax: money(130n) },
            { orderItemReference: id(5), subtotal: money(801n), tax: money(104n) },
          ],
        },
      } as OrderStatusView,
      () => true,
    );
    expect(summary.adjustments).toBe(-100n);
    expect((summary.subtotal ?? 0n) + (summary.adjustments ?? 0n) + (summary.tax ?? 0n)).toBe(
      summary.total,
    );
  });
});

describe("WP-2423 (v15 3cd0f8dd) payments and refunds the guest sees", () => {
  const cad = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  function dineIn(sources: Partial<NonNullable<OrderStatusView["sources"]>>): OrderStatusState {
    const state = readyState();
    if (state.status !== "ready") throw new Error("missing fixture");
    return {
      ...state,
      view: {
        ...state.view,
        order: {
          ...state.view.order,
          orderType: "DineIn",
          canonicalPhase: "Accepted",
          batches: [
            {
              orderBatchReference: id(3),
              submittedAt: "2026-08-11T13:55:00.000Z",
              items: [
                {
                  orderItemReference: id(4),
                  displayName: "Flat White — Small (8 oz)",
                  quantity: 1,
                  lineTotal: cad(480n),
                },
              ],
            },
            {
              orderBatchReference: id(5),
              submittedAt: "2026-08-11T13:57:00.000Z",
              items: [
                {
                  orderItemReference: id(6),
                  displayName: "Mocha — Small (8 oz)",
                  quantity: 1,
                  lineTotal: cad(537n),
                },
              ],
            },
          ],
        },
        sources: {
          checkedAt: "2026-08-11T14:00:00.000Z",
          kitchen: null,
          payments: [
            {
              status: "Succeeded",
              occurredAt: "2026-08-11T13:56:00.000Z",
              amount: cad(544n),
              freshnessStatus: "Fresh",
            },
            {
              status: "Succeeded",
              occurredAt: "2026-08-11T13:58:00.000Z",
              amount: cad(537n),
              freshnessStatus: "Fresh",
              method: "CardMachine",
              orderBatchReference: id(5),
            },
          ],
          tips: [{ orderBatchReference: id(3), amount: cad(64n) }],
          ...sources,
        },
      },
    };
  }

  it("H1: counts the round paid on the store's card machine, so the guest owes nothing", () => {
    const html = render(dineIn({}));
    expect(html).toContain(
      "Payment received $10.81 ($5.44 online, $5.37 on the store’s card machine)",
    );
    expect(html).toContain("$10.81");
    expect(html).not.toContain("Payment received $5.44<");
  });

  it("M3: shows a confirmed refund, the item it returned and its tip share", () => {
    const html = render(
      dineIn({
        refunds: {
          refunded: cad(736n),
          entries: [
            {
              kind: "Refund",
              orderItemReferences: [id(6)],
              total: cad(736n),
              tip: cad(86n),
            },
          ],
        },
      }),
    );
    expect(html).toContain("<dt>Refunded</dt><dd>$7.36</dd>");
    expect(html).toContain("Refund: $7.36 returned to your original payment, including $0.86");
    expect(html).toContain('class="order-status__item-refunded">Refunded</span>');
    expect(findInternalText([staticText(html)])).toEqual([]);
  });

  it("M3: an item cancellation keeps its own wording and only adds the refunded total", () => {
    const html = render(
      dineIn({
        itemCancellations: [
          {
            orderBatchReference: id(5),
            orderItemReferences: [id(6)],
            cancelledAt: "2026-08-11T13:59:00.000Z",
            reason: "SoldOut",
            refundStatus: "Refunded",
            refundAmount: cad(537n),
          },
        ],
        refunds: {
          refunded: cad(537n),
          entries: [
            {
              kind: "ItemCancellation",
              orderItemReferences: [id(6)],
              total: cad(537n),
              tip: cad(0n),
            },
          ],
        },
      }),
    );
    expect(html).toContain("<dt>Refunded</dt><dd>$5.37</dd>");
    expect(html).toContain("Cancelled items: $5.37 refunded");
    expect(html).not.toContain("Refund: $5.37 returned");
  });
});
