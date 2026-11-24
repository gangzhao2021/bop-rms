import { expect, test, type Page } from "@playwright/test";

/**
 * b60 (v15 b59 live, TM2 order 27): a split table bill ($28.25: part 1 $14.13 on a guest's phone,
 * part 2 $14.12 on the card machine) had $6.75 refunded to the guest's card in four refunds on
 * part 1, yet Orders still listed $28.25 and the order's totals ended at "Total $28.25", while a
 * refunded pickup read "Other refunds −$14.13 / Total after refunds $0.00". A table's refunds now
 * count the same way: the list amount and "Total after refunds" are lowered only by money given
 * back, a refund still on its way back is said as such, and the original Total stays.
 * Here also $2.00 refunded on the card machine for part 2, $3.00 to the card still on its way and
 * a refused $4.00 (which the server never counts). Synthetic Store; the server is mocked.
 */
const id = (n: number) => "01909972-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const onlineRefund = (amountMinor: string, state: string, minute: number) => ({
  amountMinor,
  reasonCode: "CUSTOMER_REQUEST",
  requestedAt: `2026-11-24T18:${String(minute).padStart(2, "0")}:00.000Z`,
  byLabel: "You",
  state,
});
const part = {
  method: "Online",
  roundingMinor: "0",
  tipMinor: "0",
  takenAt: "2026-11-24T17:40:00.000Z",
  recordedAfterOutage: false,
  cashRefunds: [],
  cardRefunds: [] as unknown[],
  onlineRefunds: [] as unknown[],
  canRefund: true,
};
const tablePayment = {
  orderReference: id(1),
  payment: null,
  parts: [
    {
      ...part,
      partNumber: 1,
      roundsMinor: "1413",
      totalMinor: "1413",
      onlineRefunds: [
        onlineRefund("500", "Refunded", 1),
        onlineRefund("100", "Refunded", 2),
        onlineRefund("50", "Refunded", 3),
        onlineRefund("25", "Refunded", 4),
        onlineRefund("400", "Refused", 5),
        onlineRefund("300", "Sending", 6),
      ],
      refundableMinor: "438",
    },
    {
      ...part,
      partNumber: 2,
      method: "CardMachine",
      roundsMinor: "1412",
      totalMinor: "1412",
      cardRefunds: [
        {
          amountMinor: "200",
          reasonCode: "FOOD_ISSUE",
          refundedAt: "2026-11-24T18:07:00.000Z",
          byLabel: "You",
        },
      ],
      refundableMinor: "1212",
    },
  ],
};

/**
 * b60 review: a table paid $46.00 on a guest's phone for $40.00 of dishes ($6.00 tip), $10.00 of it
 * refunded. The Total is what was paid (tip included, as a pickup's), so "Total after refunds"
 * equals the list's amount ($36.00), never $30.00.
 */
const tippedPayment = {
  orderReference: id(1),
  payment: {
    ...part,
    partNumber: null,
    roundsMinor: "4000",
    tipMinor: "600",
    totalMinor: "4600",
    onlineRefunds: [onlineRefund("1000", "Refunded", 1)],
    refundableMinor: "3600",
  },
  parts: [],
};

async function mock(page: Page, zh: boolean, tipped = false) {
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
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-11-24",
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
  const order = {
    orderReference: id(1),
    orderNumber: "27",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-11-24T17:20:00.000Z",
    observedAt: "2026-11-24T18:20:00.000Z",
    initialBatchReference: id(51),
    batches: [
      {
        orderBatchReference: id(51),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
        unpaidRemovableItems: [],
        unpaidRemovedItems: [],
        compableItems: [],
        compedItems: [],
      },
    ],
    canRequestAcceptance: false,
    canViewPayments: true,
    canRecordCardMachinePayment: false,
    tableBill: tipped
      ? {
          totalMinor: "4000",
          paid: { amountMinor: "4600", method: "Online", refundedMinor: "1000", tipMinor: "600" },
        }
      : {
          totalMinor: "2825",
          paid: {
            amountMinor: "2825",
            method: "Split",
            refundedMinor: "875",
            refundPendingMinor: "300",
          },
        },
    currentPhase: "Fulfilled",
    currentVersion: 6,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  };
  const item = (n: number, name: string, taxMinor: string, priceMinor = "1250") => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(51),
    name,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money(priceMinor),
    subtotal: money(priceMinor),
    discount: money("0"),
    tax: money(taxMinor),
    fee: money("0"),
    total: money((Number(priceMinor) + Number(taxMinor)).toString()),
    canCancel: false,
    cancellation: null,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order,
        lines: tipped
          ? {
              items: [
                item(1, "Beef noodles (TEST)", "230", "1770"),
                item(2, "Pork dumplings (TEST)", "230", "1770"),
              ],
              totals: {
                subtotal: money("3540"),
                discount: money("0"),
                tax: money("460"),
                fee: money("0"),
                taxRounding: money("0"),
                total: money("4000"),
                tip: money("0"),
              },
            }
          : {
              items: [
                item(1, "Beef noodles (TEST)", "163"),
                item(2, "Pork dumplings (TEST)", "162"),
              ],
              totals: {
                subtotal: money("2500"),
                discount: money("0"),
                tax: money("325"),
                fee: money("0"),
                taxRounding: money("0"),
                total: money("2825"),
              },
            },
      },
    }),
  );
  await page.route("**/merchant/orders/table-payment", (route) =>
    route.fulfill({ headers, json: tipped ? tippedPayment : tablePayment }),
  );
}

const words = (zh: boolean) =>
  zh
    ? {
        total: "合计",
        other: "其他退款",
        pending: "正在退回客人的卡",
        after: "退款后合计",
        refunded: "已退 $8.75",
        note: "$3.00 正在退回客人的卡",
      }
    : {
        total: "Total",
        other: "Other refunds",
        pending: "Going back to the guest's card",
        after: "Total after refunds",
        refunded: "$8.75 refunded",
        note: "$3.00 going back to the guest's card",
      };

/** The order's totals: the original Total, what went back, what is on its way, what is left. */
async function totalsHold(page: Page, zh: boolean) {
  const w = words(zh);
  const value = (label: string) =>
    page
      .locator(".order-lines-totals > div")
      .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`, "u") }) })
      .locator("dd")
      .first();
  await expect(value(w.total)).toHaveText("$28.25");
  await expect(value(w.other)).toHaveText("−$8.75");
  await expect(value(w.pending)).toHaveText("$3.00");
  await expect(value(w.after)).toHaveText("$19.50");
  // Read in order: the Total, what went back, what is left, then what is still on its way.
  const labels = await page.locator(".order-lines-totals dt").allTextContents();
  const at = (label: string) => labels.indexOf(label);
  expect(at(w.total)).toBeLessThan(at(w.other));
  expect(at(w.other)).toBeLessThan(at(w.after));
  expect(at(w.after)).toBeLessThan(at(w.pending));
  // Each figure on one line, with ~40 px to spare on its row (Linux fonts are wider).
  const found = await page.locator(".order-lines-totals > div").evaluateAll((rows) =>
    rows.map((row) => {
      const dd = row.querySelector("dd");
      const dt = row.querySelector("dt");
      const range = document.createRange();
      if (dd) range.selectNodeContents(dd);
      return {
        text: row.textContent ?? "",
        lines: dd ? new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size : 0,
        spare:
          row.getBoundingClientRect().width -
          (dd?.getBoundingClientRect().width ?? 0) -
          (dt?.getBoundingClientRect().width ?? 0),
      };
    }),
  );
  expect(found.length).toBeGreaterThanOrEqual(4);
  for (const row of found) {
    expect(row.lines, row.text).toBe(1);
    expect(row.spare, row.text).toBeGreaterThanOrEqual(40);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

for (const zh of [false, true]) {
  const language = zh ? "zh-Hans" : "en";
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production b60: a table's refunds lower its Orders amount and totals like a pickup's (${language}, ${width})`, async ({
      page,
    }) => {
      const w = words(zh);
      await page.setViewportSize({ width, height });
      await mock(page, zh);
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").first();
      await expect(row.locator(".order-row__money")).toHaveText("$19.50");
      await expect(row.locator(".order-row__refunded")).toHaveText(w.refunded);
      await expect(row.locator(".order-row__paid")).toContainText(w.note);
      const opener = row.locator(".order-row__open");
      if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      await totalsHold(page, zh);
      // The "Paid at the table" section keeps each refund line of its own.
      await expect(page.locator("section.table-payment").first()).toContainText("−$5.00");
      await page.screenshot({
        path: `test-results/b60-table-refund-totals-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b60: a table's refunds count on the order's own page (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh);
      await page.goto("/operations/orders/" + id(1));
      await totalsHold(page, zh);
    });
  }
}

for (const zh of [false, true]) {
  const language = zh ? "zh-Hans" : "en";
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production b60 review: a tipped table's detail and list agree after a refund (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh, true);
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").first();
      await expect(row.locator(".order-row__money")).toHaveText("$36.00");
      await expect(row.locator(".order-row__refunded")).toHaveText(
        zh ? "已退 $10.00" : "$10.00 refunded",
      );
      const opener = row.locator(".order-row__open");
      if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      const value = (label: string) =>
        page
          .locator(".order-lines-totals > div")
          .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`, "u") }) })
          .locator("dd")
          .first();
      await expect(value(zh ? "小费" : "Tip")).toHaveText("$6.00");
      await expect(value(zh ? "合计" : "Total")).toHaveText("$46.00");
      await expect(value(zh ? "其他退款" : "Other refunds")).toHaveText("−$10.00");
      // The same figure as the list's amount.
      await expect(value(zh ? "退款后合计" : "Total after refunds")).toHaveText("$36.00");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/b60r-tipped-table-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }
}
