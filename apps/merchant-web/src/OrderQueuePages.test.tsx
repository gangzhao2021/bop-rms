import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { OrderDetailScreen, OrderQueueScreen, OrderQueueStatePanel } from "./OrderQueuePages.js";
import { orderDetailFixture, orderQueueFixture } from "./order-queue.fixtures.js";
import { parseOrderDetailView, parseOrderQueueView } from "./order-queue.js";

describe("WP-1803 Order Queue screens", () => {
  it("renders the queue hierarchy and unavailable dependent facts", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OrderQueueScreen view={parseOrderQueueView(orderQueueFixture())} />
      </MemoryRouter>,
    );
    for (const value of [
      "OPS-ORDER-QUEUE",
      "Synthetic Training Store",
      "ORD-1001",
      "15 minutes",
      "Payment",
      "Kitchen",
      "Fulfillment",
      "Claim",
      "Exception",
      "Open detail",
    ])
      expect(html).toContain(value);
    expect(html).toContain("Accept / reject per policy");
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("makes stale queues visibly read-only", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OrderQueueScreen
          view={parseOrderQueueView({ ...orderQueueFixture(), freshnessStatus: "Stale" })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Stale board — read-only");
    expect(html).toContain("cannot authorize an Order action");
  });

  it("renders immutable detail while labelling collaborating gaps", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OrderDetailScreen view={parseOrderDetailView(orderDetailFixture())} />
      </MemoryRouter>,
    );
    expect(html).toContain("OPS-ORDER-DETAIL");
    expect(html).toContain("Batch 1");
    expect(html).toContain("2 immutable item snapshots");
    expect(html).toContain("are not present in WP-1225 and are not inferred");
  });

  it("renders safe permission and command-failure states", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OrderQueueStatePanel state="PermissionDenied" />
        <OrderQueueStatePanel state="CommandFailed" />
      </MemoryRouter>,
    );
    expect(html).toContain("Permission denied");
    expect(html).toContain("Command failed");
    expect(html).toContain("No Order transition is assumed");
  });
});
