import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  isAwaitingAcceptance,
  ordersAwaitingAcceptance,
  parseCurrentOrderQueue,
} from "./current-order-queue-client.js";
import { currentOrderQueueFixture } from "./current-order-queue.fixtures.js";
import { parseOrderExceptionView } from "./OrderExceptionPage.js";
import {
  NeedsAttention,
  OverviewToday,
  StoreOverview,
  attentionItems,
  storePhoneStepHref,
  countShown,
  initialOverviewState,
  summarizeExceptions,
  summarizeOrders,
  summarizePickups,
  summarizeTables,
  dayChecklist,
  DayChecklist,
  settlementStatusText,
  type OverviewTodayState,
  type TablesRead,
} from "./StoreOverview.js";
import type { StaffDiningTable } from "./dining-session-client.js";
import { settlementViewFixture } from "./settlement.fixtures.js";
import { parseSettlementView } from "./settlement-client.js";
import {
  awaitingAcceptanceText,
  paidRoundWaitText,
  tableRoundWaitText,
  waitedAgoText,
} from "./paid-round-wait.js";
import { setLanguageForTest } from "./i18n/i18n.js";

describe("WP-2423 P2 store overview", () => {
  it("Owner 2026-11-04: a pickup closed as not collected is not an open order", () => {
    const queue = parseCurrentOrderQueue(currentOrderQueueFixture(), null);
    const notCollected = {
      ...queue,
      items: queue.items.map((order, index) =>
        index === 0 ? { ...order, currentPhase: "Accepted", pickupNotCollected: true } : order,
      ),
    };
    const before = summarizeOrders({
      ...queue,
      items: queue.items.map((order, index) =>
        index === 0 ? { ...order, currentPhase: "Accepted" } : order,
      ),
    }).open;
    expect(summarizeOrders(notCollected).open).toBe(before - 1);
  });
  it("counts open and awaiting orders from the current queue", () => {
    const queue = parseCurrentOrderQueue(currentOrderQueueFixture(), null);
    expect(summarizeOrders(queue)).toEqual({
      open: 3,
      awaitingAcceptance: 1,
      earlierUnfinished: 0,
      awaitingRounds: 1,
      urgentRounds: 0,
      paidStuck: 0,
      // The fixture's only Ready order is a pickup; pickup readiness is counted from the pickup queue.
      readyToServe: 0,
      dineIn: true,
      more: false,
      servedDineIn: new Set(),
    });
  });
  it("counts a table whose later round awaits acceptance, the same way the Orders page does", () => {
    const fixture = currentOrderQueueFixture();
    const [ready, , accepted] = fixture.items;
    if (!ready || !accepted?.batches[0]) throw new Error("fixture");
    const firstRound = { ...accepted.batches[0], canCancel: false };
    const table = {
      ...accepted,
      orderReference: "018f7600-0000-7000-8000-000000000031",
      orderNumber: "ORD-1004",
      orderType: "DineIn" as const,
      initialBatchReference: firstRound.orderBatchReference,
      batches: [
        firstRound,
        {
          ...firstRound,
          orderBatchReference: "018f7600-0000-7000-8000-000000000032",
          sequence: 2,
          acceptanceStatus: "NotAccepted",
          canRequestAcceptance: true,
        },
      ],
      canRequestAcceptance: false,
    };
    const queue = parseCurrentOrderQueue({ ...fixture, items: [table, ready] }, null);
    expect(queue.items.map(isAwaitingAcceptance)).toEqual([true, false]);
    expect(ordersAwaitingAcceptance(queue)).toBe(1);
    expect(summarizeOrders(queue).awaitingAcceptance).toBe(1);
  });
  it("counts rounds when a table has several paid rounds to accept, and those waiting long", () => {
    const fixture = currentOrderQueueFixture();
    const [ready, , accepted] = fixture.items;
    if (!ready || !accepted?.batches[0]) throw new Error("fixture");
    const round = {
      ...accepted.batches[0],
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: true,
      canCancel: false,
      canCancelItems: false,
    };
    const now = Date.parse("2026-10-16T15:00:00.000Z");
    const table = {
      ...accepted,
      orderReference: "018f7600-0000-7000-8000-000000000031",
      orderNumber: "ORD-1004",
      orderType: "DineIn" as const,
      initialBatchReference: round.orderBatchReference,
      batches: [
        { ...round, awaitingAcceptanceSince: "2026-10-16T14:48:00.000Z" },
        {
          ...round,
          orderBatchReference: "018f7600-0000-7000-8000-000000000032",
          sequence: 2,
          awaitingAcceptanceSince: "2026-10-16T14:58:00.000Z",
        },
      ],
      canRequestAcceptance: false,
    };
    const queue = parseCurrentOrderQueue({ ...fixture, items: [table, ready] }, null);
    const summary = summarizeOrders(queue, now);
    expect(summary).toMatchObject({ awaitingAcceptance: 1, awaitingRounds: 2, urgentRounds: 1 });
    // WP-2423 (2026-11-03): what the kitchen never finished; made ones are on Pickup's own count.
    const earlier = (kitchenPhase: "Ready" | null) =>
      queue.items.slice(0, 1).map((order) => ({ ...order, earlierOpenPickup: true, kitchenPhase }));
    expect(
      summarizeOrders({ ...queue, items: [...earlier(null), ...earlier("Ready")] }, now)
        .earlierUnfinished,
    ).toBe(1);
    expect(
      awaitingAcceptanceText({
        orders: summary.awaitingAcceptance,
        rounds: summary.awaitingRounds,
        urgentRounds: summary.urgentRounds,
      }),
    ).toBe("2 rounds awaiting acceptance in 1 order (1 paid 5+ min ago)");
    expect(awaitingAcceptanceText({ orders: 2, rounds: 2, urgentRounds: 0 })).toBe(
      "2 awaiting acceptance",
    );
    // A paid round said on a pickup, or on a round that cannot be accepted, is not read: that
    // Order is named and left out, the others stay.
    const misread = parseCurrentOrderQueue(
      {
        ...fixture,
        items: [{ ...table, orderType: "Pickup" as const }, ready],
      },
      null,
    );
    expect(misread.items.map((item) => item.orderReference)).toEqual([ready.orderReference]);
    expect(misread.unreadable).toHaveLength(1);
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
  it("WP-2423: counts a table with a ready round as ready to serve even while another round waits", () => {
    const fixture = currentOrderQueueFixture();
    const [, , accepted] = fixture.items;
    // The Order is not Ready as a whole (another round is still being made or paid for).
    const table = { ...accepted, orderType: "DineIn", readyToServeItemCount: 1 };
    const nothingReady = {
      ...accepted,
      orderReference: "018f0f58-767a-7f3b-a1d0-0000000009f1",
      orderType: "DineIn",
      currentPhase: "Ready",
      readyToServeItemCount: 0,
    };
    const queue = parseCurrentOrderQueue({ ...fixture, items: [table] }, null);
    expect(queue.items[0]?.readyToServeItemCount).toBe(1);
    expect(summarizeOrders(queue)).toMatchObject({ readyToServe: 1, dineIn: true });
    // The count is the source: an Order whose ready food was all served is not counted.
    const served = parseCurrentOrderQueue({ ...fixture, items: [nothingReady] }, null);
    expect(summarizeOrders(served)).toMatchObject({ readyToServe: 0 });
    // A pickup never has food to serve at a table.
    expect(() =>
      parseCurrentOrderQueue(
        { ...fixture, items: [{ ...accepted, readyToServeItemCount: 1 }] },
        null,
      ),
    ).toThrow();
  });
  it("DEC-DINING-GUEST-TABLE-START: a finished dish at a table a guest started raises no alarm on Home", () => {
    const fixture = currentOrderQueueFixture();
    const [, , accepted] = fixture.items;
    const staffOpened = { ...accepted, orderType: "DineIn", readyToServeItemCount: 1 };
    // Sent only for such a table: both shapes read, and an older answer reads as before.
    expect(
      summarizeOrders(parseCurrentOrderQueue({ ...fixture, items: [staffOpened] }, null)),
    ).toMatchObject({ readyToServe: 1 });
    const guestStarted = parseCurrentOrderQueue(
      { ...fixture, items: [{ ...staffOpened, startedByGuest: true }] },
      null,
    );
    expect(guestStarted.items[0]?.startedByGuest).toBe(true);
    expect(summarizeOrders(guestStarted)).toMatchObject({ readyToServe: 0, open: 1, dineIn: true });
    expect(
      Object.hasOwn(
        parseCurrentOrderQueue({ ...fixture, items: [staffOpened] }, null).items[0] ?? {},
        "startedByGuest",
      ),
    ).toBe(false);
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
    ).toEqual({ waiting: 2, earlierDays: 0, remaking: 1, more: true });
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
              value: {
                open: 50,
                awaitingAcceptance: 4,
                earlierUnfinished: 0,
                awaitingRounds: 4,
                urgentRounds: 0,
                paidStuck: 0,
                readyToServe: 2,
                dineIn: true,
                more: true,
                servedDineIn: new Set(),
              },
            },
            pickups: { kind: "Unavailable" },
            exceptions: { kind: "Ready", value: { open: 0, overdue: 0 } },
            tables: { kind: "Hidden" },
            updatedAt: "2026-08-12T16:30:00.000Z",
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Right now");
    // 2026-10-21 live check: a count from the first page only says so in words, never "50+".
    expect(html).toContain(
      '<strong class="overview-count__value"><span class="overview-count__qualifier">At least </span>50</strong>',
    );
    expect(html).toContain(
      '<span class="overview-count__note">Counted from the most recent orders only</span>',
    );
    expect(html).not.toContain("50+");
    expect(html).toContain("Could not be read");
    expect(html).toContain("Last checked 12:30");
    expect(html).toContain('href="/operations/orders"');
    const loading = renderToStaticMarkup(
      <MemoryRouter>
        <OverviewToday state={initialOverviewState} />
      </MemoryRouter>,
    );
    expect(loading).toContain("Reading current work…");
    expect(loading).not.toContain("Refresh");
  });
  it("2026-10-21 live check: says an exact count plainly and a partial count as a lower bound", () => {
    expect(countShown(3, false, "the most recent orders")).toEqual({
      qualifier: null,
      number: "3",
      note: null,
    });
    expect(countShown(3, true, "the most recent orders")).toEqual({
      qualifier: "At least",
      number: "3",
      note: "Counted from the most recent orders only",
    });
    // "At least 0" says nothing; the note still says only part of the list was counted.
    expect(countShown(0, true, "the first tables listed")).toEqual({
      qualifier: null,
      number: "0",
      note: "Counted from the first tables listed only",
    });
    const exact = renderToStaticMarkup(
      <MemoryRouter>
        <OverviewToday
          state={{
            orders: {
              kind: "Ready",
              value: {
                open: 3,
                awaitingAcceptance: 1,
                earlierUnfinished: 0,
                awaitingRounds: 1,
                urgentRounds: 0,
                paidStuck: 0,
                readyToServe: 0,
                dineIn: false,
                more: false,
                servedDineIn: new Set(),
              },
            },
            pickups: { kind: "Hidden" },
            exceptions: { kind: "Hidden" },
            tables: { kind: "Hidden" },
            updatedAt: "2026-08-12T16:30:00.000Z",
          }}
        />
      </MemoryRouter>,
    );
    expect(exact).toContain('<strong class="overview-count__value">3</strong>');
    expect(exact).not.toContain("At least");
    expect(exact).not.toContain("overview-count__note");
  });
  it('WP-2423: counts overdue exceptions in plain words (v15 showed "15 overdues")', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NeedsAttention
          state={{
            orders: { kind: "Hidden" },
            pickups: { kind: "Hidden" },
            exceptions: { kind: "Ready", value: { open: 15, overdue: 15 } },
            tables: { kind: "Hidden" },
            updatedAt: "2026-08-12T16:30:00.000Z",
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("15 overdue");
    expect(html).not.toContain("overdues");
    expect(html).toContain('href="/operations/order-exceptions"');
  });
  it("Owner 2026-11-03: open exceptions not yet overdue still have a row; numbers drop them", () => {
    const items = attentionItems(
      {
        ...initialOverviewState,
        exceptions: { kind: "Ready", value: { open: 3, overdue: 0 } },
      },
      null,
    );
    expect(items.map((item) => [item.title, item.detail])).toEqual([
      ["Open exceptions", "3 open · None overdue"],
    ]);
  });
  it("WP-2423 (M23): an order holding a dish sold out since it was ordered is named on Home first", () => {
    const queue = parseCurrentOrderQueue(currentOrderQueueFixture(), null);
    const marked = {
      ...queue,
      items: queue.items.map((order) =>
        isAwaitingAcceptance(order) ? { ...order, soldOutNow: true as const } : order,
      ),
    };
    const summary = summarizeOrders(marked);
    expect(summary.soldOutNow).toBe(1);
    expect(summarizeOrders(queue).soldOutNow).toBeUndefined();
    const items = attentionItems(
      { ...initialOverviewState, orders: { kind: "Ready", value: summary } },
      null,
    );
    expect(items.map((item) => [item.key, item.title, item.detail, item.tone]).slice(0, 2)).toEqual(
      [
        [
          "sold-out-now",
          "Orders with a dish sold out or taken off the menu since it was ordered",
          "1 order waiting to be accepted. Open each on Orders: offer the guest a swap, or cancel that dish with a refund.",
          "danger",
        ],
        ["orders", "Orders waiting to be accepted", expect.any(String), "warning"],
      ],
    );
  });
  it("DEC-PAPER-ORDER-NEVER-RELEASED: Home names paper orders whose payment isn't recorded until they are", () => {
    const queue = parseCurrentOrderQueue(currentOrderQueueFixture(), null);
    const [first] = queue.items;
    if (first === undefined) throw new Error("fixture");
    const paper = {
      ...first,
      currentPhase: "Submitted" as const,
      counter: {
        recordedAfterOutage: true,
        paidOnCardMachine: null,
        payBy: "2026-10-21T17:20:00.000Z",
        amountDueMinor: null,
        canCancelUnpaid: false,
        canCloseAsReentered: false,
        cancelledBeforePayment: null,
      },
    };
    const summary = summarizeOrders({ ...queue, items: [paper, ...queue.items.slice(1)] });
    expect(summary.paperUnrecorded).toBe(1);
    expect(summarizeOrders(queue).paperUnrecorded).toBeUndefined();
    // Recorded, or closed as entered again: no longer named.
    const reentered = {
      ...paper,
      counter: {
        ...paper.counter,
        cancelledBeforePayment: {
          reasonCode: "COUNTER_PAPER_REENTERED" as const,
          cancelledAt: "2026-10-21T17:30:00.000Z",
          reenteredOrderNumber: "12",
        },
      },
    };
    expect(
      summarizeOrders({ ...queue, items: [reentered, ...queue.items.slice(1)] }).paperUnrecorded,
    ).toBeUndefined();
    const items = attentionItems(
      { ...initialOverviewState, orders: { kind: "Ready", value: summary } },
      null,
    );
    expect(items[0]).toMatchObject({
      key: "paper-unrecorded",
      title: "Paper orders whose payment isn't recorded",
      detail:
        "1 order taken during the outage. Record each from its paper slip on Counter order, or enter it again once its time has passed. Until then the sale isn't in the day's takings.",
      tone: "danger",
      href: "/operations/order-entry",
    });
  });
  it("WP-2423 M04: a paid order that did not reach the kitchen comes first among orders", () => {
    const items = attentionItems(
      {
        ...initialOverviewState,
        orders: {
          kind: "Ready",
          value: {
            open: 2,
            awaitingAcceptance: 1,
            earlierUnfinished: 0,
            awaitingRounds: 0,
            urgentRounds: 0,
            paidStuck: 1,
            readyToServe: 0,
            dineIn: true,
            more: false,
            servedDineIn: new Set(),
          },
        },
      },
      null,
    );
    expect(items.map((item) => [item.key, item.title, item.detail, item.tone])).toEqual([
      [
        "paid-stuck",
        "Paid orders that need you",
        "1 order paid but not in the kitchen, or not refunded as it should be. Open each on Orders to see what to do.",
        "danger",
      ],
      ["orders", "Orders waiting to be accepted", expect.any(String), "warning"],
    ]);
  });
  it("Owner 2026-11-03: a failed read says so; the list never calmly claims nothing is wrong", () => {
    const unread = {
      ...initialOverviewState,
      orders: { kind: "Unavailable" },
      pickups: { kind: "Ready", value: { waiting: 0, earlierDays: 0, remaking: 0, more: false } },
      exceptions: { kind: "Unavailable" },
      tables: { kind: "Ready", value: { tables: [], canClose: true, more: false } },
    } as const;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NeedsAttention
          state={unread}
          settlement={{ kind: "Unavailable" }}
          onRefresh={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Could not read: Orders · Exceptions · Settlement");
    expect(html).toContain("Refresh");
    expect(html).not.toContain("Nothing needs attention");
  });
  it("Owner 2026-11-03: payments that differ on the last closed day move up from the checklist", () => {
    const row = (needsLook: boolean) =>
      attentionItems(initialOverviewState, null, null, null, {
        kind: "Ready",
        value: { businessDate: "2026-10-16", text: "1 payment to look at", needsLook },
      }).find((item) => item.key === "settlement");
    expect(row(true)).toMatchObject({
      detail: "1 payment to look at",
      href: "/app/operations/payment-reconciliation?businessDate=2026-10-16",
    });
    expect(row(false)).toBeUndefined();
  });
  it("Owner 2026-11-03: Today's summary is one link, only for those with the reports screen", () => {
    const html = (reportsHref: string | null) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <OverviewToday state={initialOverviewState} reportsHref={reportsHref} />
        </MemoryRouter>,
      );
    expect(html("/app/reports/operations")).toContain('href="/app/reports/operations"');
    expect(html("/app/reports/operations")).toContain("Today&#x27;s summary");
    expect(html(null)).not.toContain("Today&#x27;s summary");
  });
  it("never shows a pickup-only Store an orders 'ready' count that contradicts its pickups", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NeedsAttention
          state={{
            orders: {
              kind: "Ready",
              value: {
                open: 5,
                awaitingAcceptance: 0,
                earlierUnfinished: 0,
                awaitingRounds: 0,
                urgentRounds: 0,
                paidStuck: 0,
                readyToServe: 0,
                dineIn: false,
                more: false,
                servedDineIn: new Set(),
              },
            },
            pickups: {
              kind: "Ready",
              value: { waiting: 4, earlierDays: 0, remaking: 1, more: false },
            },
            exceptions: { kind: "Hidden" },
            tables: { kind: "Hidden" },
            updatedAt: null,
          }}
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain("ready to serve");
    expect(html).not.toMatch(/\b0 ready\b/u);
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
    const ordersOnly = render({
      ...initialOverviewState,
      pickups: hidden,
      exceptions: hidden,
      tables: hidden,
    });
    expect(ordersOnly).toContain("Open orders");
    expect(ordersOnly).not.toContain("Waiting for pickup");
    expect(ordersOnly).not.toContain("Open tables");
    expect(
      render({
        ...initialOverviewState,
        orders: hidden,
        pickups: hidden,
        exceptions: hidden,
        tables: hidden,
      }),
    ).toBe("");
  });
});

describe("v15 finding: the store system card follows the server's answer, not the navigation", () => {
  it("mounts the alerts card for a pilot Owner or Store Manager navigation without an exceptions entry", () => {
    // The pilot navigation before this fix carried no OPS-ORDER-EXCEPTION entry, so the card never
    // rendered although the alerts route answers 200 for these roles. A 403 hides it instead.
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreOverview
          screens={["MER-WORKSPACE-HOME", "OPS-ORDER-QUEUE", "FUL-PICKUP-QUEUE", "STORE-SETUP"]}
          csrf="csrf"
          storeReference="018f0f58-767a-7f3b-a1d0-000000000001"
          storeLabel="Training Store"
          fetcher={(async () => new Response("{}", { status: 503 })) as never}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Store system");
    expect(html).toContain("Checking the store system");
  });
  it("words a paid round's wait for staff: plain, then warning at 3 min, urgent at 5 (Owner default 12)", () => {
    const paidAt = "2026-10-16T14:50:00.000Z";
    const at = (minute: number) => Date.parse(paidAt) + minute * 60_000;
    expect(paidRoundWaitText(paidAt, at(2))).toBe("Paid · the kitchen gets it once you accept it");
    expect(paidRoundWaitText(paidAt, at(4))).toBe(
      "Paid 4 min ago · the guest is waiting. Accept it to send it to the kitchen",
    );
    // M41, v15 batch 8: the urgent text names the control this person has on the order, the
    // words on its button ("Can't make it · refund" or "Refuse and refund"), or else a manager.
    expect(paidRoundWaitText(paidAt, at(5), "CantMake")).toBe(
      "Accept now · paid 5 min ago. It is never refunded automatically. If it can't be made, use Can't make it · refund: the guest gets a full refund.",
    );
    expect(paidRoundWaitText(paidAt, at(5), "RefuseAndRefund")).toBe(
      "Accept now · paid 5 min ago. It is never refunded automatically. If it can't be made, use Refuse and refund: the guest gets a full refund.",
    );
    expect(paidRoundWaitText(paidAt, at(5), null)).toBe(
      "Accept now · paid 5 min ago. It is never refunded automatically. If it can't be made, ask a manager to refuse it: the guest gets a full refund.",
    );
    expect(tableRoundWaitText(2, paidAt, at(0))).toBe(
      "Round 2 paid just now · accept it on the Orders page to send it to the kitchen",
    );
    // Tables names no button: the order's panel offers whichever this person has.
    expect(tableRoundWaitText(2, paidAt, at(6))).toBe(
      "Round 2 paid 6 min ago and still not accepted · open the order now: accept it, or turn it down there for a full refund",
    );
  });
  it("v15 batch 8: a paid round's age reads in hours or days, never thousands of minutes", () => {
    expect(waitedAgoText(0)).toBe("just now");
    expect(waitedAgoText(59)).toBe("59 min ago");
    expect(waitedAgoText(60)).toBe("1 h ago");
    expect(waitedAgoText(135)).toBe("2 h 15 min ago");
    expect(waitedAgoText(1440)).toBe("1 day ago");
    // Test Merchant 2's round paid on Nov 4 and never accepted.
    expect(waitedAgoText(9823)).toBe("6 days ago");
    const paidAt = "2026-11-04T21:00:00.000Z";
    const later = Date.parse(paidAt) + 9823 * 60_000;
    expect(tableRoundWaitText(1, paidAt, later)).toBe(
      "Round 1 paid 6 days ago and still not accepted · open the order now: accept it, or turn it down there for a full refund",
    );
    setLanguageForTest("zh-Hans");
    try {
      expect(tableRoundWaitText(1, paidAt, later)).toBe(
        "第 1 轮 6 天前已付款，仍未接单 · 请立即打开订单：接单，或在订单里拒单并全额退款",
      );
      // Under a minute the round "just paid": 刚付款, never 刚刚已付款.
      expect(tableRoundWaitText(1, paidAt, Date.parse(paidAt) + 20_000)).toBe(
        "第 1 轮刚付款 · 请在订单页接单以发送到后厨",
      );
      expect(tableRoundWaitText(1, paidAt, Date.parse(paidAt) + 4 * 60_000)).toBe(
        "第 1 轮 4 分钟前已付款 · 请在订单页接单以发送到后厨",
      );
    } finally {
      setLanguageForTest("en");
    }
  });
});

describe("WP-2423 3cd0f8dd: tables to close, earlier-day pickups and the day checklist", () => {
  const order = "01909985-0000-7000-8000-000000000101";
  const table = (overrides: Partial<StaffDiningTable> = {}): StaffDiningTable => ({
    tableReference: "01909985-0000-7000-8000-000000000201",
    stableLabel: "T1",
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 1,
    currentDiningSessionReference: "01909985-0000-7000-8000-000000000301",
    elapsedMinutes: 40,
    qrCodeValidUntil: null,
    paymentTiming: "PayFirst",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    session: { phase: "Active", version: 2, orderReference: order },
    ...overrides,
  });
  const read = (tables: StaffDiningTable[], canClose = true): TablesRead => ({
    tables,
    canClose,
    more: false,
  });
  it("M7: a served table with nothing waiting is to be closed; only for staff who close tables", () => {
    const served = new Set([order]);
    expect(summarizeTables(read([table()]), served)).toEqual({
      open: 1,
      toClose: 1,
      earlierDays: null,
      more: false,
    });
    // Still eating (order not served), a round waiting for payment, or no session: not to close.
    expect(summarizeTables(read([table()]), new Set()).toClose).toBe(0);
    expect(
      summarizeTables(
        read([table({ staffRoundsAwaitingPayment: [{ payBy: "2026-10-17T20:00:00.000Z" }] })]),
        served,
      ).toClose,
    ).toBe(0);
    expect(
      summarizeTables(
        read([table({ currentDiningSessionReference: null, elapsedMinutes: null, session: null })]),
        served,
      ),
    ).toEqual({ open: 0, toClose: 0, earlierDays: null, more: false });
    // Open so long the guests most likely left.
    expect(summarizeTables(read([table({ elapsedMinutes: 13 * 60 })]), null).toClose).toBe(1);
    expect(summarizeTables(read([table()], false), served).toClose).toBeNull();
    const html = (canClose: boolean) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <OverviewToday
            state={{
              ...initialOverviewState,
              orders: { kind: "Hidden" },
              pickups: { kind: "Hidden" },
              exceptions: { kind: "Hidden" },
              tables: {
                kind: "Ready",
                value: read([table({ elapsedMinutes: 13 * 60 })], canClose),
              },
            }}
          />
        </MemoryRouter>,
      );
    const toClose = (canClose: boolean) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <NeedsAttention
            state={{
              ...initialOverviewState,
              orders: { kind: "Hidden" },
              pickups: { kind: "Hidden" },
              exceptions: { kind: "Hidden" },
              tables: {
                kind: "Ready",
                value: read([table({ elapsedMinutes: 13 * 60 })], canClose),
              },
            }}
          />
        </MemoryRouter>,
      );
    expect(toClose(true)).toContain("1 table served — close when the guests have left");
    expect(toClose(true)).toContain('href="/operations/dining"');
    expect(toClose(false)).not.toContain("close when the guests have left");
    expect(html(true)).toContain('href="/operations/dining"');
    expect(html(true)).not.toContain("A manager or the owner closes tables");
    expect(html(false)).toContain("A manager or the owner closes tables when the guests have left");
  });
  it("L7: counts today's pickups apart from earlier days' and points to check and close", () => {
    const summary = summarizePickups(
      {
        items: [
          { phase: "Ready", businessDate: "2026-10-17" },
          { phase: "Ready", businessDate: "2026-10-15" },
          { phase: "Ready", businessDate: "2026-10-14", remakeQuantity: 1 },
          { phase: "Completed", businessDate: "2026-10-14" },
        ],
      },
      "2026-10-17",
    );
    expect(summary).toEqual({ waiting: 1, earlierDays: 2, remaking: 0, more: false });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <OverviewToday
          state={{
            ...initialOverviewState,
            orders: { kind: "Hidden" },
            exceptions: { kind: "Hidden" },
            tables: { kind: "Hidden" },
            pickups: { kind: "Ready", value: summary },
          }}
        />
      </MemoryRouter>,
    );
    // Today's waiting pickup is the number; the two from earlier days are a row to check.
    expect(html).toContain('<strong class="overview-count__value">1</strong>');
    const earlier = attentionItems(
      { ...initialOverviewState, pickups: { kind: "Ready", value: summary } },
      null,
    );
    expect(earlier[0]).toMatchObject({
      title: "Pickups from earlier days",
      action: "Check and close",
    });
    expect(earlier[0]?.detail).toMatch(/^2 · /u);
    // Without the business day every waiting pickup counts as today's (no false split).
    expect(summarizePickups({ items: [{ phase: "Ready", businessDate: "2026-10-15" }] })).toEqual({
      waiting: 1,
      earlierDays: 0,
      remaking: 0,
      more: false,
    });
  });
  it("46940b76 L1: only tables seated before the business day began count as left from before", () => {
    const readAt = "2026-10-17T15:00:00.000Z";
    const dayStartsAt = "2026-10-17T08:00:00.000Z"; // 04:00 Store time
    const tables = [
      table({ elapsedMinutes: 40 }), // seated today
      table({ elapsedMinutes: 7 * 60 }), // seated 08:00Z: the day's first minute is today
      table({ elapsedMinutes: 7 * 60 + 1 }), // seated 07:59Z: the previous business day
      table({ currentDiningSessionReference: null, elapsedMinutes: null, session: null }),
    ];
    expect(summarizeTables({ ...read(tables), readAt }, null, dayStartsAt)).toMatchObject({
      open: 3,
      earlierDays: 1,
    });
    // Without the read time or the business day the split is unknown, never guessed.
    expect(summarizeTables(read(tables), null, dayStartsAt).earlierDays).toBeNull();
    expect(summarizeTables({ ...read(tables), readAt }, null).earlierDays).toBeNull();
    const state: OverviewTodayState = {
      ...initialOverviewState,
      orders: { kind: "Hidden" },
      pickups: { kind: "Hidden" },
      exceptions: { kind: "Hidden" },
      tables: { kind: "Ready", value: { ...read(tables), readAt } },
    };
    const hidden = { kind: "Hidden" } as const;
    const status = (starts: string | null) =>
      Object.fromEntries(
        dayChecklist(state, hidden, null, starts).opening.map((item) => [item.key, item.status]),
      );
    expect(status(dayStartsAt)["tables-left-open"]).toBe("1 left");
    expect(status(null)["tables-left-open"]).toBe("Reading…");
    // Before you close still counts every open table.
    expect(
      dayChecklist(state, hidden, null, dayStartsAt).closing.find((i) => i.key === "tables")
        ?.status,
    ).toBe("3 left");
  });
  it("M6: the opening and closing checklist reads the same sources and leaves out hidden ones", () => {
    const state: OverviewTodayState = {
      orders: {
        kind: "Ready",
        value: {
          open: 2,
          awaitingAcceptance: 0,
          earlierUnfinished: 0,
          awaitingRounds: 0,
          urgentRounds: 0,
          paidStuck: 0,
          readyToServe: 0,
          dineIn: true,
          more: false,
          servedDineIn: new Set([order]),
        },
      },
      pickups: { kind: "Ready", value: { waiting: 1, earlierDays: 3, remaking: 0, more: false } },
      exceptions: { kind: "Ready", value: { open: 0, overdue: 0 } },
      tables: {
        kind: "Ready",
        value: {
          ...read([table({ elapsedMinutes: 20 * 60 })]),
          readAt: "2026-10-17T15:00:00.000Z",
        },
      },
      updatedAt: null,
    };
    const settlement = {
      kind: "Ready",
      value: { businessDate: "2026-10-16", text: "Matches the payment provider" },
    } as const;
    const list = dayChecklist(
      state,
      settlement,
      "/app/organization/stores/x/service",
      "2026-10-17T08:00:00.000Z",
    );
    const status = (items: typeof list.opening) =>
      Object.fromEntries(items.map((item) => [item.key, item.status]));
    expect(status(list.opening)).toEqual({
      "ordering-on": null,
      settlement: "Matches the payment provider",
      "earlier-pickups": "3 left",
      "tables-left-open": "1 left",
    });
    expect(status(list.closing)).toEqual({
      orders: "2 left",
      pickups: "4 left",
      tables: "1 left",
      exceptions: "Done",
      "ordering-off": null,
      "settlement-later": null,
    });
    // 2026-10-21 live check: a partial count reads "At least 2 left", never "2+ left".
    if (state.orders.kind !== "Ready") throw new Error("fixture");
    const partial = dayChecklist(
      { ...state, orders: { kind: "Ready", value: { ...state.orders.value, more: true } } },
      settlement,
      null,
      "2026-10-17T08:00:00.000Z",
    );
    expect(status(partial.closing).orders).toBe("At least 2 left");
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DayChecklist state={state} settlement={settlement} serviceHref={null} />
      </MemoryRouter>,
    );
    expect(html).toContain("Opening and closing");
    expect(html).toContain("Settlement for Fri, Oct 16");
    expect(html).not.toContain("Hours &amp; ordering");
    const hidden = { kind: "Hidden" } as const;
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <DayChecklist
            state={{
              ...state,
              orders: hidden,
              pickups: hidden,
              exceptions: hidden,
              tables: hidden,
            }}
            settlement={hidden}
            serviceHref={null}
          />
        </MemoryRouter>,
      ),
    ).toBe("");
  });
  it("M6: says the last closed day's settlement in staff words", () => {
    const parsed = parseSettlementView(settlementViewFixture());
    // The fixture: one refund difference and one unfinished guest payment (nothing charged).
    expect(settlementStatusText(parsed)).toBe("1 payment to look at");
    const reconciliation = parsed.reconciliation;
    if (reconciliation === null) throw new Error("fixture");
    const view = {
      ...parsed,
      reconciliation: { ...reconciliation, differences: reconciliation.differences.slice(1) },
    };
    expect(settlementStatusText(view)).toBe("Matches the payment provider");
    expect(settlementStatusText({ ...view, reconciliation: null })).toBe("Not checked yet");
  });
});

describe("Figma v1 (2026-10-25): Home lists what needs attention now", () => {
  const ready = <T,>(value: T) => ({ kind: "Ready", value }) as const;
  const orders = {
    open: 3,
    awaitingAcceptance: 1,
    earlierUnfinished: 0,
    awaitingRounds: 0,
    urgentRounds: 0,
    paidStuck: 0,
    readyToServe: 0,
    dineIn: false,
    more: false,
    servedDineIn: new Set<string>(),
  };
  const table: StaffDiningTable = {
    tableReference: "01909985-0000-7000-8000-000000000201",
    stableLabel: "T1",
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 1,
    currentDiningSessionReference: "01909985-0000-7000-8000-000000000301",
    elapsedMinutes: 10,
    qrCodeValidUntil: null,
    paymentTiming: "PayFirst",
    staffRoundsAwaitingPayment: [],
    guestRoundsAwaitingPayment: [],
    roundsAwaitingAcceptance: [],
    staffCall: {
      callReference: "01909985-0000-7000-8000-000000000401",
      reason: "TableNeeds",
      calledAt: "2026-10-25T15:00:00.000Z",
    },
  };
  const state: OverviewTodayState = {
    ...initialOverviewState,
    orders: ready(orders),
    pickups: ready({ waiting: 1, earlierDays: 1, remaking: 0, more: false }),
    exceptions: ready({ open: 2, overdue: 1 }),
    tables: ready({ tables: [table], canClose: true, more: false }),
    updatedAt: "2026-10-25T15:01:00.000Z",
  };
  it("WP-2423 item 11: a kitchen not set up comes first, with the link to fix it", () => {
    const href = "/app/organization/stores/s/setup#kitchen-setup";
    const items = attentionItems(state, null, null, href);
    expect(items[0]).toMatchObject({ key: "kitchen-setup", href, action: "Set up the kitchen" });
    expect(attentionItems(state, null).some((item) => item.key === "kitchen-setup")).toBe(false);
  });
  it("M109: only a Store whose configuration in force offers pickup is asked for the phone", () => {
    const ask = {
      pickupFeature: true,
      serviceModes: ["DineIn", "Pickup"] as const,
      canChangeProfile: true,
      businessPhone: null,
      storeReference: "s",
    };
    expect(storePhoneStepHref(ask)).toBe("/app/organization/stores/s/setup#store-public-profile");
    // Store features defaults pickup on, but a dine-in-only Store does not take pickup orders.
    expect(storePhoneStepHref({ ...ask, serviceModes: ["DineIn"] })).toBeNull();
    expect(storePhoneStepHref({ ...ask, pickupFeature: false })).toBeNull();
    expect(storePhoneStepHref({ ...ask, canChangeProfile: false })).toBeNull();
    expect(storePhoneStepHref({ ...ask, businessPhone: "+14165550142" })).toBeNull();
  });
  it("M109: a Store taking pickup orders with no phone asks the owner for it, with the link", () => {
    const href = "/app/organization/stores/s/setup#store-public-profile";
    const items = attentionItems(state, null, null, null, { kind: "Hidden" }, null, href);
    // A setup step listed after the guests in front of staff, not an error.
    expect(items.find((item) => item.key === "store-phone")).toMatchObject({
      title: "Add the store's phone number",
      state: "Setup step",
      tone: "warning",
      backlog: true,
      href,
      action: "Add phone number",
    });
    expect(attentionItems(state, null).some((item) => item.key === "store-phone")).toBe(false);
  });
  it("puts the guests in front of you first: staff calls, orders to accept, then the backlog", () => {
    const items = attentionItems(state, { awaiting: 2, approvedNotSent: 0, notSent: 0 });
    expect(items.map((item) => [item.title, item.state, item.href])).toEqual([
      ["1 table asking for staff", "Waiting", "/operations/dining"],
      ["Orders waiting to be accepted", "To accept", "/operations/orders"],
      ["Refunds waiting for approval", "To approve", "/app/approvals"],
      ["Pickups from earlier days", "To check", "/operations/pickup"],
      ["Exceptions overdue", "Overdue", "/operations/order-exceptions"],
    ]);
    expect(items[1]?.detail).toBe(
      awaitingAcceptanceText({ orders: 1, rounds: 0, urgentRounds: 0 }),
    );
  });
  it("says so when nothing needs attention, and renders nothing for a role without these screens", () => {
    const quiet: OverviewTodayState = {
      ...state,
      orders: ready({ ...orders, awaitingAcceptance: 0 }),
      pickups: ready({ waiting: 0, earlierDays: 0, remaking: 0, more: false }),
      exceptions: ready({ open: 0, overdue: 0 }),
      tables: ready({ tables: [], canClose: true, more: false }),
    };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NeedsAttention state={quiet} />
      </MemoryRouter>,
    );
    expect(html).toContain("Needs attention");
    expect(html).toContain("Nothing needs attention right now.");
    const hidden = { kind: "Hidden" } as const;
    expect(
      renderToStaticMarkup(
        <MemoryRouter>
          <NeedsAttention
            state={{
              ...quiet,
              orders: hidden,
              pickups: hidden,
              exceptions: hidden,
              tables: hidden,
            }}
          />
        </MemoryRouter>,
      ),
    ).toBe("");
  });
  it("WP-2423 item 9: a cleared order-rules row keeps its place, never 'nothing needs attention'", () => {
    const quiet: OverviewTodayState = {
      ...state,
      orders: ready({ ...orders, awaitingAcceptance: 0 }),
      pickups: ready({ waiting: 0, earlierDays: 0, remaking: 0, more: false }),
      exceptions: ready({ open: 0, overdue: 0 }),
      tables: ready({ tables: [], canClose: true, more: false }),
    };
    const board = {
      audience: "Installation",
      monitor: "Reporting",
      observedAt: "2026-11-07T01:10:00.000Z",
      active: [],
      recentlyCleared: [
        {
          key: "orders.workflow",
          title: "Order rules check passes again: stay on paper until BOP support says it is fixed",
          clearedAt: "2026-11-07T01:08:00.000Z",
        },
      ],
      outbound: { email: true, webhooks: 0, heartbeat: false },
      lastSuccessfulBackupAt: null,
      plannedUpdate: null,
      checksIncompleteSince: null,
      support: null,
    } as const;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NeedsAttention
          state={quiet}
          system={{ kind: "Ready", value: board }}
          timeZone="America/Toronto"
          dayStartsAt="2026-11-06T08:00:00.000Z"
        />
      </MemoryRouter>,
    );
    expect(html).not.toContain("Nothing needs attention right now.");
    expect(html).toContain(
      "Order rules check passes again: stay on paper until BOP support says it is fixed",
    );
    expect(html).toContain("do not resume ordering yet");
    expect(html).toContain("when today&#x27;s business day ends");
    expect(html).toContain("Check passed Nov 6, 2026, 8:08 PM");
    expect(html).toContain("Wait for BOP support");
    // The next business day it is gone, and Home is quiet again.
    const nextDay = renderToStaticMarkup(
      <MemoryRouter>
        <NeedsAttention
          state={quiet}
          system={{ kind: "Ready", value: board }}
          timeZone="America/Toronto"
          dayStartsAt="2026-11-07T08:00:00.000Z"
        />
      </MemoryRouter>,
    );
    expect(nextDay).toContain("Nothing needs attention right now.");
    expect(nextDay).not.toContain("passes again");
  });
  it("gives each row its state in words and one link to the page that settles it", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NeedsAttention state={state} />
      </MemoryRouter>,
    );
    expect(html).toContain(
      '<span class="overview-attention__state overview-attention__state--danger">Overdue</span>',
    );
    expect(html).toContain(
      '<a class="overview-attention__action" href="/operations/orders" data-discover="true">View orders</a>',
    );
  });
});
