import { expect, test, type Page } from "@playwright/test";

/**
 * b61 (v15 b60 live check, TM2): money on Orders said the same at every width and for every kind of
 * order. Synthetic Store; the server is mocked with the shapes seen live.
 *  - Order 50: a table split in two, part 1 paid ($14.13) with $3.00 back to the card, part 2 still
 *    owed. On phones the row said only "$28.25": the refund was in a note phones hide.
 *  - Order 48: a table paid $32.00 ($3.75 tip), all of it refunded. "Paid at the table" still said
 *    "Can still be refunded $0.00" and "It can take a few days…".
 *  - A pickup with a refund sent to the card company and not answered yet: "Other refunds" and
 *    "Total after refunds" counted it as given back (a table never does).
 *  - A table with another merged into it, paid as one bill ($60.25 with a $3.75 tip), $10.00 back:
 *    Orders said Total $28.25 (its own round) and took the whole bill's tip and refund off that.
 */
const id = (n: number) => "0190a61b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
type Shape = "partlyPaid" | "fullyRefunded" | "pickupPending" | "merged";

const refund = (amountMinor: string, state: string, minute: number) => ({
  amountMinor,
  reasonCode: "CUSTOMER_REQUEST",
  requestedAt: `2026-11-24T22:${String(minute).padStart(2, "0")}:00.000Z`,
  byLabel: "You",
  state,
});
const payment = (fields: Record<string, unknown>) => ({
  partNumber: null,
  method: "Online",
  roundsMinor: "2825",
  tipMinor: "0",
  roundingMinor: "0",
  totalMinor: "2825",
  takenAt: "2026-11-24T22:40:00.000Z",
  recordedAfterOutage: false,
  cashRefunds: [],
  cardRefunds: [],
  onlineRefunds: [] as unknown[],
  refundableMinor: "2825",
  canRefund: true,
  ...fields,
});
const tablePayments: Record<Exclude<Shape, "pickupPending">, unknown> = {
  partlyPaid: {
    orderReference: id(1),
    payment: null,
    parts: [
      payment({
        partNumber: 1,
        roundsMinor: "1413",
        totalMinor: "1413",
        onlineRefunds: [refund("300", "Refunded", 50)],
        refundableMinor: "1113",
      }),
    ],
  },
  fullyRefunded: {
    orderReference: id(1),
    payment: payment({
      tipMinor: "375",
      totalMinor: "3200",
      onlineRefunds: [refund("1000", "Refunded", 56), refund("2200", "Refunded", 58)],
      refundableMinor: "0",
    }),
    parts: [],
  },
  merged: {
    orderReference: id(1),
    payment: payment({
      roundsMinor: "5650",
      tipMinor: "375",
      totalMinor: "6025",
      onlineRefunds: [refund("1000", "Refunded", 56)],
      refundableMinor: "5025",
    }),
    parts: [],
  },
};
const tableBills: Record<Exclude<Shape, "pickupPending">, unknown> = {
  partlyPaid: {
    totalMinor: "2825",
    partlyPaid: { remainingMinor: "1412", paidParts: 1, partCount: 2, refundedMinor: "300" },
    paid: null,
  },
  fullyRefunded: {
    totalMinor: "2825",
    paid: { amountMinor: "3200", method: "Online", tipMinor: "375", refundedMinor: "3200" },
  },
  merged: {
    totalMinor: "5650",
    paid: { amountMinor: "6025", method: "Online", tipMinor: "375", refundedMinor: "1000" },
    // Round 1 is this table's; round 2 is the merged table's, on another Order.
    billRoundNumbers: [
      { orderBatchReference: id(51), roundNumber: 1 },
      { orderBatchReference: id(52), roundNumber: 2 },
    ],
  },
};

async function mock(page: Page, zh: boolean, shape: Shape) {
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
  const pickup = shape === "pickupPending";
  const position = {
    refundedMinor: "0",
    refundPendingMinor: "1413",
    refundNotSentMinor: "0",
    refundOnMachineMinor: "0",
  };
  const order = {
    orderReference: id(1),
    orderNumber: pickup ? "53" : shape === "fullyRefunded" ? "48" : "50",
    orderType: pickup ? "Pickup" : "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-11-24T22:20:00.000Z",
    observedAt: "2026-11-24T23:00:00.000Z",
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
        ...(pickup
          ? {}
          : {
              unpaidRemovableItems: [],
              unpaidRemovedItems: [],
              compableItems: [],
              compedItems: [],
            }),
      },
    ],
    canRequestAcceptance: false,
    canViewPayments: !pickup,
    canRecordCardMachinePayment: false,
    ...(pickup
      ? { paidOnline: money("1413"), paymentPosition: position }
      : { tableBill: tableBills[shape] }),
    currentPhase: pickup ? "Fulfilled" : shape === "partlyPaid" ? "Accepted" : "Fulfilled",
    currentVersion: 6,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  };
  const item = (n: number, name: string, taxMinor: string) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(51),
    name,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money("1250"),
    subtotal: money("1250"),
    discount: money("0"),
    tax: money(taxMinor),
    fee: money("0"),
    total: money((1250 + Number(taxMinor)).toString()),
    canCancel: false,
    cancellation: null,
  });
  const lines = pickup
    ? {
        items: [item(1, "Beef noodles (TEST)", "163")],
        totals: {
          subtotal: money("1250"),
          discount: money("0"),
          tax: money("163"),
          fee: money("0"),
          taxRounding: money("0"),
          total: money("1413"),
        },
      }
    : {
        items: [item(1, "Beef noodles (TEST)", "163"), item(2, "Pork dumplings (TEST)", "162")],
        totals: {
          subtotal: money("2500"),
          discount: money("0"),
          tax: money("325"),
          fee: money("0"),
          taxRounding: money("0"),
          total: money("2825"),
        },
      };
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
        lines,
        ...(pickup ? { paymentPosition: position } : {}),
      },
    }),
  );
  if (!pickup)
    await page.route("**/merchant/orders/table-payment", (route) =>
      route.fulfill({ headers, json: tablePayments[shape] }),
    );
}

const value = (page: Page, label: string) =>
  page
    .locator(".order-lines-totals > div")
    .filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`, "u") }) })
    .locator("dd")
    .first();

/** Every figure of the totals on one line, ~40 px to spare on its row, no sideways scroll. */
async function fits(page: Page, selector: string) {
  const found = await page.locator(selector).evaluateAll((rows) =>
    rows
      .filter((row) => row.getBoundingClientRect().width > 0)
      .map((row) => {
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
  expect(found.length).toBeGreaterThan(0);
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

async function openRow(page: Page) {
  const opener = page.locator("li.order-row").first().locator(".order-row__open");
  if ((await opener.getAttribute("aria-expanded")) !== "true") await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
}

for (const zh of [false, true]) {
  const language = zh ? "zh-Hans" : "en";
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`@production b61: a partly paid table's refund shows on its Orders row at every width (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh, "partlyPaid");
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").first();
      // The bill stays the amount (the rest is still owed); what went back is said under it.
      await expect(row.locator(".order-row__money")).toHaveText("$28.25");
      const line = row.locator(".order-row__refunded");
      await expect(line).toBeVisible();
      await expect(line).toHaveText(zh ? "已退 $3.00" : "$3.00 refunded");
      // The figure never breaks; on a phone the line is whole and leaves the dishes most of the
      // row, ~40 px to spare (Linux fonts are wider). Beside the panel the narrow amount column
      // may put the word under the figure, as the b60 lines do.
      const room = await line.evaluate((element) => {
        const text = element.firstChild;
        const whole = document.createRange();
        whole.selectNodeContents(element);
        const figure = document.createRange();
        const at = (text?.textContent ?? "").indexOf("$");
        if (text !== null && at >= 0) {
          figure.setStart(text, at);
          figure.setEnd(text, at + "$3.00".length);
        }
        const rects = [...whole.getClientRects()];
        return {
          figureLines: new Set([...figure.getClientRects()].map((r) => Math.round(r.top))).size,
          lines: new Set(rects.map((r) => Math.round(r.top))).size,
          text: Math.max(...rects.map((r) => r.width)),
          row: element.closest("li.order-row")?.getBoundingClientRect().width ?? 0,
          overflow: element.scrollWidth > element.clientWidth + 1,
        };
      });
      expect(room.figureLines).toBe(1);
      expect(room.overflow).toBe(false);
      if (width === 390) {
        expect(room.lines).toBe(1);
        expect(room.text + 40).toBeLessThanOrEqual(room.row / 2);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await openRow(page);
      await expect(value(page, zh ? "其他退款" : "Other refunds")).toHaveText("−$3.00");
      await expect(value(page, zh ? "退款后合计" : "Total after refunds")).toHaveText("$25.25");
      await page.screenshot({
        path: `test-results/b61-partly-paid-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b61: a table payment refunded in full says Fully refunded (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh, "fullyRefunded");
      await page.goto("/operations/orders/" + id(1));
      const paid = page.locator("section.table-payment").first();
      const row = paid
        .locator(".table-checkout__totals > div")
        .filter({
          has: page.locator("dt", { hasText: zh ? /^已全部退款$/u : /^Fully refunded$/u }),
        });
      await expect(row.locator("dd")).toHaveText("$32.00");
      // Each refund keeps its own line.
      await expect(paid).toContainText("−$10.00");
      await expect(paid).toContainText("−$22.00");
      await expect(paid).not.toContainText(zh ? "还可退" : "Can still be refunded");
      await expect(paid).not.toContainText(
        zh ? "可能要几天才会显示在客人的卡上" : "It can take a few days",
      );
      await expect(value(page, zh ? "退款后合计" : "Total after refunds")).toHaveText("$0.00");
      await fits(page, "section.table-payment .table-checkout__totals > div:last-child");
      await page.screenshot({
        path: `test-results/b61-fully-refunded-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b61: a pickup's refund not answered yet is never taken off (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh, "pickupPending");
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").first();
      // Nothing went back yet: the list keeps what was paid, as the detail does.
      await expect(row.locator(".order-row__money")).toHaveText("$14.13");
      await expect(row.locator(".order-row__refunded")).toHaveCount(0);
      await openRow(page);
      await expect(value(page, zh ? "合计" : "Total")).toHaveText("$14.13");
      await expect(value(page, zh ? "正在退回客人的卡" : "Refund on its way")).toHaveText("$14.13");
      await expect(
        page.locator(".order-lines-totals dt", {
          hasText: zh ? /^其他退款$/u : /^Other refunds$/u,
        }),
      ).toHaveCount(0);
      await expect(
        page.locator(".order-lines-totals dt", {
          hasText: zh ? /^退款后合计$/u : /^Total after refunds$/u,
        }),
      ).toHaveCount(0);
      await fits(page, ".order-lines-totals > div");
      await page.screenshot({
        path: `test-results/b61-pickup-pending-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b61: a merged table's Orders detail ends at the whole bill, as its list amount (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await mock(page, zh, "merged");
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").first();
      await expect(row.locator(".order-row__money")).toHaveText("$50.25");
      await expect(row.locator(".order-row__refunded")).toHaveText(
        zh ? "已退 $10.00" : "$10.00 refunded",
      );
      await openRow(page);
      await expect(value(page, zh ? "合计" : "Total")).toHaveText("$28.25");
      await expect(value(page, zh ? "并入本桌的其他桌" : "Tables merged into this one")).toHaveText(
        "$28.25",
      );
      await expect(value(page, zh ? "小费" : "Tip")).toHaveText("$3.75");
      await expect(value(page, zh ? "整桌账单实付" : "Whole bill paid")).toHaveText("$60.25");
      await expect(value(page, zh ? "其他退款" : "Other refunds")).toHaveText("−$10.00");
      await expect(value(page, zh ? "退款后合计" : "Total after refunds")).toHaveText("$50.25");
      await fits(page, ".order-lines-totals > div");
      await page.screenshot({
        path: `test-results/b61-merged-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }
}
