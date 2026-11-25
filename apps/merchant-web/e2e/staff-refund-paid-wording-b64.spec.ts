import { expect, test, type Page } from "@playwright/test";

/**
 * Batch 64 (v15 b62 live, TM2; b63 F27 final check): money said truthfully on Orders. Synthetic
 * Store; the server is mocked with the shapes seen live.
 *  - Order 8 (S62 E): paid $32.00 by phone, all of it refunded, the guests still seated. Its row
 *    said "Paid at the table · guest's phone" beside $0.00 (hidden on phones) and no next step.
 *  - Order 7 (S62 D): merged into S62 C and paid there. Its row printed "—" above the note.
 *  - Order 31 (counter, card machine): $2.00 refunded on the machine at the guest's request. The
 *    list said "$2.00 refunded" but the order's totals had no refund line and no total after it.
 */
const id = (n: number) => "0190a64b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const csrf = "a".repeat(43);

async function signIn(page: Page, zh: boolean) {
  if (zh)
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        // The page still renders in English.
      }
    });
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-25",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
          ],
        },
      },
    }),
  );
}

const batch = (n: number) => ({
  orderBatchReference: id(n),
  sequence: 1,
  acceptanceStatus: "Accepted",
  canRequestAcceptance: false,
  canCancel: false,
  staffCancellation: null,
  canCancelItems: false,
});
const common = (n: number, number: string) => ({
  orderReference: id(n),
  orderNumber: number,
  submittedAt: "2026-11-25T17:04:00.000Z",
  observedAt: "2026-11-25T17:40:00.000Z",
  initialBatchReference: id(n + 50),
  canRequestAcceptance: false,
  canViewPayments: false,
  canRecordCardMachinePayment: false,
  currentVersion: 4,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
});
/** Order 8: S62 E, paid $32.00 by phone, all of it back, the table still checking out. */
const refundedTable = {
  ...common(8, "8"),
  orderType: "DineIn",
  sourceChannel: "Qr",
  batches: [batch(58)],
  tableBill: {
    totalMinor: "2825",
    paid: {
      amountMinor: "3200",
      method: "Online",
      refundedMinor: "3200",
      tipMinor: "375",
    },
    checkingOut: true,
  },
  currentPhase: "Fulfilled",
};
/** Order 7: S62 D, merged into S62 C and paid there. */
const mergedTable = {
  ...common(7, "7"),
  orderType: "DineIn",
  sourceChannel: "Qr",
  batches: [{ ...batch(57), unpaidRemovableItems: [], unpaidRemovedItems: [] }],
  tableBill: {
    totalMinor: "0",
    paid: null,
    mergedInto: { tableLabel: "S62 C (TEST)", paid: true },
  },
  currentPhase: "Fulfilled",
};
/** Order 31: a counter pickup paid $14.13 on the card machine, $2.00 refunded there. */
const counterOrder = {
  ...common(31, "31"),
  orderType: "Pickup",
  sourceChannel: "Pos",
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: {
      amountMinor: "1413",
      takenAt: "2026-11-25T17:05:00.000Z",
      recordedAfterOutage: false,
      refundedMinor: "200",
    },
  },
  batches: [batch(81)],
  currentPhase: "Fulfilled",
};
const counterDetail = {
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order: counterOrder,
  lines: {
    items: [
      {
        orderItemReference: id(201),
        orderBatchReference: id(81),
        name: "Beef noodles (TEST)",
        options: [],
        quantity: 1,
        customerNote: null,
        unitPrice: money("1250"),
        subtotal: money("1250"),
        discount: money("0"),
        tax: money("163"),
        fee: money("0"),
        total: money("1413"),
        canCancel: false,
        cancellation: null,
      },
    ],
    totals: {
      subtotal: money("1250"),
      discount: money("0"),
      tax: money("163"),
      fee: money("0"),
      taxRounding: money("0"),
      total: money("1413"),
    },
  },
  record: {
    accepted: [],
    handedOver: [],
    payments: [
      {
        method: "CardMachine",
        part: null,
        round: null,
        by: "You",
        at: "2026-11-25T17:05:00.000Z",
      },
    ],
    cancellations: [],
    refunds: [
      {
        method: "CardMachine",
        amountMinor: "200",
        by: "You",
        approvedBy: null,
        at: "2026-11-25T17:28:00.000Z",
      },
    ],
    writeOff: null,
    paidOnlineByGuest: false,
  },
};

async function ordersPage(page: Page, zh: boolean) {
  await signIn(page, zh);
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({
      headers,
      json: { items: [counterOrder, refundedTable, mergedTable], nextAfterOrderReference: null },
    }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({ headers, json: counterDetail }),
  );
  await page.goto("/operations/orders");
}

async function noSideways(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

const row = (page: Page, number: string) =>
  page.locator("li.order-row").filter({
    has: page.locator(".order-row__number", { hasText: new RegExp(`^\\s*${number}\\b`, "u") }),
  });

for (const zh of [false, true]) {
  const language = zh ? "zh-Hans" : "en";
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production b64: a table refunded in full says so on its Orders row, with its next step; a merged one has no dash (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, zh);
      const refunded = row(page, "8");
      await expect(refunded.locator(".order-row__money")).toHaveText("$0.00");
      await expect(refunded.locator(".order-row__refunded")).toHaveText(
        zh ? "已退 $32.00" : "$32.00 refunded",
      );
      // At every width, phones too: why the amount is $0.00, and what is left to do.
      const said = refunded.locator(".order-row__said");
      await expect(said).toBeVisible();
      await expect(said).toHaveText(
        zh ? "已全部退款 · 客人走后关台" : "Fully refunded · close when the guests leave",
      );
      await expect(refunded).not.toContainText(zh ? "已在桌上付清" : "Paid at the table");
      // The note sits inside the row and never runs under the amount.
      const room = await refunded.evaluate((node) => {
        const box = (selector: string) => node.querySelector(selector)?.getBoundingClientRect();
        const note = node.querySelector(".order-row__said") as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(note);
        const rects = [...range.getClientRects()];
        const amount = box(".order-workbench-amount");
        const rowBox = node.getBoundingClientRect();
        return {
          overflow: note.scrollWidth > note.clientWidth + 1,
          right: Math.max(...rects.map((r) => r.right)),
          rowRight: rowBox.right,
          overlaps: rects.some(
            (r) =>
              amount !== undefined &&
              r.right > amount.left + 1 &&
              r.left < amount.right - 1 &&
              r.bottom > amount.top + 1 &&
              r.top < amount.bottom - 1,
          ),
        };
      });
      expect(room.overflow).toBe(false);
      expect(room.right).toBeLessThanOrEqual(room.rowRight);
      expect(room.overlaps).toBe(false);
      // Order 7: its note says where it was paid; no "—" as if an amount were missing.
      const merged = row(page, "7");
      await expect(merged.locator(".order-row__merged")).toBeVisible();
      await expect(merged.locator(".order-workbench-amount")).toHaveText("");
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b64-orders-rows-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b64: a counter order's own card-machine refund is a line under its totals (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, zh);
      const counter = row(page, "31");
      await expect(counter.locator(".order-row__refunded")).toHaveText(
        zh ? "已退 $2.00" : "$2.00 refunded",
      );
      const opener = counter.locator(".order-row__open");
      await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      const totals = page.locator(".order-lines-totals > div");
      const value = (label: string) =>
        totals
          .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`, "u") }) })
          .locator("dd")
          .first();
      await expect(value(zh ? "合计" : "Total")).toHaveText("$14.13");
      await expect(
        value(zh ? "已在刷卡机退款 · 12:28" : "Refunded on the card machine · 12:28"),
      ).toHaveText("−$2.00");
      await expect(value(zh ? "退款后合计" : "Total after refunds")).toHaveText("$12.13");
      // Each line (b63 F27 rule): its amount on one line, never pushed under or over the words;
      // the words on one line with about 40 px to spare for Linux fonts, or wrapped inside their
      // own column with nothing cut off.
      const found = await totals.evaluateAll((rows) =>
        rows
          .filter((r) => r.getBoundingClientRect().width > 0)
          .map((r) => {
            const term = r.querySelector("dt") as HTMLElement;
            const amount = r.querySelector("dd") as HTMLElement;
            const rowBox = r.getBoundingClientRect();
            const termBox = term.getBoundingClientRect();
            const amountBox = amount.getBoundingClientRect();
            const gap = Number.parseFloat(getComputedStyle(r).columnGap) || 0;
            const probe = document.createElement("span");
            probe.style.cssText =
              "position:absolute;visibility:hidden;white-space:nowrap;font:inherit";
            probe.textContent = term.textContent ?? "";
            term.appendChild(probe);
            const natural = probe.getBoundingClientRect().width;
            const oneLine = probe.getBoundingClientRect().height;
            probe.remove();
            const range = document.createRange();
            range.selectNodeContents(amount);
            return {
              text: r.textContent ?? "",
              amountLines: new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size,
              termLines: Math.round(termBox.height / oneLine),
              termOverflow: term.scrollWidth - term.clientWidth,
              termRight: termBox.right,
              termTop: termBox.top,
              amountLeft: amountBox.left,
              amountRight: amountBox.right,
              amountTop: amountBox.top,
              rowRight: rowBox.right,
              room: rowBox.width - amountBox.width - gap - natural,
            };
          }),
      );
      expect(found.length).toBeGreaterThan(0);
      for (const r of found) {
        expect(r.amountLines, r.text).toBe(1);
        expect(r.termOverflow, r.text).toBeLessThanOrEqual(0);
        expect(r.amountRight, r.text).toBeLessThanOrEqual(r.rowRight + 0.5);
        expect(r.termRight, r.text).toBeLessThanOrEqual(r.amountLeft + 0.5);
        expect(Math.abs(r.amountTop - r.termTop), r.text).toBeLessThanOrEqual(4);
        if (r.termLines <= 1) expect(r.room, r.text).toBeGreaterThanOrEqual(40);
      }
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b64-counter-refund-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }
}
