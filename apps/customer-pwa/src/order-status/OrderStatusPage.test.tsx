import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { OrderStatusPage, isOrderSettled } from "./OrderStatusPage.js";
import type { OrderStatusController } from "./order-status-controller.js";
import type { OrderStatusState, OrderStatusView } from "./types.js";
import { formatClockTime } from "../journey/format.js";

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
    expect(html).toContain("Not available yet");
    expect(html).toContain("Payment");
    expect(html).toContain("Show pickup code");
    expect(html).toContain("View receipt and support");
    expect(html).not.toContain("Ready for pickup");
  });

  it("makes stale projection evidence explicit", () => {
    const html = render(readyState("Stale"));
    expect(html).toContain("Status may be delayed");
    expect(html).toContain("The details below may be out of date.");
    expect(html).not.toContain("Projection state");
  });

  it.each([
    ["Rebuilding", "We are updating your order status."],
    ["Failed", "We could not update your order status."],
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
    [{ status: "not-found" }, "We can&#x27;t show this order here yet"],
    [{ status: "feature-disabled" }, "Order tracking is disabled"],
    [{ status: "unavailable" }, "Order status is not available"],
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
  expect(html).toContain("Not available yet");
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
  [0, "Kitchen preparation complete"],
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
  expect(html).toContain("Payment wasn&#x27;t completed within 30 minutes");
  expect(html).toContain("Not paid");
  expect(html).not.toContain("pickup code");
  expect(html).not.toContain("Order submitted");
  expect(isOrderSettled(view)).toBe(true);
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
    "Cancelled items: a refund of $4.52 to your original payment is pending (tax included, tip not refunded).",
  );
  // A cancelled item is not waiting to be served; the round is not cancelled.
  expect(html).toContain("Items served");
  expect(html).not.toContain("This round was cancelled by the store.");
  expect(html).not.toContain("Order cancelled by the store");
  expect(html).not.toContain("SoldOut");
  // The original items total stays; the refund is explained beneath it.
  expect(html).toMatch(/Items total<\/span><span>\$33\.98/u);
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
    "Cancelled items: $9.04 refunded to your original payment (tax included, tip not refunded).",
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
  expect(whole).not.toContain("tip not refunded");
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
      `Payment for this round didn&#x27;t go through. It will be cancelled at ${at}${
        at.endsWith(".") ? "" : "."
      } Ask a staff member if you need help.`,
    );
    expect(html).not.toContain("..");
    // The unpaid round is not waiting to be served and is not counted as owed.
    expect(html).toContain("Not paid");
    expect(html).not.toContain("Served 0 of 1");
    expect(html).toMatch(/Items total<\/span><span>\$11\.30<\/span>/u);
    expect(html).toContain("Rounds that weren&#x27;t paid are not included.");
    // Only the failed round carries the note; the paid round's kitchen state is not hidden by it.
    expect(html.match(/didn&#x27;t go through/gu)).toHaveLength(1);
    expect(html).toContain("Kitchen preparation complete");
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
      "This round was cancelled because its payment didn&#x27;t go through. You were not charged for it.",
    );
    expect(html.match(/class="order-status__item--cancelled"/gu)).toHaveLength(1);
    expect(html).toContain("Synthetic dish 41");
    // Items total agrees with the payment received.
    expect(html).toMatch(/Items total<\/span><span>\$11\.30<\/span>/u);
    expect(html).toContain("Payment received $11.30");
    expect(html).toContain("Rounds that weren&#x27;t paid are not included.");
    expect(html).not.toContain("It will be cancelled at");
    expect(html).not.toContain("cancelled by the store");
    expect(isOrderSettled(view)).toBe(false);
  });
});

describe("WP-2423 Q10 plain guidance when the visit has ended", () => {
  it("explains the expired table visit, the way back and the pickup counter, without internal wording", () => {
    const html = render({ status: "permission-denied" });
    expect(html).toContain("Scan the table QR code again");
    expect(html).toContain("your earlier orders are on your table page");
    expect(html).toContain("the store still has your order");
    expect(html).toContain('href="/"');
    expect(html).not.toMatch(/access denied|browser you used at checkout|session/iu);
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
