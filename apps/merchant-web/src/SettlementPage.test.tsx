import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StoreBusinessDayContext } from "./StoreBusinessDay.js";
import {
  SettlementNotCovered,
  SettlementPage,
  SettlementReport,
  closedDayStillOpenText,
  formatSettlementMoney,
  previousBusinessDate,
  summarizeOutcomes,
} from "./SettlementPage.js";
import { parseSettlementView } from "./settlement-client.js";
import { setLanguageForTest } from "./i18n/i18n.js";
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
    // WP-2423 (3cd0f8dd L2): a $0.00 payment a guest started but did not finish is explained in
    // plain words, not listed as a payment needing attention.
    expect(html).not.toContain("Unresolved · Awaiting customer action");
    expect(html).toContain(
      "1 online payment was started by a guest but not finished (the guest left or is still paying). Nothing was charged, so there is nothing to do.",
    );
    expect(html).toContain('href="/operations/order-exceptions"');
    expect(html).not.toContain("Showing the latest");
    expect(html).not.toContain("018f7700");
  });
  it("WP-2423 (3cd0f8dd L2): keeps an unfinished payment with money at either side in the attention list", () => {
    const view = settlementViewFixture();
    const unfinished = view.reconciliation.differences[1];
    Object.assign(unfinished ?? {}, { providerCapturedMinor: "1130" });
    const html = render(view);
    expect(html).toContain("Unresolved · Awaiting customer action");
    expect(html).not.toContain("started by a guest but not finished");
    Object.assign(unfinished ?? {}, { providerCapturedMinor: "0" });
    view.reconciliation.differences.splice(0, 1);
    const only = render(view);
    expect(only).not.toContain("Payments needing attention");
    expect(only).toContain("1 online payment was started by a guest but not finished");
  });
  it("DEC-DINE-IN-PAY-LATER: keeps tables written off unpaid in the day's summary", () => {
    const html = render({
      ...settlementViewFixture(),
      unpaidWriteOffs: {
        count: 1,
        amountMinor: "537",
        currencyCode: "CAD",
        recordedBy: [{ name: "Mia", count: 1, amountMinor: "537" }],
      },
    });
    expect(html).toContain("Guests left without paying (written off)");
    expect(html).toContain("Recorded by Mia: 1 table, $5.37");
    expect(html).toContain("$5.37");
    expect(html).toContain("1 table");
    expect(
      render({
        ...settlementViewFixture(),
        unpaidWriteOffs: { count: 0, amountMinor: "0", currencyCode: "CAD", recordedBy: [] },
      }),
    ).not.toContain("written off");
  });

  it("WP-2423 M163: money taken back is split by method and in Net cash and Card machine net, to the cent", () => {
    const amount = (count: number, amountMinor: string) => ({
      count,
      amountMinor,
      currencyCode: "CAD",
    });
    const html = render({
      ...settlementViewFixture(),
      cardMachine: {
        taken: amount(1, "900"),
        tipMinor: "100",
        recordedAfterOutageCount: 0,
        refunded: amount(0, "0"),
        takenBack: amount(1, "125"),
      },
      cash: {
        received: amount(1, "1045"),
        tipMinor: "0",
        roundingMinor: "0",
        refunded: amount(1, "200"),
        takenBack: amount(1, "500"),
        // Received less refunded plus taken back: what the drawer holds from tables.
        netMinor: "1345",
        recordedAfterOutageCount: 0,
      },
      moneyTakenBack: {
        ...amount(2, "625"),
        recordedBy: [{ name: "Sam", count: 2, amountMinor: "625" }],
        byMethod: { cash: amount(1, "500"), cardMachine: amount(1, "125") },
      },
    });
    expect(html).toContain("Charged back on card machine");
    expect(html).toContain("Cash taken back");
    // The machine's batch: $9.00 taken, nothing refunded, $1.25 charged back.
    expect(html).toContain("$10.25");
    expect(html).toContain("$13.45");
    expect(html).toContain("In cash $5.00 · charged on the card machine $1.25");
    expect(html).toContain(
      "the cash is in Net cash and the card-machine charge in Card machine net",
    );
    expect(html).not.toContain("net refunds are refunds less this");
    // A split that does not add up to the total is refused.
    expect(() =>
      parseSettlementView({
        ...settlementViewFixture(),
        moneyTakenBack: {
          ...amount(2, "625"),
          recordedBy: [],
          byMethod: { cash: amount(1, "500"), cardMachine: amount(1, "100") },
        },
      }),
    ).toThrow();
  });

  it("WP-2423 item 8 ① segment 2: lists the day's comps and discounts on their own line", () => {
    const html = render({
      ...settlementViewFixture(),
      comps: { count: 2, amountMinor: "2830", currencyCode: "CAD" },
    });
    expect(html).toContain("Comps and discounts by a manager");
    expect(html).toContain("$28.30");
    expect(html).toContain("2 dishes");
    expect(
      render({
        ...settlementViewFixture(),
        comps: { count: 0, amountMinor: "0", currencyCode: "CAD" },
      }),
    ).not.toContain("Comps and discounts by a manager");
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
    expect(html).toContain("tell BOP support");
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
  // WP-2423 (settlement-coverage): a closed day the check has not run for is said plainly, on the
  // server's word; BOP is named as told only when the alert really reached it.
  it("a closed day not compared 6 h on says so, and names BOP as told only when it was", () => {
    const base = settlementViewFixture();
    const pending = openSettlementReconciliationFixture();
    const notRun = (supportAlerted: boolean) =>
      render({
        ...base,
        reconciliation: pending,
        dayEndCheck: { state: "NotRun", closedForMs: 13 * 3600_000, supportAlerted },
      });
    const told = notRun(true);
    expect(told).toContain('data-reconciled="not-run"');
    expect(told).toContain(
      "Not compared with the payment provider yet. This business day closed 13 hours ago and its day-end check has not run. BOP support has been told; the figures above are not affected.",
    );
    const untold = notRun(false);
    expect(untold).toContain(
      "This business day closed 13 hours ago and its day-end check has not run. It runs by itself once it is fixed; the figures above are not affected.",
    );
    expect(untold).not.toContain("has been told");
    const waiting = render({
      ...base,
      reconciliation: pending,
      dayEndCheck: { state: "Waiting", closedForMs: 3600_000, supportAlerted: false },
    });
    expect(waiting).toContain(
      "Not settled yet. The settlement run for this day has not completed.",
    );
    expect(waiting).not.toContain("not-run");
    setLanguageForTest("zh-Hans");
    try {
      expect(notRun(true)).toContain(
        "还没有和支付方核对。这个营业日已结束 13 小时，日结核对还没有运行。已通知 BOP 技术支持；上面的数字不受影响。",
      );
    } finally {
      setLanguageForTest("en");
    }
    expect(() =>
      parseSettlementView({
        ...base,
        dayEndCheck: { state: "Waiting", closedForMs: 1, supportAlerted: true },
      }),
    ).toThrow("Unavailable");
  });
  // WP-2423 (settlement-coverage): a real Pilot Store's day before its day-end checks started is
  // never compared, so it never promises a check that will run.
  it("a closed day before the Store's day-end checks started says it is not compared", () => {
    const base = settlementViewFixture();
    const view = {
      ...base,
      reconciliation: openSettlementReconciliationFixture(),
      dayEndCheck: { state: "NotCovered", closedForMs: 13 * 3600_000, supportAlerted: false },
    };
    const html = render(view);
    expect(html).toContain('data-reconciled="not-covered"');
    expect(html).toContain(
      "Not compared with the payment provider. Day-end checks for this Store started after this business day, so this day is not compared; the figures above are not affected.",
    );
    expect(html).not.toContain("once it is fixed");
    expect(html).not.toContain("has not completed");
    setLanguageForTest("zh-Hans");
    try {
      expect(render(view)).toContain(
        "没有和支付方核对。本店的日结核对在这个营业日之后才开始，这一天不做核对；上面的数字不受影响。",
      );
    } finally {
      setLanguageForTest("en");
    }
    expect(() =>
      parseSettlementView({
        ...base,
        dayEndCheck: { state: "NotCovered", closedForMs: 1, supportAlerted: true },
      }),
    ).toThrow("Unavailable");
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

describe("Owner 2026-11-03: the page opens on today and says what is left of the last closed day", () => {
  it("counts back one business day across a month end", () => {
    expect(previousBusinessDate("2026-10-01")).toBe("2026-09-30");
  });
  it("opens on the Store's current business day, with yesterday one tap away", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <StoreBusinessDayContext.Provider
          value={{ businessDate: "2026-09-22", startsAt: null, endsAt: null }}
        >
          <SettlementPage storeLabel="Synthetic Store" timeZone="America/Toronto" />
        </StoreBusinessDayContext.Provider>
      </MemoryRouter>,
    );
    expect(markup).toContain('value="2026-09-22"');
    expect(markup).toContain('aria-pressed="true">Today · Tue, Sep 22');
    expect(markup).toContain('aria-pressed="false">Yesterday · Mon, Sep 21');
  });
  const said = (view: unknown) => closedDayStillOpenText(parseSettlementView(view), "2026-09-22");
  it("is silent when the last closed day matches the provider and nothing is left to look at", () => {
    const view = settlementViewFixture();
    expect(
      said({
        ...view,
        reconciliation: {
          ...view.reconciliation,
          operational: {
            ...view.reconciliation.operational,
            outcomes: {
              Matched: view.reconciliation.operational.paymentCount,
              Healed: 0,
              Unresolved: 0,
              Unavailable: 0,
              Difference: 0,
            },
          },
          differences: [],
          differenceCount: 0,
        },
      }),
    ).toBeNull();
  });
  it("says plainly when the last closed day still needs closing, and why", () => {
    const view = settlementViewFixture();
    expect(said({ ...view, reconciliation: openSettlementReconciliationFixture() })).toBe(
      "Yesterday · Mon, Sep 21 still needs closing: not yet checked against the payment provider.",
    );
    expect(said({ ...view, reconciliation: null })).toBe(
      "Yesterday · Mon, Sep 21 still needs closing: its checks could not be read.",
    );
    expect(said(view)).toMatch(
      /^Yesterday · Mon, Sep 21 still needs closing: \d+ payments? to look/u,
    );
    const statement = view.reconciliation.settlement;
    const check = statement.checks[0];
    if (!check) throw Error("fixture");
    expect(
      said({
        ...view,
        reconciliation: {
          ...view.reconciliation,
          settlement: {
            ...statement,
            run: {
              ...statement.run,
              counts: { ...statement.run.counts, Matched: 0, Difference: 1 },
            },
            checks: [{ ...check, outcome: "Difference", differenceReason: "AmountMismatch" }],
          },
        },
      }),
    ).toBe(
      "Yesterday · Mon, Sep 21 still needs closing: its totals differ from the provider statement.",
    );
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
