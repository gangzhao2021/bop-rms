import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StoreBusinessDayContext } from "./StoreBusinessDay.js";
import {
  SettlementNotCovered,
  SettlementPage,
  SettlementReport,
  formatSettlementMoney,
  summarizeOutcomes,
} from "./SettlementPage.js";
import { parseSettlementView } from "./settlement-client.js";
import {
  emptySettlementReconciliationFixture,
  openSettlementReconciliationFixture,
  settlementViewFixture,
} from "./settlement.fixtures.js";

const render = (view: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SettlementReport view={parseSettlementView(view)} />
    </MemoryRouter>,
  );

describe("WP-2423 P1 settlement report", () => {
  it("formats minor amounts without floating point", () => {
    expect(formatSettlementMoney("123450")).toBe("$1,234.50");
    expect(formatSettlementMoney("5")).toBe("$0.05");
    expect(formatSettlementMoney("0")).toBe("$0.00");
    expect(formatSettlementMoney("-1130")).toBe("−$11.30");
  });
  it("summarises outcomes with matched first and zeros left out", () => {
    expect(
      summarizeOutcomes({ Matched: 12, Healed: 0, Unresolved: 1, Unavailable: 0, Difference: 2 }),
    ).toBe("12 matched · 1 unresolved · 2 differences");
    expect(
      summarizeOutcomes({ Matched: 0, Healed: 1, Unresolved: 0, Unavailable: 3, Difference: 1 }),
    ).toBe("0 matched · 1 healed · 1 difference · 3 provider unavailable");
  });
  it("shows the day, totals, the settlement statement and each payment needing attention in Store time", () => {
    const html = render(settlementViewFixture());
    expect(html).toContain("Business day: Mon, Sep 21");
    expect(html).toContain(">Closed<");
    expect(html).toContain("Sep 21, 2026, 4:00 AM");
    expect(html).toContain("$1,234.50");
    expect(html).toContain("14 payments");
    expect(html).toContain("$11.30");
    expect(html).toContain("$1,223.20");
    expect(html).toContain("Settled · the day&#x27;s totals match the provider statement");
    expect(html).toContain("Settlement run Sep 22, 2026, 8:00 AM");
    // WP-2423: plain words for the statement, never the internal statement reference.
    expect(html).toContain("Provider statement for Mon, Sep 21");
    expect(html).not.toContain("SETTLE-2026-09-21-01");
    expect(html).toContain("$1,234.50 / $1,234.50");
    expect(html).toContain("14 payments checked in 240 runs · last Sep 22, 2026, 3:58 AM");
    expect(html).toContain("12 matched · 1 unresolved · 1 difference");
    expect(html).toContain("Payments needing attention");
    expect(html).toContain("Difference · Refund differs");
    expect(html).toContain("Unresolved · Awaiting customer action");
    expect(html).toContain('href="/operations/order-exceptions"');
    expect(html).not.toContain("Showing the latest");
    expect(html).not.toContain("018f7700");
  });
  it("names a statement difference and a truncated list", () => {
    const view = settlementViewFixture();
    Object.assign(view.reconciliation.settlement.checks[0] ?? {}, {
      outcome: "Difference",
      differenceReason: "RefundMismatch",
      providerRefundedMinor: "2260",
    });
    view.reconciliation.differenceCount = 350;
    view.reconciliation.operational.outcomes = {
      Matched: 12,
      Healed: 0,
      Unresolved: 349,
      Unavailable: 0,
      Difference: 1,
    };
    view.reconciliation.operational.paymentCount = 362;
    const html = render(view);
    expect(html).toContain(
      "Settlement difference · the day&#x27;s totals differ from the provider statement",
    );
    expect(html).toContain("$11.30 / $22.60");
    expect(html).toContain("Showing the latest 2 of 350 payments.");
    // WP-2423: an open day difference says what it is and what staff can do (no dead end).
    expect(html).toContain("Refunds for this day differ");
    expect(html).toContain(
      "The store&#x27;s records show $11.30 in refunds; the payment provider&#x27;s statement shows $22.60 ($11.30 more at the payment provider).",
    );
    expect(html).toContain("This day is checked again automatically when new records arrive.");
    expect(html).toContain("tell the pilot operator");
  });
  it("WP-2423: shows a day re-checked after an unmatched charge was refunded as resolved", () => {
    const view = settlementViewFixture();
    const settlement = view.reconciliation.settlement;
    const first = settlement.checks[0];
    if (!first) throw Error("fixture");
    Object.assign(first, {
      outcome: "Difference",
      differenceReason: "RefundMismatch",
      internalRefundedMinor: "1130",
      providerRefundedMinor: "3390",
      exceptionReference: "018f7700-0000-7000-8000-0000000000a1",
    });
    const recheckRun = "018f7700-0000-7000-8000-0000000000a2";
    Object.assign(settlement, {
      recheck: {
        run: {
          ...settlement.run,
          runReference: recheckRun,
          scheduledAt: "2026-10-15T16:00:00.000Z",
          cutoffAt: "2026-10-15T16:00:00.000Z",
          completedAt: "2026-10-15T16:00:01.000Z",
        },
        check: {
          ...first,
          checkReference: "018f7700-0000-7000-8000-0000000000a3",
          runReference: recheckRun,
          checkedAt: "2026-10-15T16:00:00.500Z",
          outcome: "Matched",
          differenceReason: null,
          internalRefundedMinor: "3390",
          providerRefundedMinor: "3390",
          exceptionReference: null,
          settlementReference: "simset_20261009_" + "d".repeat(64),
        },
        count: 1,
      },
    });
    const html = render({
      ...view,
      unmatchedProviderCharges: {
        captured: { count: 0, amountMinor: "0", currencyCode: "CAD" },
        refunded: { count: 1, amountMinor: "2260", currencyCode: "CAD" },
      },
    });
    expect(html).toContain("Settled · the day&#x27;s totals match the provider statement");
    expect(html).toContain("First check of Mon, Sep 21");
    expect(html).toContain("Checked again");
    expect(html).toContain("Difference · Refund differs");
    expect(html).toContain("$33.90 / $33.90");
    expect(html).toContain("so that difference is resolved");
    expect(html).not.toContain("Refunds for this day differ");
    expect(html).toContain("Charges that match no order");
    expect(html).toContain("Refund of an unmatched provider charge: 1 refund · $22.60");
    expect(html).not.toContain("simset_");
  });
  it("explains an open day, a day not yet settled, an empty day and unreadable sources", () => {
    const base = settlementViewFixture();
    const open = render({
      ...base,
      window: { ...base.window, status: "Open" },
      refunded: null,
      reconciliation: openSettlementReconciliationFixture(),
    });
    expect(open).toContain("Still open");
    expect(open).toContain("Totals grow until the business day closes");
    expect(open).toContain("Refund source unavailable");
    expect(open).toContain("after the business day closes");
    expect(open).toContain("14 payments checked in 240 runs");
    expect(open).toContain(">—<");
    expect(open).not.toContain("Not settled yet");
    const pending = render({ ...base, reconciliation: openSettlementReconciliationFixture() });
    expect(pending).toContain(
      "Not settled yet. The settlement run for this day has not completed.",
    );
    const empty = render({ ...base, reconciliation: emptySettlementReconciliationFixture() });
    expect(empty).toContain("No payment checks in this day yet.");
    expect(empty).not.toContain("Payments needing attention");
    const unreadable = render({ ...base, reconciliation: null });
    expect(unreadable).toContain("Reconciliation records could not be read.");
  });
  it("refuses a view whose counts disagree", () => {
    const view = settlementViewFixture();
    view.reconciliation.differenceCount = 1;
    expect(() => parseSettlementView(view)).toThrow("Unavailable");
    const foreign = settlementViewFixture();
    const statement = foreign.reconciliation.settlement.checks[0];
    if (statement)
      statement.runReference = foreign.reconciliation.operational.latestRun.runReference;
    expect(() => parseSettlementView(foreign)).toThrow("Unavailable");
  });
});

describe("WP-2423 Q19 self-approved refunds at day close", () => {
  it("shows the count and amount the owner approved alone, nothing when none, and an unread source", () => {
    const withSelf = {
      ...settlementViewFixture(),
      selfApprovedRefunds: { count: 2, amountMinor: "23200", currencyCode: "CAD" },
    };
    const html = render(withSelf);
    expect(html).toContain("Refunds the owner approved alone");
    expect(html).toContain("2 refunds · $232.00 approved by the owner without a second person");
    expect(render(settlementViewFixture())).not.toContain("approved alone");
    expect(render({ ...settlementViewFixture(), selfApprovedRefunds: null })).toContain(
      "Refunds approved by the owner alone could not be read.",
    );
  });
});

describe("WP-2423 Q19 current day beside a closed day", () => {
  it("notes today's self-approved refunds so far with a way to open today", () => {
    const html = render({
      ...settlementViewFixture(),
      currentDaySelfApprovedRefunds: {
        businessDate: "2026-09-22",
        count: 1,
        amountMinor: "11600",
        currencyCode: "CAD",
      },
    });
    expect(html).toContain(
      "Today so far (Tue, Sep 22): 1 refund · $116.00 approved by the owner alone.",
    );
    expect(
      render({
        ...settlementViewFixture(),
        currentDaySelfApprovedRefunds: {
          businessDate: "2026-09-22",
          count: 0,
          amountMinor: "0",
          currencyCode: "CAD",
        },
      }),
    ).not.toContain("Today so far");
  });
});

describe("WP-2423 Q21: the latest day staff can ask for is the Store's business day", () => {
  it("caps the day picker at the Store's current business day, not the calendar date", () => {
    // 01:30 on Oct 15 in Toronto is still the Oct 14 business day (it starts at 04:00).
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <StoreBusinessDayContext.Provider
          value={{
            businessDate: "2026-10-14",
            startsAt: "2026-10-14T08:00:00.000Z",
            endsAt: "2026-10-15T08:00:00.000Z",
          }}
        >
          <SettlementPage storeLabel="Synthetic Store" timeZone="America/Toronto" />
        </StoreBusinessDayContext.Provider>
      </MemoryRouter>,
    );
    expect(markup).toContain('max="2026-10-14"');
  });
});

describe("WP-2423 settlement history and coverage", () => {
  it("keeps a second settlement check of the day in the history without changing its result (v15 Sep 20)", () => {
    const view = settlementViewFixture();
    const settlement = view.reconciliation.settlement;
    const first = settlement.checks[0];
    if (!first) throw Error("fixture");
    Object.assign(settlement, {
      additionalChecks: [
        {
          ...first,
          checkReference: "018f7700-0000-7000-8000-0000000000c2",
          runReference: "018f7700-0000-7000-8000-0000000000c1",
          checkedAt: new Date(Date.parse(first.checkedAt) - 60_000).toISOString(),
        },
      ],
    });
    const html = render(view);
    expect(html).toContain("Settled · the day&#x27;s totals match the provider statement");
    expect(html).toContain("Earlier check of Mon, Sep 21");
    expect(html).toContain("Provider statement for Mon, Sep 21");
    expect(html).toContain("checked more than once when it closed");
    expect(html).not.toContain("could not be read");
  });
  it("answers a day before the store's records begin with its first day", () => {
    const html = renderToStaticMarkup(
      <SettlementNotCovered requestedDate="2026-09-19" firstBusinessDate="2026-09-20" />,
    );
    expect(html).toContain("No settlement records for this day");
    expect(html).toContain("Sat, Sep 19 is before the store started using this system");
    expect(html).toContain("begin on Sun, Sep 20");
    expect(html).toContain("Show Sun, Sep 20");
    expect(html).not.toContain("Permission");
  });
});

describe("WP-2423: Exceptions open Settlement on a given day", () => {
  it("starts on the day named in the link", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={["/app/operations/payment-reconciliation?businessDate=2026-10-09"]}
      >
        <SettlementPage storeLabel="Synthetic Store" timeZone="America/Toronto" />
      </MemoryRouter>,
    );
    expect(markup).toContain('value="2026-10-09"');
    const plain = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/app/operations/payment-reconciliation?businessDate=soon"]}>
        <SettlementPage storeLabel="Synthetic Store" timeZone="America/Toronto" />
      </MemoryRouter>,
    );
    expect(plain).toContain('value=""');
  });
});
