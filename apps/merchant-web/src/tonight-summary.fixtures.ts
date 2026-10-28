/**
 * WP-2423 item 8 ② (Figma 47-2): the closing summary as the BFF returns it, for one evening of a
 * synthetic store (test-only values, 13% test-only tax, no customer data). Every total is derived
 * here from the per-payment-method figures, the way the server computes the report, so the sample
 * always adds up (Owner addition (a), 2026-10-28; checked by tonight-summary.test.ts). The Figma
 * sample on page 47-2 uses these numbers.
 */
interface Figures {
  readonly payments: number;
  readonly orders: number;
  readonly gross: number;
  readonly discounts?: number;
  readonly comps?: number;
  readonly compCount?: number;
  readonly tax: number;
  readonly tips: number;
  readonly rounding?: number;
  readonly refundCount?: number;
  readonly refundSales?: number;
  readonly refundTax?: number;
}
const money = (minor: number) => String(minor);
function summary(figures: Figures, extra: { writeOffs?: number; writeOffMinor?: number } = {}) {
  const discounts = figures.discounts ?? 0,
    comps = figures.comps ?? 0,
    rounding = figures.rounding ?? 0;
  const net = figures.gross - discounts - comps;
  const collected = net + figures.tax + figures.tips + rounding;
  const refunds = (figures.refundSales ?? 0) + (figures.refundTax ?? 0);
  return {
    paymentCount: figures.payments,
    orderCount: figures.orders,
    grossSalesMinor: money(figures.gross),
    discountsMinor: money(discounts),
    compCount: figures.compCount ?? 0,
    compsMinor: money(comps),
    netSalesMinor: money(net),
    serviceChargesMinor: "0",
    taxMinor: money(figures.tax),
    taxes: figures.tax === 0 ? [] : [{ label: "HST", amountMinor: money(figures.tax) }],
    tipsMinor: money(figures.tips),
    cashRoundingMinor: money(rounding),
    unpaidWriteOffCount: extra.writeOffs ?? 0,
    unpaidWriteOffMinor: money(extra.writeOffMinor ?? 0),
    unmatchedMinor: "0",
    unmatchedPaymentCount: 0,
    collectedMinor: money(collected),
    refundCount: figures.refundCount ?? 0,
    refundsMinor: money(refunds),
    refunds: {
      salesMinor: money(figures.refundSales ?? 0),
      taxMinor: money(figures.refundTax ?? 0),
      tipsMinor: "0",
      serviceChargesMinor: "0",
      notItemizedMinor: "0",
    },
    netSalesAfterRefundsMinor: money(net - (figures.refundSales ?? 0)),
    netCollectedMinor: money(collected - refunds),
  };
}
const add = (a: Figures, b: Figures): Figures => ({
  payments: a.payments + b.payments,
  orders: a.orders + b.orders,
  gross: a.gross + b.gross,
  discounts: (a.discounts ?? 0) + (b.discounts ?? 0),
  comps: (a.comps ?? 0) + (b.comps ?? 0),
  compCount: (a.compCount ?? 0) + (b.compCount ?? 0),
  tax: a.tax + b.tax,
  tips: a.tips + b.tips,
  rounding: (a.rounding ?? 0) + (b.rounding ?? 0),
  refundCount: (a.refundCount ?? 0) + (b.refundCount ?? 0),
  refundSales: (a.refundSales ?? 0) + (b.refundSales ?? 0),
  refundTax: (a.refundTax ?? 0) + (b.refundTax ?? 0),
});
/** The evening by payment method (the pickups paid online; the tables by card or cash). */
export const tonightFigures = {
  Online: {
    payments: 12,
    orders: 12,
    gross: 15000,
    tax: 1950,
    tips: 2210,
    refundCount: 1,
    refundSales: 620,
    refundTax: 80,
  },
  CardMachine: {
    payments: 8,
    orders: 8,
    gross: 18000,
    comps: 1000,
    compCount: 2,
    tax: 2210,
    tips: 2740,
  },
  Cash: {
    payments: 4,
    orders: 4,
    gross: 8250,
    comps: 825,
    compCount: 1,
    tax: 965,
    tips: 800,
    rounding: 5,
    refundCount: 1,
    refundSales: 442,
    refundTax: 58,
  },
} as const satisfies Record<"Online" | "CardMachine" | "Cash", Figures>;

export function tonightSummaryFixture(): Record<string, unknown> {
  const all = add(add(tonightFigures.Online, tonightFigures.CardMachine), tonightFigures.Cash);
  const tables = add(tonightFigures.CardMachine, tonightFigures.Cash);
  const writeOff = { writeOffs: 1, writeOffMinor: 2304 };
  const day = summary(all, writeOff);
  const openTables = [
    {
      tableLabel: "12",
      phase: "Closing",
      paymentTiming: "PayLater",
      owedMinor: "5210",
      openedMinutes: 48,
    },
    {
      tableLabel: "7",
      phase: "Active",
      paymentTiming: "PayLater",
      owedMinor: "3430",
      openedMinutes: 160,
    },
  ];
  const byChannel = (["Online", "CardMachine", "Cash"] as const).map((channel) => ({
    channel,
    ...summary(tonightFigures[channel]),
  }));
  return structuredClone({
    report: {
      screenId: "RPT-OPS-DASHBOARD",
      queryName: "store_sales_reports_v1",
      storeLabel: "Synthetic Store",
      timeZone: "America/Toronto",
      currencyCode: "CAD",
      from: "2026-10-27",
      to: "2026-10-27",
      startsAt: "2026-10-27T08:00:00.000Z",
      endsAt: "2026-10-28T01:42:00.000Z",
      includesOpenDay: true,
      summary: day,
      byChannel,
      byOrderType: [
        { orderType: "DineIn", ...summary(tables, writeOff) },
        { orderType: "Pickup", ...summary(tonightFigures.Online) },
      ],
      items: [],
      hours: [],
      tips: [
        {
          businessDate: "2026-10-27",
          channels: byChannel.map((entry) => ({
            channel: entry.channel,
            tipsMinor: entry.tipsMinor,
            refundedMinor: "0",
            netMinor: entry.tipsMinor,
          })),
        },
      ],
      days: [
        {
          businessDate: "2026-10-27",
          status: "Open",
          startsAt: "2026-10-27T08:00:00.000Z",
          endsAt: "2026-10-28T01:42:00.000Z",
          summary: day,
          byChannel,
          items: [],
          hours: [],
        },
      ],
      reconciliation: {
        matchesSettlement: true,
        settlementCollectedMinor: day.collectedMinor,
        settlementRefundedMinor: day.refundsMinor,
        reportCollectedMinor: day.collectedMinor,
        reportRefundedMinor: day.refundsMinor,
        pendingOnlineRefundCount: 0,
      },
      permissions: { mayExport: true },
      generatedAt: "2026-10-28T01:42:00.000Z",
    },
    openTables,
    openTablesOwedMinor: String(
      openTables.reduce((sum, table) => sum + Number(table.owedMinor), 0),
    ),
    cancelled: {
      removedBeforePayment: { dishCount: 2, amountMinor: "1880" },
      cancelledAfterPayment: { dishCount: 0, amountMinor: "0" },
      cancelledUnpaid: { roundCount: 1, dishCount: 1, amountMinor: "900" },
    },
  });
}
