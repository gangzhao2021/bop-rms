import { createOrderExceptionClient } from "./order-exception-client.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OrderExceptionPage,
  OrderExceptionScreen,
  parseOrderExceptionView,
} from "./OrderExceptionPage.js";
const fixture = () => ({
  screenId: "OPS-ORDER-EXCEPTION",
  projectionName: "merchant_order_exception_v1",
  storeLabel: "Synthetic Training Store",
  businessDate: "2026-08-12",
  projectedAt: "2026-08-12T16:14:00.000Z",
  freshnessStatus: "Fresh",
  items: [
    {
      exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000901",
      orderReference: "018f0f58-767a-7f3b-a1d0-000000000902",
      orderNumber: null as string | null,
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
  ],
});
describe("WP-1809 Order Exception Workbench", () => {
  it("renders bounded source facts and owning-domain actions", () => {
    const html = renderToStaticMarkup(
      <OrderExceptionScreen view={parseOrderExceptionView(fixture())} />,
    );
    for (const value of [
      "OPS-ORDER-EXCEPTION",
      "Critical",
      "PaidWithoutFulfillableOrder",
      "Unknown",
      "Request owning-domain compensation / retry",
      "Resolve from final source evidence",
      "Clear filters",
    ])
      expect(html).toContain(value);
    expect(html).toContain("Linked order · order number unavailable");
    expect(html).toContain('id="exception-actions-unavailable"');
    expect(html.match(/aria-describedby="exception-actions-unavailable"/gu)).toHaveLength(4);
    expect(html).not.toContain("018f0f58-767a-7f3b-a1d0-000000000902");
  });
  it("rejects client-resolved rows without source finality", () => {
    const input = fixture();
    expect(() =>
      parseOrderExceptionView({ ...input, items: [{ ...input.items[0], status: "Resolved" }] }),
    ).toThrow("ORDER_EXCEPTION_INVALID");
  });
  it.each(["2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10"])(
    "rejects impossible Business Date %s",
    (businessDate) => {
      expect(() => parseOrderExceptionView({ ...fixture(), businessDate })).toThrow(
        "ORDER_EXCEPTION_INVALID",
      );
    },
  );
  it("accepts a real leap-day Business Date", () => {
    expect(parseOrderExceptionView({ ...fixture(), businessDate: "2024-02-29" }).businessDate).toBe(
      "2024-02-29",
    );
  });
});

describe("WP-2402 workbench recovery states", () => {
  it("starts with a loading status instead of an error", () => {
    const html = renderToStaticMarkup(<OrderExceptionPage />);
    expect(html).toContain("Loading Order Exception Workbench");
    expect(html).not.toContain("Workbench unavailable");
  });
  it("keeps overdue stale facts visible with all mutation buttons disabled", () => {
    const html = renderToStaticMarkup(
      <OrderExceptionScreen
        view={parseOrderExceptionView({
          ...fixture(),
          projectedAt: "2026-08-12T16:30:00.000Z",
          freshnessStatus: "Stale",
        })}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain("Stale workbench");
    expect(html).toContain("2026-08-12T16:15:00.000Z");
    expect(html).toContain("PaidWithoutFulfillableOrder");
    const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gu)];
    expect(buttons).toHaveLength(6);
    expect(buttons[0]?.[1]).not.toContain("disabled");
    for (const button of buttons.slice(1)) expect(button[1]).toContain("disabled");
  });
  it("distinguishes an empty read from unavailable data without implying freshness", () => {
    const html = renderToStaticMarkup(
      <OrderExceptionScreen
        view={parseOrderExceptionView({
          ...fixture(),
          freshnessStatus: "Stale",
          items: [],
        })}
      />,
    );
    expect(html).toContain("No exceptions in this view");
    expect(html).toContain("Stale workbench");
    expect(html).not.toContain("<article");
  });
});

it("accepts the full 500-row server bound through the HTTP client and rejects 501", async () => {
  const rows = Array.from({ length: 501 }, (_, index) => ({
    ...fixture().items[0],
    exceptionReference: "018f0f58-767a-7f3b-a1d0-" + index.toString(16).padStart(12, "0"),
    kind: "PaymentReconciliationDifference",
    status: "Acknowledged",
    providerState: "NotApplicable",
    compensationStatus: "NotRequested",
  }));
  const input = { ...fixture(), storeLabel: "S".repeat(100), items: rows.slice(0, 500) };
  const body = JSON.stringify(input);
  // Longest enum spellings, full-length label, fixed-width references and instants.
  expect(body.length).toBeLessThanOrEqual(262144);
  const result = await createOrderExceptionClient(
    async () =>
      new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
  ).load();
  expect(parseOrderExceptionView(result).items).toHaveLength(500);
  expect(() => parseOrderExceptionView({ ...input, items: rows })).toThrow(
    "ORDER_EXCEPTION_INVALID",
  );
});

it("WP-2423: names the linked order by its order number and refuses a number without an order", () => {
  const input = fixture();
  const html = renderToStaticMarkup(
    <OrderExceptionScreen
      view={parseOrderExceptionView({
        ...input,
        items: [{ ...input.items[0], orderNumber: "13" }],
      })}
    />,
  );
  expect(html).toContain("Order 13");
  expect(() =>
    parseOrderExceptionView({
      ...input,
      items: [
        {
          ...input.items[0],
          kind: "PaymentReconciliationDifference",
          orderReference: null,
          orderNumber: "13",
        },
      ],
    }),
  ).toThrow();
});

it("renders an unassociated reconciliation record without enabling order-specific compensation", () => {
  const input = fixture();
  const view = parseOrderExceptionView({
    ...input,
    items: [{ ...input.items[0], kind: "PaymentReconciliationDifference", orderReference: null }],
  });
  const html = renderToStaticMarkup(<OrderExceptionScreen view={view} csrf={"a".repeat(43)} />);
  expect(html).toContain("Order reference unavailable");
  expect(html).not.toContain("Review confirmed refund");
  expect(() =>
    parseOrderExceptionView({ ...input, items: [{ ...input.items[0], orderReference: null }] }),
  ).toThrow();
});

it("does not advertise executable generic commands for a fresh unlinked payment difference", () => {
  const input = fixture();
  const html = renderToStaticMarkup(
    <OrderExceptionScreen
      view={parseOrderExceptionView({
        ...input,
        items: [
          {
            ...input.items[0],
            kind: "PaymentReconciliationDifference",
            orderReference: null,
            compensationStatus: "NotRequested",
          },
        ],
      })}
      onRefresh={() => undefined}
    />,
  );
  expect(html).toContain("No linked order is available");
  expect(html).toContain("requires reconciliation review");
  expect(html).toContain("not available");
  const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gu)];
  expect(buttons).toHaveLength(6);
  expect(buttons[0]?.[1]).not.toContain("disabled");
  for (const button of buttons.slice(1)) expect(button[1]).toContain("disabled");
});
