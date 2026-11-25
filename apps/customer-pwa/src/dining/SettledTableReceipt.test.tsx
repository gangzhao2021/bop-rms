import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import {
  parseSettledTableReceipt,
  PrintTableReceipt,
  SettledTableReceiptView,
} from "./SettledTableReceipt.js";

/**
 * Batch 60 (v15 b59 live, L59S B): staff comp 1 of 2 Beef noodles. The guest's receipt keeps the
 * line at its price and says one of the two bowls was on the house, never that both were.
 */
afterEach(() => {
  renderToStaticMarkup(<LanguageRoot initial="en">{() => null}</LanguageRoot>);
});
const receipt = (item: Record<string, unknown>) => ({
  schemaVersion: 1,
  receipt: {
    tableLabel: "L59S B (TEST)",
    rounds: [
      {
        roundNumber: 1,
        fromTableLabel: null,
        items: [item, { displayName: "Tea", subtotalMinor: "380", reduced: null }],
      },
    ],
    subtotalMinor: "1630",
    taxMinor: "212",
    ordersTotalMinor: "1842",
    tipMinor: "0",
    roundingMinor: "0",
    paidMinor: "1842",
    split: false,
    payments: [{ partNumber: null, method: "CardMachine", totalMinor: "1842" }],
  },
});
const noodles = {
  displayName: "Beef noodles (TEST)",
  subtotalMinor: "2500",
  reduced: "Comp",
  compedQuantity: 1,
  quantity: 2,
};
const html = (payload: unknown, language: "en" | "zh-Hans" = "en") =>
  renderToStaticMarkup(
    <LanguageRoot initial={language}>
      {() => <SettledTableReceiptView receipt={parseSettledTableReceipt(payload)} />}
    </LanguageRoot>,
  );

it("says 1 of 2 on the house beside the line, which keeps its price", () => {
  const page = html(receipt(noodles));
  // Batch 63: with how many of the dish, as the Rounds list says it.
  expect(page).toContain("<dt>2 × Beef noodles (TEST) · 1 of 2 on the house</dt><dd>$25.00</dd>");
  expect(page).not.toContain("Beef noodles (TEST) · On the house");
  // A line comped whole reads as before.
  const whole = html(receipt({ ...noodles, compedQuantity: undefined, quantity: undefined }));
  expect(whole).toContain("<dt>Beef noodles (TEST) · On the house</dt>");
});

it("says it in Chinese", () => {
  expect(html(receipt(noodles), "zh-Hans")).toContain(
    "2 × Beef noodles (TEST) · 2 份中的 1 份店家赠送",
  );
});

/**
 * Batch 63 (design review D62B-02): round 2 held 2 bowls, and the ended receipt read "Beef noodles
 * (TEST) $25.00" (one bowl at twice the price) while the Rounds list read "2 × Beef noodles".
 */
it("batch 63: every line says how many of the dish, as the Rounds list does", () => {
  const page = html(
    receipt({
      displayName: "Beef noodles (TEST)",
      subtotalMinor: "2500",
      reduced: null,
      quantity: 2,
    }),
  );
  expect(page).toContain("<dt>2 × Beef noodles (TEST)</dt><dd>$25.00</dd>");
  expect(
    html(
      receipt({
        displayName: "Beef noodles (TEST)",
        subtotalMinor: "2500",
        reduced: null,
        quantity: 2,
      }),
      "zh-Hans",
    ),
  ).toContain("<dt>2 × Beef noodles (TEST)</dt>");
  // An older server sends no count: the line is said as before.
  expect(page).toContain("<dt>Tea</dt>");
  for (const broken of [0, 1000, "2", 1.5])
    expect(() =>
      parseSettledTableReceipt(
        receipt({ displayName: "Tea", subtotalMinor: "380", reduced: null, quantity: broken }),
      ),
    ).toThrow();
});

it("reads the count strictly: only for a comp, and fewer than the line has", () => {
  for (const broken of [
    { ...noodles, compedQuantity: 0 },
    { ...noodles, compedQuantity: 2 },
    { ...noodles, quantity: undefined },
    { ...noodles, compedQuantity: "1" },
    { ...noodles, reduced: "Discount" },
  ])
    expect(() => parseSettledTableReceipt(receipt(broken))).toThrow();
});

/**
 * Batch 61 (v15 b60 live, CRT60 B order 46 and C order 49): by dish, A paid $14.13 and B $14.12,
 * a manager refunded all (or $8.00) of A, staff closed and cleaned the table. The ended receipt
 * read 实付合计 $28.25 / 已退款 −$14.13 / 第 1 份 … $14.13 / 第 2 份 … $14.12 on both phones: the
 * gross called 实付, no paid-after-refunds row, and every part's amount to every phone. The
 * settled receipt the API now sends (its batch 61 test): the asking phone's own part only.
 */
const byDish = (yours: Record<string, unknown>, refundedMinor: string) => ({
  schemaVersion: 1,
  receipt: {
    tableLabel: "CRT60 B (TEST)",
    rounds: [
      {
        roundNumber: 1,
        fromTableLabel: null,
        items: [{ displayName: "Beef noodles (TEST)", subtotalMinor: "1250", reduced: null }],
      },
      {
        roundNumber: 2,
        fromTableLabel: null,
        items: [{ displayName: "Beef noodles (TEST)", subtotalMinor: "1250", reduced: null }],
      },
    ],
    subtotalMinor: "2500",
    taxMinor: "325",
    taxRoundingMinor: "0",
    pointsUsedMinor: "0",
    ordersTotalMinor: "2825",
    tipMinor: "0",
    roundingMinor: "0",
    paidMinor: "2825",
    refundedMinor,
    split: true,
    paymentCount: 2,
    payments: [
      {
        method: "Online",
        tipMinor: "0",
        roundingMinor: "0",
        paidAt: "2026-11-24T00:34:40.000Z",
        yours: true,
        ...yours,
      },
    ],
  },
});
const rows = (page: string) =>
  [...page.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/gu)].map((row) => `${row[1]} ${row[2]}`);

it("batch 61: paid, refunded and paid after refunds, and only this phone's own part with its refunds", () => {
  const payer = byDish({ partNumber: 1, totalMinor: "1413", refundedMinor: "1413" }, "1413");
  expect(rows(html(payer)).slice(-8)).toEqual([
    "Tax $3.25",
    "Paid $28.25",
    "Refunded −$14.13",
    "Total paid after refunds $14.12",
    "Number of payments 2",
    "Your payment Online by phone · $14.13",
    "Refunded to your card −$14.13",
    "You paid after refunds $0.00",
  ]);
  const zh = rows(html(payer, "zh-Hans"));
  expect(zh).toContain("已付款 $28.25");
  expect(zh).toContain("退款后实付 $14.12");
  expect(zh).toContain("您的付款 手机在线付款 · $14.13");
  expect(zh.join()).not.toMatch(/实付合计|第 2 份/u);
  // Phone B: its own part, never A's part or A's refund as its own.
  const other = html(byDish({ partNumber: 2, totalMinor: "1412" }, "800"));
  expect(rows(other).slice(-5)).toEqual([
    "Paid $28.25",
    "Refunded −$8.00",
    "Total paid after refunds $20.25",
    "Number of payments 2",
    "Your payment Online by phone · $14.12",
  ]);
  expect(other).not.toMatch(/\$14\.13|\$6\.13|your card|Part 1/u);
  // Nothing refunded: the one total, called Total paid / 实付合计, as before.
  const none = rows(html(byDish({ partNumber: 1, totalMinor: "1413" }, "0"), "zh-Hans"));
  expect(none).toContain("实付合计 $28.25");
  expect(none.join()).not.toMatch(/已退款|退款后/u);
});

it("batch 61: own refunds are read strictly (never more pending than refunded, never another's)", () => {
  const read = (payment: Record<string, unknown>) => () =>
    parseSettledTableReceipt(byDish(payment, "800"));
  expect(
    read({ partNumber: 1, totalMinor: "1413", refundedMinor: "800" })().payments[0],
  ).toMatchObject({
    yours: true,
    refundedMinor: "800",
    refundPendingMinor: "0",
  });
  expect(
    read({ partNumber: 1, totalMinor: "1413", refundedMinor: "300", refundPendingMinor: "800" }),
  ).toThrow();
  expect(read({ partNumber: 1, totalMinor: "1413", yours: false, refundedMinor: "800" })).toThrow();
  // An older server: no count, every part listed and none marked as this phone's.
  const older = parseSettledTableReceipt({
    ...receipt(noodles),
    receipt: { ...receipt(noodles).receipt, split: true },
  });
  expect(older.paymentCount).toBeNull();
  expect(older.payments[0]?.yours).toBe(false);
});

/**
 * Batch 63 (design review D62B-08, F06): one phone paid both parts of an even split (D62BV A,
 * $23.07 and $21.19). The ended receipt listed "Your payment · Online by phone · $23.07" and
 * "Your payment · Online by phone · $21.19" with no total. Now one heading, each part, and what
 * this phone paid in all.
 */
it("batch 63: a phone that paid several parts reads them under one heading, with a total", () => {
  const both = byDish({ partNumber: 1, totalMinor: "2307" }, "0");
  both.receipt.payments.push({
    method: "Online",
    tipMinor: "0",
    roundingMinor: "0",
    paidAt: "2026-11-24T00:35:02.000Z",
    yours: true,
    partNumber: 2,
    totalMinor: "2119",
  } as never);
  const page = html(both);
  expect(page.match(/Your payment</gu)).toBeNull();
  expect(page).toContain('<h3 id="table-your-payments">Your payments</h3>');
  expect(rows(page)).toEqual(
    expect.arrayContaining([
      "Part 1 · Online by phone $23.07",
      "Part 2 · Online by phone $21.19",
      "Total paid by you $44.26",
    ]),
  );
  const zh = html(both, "zh-Hans");
  expect(rows(zh)).toEqual(
    expect.arrayContaining([
      "第 1 份 · 手机在线付款 $23.07",
      "第 2 份 · 手机在线付款 $21.19",
      "您实付合计 $44.26",
    ]),
  );
  // One part of its own: said as before, once.
  expect(rows(html(byDish({ partNumber: 1, totalMinor: "1413" }, "0")))).toContain(
    "Your payment Online by phone · $14.13",
  );
});

/**
 * Batch 63 (design review D62B-03, F05): a dine-in guest could not keep a receipt — no Store name
 * or address and no date (the pickup receipt has them), and no print or save action.
 */
it("batch 63: the receipt says who it is from and when, and offers to print or save it", () => {
  const merchant = {
    brandDisplayName: "Test Merchant 2 - not production",
    storeDisplayName: "Test Merchant 2 Main - not production",
    address: {
      addressLines: ["100 Test Street"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5V 1A1",
      countryCode: "CA",
    },
  };
  const withHeader = receipt(noodles);
  Object.assign(withHeader.receipt, { merchant, paidAt: "2026-11-24T00:35:02.000Z" });
  const page = html(withHeader);
  expect(page).toContain(
    '<p class="dining-session__receipt-store">Test Merchant 2 Main - not production</p>',
  );
  expect(page).toContain("<p>Test Merchant 2 - not production</p>");
  expect(page).toContain(
    "<address><span>100 Test Street</span><span>Toronto, ON M5V 1A1</span></address>",
  );
  // A named table is said as written ("Table" only before a number or code).
  expect(page).toContain("<p>L59S B (TEST)</p>");
  expect(page).toMatch(/<p>Paid Nov 2[34], 2026/u);
  const zh = html(withHeader, "zh-Hans");
  expect(zh).toContain("<p>L59S B (TEST)</p>");
  expect(zh).toMatch(/<p>付款时间 2026/u);
  // An older server sends neither: no header.
  expect(html(receipt(noodles))).not.toContain("dining-session__receipt-merchant");
  // No address line at all is still a well-formed list; the header just has the locality.
  const noLines = receipt(noodles);
  Object.assign(noLines.receipt, {
    merchant: { ...merchant, address: { ...merchant.address, addressLines: [] as string[] } },
  });
  expect(parseSettledTableReceipt(noLines).merchant?.address.addressLines).toEqual([]);
  // Batch 63 review: a header that can't be read (markup, a part longer than allowed, a control
  // character, a missing address) is left out; the receipt itself, its dishes and totals, stays.
  for (const broken of [
    { ...merchant, storeDisplayName: "<b>x</b>" },
    { ...merchant, brandDisplayName: "x".repeat(201) },
    { ...merchant, address: { ...merchant.address, postalCode: "M5V 1A1".repeat(4) } },
    { ...merchant, address: { ...merchant.address, locality: "Toronto\u0000" } },
    { ...merchant, address: null },
    "Test Merchant",
  ]) {
    const bad = receipt(noodles);
    Object.assign(bad.receipt, { merchant: broken });
    const parsed = parseSettledTableReceipt(bad);
    expect(parsed.merchant).toBeNull();
    expect(parsed.rounds).toHaveLength(1);
    expect(html(bad)).not.toContain("dining-session__receipt-merchant");
  }
  const print = renderToStaticMarkup(
    <LanguageRoot initial="zh-Hans">{() => <PrintTableReceipt />}</LanguageRoot>,
  );
  expect(print).toBe(
    '<p class="dining-session__receipt-print"><button type="button">打印或保存收据</button></p>',
  );
});

// Batch 64 (v15 b62 live, G62 A order 2): one phone paid the whole table ($28.25) and staff gave
// $8.00 back. Once the table was closed and cleaned, that phone's receipt read the same as every
// other phone's: its own "You paid … on this phone … went back to your card" lines and the refund's
// date were gone. "See the receipt" on the ended Menu and Cart also left focus on the page.
it("batch 64: a bill paid whole on a phone keeps that phone's own lines inside the receipt", () => {
  const paidWhole = {
    partNumber: null,
    totalMinor: "2825",
    tipMinor: "0",
    roundingMinor: "0",
    paidAt: "2026-11-24T00:34:40.000Z",
  };
  const whole = {
    schemaVersion: 1,
    receipt: {
      ...byDish({}, "800").receipt,
      split: false,
      paymentCount: undefined,
      payments: [{ ...paidWhole, method: "Online" }],
    },
  };
  const own = <p className="own-lines">You paid $28.25 online on this phone.</p>;
  const page = (payload: unknown) =>
    renderToStaticMarkup(
      <LanguageRoot initial="en">
        {() => (
          <SettledTableReceiptView receipt={parseSettledTableReceipt(payload)} ownLines={own} />
        )}
      </LanguageRoot>,
    );
  const wholePage = page(whole);
  // Inside the table's receipt, after its totals and "Paid by".
  expect(wholePage).toMatch(
    /<section[^>]*data-your-receipt=""[^>]*>.*Paid by.*You paid \$28\.25 online on this phone\..*<\/section>/su,
  );
  // A bill paid in parts already lists this phone's own parts; paid at the table, no phone paid.
  expect(page(byDish({ partNumber: 1, totalMinor: "1413" }, "800"))).not.toContain("own-lines");
  expect(
    page({
      ...whole,
      receipt: {
        ...whole.receipt,
        payments: [{ ...paidWhole, method: "CardMachine" }],
      },
    }),
  ).not.toContain("own-lines");
});
