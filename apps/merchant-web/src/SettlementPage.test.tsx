import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SettlementReport, formatSettlementMoney } from "./SettlementPage.js";
import { parseSettlementView } from "./settlement-client.js";
import { settlementViewFixture } from "./settlement.fixtures.js";

describe("WP-2423 P1 settlement report", () => {
  it("formats minor amounts without floating point", () => {
    expect(formatSettlementMoney("123450")).toBe("$1,234.50");
    expect(formatSettlementMoney("5")).toBe("$0.05");
    expect(formatSettlementMoney("0")).toBe("$0.00");
    expect(formatSettlementMoney("-1130")).toBe("-$11.30");
  });
  it("shows the day, totals, the run result and each difference in Store time", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <SettlementReport view={parseSettlementView(settlementViewFixture())} />
      </MemoryRouter>,
    );
    expect(html).toContain("Business day 2026-09-21");
    expect(html).toContain(">Closed<");
    expect(html).toContain("2026-09-21 04:00");
    expect(html).toContain("$1,234.50");
    expect(html).toContain("14 payments");
    expect(html).toContain("$11.30");
    expect(html).toContain("$1,223.20");
    expect(html).toContain("1 difference · 0 unresolved · 0 unavailable · 13 matched");
    expect(html).toContain("Last run 2026-09-22 04:06 · daily settlement");
    expect(html).toContain("Difference · Refund differs");
    expect(html).toContain("SETTLE-2026-09-21-01");
    expect(html).toContain('href="/operations/order-exceptions"');
    expect(html).not.toContain("018f7700");
  });
  it("explains an open day, a day without a run and unreadable sources", () => {
    const open = renderToStaticMarkup(
      <MemoryRouter>
        <SettlementReport
          view={parseSettlementView({
            ...settlementViewFixture(),
            window: { ...settlementViewFixture().window, status: "Open" },
            refunded: null,
            reconciliation: { runs: [], differences: [] },
          })}
        />
      </MemoryRouter>,
    );
    expect(open).toContain("Still open");
    expect(open).toContain("Totals grow until the business day closes");
    expect(open).toContain("Refund source unavailable");
    expect(open).toContain("after the business day closes");
    expect(open).toContain(">—<");
    const closed = renderToStaticMarkup(
      <MemoryRouter>
        <SettlementReport
          view={parseSettlementView({
            ...settlementViewFixture(),
            reconciliation: null,
          })}
        />
      </MemoryRouter>,
    );
    expect(closed).toContain("Reconciliation records could not be read.");
  });
});
