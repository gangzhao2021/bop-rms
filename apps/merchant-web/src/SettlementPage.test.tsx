import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { SettlementReport, formatSettlementMoney, summarizeOutcomes } from "./SettlementPage.js";
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
    expect(formatSettlementMoney("-1130")).toBe("-$11.30");
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
    expect(html).toContain("Business day 2026-09-21");
    expect(html).toContain(">Closed<");
    expect(html).toContain("2026-09-21 04:00");
    expect(html).toContain("$1,234.50");
    expect(html).toContain("14 payments");
    expect(html).toContain("$11.30");
    expect(html).toContain("$1,223.20");
    expect(html).toContain("Settled · the day&#x27;s totals match the provider statement");
    expect(html).toContain("Settlement run 2026-09-22 08:00");
    expect(html).toContain("SETTLE-2026-09-21-01");
    expect(html).toContain("$1,234.50 / $1,234.50");
    expect(html).toContain("14 payments checked in 240 runs · last 2026-09-22 03:58");
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
    Object.assign(view.reconciliation.settlement.checks[0]!, {
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
    foreign.reconciliation.settlement.checks[0]!.runReference =
      foreign.reconciliation.operational.latestRun!.runReference;
    expect(() => parseSettlementView(foreign)).toThrow("Unavailable");
  });
});
