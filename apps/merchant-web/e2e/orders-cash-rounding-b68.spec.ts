import { expect, test, type Page } from "@playwright/test";
import { headers, id, inLanguage, quietFrame, session, sizes } from "./merchant-shell-fixture";

/**
 * Batch 68 (v15 b67 live, TM2 order 8; synthetic Store, TEST-only data answered in the browser with
 * the shapes v15 sent): a counter order of $3.67 paid $3.65 in cash (rounded to 5 cents) and
 * refunded in full in cash ($3.65 given back). The Orders row read $0.00 / $3.65 refunded, but the
 * detail read Total $3.67 / Cash given back −$3.65 / Total after refunds $0.02, with no Cash
 * rounding line. Now the detail says Cash rounding −$0.02, Total $3.65 and $0.00 after refunds, in
 * English and Chinese at 390, 1024 and 1440, with room left for Linux fonts (DejaVu).
 */
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const order8 = {
  orderReference: id(80),
  orderNumber: "8",
  submittedAt: "2026-11-27T16:02:00.000Z",
  observedAt: "2026-11-27T16:05:00.000Z",
  initialBatchReference: id(81),
  canRequestAcceptance: false,
  canViewPayments: false,
  canRecordCardMachinePayment: false,
  currentVersion: 6,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  currentPhase: "Fulfilled",
  orderType: "Pickup",
  sourceChannel: "Pos",
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: {
      amountMinor: "365",
      takenAt: "2026-11-27T16:02:53.000Z",
      recordedAfterOutage: false,
      refundedMinor: "365",
      cash: { tenderedMinor: "500", changeMinor: "135", roundingMinor: "-2" },
    },
  },
  batches: [
    {
      orderBatchReference: id(81),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
};
const detail8 = {
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order: order8,
  lines: {
    items: [
      {
        orderItemReference: id(201),
        orderBatchReference: id(81),
        name: "Soy milk (Hot) (TEST)",
        options: [],
        quantity: 1,
        customerNote: null,
        unitPrice: money("325"),
        subtotal: money("325"),
        discount: money("0"),
        tax: money("42"),
        fee: money("0"),
        total: money("367"),
        canCancel: false,
        cancellation: null,
      },
    ],
    totals: {
      subtotal: money("325"),
      discount: money("0"),
      tax: money("42"),
      fee: money("0"),
      taxRounding: money("0"),
      total: money("367"),
    },
  },
  record: {
    accepted: [],
    handedOver: [],
    payments: [
      { method: "Cash", part: null, round: null, by: "You", at: "2026-11-27T16:02:53.000Z" },
    ],
    cancellations: [],
    refunds: [
      {
        method: "Cash",
        amountMinor: "367",
        by: "You",
        approvedBy: null,
        at: "2026-11-27T16:04:42.000Z",
        cashGivenBackMinor: "365",
        reasonCode: "CUSTOMER_REQUEST",
      },
    ],
    writeOff: null,
    paidOnlineByGuest: false,
  },
};

/** Each totals line of the open detail: its words, its amount and where both sit. */
async function totalsLines(page: Page) {
  return page.locator(".order-lines-totals > div").evaluateAll((rows) =>
    rows.map((row) => {
      const term = row.querySelector("dt") as HTMLElement;
      const amount = row.querySelector("dd") as HTMLElement;
      const termBox = term.getBoundingClientRect();
      const amountBox = amount.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(term);
      const words = [...range.getClientRects()].filter((rect) => rect.width > 0);
      return {
        term: (term.textContent ?? "").replace(/\u2060/gu, "").replace(/\u00a0/gu, " "),
        amount: amount.textContent ?? "",
        wordsRight: Math.max(...words.map((rect) => rect.right)),
        amountLeft: amountBox.left,
        amountRight: amountBox.right,
        termOverflow: term.scrollWidth - term.clientWidth,
        rowRight: row.getBoundingClientRect().right,
        termTop: termBox.top,
        amountTop: amountBox.top,
      };
    }),
  );
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b68: a counter cash order refunded in full reads $0.00 after refunds, its cash rounding said (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/session", (route) =>
        route.fulfill({ headers, json: session("2026-11-27") }),
      );
      await page.route("**/merchant/orders*", (route) =>
        route.fulfill({ headers, json: { items: [order8], nextAfterOrderReference: null } }),
      );
      await page.route("**/merchant/orders/detail*", (route) =>
        route.fulfill({ headers, json: detail8 }),
      );
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").filter({
        has: page.locator(".order-row__number", { hasText: /^\s*8\b/u }),
      });
      await expect(row.locator(".order-row__open")).toHaveAttribute("aria-expanded", "true");
      // The row: $0.00 kept, $3.65 refunded, as before.
      await expect(row.locator(".order-workbench-amount")).toContainText("$0.00");
      await expect(row.locator(".order-workbench-amount")).toContainText("$3.65");
      const lines = await totalsLines(page);
      const said = lines.map((line) => [line.term, line.amount]);
      expect(said).toEqual(
        zh
          ? [
              ["小计", "$3.25"],
              ["税", "$0.42"],
              ["现金取整", "−$0.02"],
              ["合计", "$3.65"],
              ["已退现金 · 顾客要求退款 · 11:04", "−$3.65"],
              ["退款后合计", "$0.00"],
            ]
          : [
              ["Subtotal", "$3.25"],
              ["Tax", "$0.42"],
              ["Cash rounding", "−$0.02"],
              ["Total", "$3.65"],
              ["Cash given back · Customer asked for a refund · 11:04", "−$3.65"],
              ["Total after refunds", "$0.00"],
            ],
      );
      // Every line's words end before its amount (about 40 px kept for Linux fonts on the short
      // lines), its amount ends at the row's right edge, and nothing scrolls sideways.
      const rounding = lines[2];
      const total = lines[3];
      expect(rounding && total).toBeTruthy();
      for (const line of lines) {
        expect(line.termOverflow, line.term).toBeLessThanOrEqual(0);
        expect(line.wordsRight, line.term).toBeLessThanOrEqual(line.amountLeft + 0.5);
        expect(Math.abs(line.amountRight - line.rowRight), line.term).toBeLessThanOrEqual(1);
      }
      for (const line of [lines[0], lines[1], rounding, total, lines[5]])
        expect((line?.amountLeft ?? 0) - (line?.wordsRight ?? 0), line?.term).toBeGreaterThan(40);
      // The rounding sits on one line with its amount, right above the Total, aligned with it.
      expect(Math.abs((rounding?.termTop ?? 0) - (rounding?.amountTop ?? 1))).toBeLessThanOrEqual(
        2,
      );
      expect(
        Math.abs((rounding?.amountRight ?? 0) - (total?.amountRight ?? 1)),
      ).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `test-results/b68-cash-rounding-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }
