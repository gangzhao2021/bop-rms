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
  OverviewToday,
  StoreOverview,
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
} from "./paid-round-wait.js";

describe("WP-2423 P2 store overview", () => {
  it("counts open and awaiting orders from the current queue", () => {
    const queue = parseCurrentOrderQueue(currentOrderQueueFixture(), null);
    expect(summarizeOrders(queue)).toEqual({
      open: 3,
      awaitingAcceptance: 1,
      awaitingRounds: 1,
      urgentRounds: 0,
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
    expect(
      awaitingAcceptanceText({
        orders: summary.awaitingAcceptance,
        rounds: summary.awaitingRounds,
        urgentRounds: summary.urgentRounds,
      }),
    ).toBe("2 rounds awaiting acceptance in 1 order (1 paid 10+ min ago)");
    expect(awaitingAcceptanceText({ orders: 2, rounds: 2, urgentRounds: 0 })).toBe(
      "2 awaiting acceptance",
    );
    // A paid round said on a pickup, or on a round that cannot be accepted, is refused.
    expect(() =>
      parseCurrentOrderQueue(
        {
          ...fixture,
          items: [{ ...table, orderType: "Pickup" as const }, ready],
        },
        null,
      ),
    ).toThrow();
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
                awaitingRounds: 4,
                urgentRounds: 0,
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
                awaitingRounds: 1,
                urgentRounds: 0,
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
        <OverviewToday
          timeZone="America/Toronto"
          onRefresh={() => undefined}
          state={{
            orders: { kind: "Unavailable" },
            pickups: { kind: "Unavailable" },
            exceptions: { kind: "Ready", value: { open: 15, overdue: 15 } },
            tables: { kind: "Hidden" },
            updatedAt: "2026-08-12T16:30:00.000Z",
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("15 overdue");
    expect(html).not.toContain("overdues");
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
                awaitingRounds: 0,
                urgentRounds: 0,
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
    const ordersOnly = render({
      ...initialOverviewState,
      pickups: hidden,
      exceptions: hidden,
      tables: hidden,
    });
    expect(ordersOnly).toContain("Open orders");
    expect(ordersOnly).not.toContain("Pickups waiting");
    expect(ordersOnly).not.toContain("Open exceptions");
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
  it("words a paid round's wait for staff: plain, then warning at 5 min, urgent at 10", () => {
    const paidAt = "2026-10-16T14:50:00.000Z";
    const at = (minute: number) => Date.parse(paidAt) + minute * 60_000;
    expect(paidRoundWaitText(paidAt, at(2))).toBe("Paid · the kitchen gets it once you accept it");
    expect(paidRoundWaitText(paidAt, at(6))).toBe(
      "Paid 6 min ago · the guest is waiting. Accept it to send it to the kitchen",
    );
    expect(paidRoundWaitText(paidAt, at(12))).toMatch(
      /^Paid 12 min ago and still not accepted · accept it now\. It is never cancelled or refunded automatically/u,
    );
    expect(tableRoundWaitText(2, paidAt, at(0))).toBe(
      "Round 2 paid just now · accept it on the Orders page to send it to the kitchen",
    );
    expect(tableRoundWaitText(2, paidAt, at(11))).toBe(
      "Round 2 paid 11 min ago and still not accepted · accept it on the Orders page now",
    );
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
    expect(html(true)).toContain("1 table served — close when the guests have left");
    expect(html(true)).toContain('href="/operations/dining"');
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
    expect(html).toContain("Pickups from earlier days");
    expect(html).toContain("Check and close");
    expect(html).toContain('<strong class="overview-count__value">1</strong>');
    expect(html).toContain('<strong class="overview-count__value">2</strong>');
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
          awaitingRounds: 0,
          urgentRounds: 0,
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
