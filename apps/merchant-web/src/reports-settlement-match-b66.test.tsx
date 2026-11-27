// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { settlementReportsGapText } from "./SettlementPage.js";
import { parseSettlementView } from "./settlement-client.js";
import { settlementViewFixture } from "./settlement.fixtures.js";
import { settlementMatchText } from "./StoreReportsPage.js";
import type { StoreReportSummary } from "./store-reports-client.js";

/**
 * Batch 66 (v15 b65 live, TM2):
 *  - Reports (Nov 25) said "Matches the day-end settlement: $1,353.85 collected, $275.12 refunded"
 *    over "Net taken $1,311.46 taken − $232.73 refunded": it matches on Net taken; the $42.39 of
 *    3 orders taken and given back the same day is in Settlement's figures only.
 *  - Settlement (Nov 26) said "Reports … can be lower" on a day Reports left nothing out.
 */
afterEach(() => setLanguageForTest("en"));

const id = (n: number) => "0190a66b-0000-7000-8000-" + n.toString(16).padStart(12, "0");

describe("b66: Reports' match line says what matches", () => {
  // Nov 25 at TM2: Net taken $1,078.73 (Online $813.41 + card machine $52.52 + cash $212.80).
  const summary = (cancelledInFullCount: number, cancelledInFullMinor: string) =>
    ({
      netCollectedMinor: "107873",
      collectedMinor: "131146",
      refundsMinor: "23273",
      cancelledInFullCount,
      cancelledInFullMinor,
    }) as unknown as StoreReportSummary;

  it("names Net taken and the money listed apart, never Settlement's taken above a lower summary", () => {
    const text = settlementMatchText(summary(3, "4239"));
    expect(text).toBe(
      "Matches the day-end settlement: Net taken $1,078.73, all payment methods together. Settlement also counts 3 orders ($42.39) taken and given back the same day, which this report lists apart, so its taken and refunded each read $42.39 more.",
    );
    expect(text).not.toContain("$1,353.85");
    expect(text).not.toContain("collected");
    setLanguageForTest("zh-Hans");
    expect(settlementMatchText(summary(3, "4239"))).toBe(
      "与日结一致：所有付款方式合计净实收 $1,078.73。结算还算进了当天收款又全部退回的 3 笔订单（$42.39），本报表把它们另外列出，所以结算的实收和退款都多 $42.39。",
    );
  });

  it("on a day nothing is left out, says only that Net taken matches", () => {
    expect(settlementMatchText(summary(0, "0"))).toBe(
      "Matches the day-end settlement: Net taken $1,078.73, all payment methods together.",
    );
    setLanguageForTest("zh-Hans");
    expect(settlementMatchText(summary(0, "0"))).toBe(
      "与日结一致：所有付款方式合计净实收 $1,078.73。",
    );
  });
});

describe("b66: Settlement's note on Reports shows only on a day it applies", () => {
  const online = { channel: "Online" as const, orderCount: 3, amountMinor: "4239" };

  it("names the orders and money Reports lists apart, by payment method", () => {
    expect(settlementReportsGapText([{ ...online, currencyCode: "CAD" }])).toBe(
      "Reports lists 3 orders ($42.39) taken and given back the same day apart, so its Online (guest's phone) taken and refunded each read $42.39 less than here. Net taken is the same.",
    );
    setLanguageForTest("zh-Hans");
    expect(
      settlementReportsGapText([
        { ...online, currencyCode: "CAD" },
        { channel: "Cash", orderCount: 1, amountMinor: "365", currencyCode: "CAD" },
      ]),
    ).toBe(
      "报表把当天收款又全部退回的 3 笔订单（$42.39）另外列出，所以报表的线上（客人手机）实收和退款都比这里少 $42.39。净实收相同。报表把当天收款又全部退回的 1 笔订单（$3.65）另外列出，所以报表的现金实收和退款都比这里少 $3.65。净实收相同。",
    );
  });

  it("says nothing on a day Reports leaves nothing out, or when the server does not say", () => {
    expect(settlementReportsGapText([])).toBeNull();
    expect(settlementReportsGapText(null)).toBeNull();
    expect(settlementReportsGapText(undefined)).toBeNull();
  });

  it("reads the server's figures and refuses ones that cannot be right", () => {
    const view = (reportsLeftOut: unknown) =>
      parseSettlementView({ ...settlementViewFixture(), reportsLeftOut });
    expect(view([{ ...online, currencyCode: "CAD" }]).reportsLeftOut).toEqual([
      { ...online, currencyCode: "CAD" },
    ]);
    expect(view([]).reportsLeftOut).toEqual([]);
    expect(view(null).reportsLeftOut).toBeNull();
    expect(parseSettlementView(settlementViewFixture()).reportsLeftOut).toBeUndefined();
    for (const bad of [
      [{ ...online, currencyCode: "USD" }],
      [{ ...online, orderCount: 0, currencyCode: "CAD" }],
      [{ ...online, amountMinor: "0", currencyCode: "CAD" }],
      [{ ...online, channel: "Points", currencyCode: "CAD" }],
      [
        { ...online, currencyCode: "CAD" },
        { ...online, currencyCode: "CAD" },
      ],
      [{ ...online, currencyCode: "CAD", orderReference: id(1) }],
      "3",
    ])
      expect(() => view(bad)).toThrow();
  });
});
