import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { OrderStatusPage } from "./OrderStatusPage.js";
import type { OrderStatusController } from "./order-status-controller.js";
import type { OrderStatusState } from "./types.js";

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
    expect(html).toContain("CAD 25.98");
    expect(html).toContain("Kitchen status");
    expect(html).toContain("Not available yet");
    expect(html).toContain("Payment status");
    expect(html).toContain("Check pickup readiness");
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
    expect(html).not.toContain("Check pickup readiness");
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
    [{ status: "permission-denied" }, "Order access denied"],
    [{ status: "not-found" }, "This order cannot be opened"],
    [{ status: "feature-disabled" }, "Order tracking is disabled"],
    [{ status: "unavailable" }, "Order status is not available"],
    [{ status: "offline", view: null }, "Offline read-only"],
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
    expect(html).toContain("Payment received: CAD 25.98");
    expect(html).toContain("Payment attempt failed");
    expect(html).toContain("This payment update may be out of date");
    expect(html).toContain("individual payment results");
    expect(html).not.toContain("Paid");
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
  expect(html).toContain("Kitchen preparation complete");
  expect(html).toContain("Check pickup readiness");
  expect(html).not.toContain("Order collected");
  expect(html).not.toContain("Ready for pickup");
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
  expect(html).not.toContain("Check pickup readiness");
  expect(html).not.toContain("Order collected");
});
