import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { inClosingWindow } from "./ClosingReminder.js";
import { parseTonightSummary } from "./store-reports-client.js";
import { tonightProblems, TonightSummaryView } from "./TonightSummary.js";
import { tonightSummaryFixture } from "./tonight-summary.fixtures.js";

const render = (value: Record<string, unknown>) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <TonightSummaryView summary={parseTonightSummary(value)} />
    </MemoryRouter>,
  );

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
      "Table cash that should be in the drawer",
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
  it("v15 finding a: never lists a paid table under not paid yet at $0.00", () => {
    const html = render(tonightSummaryFixture());
    const notPaid = html.slice(
      html.indexOf("Tables not paid yet"),
      html.indexOf("Paid, guests still seated"),
    );
    expect(notPaid).not.toContain("Table 3");
    expect(notPaid).not.toContain("$0.00");
  });
  it("shows the closing reminder in the last 8 hours of the business day only", () => {
    const endsAt = "2026-10-28T08:00:00.000Z";
    expect(inClosingWindow(endsAt, Date.parse("2026-10-28T00:30:00.000Z"))).toBe(true);
    expect(inClosingWindow(endsAt, Date.parse("2026-10-27T23:00:00.000Z"))).toBe(false);
    expect(inClosingWindow(endsAt, Date.parse("2026-10-28T08:00:00.000Z"))).toBe(false);
    expect(inClosingWindow(null, Date.now())).toBe(false);
  });
});
