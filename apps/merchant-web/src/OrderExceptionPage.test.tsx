import { createOrderExceptionClient } from "./order-exception-client.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { StoreTimeZoneContext } from "./StoreTime.js";
import { findInternalText } from "../e2e/internal-text-patterns.js";
import { isExceptionOverdue } from "./order-exception-view.js";
import { summarizeExceptions } from "./StoreOverview.js";
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
      "Exceptions",
      "Critical",
      "Paid without a fulfillable order",
      "Unknown",
      "Clear filters",
    ])
      expect(html).toContain(value);
    for (const value of [
      "OPS-ORDER-EXCEPTION",
      "Request owning-domain compensation / retry",
      "Resolve from final source evidence",
      "exception-actions-unavailable",
    ])
      expect(html).not.toContain(value);
    expect(html).toContain("Linked order · order number not shown");
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
    expect(html).toContain("Loading exceptions");
    expect(html).not.toContain("Exceptions unavailable");
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
    expect(html).toContain("Data may be out of date");
    expect(html).toContain("2026-08-12T16:15:00.000Z");
    expect(html).toContain("Paid without a fulfillable order");
    expect(html).not.toContain("PaidWithoutFulfillableOrder</h3>");
    const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gu)];
    expect(buttons[0]?.[1]).not.toContain("disabled");
    // Dead placeholder actions are gone; only real source actions remain.
    for (const label of [
      ">Acknowledge<",
      ">Assign<",
      "Request owning-domain",
      "Resolve from final",
    ])
      expect(html).not.toContain(label);
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
    expect(html).toContain("Data may be out of date");
    expect(html).not.toContain("<article");
  });
});

it("accepts the full 2000-row server bound through the HTTP client and rejects 2001", async () => {
  const rows = Array.from({ length: 2001 }, (_, index) => ({
    ...fixture().items[0],
    exceptionReference: "018f0f58-767a-7f3b-a1d0-" + index.toString(16).padStart(12, "0"),
    orderNumber: "A".repeat(40),
    kind: "PaymentReconciliationDifference",
    status: "Acknowledged",
    providerState: "NotApplicable",
    compensationStatus: "NotRequested",
  }));
  const input = {
    ...fixture(),
    storeLabel: "S".repeat(100),
    olderResolvedBefore: "018f0f58-767a-7f3b-a1d0-000000009999",
    items: rows.slice(0, 2000),
  };
  const body = JSON.stringify(input);
  // Longest enum spellings, full-length label and order number, fixed-width references and instants.
  expect(body.length).toBeLessThanOrEqual(1048576);
  const result = await createOrderExceptionClient(
    async () =>
      new Response(body, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
  ).load();
  expect(parseOrderExceptionView(result).items).toHaveLength(2000);
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
  expect(html).toContain("No matching order");
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
  expect(html).toContain("No order is linked to this payment difference");
  const buttons = [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gu)];
  expect(buttons[0]?.[1]).not.toContain("disabled");
  for (const button of buttons.slice(1)) expect(button[1]).toContain("disabled");
});

describe("WP-2423 reconciliation cards say what the difference is about", () => {
  const dayItem = (resolvedAt: string | null) => ({
    ...fixture().items[0],
    exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000911",
    orderReference: null,
    kind: "PaymentReconciliationDifference",
    severity: "High",
    status: resolvedAt === null ? "Open" : "Resolved",
    providerState: "Confirmed",
    compensationStatus: "NotRequested",
    sourceFinal: resolvedAt !== null,
    reconciliation: {
      type: "BusinessDayTotals",
      businessDate: "2026-10-09",
      captured: { storeMinor: "5650", providerMinor: "5650" },
      refunded: { storeMinor: "0", providerMinor: "2260" },
      checkedAt: "2026-10-10T08:00:03.000Z",
      resolvedAt,
    },
  });
  const render = (items: unknown[]) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <StoreTimeZoneContext.Provider value="America/Toronto">
          <OrderExceptionScreen
            view={parseOrderExceptionView({ ...fixture(), items })}
            csrf={"a".repeat(43)}
            onRefresh={() => undefined}
          />
        </StoreTimeZoneContext.Provider>
      </MemoryRouter>,
    );
  it("shows a resolved business-day difference with its day, the side that differed and the re-check", () => {
    const html = render([dayItem("2026-10-15T13:32:56.580Z")]);
    expect(html).toContain("Business day totals differ from the payment provider");
    expect(html).toContain("Fri, Oct 9");
    expect(html).toContain("Refunds: the payment provider has $22.60 more than the store.");
    expect(html).not.toContain("Payments taken: the payment provider has");
    expect(html).toContain("Resolved: the day was checked again");
    expect(html).toContain('href="/app/operations/payment-reconciliation?businessDate=2026-10-09"');
    expect(html).toContain("Open Settlement for Fri, Oct 9");
    expect(html).toContain("Follow-up closed: this difference is resolved.");
    for (const text of [
      "Review unmatched charge",
      "View charge details",
      "Review current follow-up",
      "Acknowledge payment difference",
      "No matching order",
      "No order is linked",
      "Refresh the page",
      "version",
    ])
      expect(html).not.toContain(text);
    expect(findInternalText([html.replace(/<[^>]+>/gu, " ")])).toEqual([]);
  });
  it("keeps follow-up open for an unresolved business-day difference and points to Settlement", () => {
    const html = render([dayItem(null)]);
    expect(html).toContain("do not match the payment provider&#x27;s statement");
    expect(html).toContain("Review current follow-up");
    expect(html).not.toContain("View charge details");
    expect(html).not.toContain("Review unmatched charge");
  });
  it("2026-10-17: a single payment's difference resolved by its re-check says so and offers no follow-up", () => {
    const paymentItem = (resolvedAt: string | null) => ({
      ...dayItem(resolvedAt),
      orderReference: "018f0f58-767a-7f3b-a1d0-000000000920",
      orderNumber: "42",
      reconciliation: { type: "Payment", resolvedAt },
    });
    const resolved = render([paymentItem("2026-10-17T14:05:00.000Z")]);
    expect(resolved).toContain("Payment reconciliation difference");
    expect(resolved).toContain("Order 42");
    expect(resolved).toContain("Resolved: this payment was checked again");
    expect(resolved).toContain("now matches the payment provider");
    expect(resolved).toContain("Follow-up closed: this difference is resolved.");
    expect(resolved).not.toContain("Review current follow-up");
    expect(resolved).not.toContain("Business day totals differ");
    expect(findInternalText([resolved.replace(/<[^>]+>/gu, " ")])).toEqual([]);
    const open = render([paymentItem(null)]);
    expect(open).not.toContain("Resolved: this payment was checked again");
    expect(open).toContain("Review current follow-up");
  });
  it("offers the charge and its refund only for a charge that matches no order", () => {
    const html = render([{ ...dayItem(null), reconciliation: { type: "UnmatchedCharge" } }]);
    expect(html).toContain("Charge that matches no order");
    expect(html).toContain("View charge details");
    expect(html).toContain("Review unmatched charge");
    expect(html).toContain("matches no order or payment in this store");
  });
  it("D3: says the details could not be loaded instead of showing an unmatched-charge card", () => {
    const html = render([
      {
        ...dayItem(null),
        exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000912",
        reconciliation: { type: "Unavailable" },
      },
      dayItem("2026-10-15T13:32:56.580Z"),
    ]);
    expect(html).toContain(
      "The details of this payment difference could not be loaded, so what to do next is not shown. Refresh the page to try again.",
    );
    // The other card keeps its own detail.
    expect(html).toContain("Business day totals differ from the payment provider");
    for (const text of [
      "Charge that matches no order",
      "View charge details",
      "Review unmatched charge",
      "Review current follow-up",
      "Acknowledge payment difference",
      "No order is linked",
    ])
      expect(html).not.toContain(text);
    expect(findInternalText([html.replace(/<[^>]+>/gu, " ")])).toEqual([]);
    expect(() =>
      parseOrderExceptionView({
        ...fixture(),
        items: [{ ...dayItem(null), reconciliation: { type: "Unavailable", reason: "x" } }],
      }),
    ).toThrow("ORDER_EXCEPTION_INVALID");
  });
  it("refuses a detail on another kind or a malformed day total", () => {
    expect(() =>
      parseOrderExceptionView({
        ...fixture(),
        items: [{ ...fixture().items[0], reconciliation: { type: "Payment", resolvedAt: null } }],
      }),
    ).toThrow("ORDER_EXCEPTION_INVALID");
    const bad = dayItem(null);
    expect(() =>
      parseOrderExceptionView({
        ...fixture(),
        items: [
          {
            ...bad,
            reconciliation: {
              ...bad.reconciliation,
              refunded: { storeMinor: "-1", providerMinor: "0" },
            },
          },
        ],
      }),
    ).toThrow("ORDER_EXCEPTION_INVALID");
  });
});

it("DEC-EXCEPTION-CONFIRMED-REFUND-DUE: a confirmed refund reads as refunded and checked by the day's end", () => {
  const input = fixture();
  const confirmed = {
    ...input.items[0],
    providerState: "Confirmed",
    dueAt: "2026-08-13T04:00:00.000Z",
  };
  const unconfirmed = {
    ...input.items[0],
    exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000903",
  };
  const html = renderToStaticMarkup(
    <StoreTimeZoneContext.Provider value="America/Toronto">
      <MemoryRouter>
        <OrderExceptionScreen
          view={parseOrderExceptionView({ ...input, items: [confirmed, unconfirmed] })}
        />
      </MemoryRouter>
    </StoreTimeZoneContext.Provider>,
  );
  const [first, second] = html.split("<article").slice(1);
  expect(first).toContain("Refunded · check by");
  expect(first).toContain("Refunded — check by end of day");
  expect(first).not.toContain("Critical · due");
  expect(first).not.toContain("<dd>Pending</dd>");
  expect(second).toContain("Critical · due");
  expect(second).toContain("<dd>Pending</dd>");
  expect(findInternalText([html.replace(/<[^>]+>/gu, " ")])).toEqual([]);
});

it("WP-2423: an overdue confirmed refund says so on the card, and a resolved case offers no actions", () => {
  const input = fixture();
  const overdue = {
    ...input.items[0],
    providerState: "Confirmed",
    dueAt: "2026-08-12T16:10:00.000Z",
  };
  const resolved = {
    ...overdue,
    exceptionReference: "018f0f58-767a-7f3b-a1d0-000000000904",
    status: "Resolved",
    sourceFinal: true,
  };
  const view = parseOrderExceptionView({ ...input, items: [overdue, resolved] });
  const html = renderToStaticMarkup(
    <StoreTimeZoneContext.Provider value="America/Toronto">
      <MemoryRouter>
        <OrderExceptionScreen view={view} csrf={"a".repeat(43)} />
      </MemoryRouter>
    </StoreTimeZoneContext.Provider>,
  );
  const [first, second] = html.split("<article").slice(1);
  expect(first).toContain("Refunded · check overdue since");
  expect(first).toContain("Refunded — store check overdue");
  expect(first).not.toContain("check by");
  expect(first).toContain("Review confirmed refund");
  expect(second).not.toContain("overdue");
  expect(second).not.toContain("Review confirmed refund");
  expect(second).not.toContain("<button");
  expect(second).toContain("Resolved: nothing more to do.");
  expect(view.items.map((item) => isExceptionOverdue(item, view.projectedAt))).toEqual([
    true,
    false,
  ]);
  expect(summarizeExceptions(view)).toEqual({ open: 1, overdue: 1 });
  expect(findInternalText([html.replace(/<[^>]+>/gu, " ")])).toEqual([]);
});

it("WP-2423: a resolved charge that matches no order keeps only its read-only review", () => {
  const input = fixture();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <OrderExceptionScreen
        view={parseOrderExceptionView({
          ...input,
          items: [
            {
              ...input.items[0],
              kind: "PaymentReconciliationDifference",
              orderReference: null,
              providerState: "Confirmed",
              compensationStatus: "NotRequested",
              status: "Resolved",
              sourceFinal: true,
              reconciliation: { type: "UnmatchedCharge" },
            },
          ],
        })}
        csrf={"a".repeat(43)}
      />
    </MemoryRouter>,
  );
  const card = html.split("<article")[1] ?? "";
  expect(card).toContain("Review unmatched charge");
  expect(card).toContain("Follow-up closed: this difference is resolved.");
  expect(card).not.toContain("refund it if no order");
  expect(card).not.toContain("overdue");
});

it("WP-2423: offers older resolved exceptions only when the server has more", () => {
  const input = fixture();
  const render = (olderResolvedBefore: string | null, older?: "Loading" | "Failed") =>
    renderToStaticMarkup(
      <MemoryRouter>
        <OrderExceptionScreen
          view={parseOrderExceptionView({ ...input, olderResolvedBefore })}
          onShowOlder={() => undefined}
          {...(older ? { older } : {})}
        />
      </MemoryRouter>,
    );
  expect(render(null)).not.toContain("older resolved");
  expect(render("018f0f58-767a-7f3b-a1d0-000000000990")).toContain(
    "Show older resolved exceptions",
  );
  expect(render("018f0f58-767a-7f3b-a1d0-000000000990", "Loading")).toContain(
    "Loading older resolved exceptions",
  );
  expect(render("018f0f58-767a-7f3b-a1d0-000000000990", "Failed")).toContain(
    "Older resolved exceptions could not be loaded. Try again.",
  );
  expect(() => parseOrderExceptionView({ ...input, olderResolvedBefore: "older" })).toThrow(
    "ORDER_EXCEPTION_INVALID",
  );
  // An older server without history paging still parses.
  expect(parseOrderExceptionView(input).olderResolvedBefore).toBeNull();
});
