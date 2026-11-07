import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { closingReminderPhase, inClosingWindow } from "./ClosingReminder.js";
import { parseTonightSummary } from "./store-reports-client.js";
import { tonightProblems, TonightSummaryView } from "./TonightSummary.js";
import { tonightSummaryFixture } from "./tonight-summary.fixtures.js";

const render = (value: Record<string, unknown>) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <TonightSummaryView summary={parseTonightSummary(value)} />
    </MemoryRouter>,
  );

describe("DEC-PAID-ORDER-AUTO-ACCEPT: decisions nobody senior was asked about, named tonight", () => {
  const events = [
    {
      kind: "CantMake",
      orderNumber: "21",
      staffName: "Mei",
      reasonCode: "SOLD_OUT",
      at: "2026-10-28T00:10:00.000Z",
    },
    {
      kind: "AutomaticRefund",
      orderNumber: "22",
      staffName: null,
      reasonCode: "STORE_ERROR",
      at: "2026-10-28T00:20:00.000Z",
    },
    {
      kind: "KeptByHand",
      orderNumber: "23",
      staffName: null,
      reasonCode: null,
      at: "2026-10-28T00:30:00.000Z",
    },
    {
      kind: "RoundMadeByHand",
      orderNumber: "24",
      roundSequence: 2,
      staffName: "Mei",
      reasonCode: null,
      at: "2026-10-28T00:40:00.000Z",
    },
  ];
  it("lists each in staff words, with who and why, never a code", () => {
    const html = render({ ...tonightSummaryFixture(), paidOrderEvents: events });
    expect(html).toContain("Order 21 · Can&#x27;t make it · refunded");
    expect(html).toContain("Mei · Sold out");
    expect(html).toContain("Order 22 · refunded automatically · the kitchen never started it");
    expect(html).toContain("Order 23 · made by hand · not refunded automatically");
    // A table round is never refunded automatically: its line says which round, and no refund.
    expect(html).toContain("Order 24 · round 2 · made by hand");
    expect(html).not.toMatch(/Order 24[^<]*refund/u);
    expect(html).not.toContain("RoundMadeByHand");
    expect(html).not.toContain("SOLD_OUT");
    expect(html).not.toContain("STORE_ERROR");
    expect(html).not.toContain("KeptByHand");
  });
  it("WP-2423 live minor 13: an earlier day's order is named with its date, today's without", () => {
    const html = render({
      ...tonightSummaryFixture(),
      paidOrderEvents: [
        { ...events[3], orderNumber: "16", orderBusinessDate: "2026-10-26" },
        { ...events[2], orderNumber: "17", orderBusinessDate: "2026-10-27" },
      ],
    });
    // The summary is for 2026-10-27; order 16 belongs to the table opened the evening before.
    expect(html).toContain("Order 10/26 · 16 · round 2 · made by hand");
    expect(html).toContain("Order 17 · made by hand · not refunded automatically");
    setLanguageForTest("zh-Hans");
    try {
      expect(
        render({
          ...tonightSummaryFixture(),
          paidOrderEvents: [{ ...events[3], orderNumber: "16", orderBusinessDate: "2026-10-26" }],
        }),
      ).toContain("10/26 · 16");
    } finally {
      setLanguageForTest("en");
    }
    // A wrong day is refused; an older server without it still reads.
    expect(() =>
      parseTonightSummary({
        ...tonightSummaryFixture(),
        paidOrderEvents: [{ ...events[0], orderBusinessDate: "yesterday" }],
      }),
    ).toThrow();
    expect(
      parseTonightSummary({ ...tonightSummaryFixture(), paidOrderEvents: [events[0]] })
        .paidOrderEvents[0]?.orderBusinessDate,
    ).toBeNull();
  });
  it("a Store without any sees nothing new, and a wrong entry is refused", () => {
    expect(parseTonightSummary(tonightSummaryFixture()).paidOrderEvents).toEqual([]);
    expect(render(tonightSummaryFixture())).not.toContain(
      "Paid orders sent straight to the kitchen",
    );
    expect(() =>
      parseTonightSummary({
        ...tonightSummaryFixture(),
        paidOrderEvents: [{ ...events[0], kind: "Deleted" }],
      }),
    ).toThrow();
    // Only a table round names its round, and always does.
    for (const wrong of [
      { ...events[0], roundSequence: 1 },
      { ...events[3], roundSequence: undefined },
      { ...events[3], roundSequence: 0 },
    ])
      expect(() =>
        parseTonightSummary({ ...tonightSummaryFixture(), paidOrderEvents: [wrong] }),
      ).toThrow();
  });
});

describe("WP-2423 item 8 ② tonight's closing summary", () => {
  it("Owner addition (a): the sample's figures add up and the real parser accepts it", () => {
    const summary = parseTonightSummary(tonightSummaryFixture());
    expect(tonightProblems(summary)).toEqual([]);
    const s = summary.report.summary;
    // The evening the Figma sample (page 47-2) shows, worked through.
    expect([s.grossSalesMinor, s.compsMinor, s.netSalesMinor, s.taxMinor]).toEqual([
      "41250",
      "1825",
      "39425",
      "5125",
    ]);
    expect([s.tipsMinor, s.cashRoundingMinor, s.collectedMinor]).toEqual(["5750", "5", "50305"]);
    expect([s.refundsMinor, s.netCollectedMinor]).toEqual(["1200", "49105"]);
    expect(summary.openTablesOwedMinor).toBe("8640");
  });
  it("catches figures that don't add up", () => {
    const broken = tonightSummaryFixture();
    const report = broken.report as { summary: Record<string, unknown> };
    report.summary.collectedMinor = "51645";
    expect(tonightProblems(parseTonightSummary(broken))).toContain("collected");
    const tables = tonightSummaryFixture();
    tables.openTablesOwedMinor = "9000";
    // The parser itself refuses an open-tables total that isn't the tables added up.
    expect(() => parseTonightSummary(tables)).toThrow();
  });
  it("shows sales, takings with the card-machine batch check and the drawer note, open tables and cancellations", () => {
    const html = render(tonightSummaryFixture());
    for (const text of [
      "Gross sales",
      "$412.50",
      "Comps and discounts by a manager",
      "−$18.25",
      "$394.25",
      "Tax · HST",
      "$51.25",
      // Taken by method, cash in detail.
      "$191.60",
      "$219.50",
      "$91.95",
      "Table cash this system recorded (not the whole cash drawer)",
      "$86.95",
      "$503.05",
      "$491.05",
      // (b) the card machine's batch should match what it took, refunds off.
      "The batch total should be $219.50",
      // (c) the drawer also holds the merchant's own register cash.
      "The cash drawer also holds cash taken on your own register.",
      // Open tables and the write-off.
      "Table 12",
      "$52.10",
      // Only the tables that still owe are counted under "not paid yet" (v15 finding a).
      "2 tables · $86.40 to take before closing",
      "Paid, guests still seated",
      "Table 3",
      "Guests left without paying (written off)",
      "$23.04",
      // Listed, not sales.
      "Dishes taken off a bill before payment",
      "$18.80",
      "Rounds and orders cancelled unpaid",
    ])
      expect(html, text).toContain(text);
  });
  it("v15 2026-10-30: says it matches the day-end settlement only when every payment is in sales", () => {
    expect(render(tonightSummaryFixture())).toContain("Matches the day-end settlement");
    const short = tonightSummaryFixture();
    const report = short.report as {
      summary: Record<string, unknown>;
      reconciliation: Record<string, unknown>;
    };
    // A payment not counted in sales and tax (the sales are short by it).
    report.summary.unmatchedMinor = "4606";
    report.summary.netSalesMinor = String(BigInt(String(report.summary.netSalesMinor)) - 4606n);
    report.summary.grossSalesMinor = String(BigInt(String(report.summary.grossSalesMinor)) - 4606n);
    const html = render(short);
    expect(html).toContain("Paid but not matched to items");
    expect(html).toContain("$46.06");
    expect(html).toContain("Doesn&#x27;t match the day-end settlement");
    expect(html).not.toContain("Matches the day-end settlement");
    const money = tonightSummaryFixture();
    (money.report as { reconciliation: Record<string, unknown> }).reconciliation.matchesSettlement =
      false;
    expect(render(money)).toContain("are not counted in these figures yet");
  });
  it("v15 finding a: never lists a paid table under not paid yet at $0.00", () => {
    const html = render(tonightSummaryFixture());
    const notPaid = html.slice(
      html.indexOf("Tables not paid yet"),
      html.indexOf("Paid, guests still seated"),
    );
    expect(notPaid).not.toContain("Table 3");
    expect(notPaid).not.toContain("$0.00");
  });
  it("times the closing reminder by the Store's published closing", () => {
    const endsAt = "2026-10-28T08:00:00.000Z"; // 04:00 the next morning, Toronto.
    const at = (instant: string) => Date.parse(instant);
    // Lunch-only, closing 14:30 Toronto (18:30Z): an hour before and after, then only unpaid tables.
    const lunch = { endsAt, closesAt: "2026-10-27T18:30:00.000Z", closedToday: false };
    expect(closingReminderPhase(lunch, at("2026-10-27T17:29:00.000Z"))).toBe("Hidden");
    expect(closingReminderPhase(lunch, at("2026-10-27T17:30:00.000Z"))).toBe("BeforeClosing");
    expect(closingReminderPhase(lunch, at("2026-10-27T18:30:00.000Z"))).toBe("AfterClosing");
    expect(closingReminderPhase(lunch, at("2026-10-27T19:30:00.000Z"))).toBe("UnpaidTablesOnly");
    expect(closingReminderPhase(lunch, at("2026-10-28T00:30:00.000Z"))).toBe("UnpaidTablesOnly");
    // Overnight, closing 01:30 Toronto: not at 20:00, as the old rule would have been.
    const overnight = { endsAt, closesAt: "2026-10-28T05:30:00.000Z", closedToday: false };
    expect(closingReminderPhase(overnight, at("2026-10-28T00:30:00.000Z"))).toBe("Hidden");
    expect(closingReminderPhase(overnight, at("2026-10-28T05:00:00.000Z"))).toBe("BeforeClosing");
    expect(closingReminderPhase(overnight, at("2026-10-28T06:00:00.000Z"))).toBe("AfterClosing");
    // Closed today: only an unpaid table is worth saying.
    const closed = { endsAt, closesAt: null, closedToday: true };
    expect(closingReminderPhase(closed, at("2026-10-27T18:00:00.000Z"))).toBe("UnpaidTablesOnly");
    // Hours unreadable or not published: the last 8 hours of the day, not silence.
    const unknown = { endsAt, closesAt: null, closedToday: false };
    expect(closingReminderPhase(unknown, at("2026-10-28T00:30:00.000Z"))).toBe("BeforeClosing");
    expect(closingReminderPhase(unknown, at("2026-10-27T23:00:00.000Z"))).toBe("Hidden");
    expect(closingReminderPhase({ endsAt }, at("2026-10-28T00:30:00.000Z"))).toBe("BeforeClosing");
    expect(closingReminderPhase(null, at("2026-10-28T00:30:00.000Z"))).toBe("Hidden");
  });
  it("shows the fallback closing reminder in the last 8 hours of the business day only", () => {
    const endsAt = "2026-10-28T08:00:00.000Z";
    expect(inClosingWindow(endsAt, Date.parse("2026-10-28T00:30:00.000Z"))).toBe(true);
    expect(inClosingWindow(endsAt, Date.parse("2026-10-27T23:00:00.000Z"))).toBe(false);
    expect(inClosingWindow(endsAt, Date.parse("2026-10-28T08:00:00.000Z"))).toBe(false);
    expect(inClosingWindow(null, Date.now())).toBe(false);
  });
});
