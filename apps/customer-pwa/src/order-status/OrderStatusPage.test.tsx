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

function readyState(freshnessStatus: "Fresh" | "Stale" = "Fresh"): OrderStatusState {
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
  it("renders only admitted status facts and the missing later boundaries", () => {
    const html = render(readyState());
    expect(html).toContain("Order submitted");
    expect(html).toContain("2 × Synthetic bowl");
    expect(html).toContain("CAD 25.98");
    expect(html).toContain("Kitchen status");
    expect(html).toContain("Not available yet");
    expect(html).toContain("Payment status");
    expect(html).toContain("Check pickup readiness");
    expect(html).toContain("Receipt and support actions are not available");
    expect(html).not.toContain("Ready for pickup");
  });

  it("makes stale projection evidence explicit", () => {
    const html = render(readyState("Stale"));
    expect(html).toContain("Status may be delayed");
    expect(html).toContain("Projection state: Stale");
  });

  it.each([
    [{ status: "loading" }, "Loading order status"],
    [{ status: "invalid-reference" }, "Order link is invalid"],
    [{ status: "permission-denied" }, "Order access denied"],
    [{ status: "not-found" }, "Order not found"],
    [{ status: "feature-disabled" }, "Order tracking is disabled"],
    [{ status: "unavailable" }, "Order status is not available"],
    [{ status: "offline", view: null }, "Offline read-only"],
  ] as const)("renders the bounded state %#", (state, message) => {
    expect(render(state)).toContain(message);
  });
});
