import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { allMethodsNetMinor, SettlementReport } from "./SettlementPage.js";
import { parseSettlementView } from "./settlement-client.js";
import { settlementViewFixture } from "./settlement.fixtures.js";
import { pinFixtureYear } from "./store-year.fixture.js";

/**
 * Batch 67 (v15 b66 live, TM2 Nov 25): Reports said "Matches the day-end settlement: Net taken
 * $1,078.73, all payment methods together", but Settlement showed only Online "Net taken $813.41",
 * Card machine net $52.52 and Net cash $212.80; staff had to add three numbers, and the one figure
 * Settlement called Net taken was online only. Settlement now shows one all-methods Net taken from
 * the figures it already shows, and the online one is "Online net".
 */
beforeEach(() => pinFixtureYear());
afterEach(() => {
  vi.useRealTimers();
  setLanguageForTest("en");
});

const cad = (count: number, amountMinor: string) => ({ count, amountMinor, currencyCode: "CAD" });
/** TM2 Nov 25 as v15 read it (TEST data): online, card machine and cash. */
const nov25 = (extra: { cardBack?: string; cashBack?: string } = {}) => ({
  ...settlementViewFixture(),
  captured: cad(63, "107421"),
  refunded: cad(23, "26080"),
  cardMachine: {
    taken: cad(4, "6019"),
    tipMinor: "0",
    recordedAfterOutageCount: 0,
    refunded: cad(3, "767"),
    ...(extra.cardBack === undefined ? {} : { takenBack: cad(1, extra.cardBack) }),
  },
  cash: {
    received: cad(15, "21945"),
    tipMinor: "0",
    roundingMinor: "18",
    refunded: cad(2, "665"),
    netMinor: (21945n - 665n + BigInt(extra.cashBack ?? "0")).toString(),
    recordedAfterOutageCount: 0,
    ...(extra.cashBack === undefined ? {} : { takenBack: cad(1, extra.cashBack) }),
  },
});
const render = (view: unknown) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SettlementReport view={parseSettlementView(view)} />
    </MemoryRouter>,
  );
/** The all-methods section's words, tags out. */
const allMethods = (html: string) => {
  const tag = html.indexOf('class="store-card settlement__all-methods"');
  if (tag < 0) return null;
  const start = html.indexOf(">", tag) + 1;
  return html
    .slice(start, html.indexOf("</section>", start))
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#x27;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
};

describe("b67: Settlement shows one Net taken for all payment methods", () => {
  it("adds online, card machine and cash, less their refunds: Reports' $1,078.73 on Nov 25", () => {
    expect(allMethodsNetMinor(parseSettlementView(nov25()))).toBe("107873");
    const html = render(nov25());
    expect(allMethods(html)).toBe(
      "All payment methods Net taken $1,078.73 Online, card machine and cash together, minus refunds: the Net taken in Reports.",
    );
    // The online-only figure is named as online, so "Net taken" means one figure on the page.
    expect(html).toContain('<span class="overview-count__label">Online net</span>');
    expect(html.match(/>Net taken</gu)).toHaveLength(1);
    // It comes after the cash, before comps: the sum under its three parts.
    expect(html.indexOf("settlement__all-methods")).toBeGreaterThan(
      html.indexOf("settlement__cash"),
    );
    setLanguageForTest("zh-Hans");
    const zh = render(nov25());
    expect(allMethods(zh)).toBe(
      "所有付款方式 净实收 $1,078.73 线上、刷卡机和现金合计减去退款，即报表里的净实收。",
    );
    expect(zh).toContain('<span class="overview-count__label">线上净实收</span>');
    expect(zh.match(/>净实收</gu)).toHaveLength(1);
  });

  it("leaves out money taken back after a refund made by mistake, as Reports does, and says so", () => {
    const view = nov25({ cardBack: "500", cashBack: "250" });
    expect(allMethodsNetMinor(parseSettlementView(view))).toBe("107873");
    expect(allMethods(render(view))).toBe(
      "All payment methods Net taken $1,078.73 Online, card machine and cash together, minus refunds: the Net taken in Reports. Not counting $7.50 taken back after refunds made by mistake, which is in Card machine net and Net cash.",
    );
    setLanguageForTest("zh-Hans");
    expect(allMethods(render(view))).toBe(
      "所有付款方式 净实收 $1,078.73 线上、刷卡机和现金合计减去退款，即报表里的净实收。不含退款弄错后收回的 $7.50，这笔钱算在刷卡机净实收和现金净实收里。",
    );
  });

  it("Nov 26, a day Reports leaves nothing out: Reports' $342.17", () => {
    const view = {
      ...nov25(),
      captured: cad(22, "26433"),
      refunded: cad(5, "5303"),
      cardMachine: {
        taken: cad(6, "10257"),
        tipMinor: "0",
        recordedAfterOutageCount: 0,
        refunded: cad(0, "0"),
      },
      cash: {
        received: cad(2, "3195"),
        tipMinor: "0",
        roundingMinor: "2",
        refunded: cad(1, "365"),
        netMinor: "2830",
        recordedAfterOutageCount: 0,
      },
    };
    expect(allMethodsNetMinor(parseSettlementView(view))).toBe("34217");
    expect(allMethods(render(view))).toContain("Net taken $342.17");
  });

  it("a day with no cash still counts all methods (cash $0)", () => {
    const view = {
      ...nov25(),
      cash: {
        received: cad(0, "0"),
        tipMinor: "0",
        roundingMinor: "0",
        refunded: cad(0, "0"),
        netMinor: "0",
        recordedAfterOutageCount: 0,
      },
    };
    expect(allMethodsNetMinor(parseSettlementView(view))).toBe("86593");
    expect(allMethods(render(view))).toContain("Net taken $865.93");
  });

  it("never shows a partial sum: a part that could not be read reads 'Could not be read'", () => {
    for (const broken of [{ cardMachine: null }, { cash: null }, { captured: null }]) {
      const view = { ...nov25(), ...broken };
      expect(allMethodsNetMinor(parseSettlementView(view))).toBeNull();
      expect(allMethods(render(view))).toBe(
        "All payment methods Net taken Could not be read Online, card machine and cash together, minus refunds: the Net taken in Reports.",
      );
    }
  });

  it("an older server that does not send card machine or cash shows no all-methods line", () => {
    const view = settlementViewFixture();
    expect(allMethodsNetMinor(parseSettlementView(view))).toBeUndefined();
    expect(allMethods(render(view))).toBeNull();
  });
});
