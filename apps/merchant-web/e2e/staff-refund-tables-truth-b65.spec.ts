import { expect, test, type Locator, type Page } from "@playwright/test";
import { settlementViewFixture } from "../src/settlement.fixtures.js";
import { storeReportsViewFixture } from "../src/store-reports.fixtures.js";
import {
  headers,
  id,
  inLanguage,
  quietFrame,
  session,
  sizes,
  type Language,
} from "./merchant-shell-fixture";

/**
 * Batch 65 (v15 b64 live, TM2 S64 A/B/E, orders 79 and the Settlement/Reports check). Synthetic
 * Store; the server is answered in the browser with the shapes seen live (TEST-only data):
 *  - S64 E: a Tables checkout panel open on one screen kept "Paid / Total paid / Print paid bill"
 *    after the bill was refunded in full from Orders on another screen, even after Refresh tables.
 *  - S64 B: the Tables row of a part-refunded table said "Paid" (已付清) at the paid amount.
 *  - A bill refunded in full with part of it still on its way reads "Being refunded" (退款中).
 *  - Order 79: a counter cash refund read only "Refunded" under the totals, and the Payment page
 *    kept "Now give back $3.65 from the drawer…" after the cash was recorded as given back.
 *  - Settlement and Reports showed different "Online (guest's phone)" figures with no reason.
 * Measured at 390, 1024 and 1440 in English and Chinese, with room left for Linux fonts (DejaVu).
 */
async function noSideways(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

/**
 * A line of words (a wrapping flex item): inside the box it sits in, nothing cut off or past its
 * edge. On the line it shares it keeps about 40 px to spare for Linux fonts, or else it can take a
 * line of its own in that box with that room (where a wider font moves it).
 */
async function fits(line: Locator, within: Locator) {
  const found = await line.evaluate(
    (node, boxNode) => {
      const box = (boxNode as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(boxNode as HTMLElement);
      const inner = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:inherit";
      probe.textContent = node.textContent ?? "";
      node.appendChild(probe);
      const natural = probe.getBoundingClientRect().width;
      probe.remove();
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      const right = Math.max(...rects.map((r) => r.right));
      return {
        text: node.textContent ?? "",
        overflow: (node as HTMLElement).scrollWidth - (node as HTMLElement).clientWidth,
        right,
        boxRight: box.right - parseFloat(style.paddingRight),
        room: box.right - parseFloat(style.paddingRight) - right,
        ownLineRoom: inner - natural,
      };
    },
    await within.elementHandle(),
  );
  expect(found.overflow, found.text).toBeLessThanOrEqual(0);
  expect(found.right, found.text).toBeLessThanOrEqual(found.boxRight + 0.5);
  expect(Math.max(found.room, found.ownLineRoom), found.text).toBeGreaterThanOrEqual(40);
}

/* ---------- Tables: S64 E (refunded from another screen), S64 B (part), being refunded ---------- */

type Refund = { refundedMinor: string; refundPendingMinor: string } | null;

/** One table checking out, paid $16.01 by phone ($14.13 and a $1.88 tip); `state.refund` is what went back. */
async function tables(page: Page, language: Language, state: { refund: Refund }) {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.route("**/merchant/session", (route) =>
    route.fulfill({ headers, json: session("2026-11-24") }),
  );
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        canCloseSessions: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "S64 E (TEST)",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            blockReasonCode: null,
            aggregateVersion: 2,
            currentDiningSessionReference: id(2),
            elapsedMinutes: 40,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
            paymentTiming: "PayLater",
            session: { phase: "Closing", version: 7, orderReference: id(3) },
            staffRoundsAwaitingPayment: [],
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        tableLabel: "S64 E (TEST)",
        diningSessionReference: id(2),
        sessionPhase: "Closing",
        closureStatus: "Open",
        closureVersion: 0,
        currentOrderVersion: 4,
        sessionVersion: 7,
        tableAssignmentVersion: 1,
        orderVersion: 4,
        phase: "Fulfilled",
        observedAt: "2026-11-25T01:30:00.000Z",
        items: [
          {
            orderItemReference: id(901),
            orderBatchReference: id(21),
            displayName: "Beef noodles (TEST)",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: "Fulfilled",
            orderedQuantity: 1,
            deliveredQuantity: 1,
            remainingQuantity: 0,
            itemServiceVersion: 1,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/table-close-plan", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(3),
        diningSessionReference: id(2),
        orderVersion: 4,
        observedAt: "2026-11-25T01:30:00.000Z",
        rounds: [],
        closeBlockers: [],
        totals: { onlineMinor: "1601", cardMachineMinor: "0" },
      },
    }),
  );
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(2),
        sessionPhase: "Closing",
        sessionVersion: 7,
        paymentTiming: "PayLater",
        tableLabel: "S64 E (TEST)",
        orderReference: id(3),
        rounds: [
          {
            roundNumber: 1,
            orderBatchReference: id(21),
            submissionReference: id(31),
            items: [
              {
                orderItemReference: id(901),
                quantity: 1,
                displayName: "Beef noodles (TEST)",
                subtotalMinor: "1250",
                totalMinor: "1413",
              },
            ],
            subtotalMinor: "1250",
            taxMinor: "163",
            totalMinor: "1413",
            paid: true,
          },
        ],
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
        consistent: true,
        settlement: {
          method: "Online",
          roundsMinor: "1413",
          tipMinor: "188",
          roundingMinor: "0",
          totalMinor: "1601",
          tenderedMinor: null,
          changeMinor: null,
          recordedAt: "2026-11-25T01:13:00.000Z",
          recordedAfterOutage: false,
        },
        // The server's figures: refundedMinor counts a refund still on its way too.
        ...(state.refund === null
          ? {}
          : {
              refundedMinor: state.refund.refundedMinor,
              ...(state.refund.refundPendingMinor === "0"
                ? {}
                : { refundPendingMinor: state.refund.refundPendingMinor }),
            }),
      },
    }),
  );
  const order = () => {
    const pending = BigInt(state.refund?.refundPendingMinor ?? "0");
    const given = BigInt(state.refund?.refundedMinor ?? "0") - pending;
    return {
      orderReference: id(3),
      orderNumber: "65",
      orderType: "DineIn",
      sourceChannel: "Qr",
      submittedAt: "2026-11-25T01:00:00.000Z",
      observedAt: "2026-11-25T01:30:00.000Z",
      initialBatchReference: id(21),
      batches: [
        {
          orderBatchReference: id(21),
          sequence: 1,
          acceptanceStatus: "Accepted",
          canRequestAcceptance: false,
          canCancel: false,
          staffCancellation: null,
          canCancelItems: false,
        },
      ],
      canRequestAcceptance: false,
      tableBill: {
        totalMinor: "1413",
        paid: {
          amountMinor: "1601",
          method: "Online",
          tipMinor: "188",
          ...(given > 0n ? { refundedMinor: given.toString() } : {}),
          ...(pending > 0n ? { refundPendingMinor: pending.toString() } : {}),
        },
        checkingOut: true,
      },
      currentPhase: "Fulfilled",
      currentVersion: 4,
      unfulfillable: null,
      pickupNotCollected: false,
      acceptBy: null,
      awaitingPayment: false,
    };
  };
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order()], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(),
        lines: {
          items: [
            {
              orderItemReference: id(901),
              orderBatchReference: id(21),
              name: "Beef noodles (TEST)",
              options: [],
              quantity: 1,
              customerNote: null,
              unitPrice: { amountMinor: "1250", currencyCode: "CAD" },
              subtotal: { amountMinor: "1250", currencyCode: "CAD" },
              discount: { amountMinor: "0", currencyCode: "CAD" },
              tax: { amountMinor: "163", currencyCode: "CAD" },
              fee: { amountMinor: "0", currencyCode: "CAD" },
              total: { amountMinor: "1413", currencyCode: "CAD" },
              canCancel: false,
              cancellation: null,
            },
          ],
          totals: {
            subtotal: { amountMinor: "1250", currencyCode: "CAD" },
            discount: { amountMinor: "0", currencyCode: "CAD" },
            tax: { amountMinor: "163", currencyCode: "CAD" },
            fee: { amountMinor: "0", currencyCode: "CAD" },
            taxRounding: { amountMinor: "0", currencyCode: "CAD" },
            total: { amountMinor: "1413", currencyCode: "CAD" },
          },
        },
      },
    }),
  );
  await page.goto("/operations/dining");
  const zh = language === "zh-Hans";
  return {
    row: page.locator(".table-row").filter({ hasText: "S64 E (TEST)" }),
    open: async () => {
      await page
        .getByRole("button", {
          name: zh ? "选择 S64 E (TEST)" : "Select S64 E (TEST)",
          exact: true,
        })
        .click();
      await expect(page.locator("#table-checkout-title")).toBeVisible();
    },
    heading: page.locator("#table-checkout-title"),
    panel: page.getByRole("complementary", {
      name: zh ? "所选桌台详情" : "Selected table details",
    }),
    refresh: () => page.getByRole("button", { name: zh ? "刷新桌台" : "Refresh tables" }).click(),
  };
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b65: a checkout panel already open follows a full refund made on another screen (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const state: { refund: Refund } = { refund: null };
      const floor = await tables(page, language, state);
      await floor.open();
      await expect(floor.heading).toHaveText(zh ? "已付款" : "Paid");
      await expect(floor.panel).toContainText(zh ? "打印已付账单" : "Print paid bill");
      // The bill is refunded in full from Orders on another screen; staff here press Refresh tables.
      state.refund = { refundedMinor: "1601", refundPendingMinor: "0" };
      await floor.refresh();
      await expect(floor.heading).toHaveText(zh ? "已退款" : "Refunded");
      await expect(
        floor.panel.getByRole("button", { name: zh ? "打印账单" : "Print bill" }),
      ).toBeVisible();
      for (const stale of zh
        ? ["打印已付账单", "实付合计", "已全部付清"]
        : ["Print paid bill", "Total paid", "Paid in full"])
        await expect(floor.panel).not.toContainText(stale);
      // The Tables row says the same, at what the table comes to after the refund.
      await expect(floor.row.locator(".table-row__status")).toContainText(
        zh ? "已全部退款 · 客人走后关台" : "Fully refunded · close when the guests leave",
      );
      await expect(floor.row.locator(".table-row__detail")).toHaveText(
        zh ? "$0.00 · 已退 $16.01" : "$0.00 · $16.01 refunded",
      );
      await fits(floor.row.locator(".table-row__detail"), floor.row.locator(".table-row__open"));
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b65-tables-refunded-${language}-${width}.png`,
        fullPage: true,
      });
    });

    // Batch 66 (v15 b65 live, S65 A/C): nobody presses Refresh tables. The panel kept "Paid /
    // Print paid bill" for about 20 s (the floor's own 30 s read); now within one paid-bill read.
    test(`@production b66: an open checkout panel turns Refunded by itself within seconds of a refund on another screen (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await page.clock.install();
      const state: { refund: Refund } = { refund: null };
      const floor = await tables(page, language, state);
      await floor.open();
      await expect(floor.heading).toHaveText(zh ? "已付款" : "Paid");
      await expect(floor.panel).toContainText(zh ? "打印已付账单" : "Print paid bill");
      let billReads = 0,
        floorReads = 0;
      page.on("request", (request) => {
        if (request.url().endsWith("/merchant/dining/table-bill")) billReads += 1;
        if (request.url().endsWith("/merchant/dining/tables")) floorReads += 1;
      });
      // Nothing changed for 9 s: the bill is read once more, the floor not at all.
      await page.clock.runFor(9_000);
      await expect.poll(() => billReads).toBe(1);
      expect(floorReads).toBe(0);
      await expect(floor.heading).toHaveText(zh ? "已付款" : "Paid");
      // Refunded in full from Orders on another screen; this screen is not touched.
      state.refund = { refundedMinor: "1601", refundPendingMinor: "0" };
      await page.clock.runFor(9_000);
      await expect(floor.heading).toHaveText(zh ? "已退款" : "Refunded");
      await expect(
        floor.panel.getByRole("button", { name: zh ? "打印账单" : "Print bill" }),
      ).toBeVisible();
      for (const stale of zh ? ["打印已付账单", "实付合计"] : ["Print paid bill", "Total paid"])
        await expect(floor.panel).not.toContainText(stale);
      // The floor is read again once, so the rounds line and the Tables row say the same.
      await expect(floor.panel.locator(".dining-rounds__table")).toHaveText(
        zh ? "已全部退款 · 客人走后关台" : "Fully refunded · close when the guests leave",
      );
      await expect(floor.row.locator(".table-row__status")).toContainText(
        zh ? "已全部退款 · 客人走后关台" : "Fully refunded · close when the guests leave",
      );
      expect(floorReads).toBe(1);
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b66-tables-refunded-by-itself-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b65: a part-refunded table is never "paid in full", at its amount after the refund (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const floor = await tables(page, language, {
        refund: { refundedMinor: "500", refundPendingMinor: "0" },
      });
      const status = floor.row.locator(".table-row__status");
      await expect(status).toContainText(
        zh ? "部分已退款 · 客人走后关台" : "Part refunded · close when the guests leave",
      );
      await expect(status).not.toContainText(zh ? "已付清" : "Paid ·");
      await expect(floor.row.locator(".table-row__detail")).toHaveText(
        zh ? "$11.01 · 已退 $5.00" : "$11.01 · $5.00 refunded",
      );
      await fits(floor.row.locator(".table-row__detail"), floor.row.locator(".table-row__open"));
      await floor.open();
      // The receipt says part of it went back; the rounds line says so too.
      await expect(floor.panel.locator(".dining-rounds__table")).toHaveText(
        zh ? "部分已退款 · 客人走后关台" : "Part refunded · close when the guests leave",
      );
      await expect(floor.panel).not.toContainText(zh ? "已付清" : "Paid · close");
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b65-tables-part-${language}-${width}.png`,
        fullPage: true,
      });
    });

    test(`@production b65: a bill refunded in full with part still on its way reads being refunded (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      // $10.00 back on the card, $6.01 still on its way there.
      const floor = await tables(page, language, {
        refund: { refundedMinor: "1601", refundPendingMinor: "601" },
      });
      await expect(floor.row.locator(".table-row__status")).toContainText(
        zh ? "退款中 · 客人走后关台" : "Being refunded · close when the guests leave",
      );
      await expect(floor.row.locator(".table-row__detail")).toHaveText(
        zh ? "已退 $10.00 · 退回中 $6.01" : "$10.00 refunded · $6.01 on its way",
      );
      await fits(floor.row.locator(".table-row__detail"), floor.row.locator(".table-row__open"));
      await floor.open();
      await expect(floor.heading).toHaveText(zh ? "退款中" : "Being refunded");
      await expect(floor.panel.locator(".dining-rounds__table")).toHaveText(
        zh ? "退款中 · 客人走后关台" : "Being refunded · close when the guests leave",
      );
      await expect(floor.panel).toContainText(
        zh ? "正在全部退款。客人离开后关台。" : "Being refunded in full.",
      );
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b65-tables-on-its-way-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }

/* ---------- Orders: order 79's cash refund under its totals ---------- */

const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
/** Order 79: $17.80 in cash at the counter; a $3.67 request given back as $3.65 from the drawer. */
const cashOrder = {
  orderReference: id(79),
  orderNumber: "79",
  orderType: "Pickup",
  sourceChannel: "Pos",
  submittedAt: "2026-11-25T01:30:00.000Z",
  observedAt: "2026-11-25T01:45:00.000Z",
  initialBatchReference: id(81),
  canRequestAcceptance: false,
  canViewPayments: false,
  canRecordCardMachinePayment: false,
  currentVersion: 4,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: {
      amountMinor: "1780",
      takenAt: "2026-11-25T01:31:00.000Z",
      recordedAfterOutage: false,
      refundedMinor: "365",
      cash: { tenderedMinor: "2000", changeMinor: "220", roundingMinor: "0" },
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
  currentPhase: "Fulfilled",
};
const cashDetail = {
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order: cashOrder,
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
      {
        orderItemReference: id(202),
        orderBatchReference: id(81),
        name: "Soy milk (TEST)",
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
      subtotal: money("1575"),
      discount: money("0"),
      tax: money("205"),
      fee: money("0"),
      taxRounding: money("0"),
      total: money("1780"),
    },
  },
  record: {
    accepted: [],
    handedOver: [],
    payments: [
      { method: "Cash", part: null, round: null, by: "You", at: "2026-11-25T01:31:00.000Z" },
    ],
    cancellations: [],
    refunds: [
      {
        method: "Cash",
        amountMinor: "367",
        by: "You",
        approvedBy: null,
        at: "2026-11-25T01:41:00.000Z",
        cashGivenBackMinor: "365",
        reasonCode: "CUSTOMER_REQUEST",
      },
    ],
    writeOff: null,
    paidOnlineByGuest: false,
  },
};

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b65: a counter cash refund under the Orders totals names the cash given back, why and when (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/session", (route) =>
        route.fulfill({ headers, json: session("2026-11-24") }),
      );
      await page.route("**/merchant/orders*", (route) =>
        route.fulfill({ headers, json: { items: [cashOrder], nextAfterOrderReference: null } }),
      );
      await page.route("**/merchant/orders/detail*", (route) =>
        route.fulfill({ headers, json: cashDetail }),
      );
      await page.goto("/operations/orders");
      const row = page.locator("li.order-row").filter({
        has: page.locator(".order-row__number", { hasText: /^\s*79\b/u }),
      });
      await expect(row.locator(".order-row__refunded")).toHaveText(
        zh ? "已退 $3.65" : "$3.65 refunded",
      );
      // The one order on the list opens by itself.
      const opener = row.locator(".order-row__open");
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      const totals = page.locator(".order-lines-totals > div");
      const label = zh
        ? "已退现金 · 顾客要求退款 · 20:41"
        : "Cash given back · Customer asked for a refund · 20:41";
      const value = (term: string) =>
        totals
          .filter({ has: page.locator("dt", { hasText: new RegExp(`^${term}$`, "u") }) })
          .locator("dd")
          .first();
      await expect(value(label)).toHaveText("−$3.65");
      await expect(value(zh ? "退款后合计" : "Total after refunds")).toHaveText("$14.15");
      await expect(
        totals.filter({ hasText: new RegExp(`^${zh ? "已退款" : "Refunded"}`, "u") }),
      ).toHaveCount(0);
      // Each line: its amount on one line beside the words; words with room, or wrapped in place.
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
              amountLeft: amountBox.left,
              amountRight: amountBox.right,
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
        if (r.termLines <= 1) expect(r.room, r.text).toBeGreaterThanOrEqual(40);
      }
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b65-cash-refund-line-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }

/* ---------- Payment page: the instruction ends once the cash is recorded as given back ---------- */

async function cashRefundPage(page: Page, language: Language) {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.route("**/merchant/session", (route) =>
    route.fulfill({ headers, json: session("2026-11-24") }),
  );
  const intent = id(331),
    attempt = id(332);
  let requested: Record<string, unknown> | null = null;
  let given = false;
  await page.route("**/merchant/payments/refunds/approvals", (route) =>
    route.fulfill({
      headers,
      json: {
        observedAt: new Date().toISOString(),
        canApprove: false,
        soleOperator: null,
        entries: [],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/context", (route) =>
    route.fulfill({
      headers,
      json: {
        paymentIntentReference: intent,
        paymentAttemptReference: attempt,
        orderReference: id(79),
        orderBatchReference: id(81),
        observedAt: new Date().toISOString(),
        paymentState: "Captured",
        paymentMethod: "CardMachine",
        paidInCash: true,
        cashLeftMinor: given ? "1415" : "1780",
        currencyCode: "CAD",
        capturedAmountMinor: "1780",
        confirmedRefundMinor: given ? "367" : "0",
        pendingRefundMinor: requested !== null && !given ? "367" : "0",
        canRequest: true,
        requestBlocked: null,
        canSend: true,
      },
    }),
  );
  const request = () => ({
    requestReference: String(requested?.requestReference),
    operationReference: String(requested?.operationReference),
    claimVersion: 1,
    requestedAt: "2026-11-25T01:40:00.000Z",
    reasonCode: "CUSTOMER_REQUEST",
    currencyCode: "CAD",
    amountMinor: "367",
    decline: null,
    progress: given ? "Refunded" : "Recorded",
    paymentMethod: "CardMachine",
  });
  await page.route("**/merchant/payments/refunds/items", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(79),
        orderNumber: "79",
        canRequest: true,
        claimVersion: requested === null ? 0 : 1,
        recentRequests: requested === null ? [] : [request()],
        items: [
          {
            orderBatchReference: id(81),
            orderItemReference: id(202),
            label: "Soy milk (TEST)",
            quantity: 1,
            unclaimedQuantity: requested === null ? 1 : 0,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: intent,
            paymentMethod: "CardMachine",
          },
          {
            orderBatchReference: id(81),
            orderItemReference: id(201),
            label: "Beef noodles (TEST)",
            quantity: 1,
            unclaimedQuantity: 1,
            paymentCaptured: true,
            refundedByCancellation: false,
            paymentIntentReference: intent,
            paymentMethod: "CardMachine",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/preview", (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    return route.fulfill({
      headers,
      json: {
        status: "Previewed",
        requestReference: body.requestReference,
        operationReference: body.operationReference,
        claimVersion: 0,
        currencyCode: "CAD",
        amountMinor: "367",
        paymentAttemptReferences: [attempt],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        components: {
          netAmountMinor: "325",
          taxAmountMinor: "42",
          tipAmountMinor: "0",
          serviceChargeAmountMinor: "0",
          serviceChargeTaxAmountMinor: "0",
        },
      },
    });
  });
  await page.route("**/merchant/payments/refunds/request", (route) => {
    requested = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    return route.fulfill({
      status: 202,
      headers,
      json: {
        status: "RequestRecorded",
        requestReference: requested.requestReference,
        operationReference: requested.operationReference,
        claimVersion: 1,
        currencyCode: "CAD",
        amountMinor: "367",
        paymentAttemptReferences: [attempt],
        approvalRequired: false,
        escalationReasons: [],
        approveAlone: false,
        replayed: false,
      },
    });
  });
  await page.route("**/merchant/payments/refunds/status", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(79),
        requestReference: requested?.requestReference,
        operationReference: requested?.operationReference,
        observedAt: new Date().toISOString(),
        currencyCode: "CAD",
        amountMinor: "367",
        payments: [
          {
            paymentAttemptReference: attempt,
            paymentIntentReference: intent,
            state: given ? "Confirmed" : "NotDispatched",
            method: "CardMachine",
            refundedOnCardMachineAt: given ? "2026-11-25T01:41:00.000Z" : null,
            cardMachineSlipReference: null,
            executionOperationReference: null,
            executionApprovalReference: null,
            amountMinor: "367",
            confirmedMinor: given ? "367" : "0",
            pendingMinor: given ? "0" : "367",
            cashGivenBackMinor: "365",
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/payments/refunds/card-machine-record", (route) => {
    given = true;
    return route.fulfill({
      headers,
      json: {
        status: "Recorded",
        orderReference: id(79),
        requestReference: requested?.requestReference,
        amountMinor: "365",
        refundedAt: "2026-11-25T01:41:00.000Z",
        receipt: "NoDigitalReceipt",
      },
    });
  });
  await page.goto("/app/operations/payments/" + intent + "/refund");
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b65: the Payment page stops saying "Now give back…" once the cash is recorded as given back (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await cashRefundPage(page, language);
      await page.getByRole("spinbutton", { name: /Soy milk/u }).fill("1");
      await page
        .getByRole("combobox", { name: zh ? "原因" : "Reason" })
        .selectOption("CUSTOMER_REQUEST");
      await page.getByRole("button", { name: zh ? "核对退款" : "Review refund" }).click();
      await page.getByRole("checkbox", { name: zh ? /我已核对/u : /I confirm/u }).check();
      await page
        .getByRole("button", { name: zh ? "记录退款申请" : "Record refund request" })
        .click();
      const instruction = zh ? "请从钱箱退还现金 $3.65" : "Now give back $3.65 from the drawer";
      const main = page.getByRole("main");
      await expect(main).toContainText(instruction);
      await page
        .getByRole("button", { name: zh ? "已退还现金 $3.65" : "Gave back $3.65 in cash" })
        .click();
      await expect(main).toContainText(zh ? "已记录退还现金" : "Cash given back recorded: $3.65");
      // Never told to give back again what is already back.
      await expect(main).not.toContainText(instruction);
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b65-cash-recorded-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }

/* ---------- Settlement and Reports: the same label, the reason for different figures ---------- */

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b65: Reports says what its Online leaves out that Settlement counts, and Settlement says why (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/session", (route) =>
        route.fulfill({ headers, json: session("2026-10-14") }),
      );
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({
          headers,
          json: {
            businessDate: "2026-10-14",
            startsAt: "2026-10-14T08:00:00.000Z",
            endsAt: "2026-10-15T08:00:00.000Z",
            timeZone: "America/Toronto",
            observedAt: "2026-10-15T01:00:00.000Z",
          },
        }),
      );
      // Three orders not kept were taken ($42.39) and given back the same day, all online.
      const view = storeReportsViewFixture() as {
        summary: Record<string, unknown>;
        byChannel: Record<string, unknown>[];
      };
      view.summary.cancelledInFullCount = 3;
      view.summary.cancelledInFullMinor = "4239";
      const online = view.byChannel.find((entry) => entry.channel === "Online");
      if (online === undefined) throw new Error("fixture has no Online row");
      online.cancelledInFullCount = 3;
      online.cancelledInFullMinor = "4239";
      await page.route("**/merchant/reports?*", (route) => route.fulfill({ headers, json: view }));
      await page.route("**/merchant/reports/tonight", (route) =>
        route.fulfill({ status: 503, json: { error: "unavailable" } }),
      );
      await page.goto("/app/reports/operations");
      await page.getByRole("button", { name: zh ? "按时段报表" : "Sales by period" }).click();
      const note = page.locator(".store-reports__left-out");
      await expect(note).toHaveText(
        zh
          ? "线上（客人手机）没有算当天收款又全部退回的 3 笔订单（$42.39）。结算把它们算进线上（客人手机）的实收和退款，所以那两项都多 $42.39；净实收相同。"
          : "Online (guest's phone) leaves out 3 orders ($42.39) taken and given back the same day. Settlement counts them in its Online (guest's phone) taken and refunded, so both read $42.39 more there; Net taken is the same.",
      );
      // Right under the table it explains.
      const table = page.getByRole("table", { name: zh ? "按付款方式销售" : "Sales by payment" });
      const tableBox = await table.boundingBox();
      const noteBox = await note.boundingBox();
      expect(noteBox?.y ?? 0).toBeGreaterThanOrEqual((tableBox?.y ?? 0) + (tableBox?.height ?? 0));
      const noteRight = await note.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return {
          right: Math.max(...[...range.getClientRects()].map((r) => r.right)),
          box: node.getBoundingClientRect().right,
          overflow: (node as HTMLElement).scrollWidth - (node as HTMLElement).clientWidth,
        };
      });
      expect(noteRight.overflow).toBeLessThanOrEqual(0);
      expect(noteRight.right).toBeLessThanOrEqual(noteRight.box + 0.5);
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b65-reports-left-out-${language}-${width}.png`,
        fullPage: true,
      });

      // Batch 66: Settlement says it on a day Reports leaves orders out (here, the same 3).
      await page.route("**/merchant/settlement*", (route) =>
        route.fulfill({
          headers,
          json: {
            ...settlementViewFixture(),
            reportsLeftOut: [
              { channel: "Online", orderCount: 3, amountMinor: "4239", currencyCode: "CAD" },
            ],
          },
        }),
      );
      await page.goto("/app/operations/payment-reconciliation");
      const gap = page.locator(".settlement__reports-gap");
      await expect(gap).toContainText(
        zh
          ? "报表把当天收款又全部退回的 3 笔订单（$42.39）另外列出"
          : "Reports lists 3 orders ($42.39) taken and given back the same day apart",
      );
      // Right under the day's totals it explains, inside the page.
      const totals = page.locator(".settlement__totals").first();
      const totalsBox = await totals.boundingBox();
      const gapBox = await gap.boundingBox();
      expect(gapBox?.y ?? 0).toBeGreaterThanOrEqual((totalsBox?.y ?? 0) + (totalsBox?.height ?? 0));
      expect(
        await gap.evaluate(
          (node) => (node as HTMLElement).scrollWidth - (node as HTMLElement).clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b65-settlement-gap-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }
