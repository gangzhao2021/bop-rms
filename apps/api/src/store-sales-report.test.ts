import { describe, expect, it } from "vitest";
import type { StoreSalesOrder, StoreSalesOrderItem } from "@rms/ordering";
import type { StoreSalesPayment, StoreSalesRefund } from "@rms/payment";
import {
  computeStoreSalesReport,
  decimalFromMinor,
  storeSalesReportCsv,
  type StoreSalesReportInput,
} from "./store-sales-report.js";
import { businessDatesBetween } from "./persistent-merchant-store-reports.js";

const ref = (n: number) => "01a7c000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sku = { latteLarge: ref(901), latteSmall: ref(902), muffin: ref(903) };
const names = {
  [sku.latteLarge]: "Latte — Large",
  [sku.latteSmall]: "Latte — Small",
  [sku.muffin]: "Muffin",
};
let itemNumber = 1000;
/** A priced line with 13% test-only tax ("SYNTHETIC_TAX"), as an Ordering snapshot carries it. */
function item(skuReference: string, quantity: number, subtotal: number, discount = 0) {
  const tax = Math.round((subtotal - discount) * 0.13);
  return {
    orderItemReference: ref(itemNumber++),
    quantity,
    productReference: ref(800),
    skuReference,
    name: names[skuReference] ?? "",
    subtotalMinor: BigInt(subtotal),
    discountMinor: BigInt(discount),
    taxMinor: BigInt(tax),
    feeMinor: 0n,
    totalMinor: BigInt(subtotal - discount + tax),
    taxComponents: [{ code: "SYNTHETIC_TAX", amountMinor: BigInt(tax) }],
  } satisfies StoreSalesOrderItem;
}
const total = (items: readonly StoreSalesOrderItem[]) =>
  items.reduce((sum, line) => sum + line.totalMinor, 0n);

// Two business days (America/Toronto, day starts 04:00 = 08:00Z in October).
const days = [
  {
    businessDate: "2026-10-13",
    startsAt: "2026-10-13T08:00:00.000Z",
    endsAt: "2026-10-14T08:00:00.000Z",
    timeZone: "America/Toronto",
    status: "Closed" as const,
  },
  {
    businessDate: "2026-10-14",
    startsAt: "2026-10-14T08:00:00.000Z",
    endsAt: "2026-10-14T23:00:00.000Z",
    timeZone: "America/Toronto",
    status: "Open" as const,
  },
];
const p0Items = [item(sku.latteLarge, 2, 1000)];
const p1Items = [item(sku.latteLarge, 2, 1000), item(sku.muffin, 1, 350)];
const t1b1 = [item(sku.latteLarge, 1, 500)];
const t1b2 = [item(sku.muffin, 2, 700, 100)];
const t1b3 = [item(sku.latteLarge, 1, 500)]; // submitted, never paid, cancelled by the System
const c1Items = [item(sku.latteSmall, 1, 400)];
const c2Items = [item(sku.muffin, 1, 350)];
const order = (
  n: number,
  orderType: "DineIn" | "Pickup",
  sourceChannel: "Web" | "Qr" | "Pos",
  batches: (readonly StoreSalesOrderItem[])[],
): StoreSalesOrder => ({
  orderReference: ref(n),
  orderType,
  sourceChannel,
  businessDate: "2026-10-14",
  batches: batches.map((items, index) => ({ orderBatchReference: ref(n + 10 + index), items })),
});
const orders = [
  { ...order(100, "Pickup", "Web", [p0Items]), businessDate: "2026-10-13" },
  order(200, "Pickup", "Web", [p1Items]),
  order(300, "DineIn", "Qr", [t1b1, t1b2, t1b3]),
  order(400, "Pickup", "Pos", [c1Items]),
  order(500, "Pickup", "Pos", [c2Items]),
];
const payment = (
  channel: "Online" | "CardMachine",
  n: number,
  batch: number,
  items: readonly StoreSalesOrderItem[],
  tip: number,
  takenAt: string,
): StoreSalesPayment => ({
  channel,
  paymentIntentReference: ref(n + 50 + batch),
  orderReference: ref(n),
  orderBatchReference: ref(n + 10 + batch),
  orderAllocationMinor: total(items),
  tipMinor: BigInt(tip),
  totalMinor: total(items) + BigInt(tip),
  roundingMinor: 0n,
  paymentCount: 1,
  takenAt,
});
const p0 = payment("Online", 100, 0, p0Items, 0, "2026-10-13T20:00:00.000Z");
const p1 = payment("Online", 200, 0, p1Items, 200, "2026-10-14T15:10:00.000Z");
const t1Paid1 = payment("Online", 300, 0, t1b1, 100, "2026-10-14T16:05:00.000Z");
const t1Paid2 = payment("Online", 300, 1, t1b2, 0, "2026-10-14T17:20:00.000Z");
const c1 = payment("CardMachine", 400, 0, c1Items, 50, "2026-10-14T16:30:00.000Z");
const c2 = payment("CardMachine", 500, 0, c2Items, 0, "2026-10-14T16:40:00.000Z");
const muffin = p1Items[1] ?? p1Items[0];
const refunds: StoreSalesRefund[] = [
  // Yesterday's pickup could not be fulfilled: the whole payment went back this morning.
  {
    channel: "Online",
    kind: "Compensation",
    refundReference: ref(700),
    orderReference: p0.orderReference,
    paymentIntentReference: p0.paymentIntentReference,
    amountMinor: 1130n,
    refundedAt: "2026-10-14T12:00:00.000Z",
    items: null,
  },
  // Staff cancelled the muffin of the online pickup after payment (item cancellation refund).
  {
    channel: "Online",
    kind: "Ordinary",
    refundReference: ref(701),
    orderReference: p1.orderReference,
    paymentIntentReference: p1.paymentIntentReference,
    amountMinor: 396n,
    refundedAt: "2026-10-14T18:00:00.000Z",
    items: [
      {
        orderItemReference: muffin?.orderItemReference ?? "",
        unitCount: 1,
        netMinor: 350n,
        taxMinor: 46n,
        tipMinor: 0n,
        serviceChargeMinor: 0n,
      },
    ],
  },
  // Staff cancelled the second counter order and refunded it on the card machine.
  {
    channel: "CardMachine",
    kind: "CardMachine",
    refundReference: ref(702),
    orderReference: c2.orderReference,
    paymentIntentReference: c2.paymentIntentReference,
    amountMinor: 396n,
    refundedAt: "2026-10-14T16:45:00.000Z",
    items: null,
  },
];
const today: StoreSalesReportInput = {
  storeLabel: "Synthetic Store",
  timeZone: "America/Toronto",
  days: days.slice(1),
  payments: [p1, t1Paid1, t1Paid2, c1, c2],
  refundedPayments: [p0],
  refunds,
  settlement: {
    onlineCaptured: { count: 3, amountMinor: 3069n },
    onlineRefunded: { count: 2, amountMinor: 1526n },
    cardMachineTaken: { count: 2, amountMinor: 898n, tipMinor: 50n },
    cardMachineRefunded: { count: 1, amountMinor: 396n },
    cashTaken: { count: 0, amountMinor: 0n, tipMinor: 0n, roundingMinor: 0n },
    cashRefunded: { count: 0, amountMinor: 0n },
  },
  unresolvedOnlineRefundCount: 0,
  orders,
  mayExport: true,
  generatedAt: "2026-10-14T23:00:00.000Z",
};

describe("store sales report (WP-2423 Q14)", () => {
  it("summarizes a day of pickup, multi-round dine-in, counter card-machine sales, refunds and tips", () => {
    const view = computeStoreSalesReport(today);
    expect(view.summary).toMatchObject({
      paymentCount: 5,
      orderCount: 4,
      grossSalesMinor: "3300",
      discountsMinor: "100",
      netSalesMinor: "3200",
      taxMinor: "417",
      taxes: [{ label: "SYNTHETIC TAX", amountMinor: "417" }],
      tipsMinor: "350",
      collectedMinor: "3967",
      unmatchedMinor: "0",
      refundCount: 3,
      refundsMinor: "1922",
      refunds: {
        salesMinor: "1700",
        taxMinor: "222",
        tipsMinor: "0",
        serviceChargesMinor: "0",
        notItemizedMinor: "0",
      },
      netCollectedMinor: "2045",
      netSalesAfterRefundsMinor: "1500",
    });
    const channel = (c: string) => view.byChannel.find((entry) => entry.channel === c);
    expect(channel("Online")).toMatchObject({
      paymentCount: 3,
      collectedMinor: "3069",
      tipsMinor: "300",
      refundsMinor: "1526",
    });
    expect(channel("CardMachine")).toMatchObject({
      paymentCount: 2,
      collectedMinor: "898",
      tipsMinor: "50",
      refundsMinor: "396",
      netCollectedMinor: "502",
    });
    const kind = (k: string) => view.byOrderType.find((entry) => entry.orderType === k);
    // The unpaid third round never counts; the dine-in table is one order with two payments.
    expect(kind("DineIn")).toMatchObject({ orderCount: 1, paymentCount: 2, netSalesMinor: "1100" });
    expect(kind("Pickup")).toMatchObject({ orderCount: 1, refundsMinor: "1526" });
    expect(kind("Counter")).toMatchObject({ orderCount: 2, netSalesMinor: "750" });
    expect(view.reconciliation).toEqual({
      matchesSettlement: true,
      settlementCollectedMinor: "3967",
      settlementRefundedMinor: "1922",
      reportCollectedMinor: "3967",
      reportRefundedMinor: "1922",
      pendingOnlineRefundCount: 0,
    });
  });

  it("reports items by name and size with refunds and cancellations, and sales by store-time hour", () => {
    const view = computeStoreSalesReport(today);
    expect(view.items).toEqual([
      {
        name: "Latte — Large",
        quantitySold: 3,
        grossSalesMinor: "1500",
        discountsMinor: "0",
        netSalesMinor: "1500",
        refundedQuantity: 2,
        refundsMinor: "1000",
        netAfterRefundsMinor: "500",
      },
      {
        name: "Muffin",
        quantitySold: 4,
        grossSalesMinor: "1400",
        discountsMinor: "100",
        netSalesMinor: "1300",
        refundedQuantity: 2,
        refundsMinor: "700",
        netAfterRefundsMinor: "600",
      },
      {
        name: "Latte — Small",
        quantitySold: 1,
        grossSalesMinor: "400",
        discountsMinor: "0",
        netSalesMinor: "400",
        refundedQuantity: 0,
        refundsMinor: "0",
        netAfterRefundsMinor: "400",
      },
    ]);
    expect(view.hours.map((row) => [row.hour, row.paymentCount, row.collectedMinor])).toEqual([
      ["11:00", 1, "1726"],
      ["12:00", 3, String(665 + 502 + 396)],
      ["13:00", 1, "678"],
    ]);
    expect(view.tips).toEqual([
      {
        businessDate: "2026-10-14",
        channels: [
          { channel: "Online", tipsMinor: "300", refundedMinor: "0", netMinor: "300" },
          { channel: "CardMachine", tipsMinor: "50", refundedMinor: "0", netMinor: "50" },
          { channel: "Cash", tipsMinor: "0", refundedMinor: "0", netMinor: "0" },
        ],
      },
    ]);
  });

  it("returns the remaining tip with a whole-payment refund and flags a settlement difference", () => {
    const cancelled: StoreSalesRefund = {
      channel: "CardMachine",
      kind: "CardMachine",
      refundReference: ref(703),
      orderReference: c1.orderReference,
      paymentIntentReference: c1.paymentIntentReference,
      amountMinor: 502n,
      refundedAt: "2026-10-14T19:00:00.000Z",
      items: null,
    };
    const view = computeStoreSalesReport({ ...today, refunds: [...refunds, cancelled] });
    expect(view.summary.refunds).toMatchObject({ salesMinor: "2100", tipsMinor: "50" });
    expect(view.tips[0]?.channels[1]).toEqual({
      channel: "CardMachine",
      tipsMinor: "50",
      refundedMinor: "50",
      netMinor: "0",
    });
    // The settlement did not see that refund: the report says the two differ.
    expect(view.reconciliation.matchesSettlement).toBe(false);
  });

  it("covers a range of days and keeps each day's figures", () => {
    const view = computeStoreSalesReport({
      ...today,
      days,
      payments: [p0, ...today.payments],
      refundedPayments: [],
      settlement: {
        ...today.settlement,
        onlineCaptured: { count: 4, amountMinor: 3069n + 1130n },
      },
    });
    expect(view.from).toBe("2026-10-13");
    expect(view.to).toBe("2026-10-14");
    expect(view.includesOpenDay).toBe(true);
    expect(view.days.map((day) => [day.businessDate, day.summary.collectedMinor])).toEqual([
      ["2026-10-13", "1130"],
      ["2026-10-14", "3967"],
    ]);
    expect(view.summary.collectedMinor).toBe("5097");
    expect(view.reconciliation.matchesSettlement).toBe(true);
  });

  it("WP-2423 D4: counts a table's later round on the day it was paid, not the day the table opened", () => {
    // Table opened on Oct 13 (first round paid then); a second round was added and paid on Oct 14.
    const opened = {
      ...order(600, "DineIn", "Qr", [p0Items, c1Items]),
      businessDate: "2026-10-13",
    };
    const first = payment("Online", 600, 0, p0Items, 0, "2026-10-13T21:00:00.000Z");
    const later = payment("Online", 600, 1, c1Items, 0, "2026-10-14T16:00:00.000Z");
    const view = computeStoreSalesReport({
      ...today,
      days,
      orders: [opened],
      payments: [first, later],
      refundedPayments: [],
      refunds: [],
      settlement: {
        onlineCaptured: { count: 2, amountMinor: first.totalMinor + later.totalMinor },
        onlineRefunded: { count: 0, amountMinor: 0n },
        cardMachineTaken: { count: 0, amountMinor: 0n, tipMinor: 0n },
        cardMachineRefunded: { count: 0, amountMinor: 0n },
        cashTaken: { count: 0, amountMinor: 0n, tipMinor: 0n, roundingMinor: 0n },
        cashRefunded: { count: 0, amountMinor: 0n },
      },
    });
    expect(
      view.days.map((day) => [
        day.businessDate,
        day.summary.collectedMinor,
        day.summary.grossSalesMinor,
      ]),
    ).toEqual([
      ["2026-10-13", first.totalMinor.toString(), "1000"],
      ["2026-10-14", later.totalMinor.toString(), "400"],
    ]);
  });

  it("refuses inconsistent sources instead of printing a plausible total", () => {
    expect(() => computeStoreSalesReport({ ...today, days: [] })).toThrow();
    expect(() => computeStoreSalesReport({ ...today, refundedPayments: [] })).toThrow();
    // A payment whose items are missing is shown as not matched, never silently dropped.
    const view = computeStoreSalesReport({
      ...today,
      orders: orders.filter((entry) => entry.orderReference !== ref(400)),
    });
    expect(view.summary.unmatchedMinor).toBe(String(total(c1Items)));
    expect(view.summary.unmatchedPaymentCount).toBe(1);
  });

  it("exports each report as UTF-8 CSV with a header row, business date and decimal money, no customer data", () => {
    const view = computeStoreSalesReport(today);
    const summary = storeSalesReportCsv(view, "summary");
    expect(summary.startsWith("﻿")).toBe(true);
    const lines = summary.slice(1).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "business_date,day_status,payments,orders,gross_sales,discounts,net_sales,service_charges,tax_synthetic_tax,tax_total,tips,total_collected,refunds,net_collected,online_collected,card_machine_collected,cash_collected,online_refunds,card_machine_refunds,cash_refunds,cash_rounding,currency",
    );
    expect(lines[1]).toBe(
      "2026-10-14,open (so far),5,4,33.00,1.00,32.00,0.00,4.17,4.17,3.50,39.67,19.22,20.45,30.69,8.98,0.00,15.26,3.96,0.00,0.00,CAD",
    );
    const items = storeSalesReportCsv(view, "items").slice(1).trimEnd().split("\r\n");
    expect(items[0]).toBe(
      "business_date,item,quantity_sold,gross_sales,discounts,net_sales,refunded_quantity,refunds,net_after_refunds,currency",
    );
    expect(items).toContain("2026-10-14,Latte — Large,3,15.00,0.00,15.00,2,10.00,5.00,CAD");
    const hourly = storeSalesReportCsv(view, "hourly").slice(1).trimEnd().split("\r\n");
    expect(hourly[1]).toBe("2026-10-14,11:00,1,13.50,1.76,2.00,17.26,CAD");
    const tips = storeSalesReportCsv(view, "tips").slice(1).trimEnd().split("\r\n");
    expect(tips).toEqual([
      "business_date,payment_channel,tips,tips_refunded,net_tips,currency",
      "2026-10-14,Online,3.00,0.00,3.00,CAD",
      "2026-10-14,Store card machine,0.50,0.00,0.50,CAD",
      "2026-10-14,Cash,0.00,0.00,0.00,CAD",
    ]);
    for (const kind of ["summary", "items", "hourly", "tips"] as const)
      expect(storeSalesReportCsv(view, kind)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-7/u);
  });

  it("keeps spreadsheet formulas and separators in item names as plain text", () => {
    const view = computeStoreSalesReport({
      ...today,
      orders: orders.map((entry) => ({
        ...entry,
        batches: entry.batches.map((batch) => ({
          ...batch,
          items: batch.items.map((line) =>
            line.skuReference === sku.latteSmall
              ? { ...line, name: '=HYPERLINK("x"), "big"' }
              : line,
          ),
        })),
      })),
    });
    expect(storeSalesReportCsv(view, "items")).toContain(`"'=HYPERLINK(""x""), ""big"""`);
  });

  it("formats minor units as decimals without floating point", () => {
    expect(decimalFromMinor("0")).toBe("0.00");
    expect(decimalFromMinor("5")).toBe("0.05");
    expect(decimalFromMinor("-1234")).toBe("-12.34");
    expect(decimalFromMinor("9223372036854775807")).toBe("92233720368547758.07");
  });

  it("lists the business dates of a range and refuses more than the limit or a reversed range", () => {
    expect(businessDatesBetween("2026-10-30", "2026-11-02", 31)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(() => businessDatesBetween("2026-10-14", "2026-10-13", 31)).toThrow();
    expect(() => businessDatesBetween("2026-09-01", "2026-10-14", 31)).toThrow();
  });

  it("DEC-DINE-IN-PAY-LATER: a table paid in cash is one payment over its rounds, rounding apart", () => {
    const tableOrder = order(900, "DineIn", "Qr", [p0Items, c1Items]);
    const key = (line: number) => ref(950) + ":" + String(line);
    const round1 = total(p0Items),
      round2 = total(c1Items);
    const lines: StoreSalesPayment[] = [
      {
        channel: "Cash",
        paymentIntentReference: key(1),
        orderReference: ref(900),
        orderBatchReference: ref(910),
        orderAllocationMinor: round1,
        tipMinor: 0n,
        totalMinor: round1,
        roundingMinor: 0n,
        paymentCount: 1,
        takenAt: "2026-10-14T20:00:00.000Z",
      },
      {
        channel: "Cash",
        paymentIntentReference: key(2),
        orderReference: ref(900),
        orderBatchReference: ref(911),
        orderAllocationMinor: round2,
        tipMinor: 300n,
        totalMinor: round2 + 300n,
        roundingMinor: 2n,
        paymentCount: 0,
        takenAt: "2026-10-14T20:00:00.000Z",
      },
    ];
    const taken = round1 + round2 + 302n;
    const view = computeStoreSalesReport({
      ...today,
      orders: [tableOrder],
      payments: lines,
      refundedPayments: [],
      refunds: [
        {
          channel: "Cash",
          kind: "Cash",
          refundReference: ref(960),
          orderReference: ref(900),
          paymentIntentReference: key(2),
          amountMinor: 500n,
          refundedAt: "2026-10-14T21:00:00.000Z",
          items: null,
        },
      ],
      settlement: {
        onlineCaptured: { count: 0, amountMinor: 0n },
        onlineRefunded: { count: 0, amountMinor: 0n },
        cardMachineTaken: { count: 0, amountMinor: 0n, tipMinor: 0n },
        cardMachineRefunded: { count: 0, amountMinor: 0n },
        cashTaken: { count: 1, amountMinor: taken, tipMinor: 300n, roundingMinor: 2n },
        cashRefunded: { count: 1, amountMinor: 500n },
      },
    });
    const cash = view.byChannel.find((row) => row.channel === "Cash");
    expect(cash).toMatchObject({
      paymentCount: 1,
      orderCount: 1,
      collectedMinor: taken.toString(),
      tipsMinor: "300",
      cashRoundingMinor: "2",
      refundsMinor: "500",
    });
    expect(view.reconciliation.matchesSettlement).toBe(true);
    // A settlement that took a different amount in cash would not agree.
    expect(
      computeStoreSalesReport({
        ...today,
        orders: [tableOrder],
        payments: lines,
        refundedPayments: [],
        refunds: [],
        settlement: {
          onlineCaptured: { count: 0, amountMinor: 0n },
          onlineRefunded: { count: 0, amountMinor: 0n },
          cardMachineTaken: { count: 0, amountMinor: 0n, tipMinor: 0n },
          cardMachineRefunded: { count: 0, amountMinor: 0n },
          cashTaken: { count: 1, amountMinor: taken + 5n, tipMinor: 300n, roundingMinor: 2n },
          cashRefunded: { count: 0, amountMinor: 0n },
        },
      }).reconciliation.matchesSettlement,
    ).toBe(false);
    expect(storeSalesReportCsv(view, "summary").split("\r\n")[0]).toContain("cash_collected");
  });
});
