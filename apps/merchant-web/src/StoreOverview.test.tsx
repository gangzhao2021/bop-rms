import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { parseCurrentOrderQueue } from "./current-order-queue-client.js";
import { currentOrderQueueFixture } from "./current-order-queue.fixtures.js";
import { parseOrderExceptionView } from "./OrderExceptionPage.js";
import {
  OverviewToday,
  initialOverviewState,
  summarizeExceptions,
  summarizeOrders,
  summarizePickups,
} from "./StoreOverview.js";

describe("WP-2423 P2 store overview", () => {
  it("counts open and awaiting orders from the current queue", () => {
    const queue = parseCurrentOrderQueue(currentOrderQueueFixture(), null);
    expect(summarizeOrders(queue)).toEqual({
      open: 3,
      awaitingAcceptance: 1,
      // The fixture's only Ready order is a pickup; pickup readiness is counted from the pickup queue.
      readyToServe: 0,
      dineIn: true,
      more: false,
    });
  });
  it("counts only dine-in orders as ready to serve; pickups ready for collection come from Fulfillment", () => {
    const fixture = currentOrderQueueFixture();
    const [ready, awaiting, accepted] = fixture.items;
    const queue = parseCurrentOrderQueue(
      { ...fixture, items: [{ ...ready, orderType: "DineIn" }, awaiting, accepted] },
      null,
    );
    expect(summarizeOrders(queue)).toMatchObject({ open: 3, readyToServe: 1, dineIn: true });
    const pickupsOnly = parseCurrentOrderQueue({ ...fixture, items: [ready, accepted] }, null);
    expect(summarizeOrders(pickupsOnly)).toMatchObject({ readyToServe: 0, dineIn: false });
  });
  it("counts waiting pickups and open or overdue exceptions", () => {
    expect(
      summarizePickups({
        items: [
          { phase: "Ready" },
          { phase: "Completed" },
          { phase: "InProgress", remakeQuantity: 1 },
          { phase: "Completed", remakeQuantity: 1 },
        ],
        nextAfterFulfillmentReference: "018f0f58-767a-7f3b-a1d0-000000000001",
      }),
    ).toEqual({ waiting: 2, remaking: 1, more: true });
    const view = parseOrderExceptionView({
      screenId: "OPS-ORDER-EXCEPTION",
      projectionName: "merchant_order_exception_v1",
      storeLabel: "Training Store",
      businessDate: "2026-08-12",
      projectedAt: "2026-08-12T16:30:00.000Z",
      freshnessStatus: "Fresh",
      items: [
        {
          exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000901",
          orderReference: "018f0f58-767a-7f3b-a1d0-000000000902",
          orderNumber: null,
          kind: "PaidWithoutFulfillableOrder",
          severity: "Critical",
          status: "Open",
          providerState: "Unknown",
          compensationStatus: "Pending",
          sourceOwner: "Payment",
          createdAt: "2026-08-12T16:00:00.000Z",
          dueAt: "2026-08-12T16:15:00.000Z",
          ownerStatus: "Unassigned",
          sourceFinal: false,
        },
        {
          exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000903",
          orderReference: "018f0f58-767a-7f3b-a1d0-000000000904",
          orderNumber: null,
          kind: "CaptureDeadlineExceeded",
          severity: "High",
          status: "Resolved",
          providerState: "Unknown",
          compensationStatus: "Pending",
          sourceOwner: "Payment",
          createdAt: "2026-08-12T15:00:00.000Z",
          dueAt: "2026-08-12T15:15:00.000Z",
          ownerStatus: "Unassigned",
          sourceFinal: true,
        },
      ],
    });
    expect(summarizeExceptions(view)).toEqual({ open: 1, overdue: 1 });
  });
  it("renders counts, unavailable sources and the Store-local update time", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OverviewToday
          timeZone="America/Toronto"
          onRefresh={() => undefined}
          state={{
            orders: {
              kind: "Ready",
              value: { open: 50, awaitingAcceptance: 4, readyToServe: 2, dineIn: true, more: true },
            },
            pickups: { kind: "Unavailable" },
            exceptions: { kind: "Ready", value: { open: 0, overdue: 0 } },
            updatedAt: "2026-08-12T16:30:00.000Z",
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Right now");
    expect(html).toContain('<strong class="overview-count__value">50+</strong>');
    expect(html).toContain("4 awaiting acceptance · 2 ready to serve");
    expect(html).toContain("Could not be read");
    expect(html).toContain("None overdue");
    expect(html).toContain("Last checked 12:30");
    expect(html).toContain('href="/operations/order-exceptions"');
    const loading = renderToStaticMarkup(
      <MemoryRouter>
        <OverviewToday state={initialOverviewState} />
      </MemoryRouter>,
    );
    expect(loading).toContain("Reading current work…");
    expect(loading).not.toContain("Refresh");
  });
  it("never shows a pickup-only Store an orders 'ready' count that contradicts its pickups", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OverviewToday
          state={{
            orders: {
              kind: "Ready",
              value: {
                open: 5,
                awaitingAcceptance: 0,
                readyToServe: 0,
                dineIn: false,
                more: false,
              },
            },
            pickups: { kind: "Ready", value: { waiting: 4, remaking: 1, more: false } },
            exceptions: { kind: "Hidden" },
            updatedAt: null,
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("0 awaiting acceptance<");
    expect(html).not.toContain("ready to serve");
    expect(html).not.toMatch(/\b0 ready\b/u);
    expect(html).toContain('<strong class="overview-count__value">4</strong>');
    expect(html).toContain("1 order waiting on a remake");
  });
});

describe("WP-2423 Q11 follow-up: Home reads only what the role's screens permit", () => {
  const render = (state: Parameters<typeof OverviewToday>[0]["state"]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <OverviewToday state={state} />
      </MemoryRouter>,
    );
  it("leaves out counts for screens the role does not have, and the card when none remain", () => {
    const hidden = { kind: "Hidden" } as const;
    const ordersOnly = render({ ...initialOverviewState, pickups: hidden, exceptions: hidden });
    expect(ordersOnly).toContain("Open orders");
    expect(ordersOnly).not.toContain("Pickups waiting");
    expect(ordersOnly).not.toContain("Open exceptions");
    expect(
      render({ ...initialOverviewState, orders: hidden, pickups: hidden, exceptions: hidden }),
    ).toBe("");
  });
});
