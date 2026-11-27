import { expect, test, type Locator, type Page } from "@playwright/test";
import { headers, id, inLanguage, quietFrame, session, sizes } from "./merchant-shell-fixture";

/**
 * Batch 67 (polish backlog items 3, 6, 8 and 22; v15 b65 and b66 live at TM2). Synthetic Store;
 * the server is answered in the browser with the shapes seen live (TEST-only data):
 *  - 3: a part-refunded table order's Orders note "Part refunded at the table · guest's phone" was
 *    hidden on phones and beside an open order, while the fully refunded note showed.
 *  - 6: zh 390, the counter cash refund line under the totals put "01:32" alone under its date.
 *  - 8: on Counter, a "Sent, not paid yet" row whose payment form had been opened and closed read
 *    "收款 · $14.13" while the other row read "收款".
 *  - 22: after the 04:00 business-day start, a still-seated paid table's order of 03:58 was a
 *    hidden row under Orders > Today; staff needed Filter > All days to refund it.
 * Measured at 390, 1024 and 1440 in English and Chinese, with room left for Linux fonts (DejaVu).
 */
async function noSideways(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
}

const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const batch = (n: number, submittedAt?: string) => ({
  orderBatchReference: id(n),
  sequence: 1,
  ...(submittedAt === undefined ? {} : { submittedAt }),
  acceptanceStatus: "Accepted",
  canRequestAcceptance: false,
  canCancel: false,
  staffCancellation: null,
  canCancelItems: false,
});
const common = (n: number, number: string, submittedAt: string, businessDate?: string) => ({
  orderReference: id(n),
  orderNumber: number,
  ...(businessDate === undefined ? {} : { businessDate }),
  submittedAt,
  observedAt: "2026-11-27T09:20:00.000Z",
  initialBatchReference: id(n + 50),
  canRequestAcceptance: false,
  canViewPayments: false,
  canRecordCardMachinePayment: false,
  currentVersion: 4,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  currentPhase: "Fulfilled",
});
const row = (page: Page, number: RegExp | string) =>
  page.locator("li.order-row").filter({
    has: page.locator(".order-row__number", {
      hasText: typeof number === "string" ? new RegExp(`^\\s*${number}\\b`, "u") : number,
    }),
  });
const businessDay = (businessDate: string, startsAt: string) => ({
  businessDate,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 24 * 3_600_000).toISOString(),
  timeZone: "America/Toronto",
  observedAt: new Date().toISOString(),
});

/* ---------- 3: a part refund at the table is said on the Orders row at every width ---------- */

/** S65 B: paid $16.01 by phone ($14.13 and a $1.88 tip), $5.00 refunded, guests still seated. */
const partRefunded = {
  ...common(8, "8", "2026-11-27T01:04:00.000Z"),
  orderType: "DineIn",
  sourceChannel: "Qr",
  batches: [batch(58)],
  tableBill: {
    totalMinor: "1413",
    paid: { amountMinor: "1601", method: "Online", refundedMinor: "500", tipMinor: "188" },
    checkingOut: true,
  },
};
/** A counter pickup paid at the counter, to open beside the list. */
const counterOrder = {
  ...common(31, "31", "2026-11-27T01:10:00.000Z"),
  orderType: "Pickup",
  sourceChannel: "Pos",
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: {
      amountMinor: "1413",
      takenAt: "2026-11-27T01:11:00.000Z",
      recordedAfterOutage: false,
      refundedMinor: "0",
    },
  },
  batches: [batch(81)],
};
const counterLines = {
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
};

/**
 * The note on its row: shown, inside the row and never under the amount. It wraps in place in the
 * grey line; kept on one line, it keeps about 40 px to spare for Linux fonts there, or could take a
 * line of its own with that room (where a wider font moves it).
 */
async function noteFits(note: Locator, within: Locator) {
  await expect(note).toBeVisible();
  const found = await note.evaluate(
    (node, rowNode) => {
      const rowBox = (rowNode as HTMLElement).getBoundingClientRect();
      const amount = (rowNode as HTMLElement)
        .querySelector(".order-workbench-amount")
        ?.getBoundingClientRect();
      // The box the note wraps in: its nearest ancestor that is not inline.
      let boxNode = (node as HTMLElement).parentElement as HTMLElement;
      while (/^(inline|contents)$/u.test(getComputedStyle(boxNode).display))
        boxNode = boxNode.parentElement as HTMLElement;
      const box = boxNode.getBoundingClientRect();
      const style = getComputedStyle(boxNode);
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
        rowRight: rowBox.right,
        room: box.right - parseFloat(style.paddingRight) - right,
        ownLineRoom: inner - natural,
        lines: new Set(rects.map((r) => Math.round(r.top))).size,
        overlaps: rects.some(
          (r) =>
            amount !== undefined &&
            r.right > amount.left + 1 &&
            r.left < amount.right - 1 &&
            r.bottom > amount.top + 1 &&
            r.top < amount.bottom - 1,
        ),
      };
    },
    await within.elementHandle(),
  );
  expect(found.overflow, found.text).toBeLessThanOrEqual(0);
  expect(found.right, found.text).toBeLessThanOrEqual(found.rowRight + 0.5);
  expect(found.overlaps, found.text).toBe(false);
  if (found.lines <= 1)
    expect(Math.max(found.room, found.ownLineRoom), found.text).toBeGreaterThanOrEqual(40);
}

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b67: a part-refunded table's Orders note shows on phones and beside an open order (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/session", (route) =>
        route.fulfill({ headers, json: session("2026-11-26") }),
      );
      await page.route("**/merchant/orders*", (route) =>
        route.fulfill({
          headers,
          json: { items: [counterOrder, partRefunded], nextAfterOrderReference: null },
        }),
      );
      await page.route("**/merchant/orders/detail*", (route) =>
        route.fulfill({
          headers,
          json: {
            screenId: "OPS-ORDER-DETAIL",
            pickupContact: null,
            order: counterOrder,
            lines: counterLines,
          },
        }),
      );
      await page.goto("/operations/orders");
      const part = row(page, "8");
      const words = zh
        ? "已在桌上部分退款 · 客人手机"
        : "Part refunded at the table · guest's phone";
      await expect(part.locator(".order-row__refunded")).toHaveText(
        zh ? "已退 $5.00" : "$5.00 refunded",
      );
      const note = part.locator(".order-row__said");
      await expect(note).toHaveText(words);
      await noteFits(note, part);
      // Beside an open order (the panel takes the right on a tablet and a desktop) it stays.
      if (width > 390) {
        const opener = row(page, "31").locator(".order-row__open");
        await opener.click();
        await expect(opener).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator(".order-workbench")).toHaveAttribute("data-panel", "open");
        await expect(note).toHaveText(words);
        await noteFits(note, part);
      }
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b67-part-refunded-row-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }

/* ---------- 6: a cash refund before 04:00 keeps its date and its time on one line ---------- */

/** Order 12 of Thu Nov 26, paid in cash; $3.67 asked back at 01:32 on Fri Nov 27, $3.65 given. */
const cashOrder = {
  ...common(79, "12", "2026-11-27T06:20:00.000Z", "2026-11-26"),
  listedBusinessDate: "2026-11-26",
  initialBatchReference: id(81),
  orderType: "Pickup",
  sourceChannel: "Pos",
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: {
      amountMinor: "1780",
      takenAt: "2026-11-27T06:21:00.000Z",
      recordedAfterOutage: false,
      refundedMinor: "365",
      cash: { tenderedMinor: "2000", changeMinor: "220", roundingMinor: "0" },
    },
  },
  batches: [batch(81)],
};
const cashDetail = {
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order: cashOrder,
  lines: {
    items: [
      counterLines.items[0],
      {
        ...counterLines.items[0],
        orderItemReference: id(202),
        name: "Soy milk (TEST)",
        unitPrice: money("325"),
        subtotal: money("325"),
        tax: money("42"),
        total: money("367"),
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
      { method: "Cash", part: null, round: null, by: "You", at: "2026-11-27T06:21:00.000Z" },
    ],
    cancellations: [],
    refunds: [
      {
        method: "Cash",
        amountMinor: "367",
        by: "You",
        approvedBy: null,
        at: "2026-11-27T06:32:00.000Z",
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
    test(`@production b67: a cash refund line before the day's start keeps its date and time together (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/session", (route) =>
        route.fulfill({ headers, json: session("2026-11-26") }),
      );
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({ headers, json: businessDay("2026-11-26", "2026-11-26T09:00:00.000Z") }),
      );
      await page.route("**/merchant/orders*", (route) =>
        route.fulfill({ headers, json: { items: [cashOrder], nextAfterOrderReference: null } }),
      );
      await page.route("**/merchant/orders/detail*", (route) =>
        route.fulfill({ headers, json: cashDetail }),
      );
      await page.goto("/operations/orders");
      const opener = row(page, "12").locator(".order-row__open");
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      const when = zh ? "11月27日周五 01:32" : "Fri, Nov 27 01:32";
      const term = page
        .locator(".order-lines-totals dt")
        .filter({ hasText: zh ? /^已退现金/u : /^Cash given back/u });
      await expect(term).toHaveCount(1);
      // It reads as before (the joiners are invisible and never read aloud).
      expect((await term.textContent())?.replace(/\u2060/gu, "").replace(/\u00a0/gu, " ")).toBe(
        zh
          ? `已退现金 · 顾客要求退款 · ${when}`
          : `Cash given back · Customer asked for a refund · ${when}`,
      );
      const found = await term.evaluate((node) => {
        const text = node.firstChild as Text;
        const all = text.data;
        const start = all.lastIndexOf(" · ") + 3;
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, all.length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0);
        const box = node.getBoundingClientRect();
        const row = (node.parentElement as HTMLElement).getBoundingClientRect();
        const amount = (node.parentElement as HTMLElement)
          .querySelector("dd")
          ?.getBoundingClientRect();
        return {
          whenLines: new Set(rects.map((r) => Math.round(r.top))).size,
          whenRight: Math.max(...rects.map((r) => r.right)),
          termRight: box.right,
          overflow: (node as HTMLElement).scrollWidth - (node as HTMLElement).clientWidth,
          amountLeft: amount?.left ?? row.right,
          rowRight: row.right,
        };
      });
      expect(found.whenLines, when).toBe(1);
      expect(found.overflow).toBeLessThanOrEqual(0);
      expect(found.whenRight).toBeLessThanOrEqual(found.termRight + 0.5);
      expect(found.termRight).toBeLessThanOrEqual(found.amountLeft + 0.5);
      await expect(term.locator("xpath=..").locator("dd").first()).toHaveText("−$3.65");
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b67-cash-refund-when-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }

/* ---------- 8: every Counter "Sent, not paid yet" row reads Take payment ---------- */

const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const menu = {
  screenId: "OPS-ORDER-ENTRY",
  menu: {
    status: "Found",
    schemaVersion: 1,
    projection: {},
    scope: {},
    menu: {
      menuReference: id(1),
      menuVersionReference: id(2),
      releaseReference: id(3),
      locale: "en-CA",
      name: "Menu",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveUntil: null,
      sections: [
        {
          sectionReference: id(4),
          name: "Noodles (TEST)",
          sellables: [
            {
              sellableReference: id(5),
              productVersionReference: id(6),
              name: "Beef noodles (TEST)",
              presentationRole: "Standard",
              pinned: false,
              availability: "Available",
              optionRules: [],
              allergenDisclosure: {},
              displayPrice: price("12.50"),
              taxDisplayContext: {},
            },
          ],
        },
      ],
    },
  },
};
const sent = (n: number, number: string, amountDueMinor: string | null) => ({
  orderReference: id(n),
  orderNumber: number,
  orderType: "Pickup",
  sourceChannel: "Pos",
  submittedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  observedAt: new Date().toISOString(),
  initialBatchReference: id(n + 1),
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: null,
    payBy: new Date(Date.now() + 20 * 60_000).toISOString(),
    amountDueMinor,
    canCancelUnpaid: true,
    cancelledBeforePayment: null,
  },
  canRecordCardMachinePayment: true,
  canViewPayments: false,
  batches: [
    {
      orderBatchReference: id(n + 1),
      sequence: 1,
      acceptanceStatus: "NotAccepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  currentPhase: "Submitted",
  currentVersion: 1,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: true,
});
const due: Record<string, string> = { [id(60)]: "1413", [id(70)]: "803" };

for (const language of ["en", "zh-Hans"] as const)
  test(`@production b67: every Sent, not paid yet row reads Take payment, before and after its form was opened (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await inLanguage(page, language);
    await quietFrame(page);
    await page.route("**/merchant/counter/menu**", (route) =>
      route.fulfill({ headers, json: menu }),
    );
    await page.route("**/merchant/orders", (route) =>
      route.fulfill({
        headers,
        json: {
          items: [sent(70, "46", null), sent(60, "45", null)],
          nextAfterOrderReference: null,
        },
      }),
    );
    await page.route("**/merchant/orders/detail?*", (route) => {
      const reference = new URL(route.request().url()).searchParams.get("order") ?? "";
      const amount = due[reference] ?? "1413";
      const order = reference === id(70) ? sent(70, "46", amount) : sent(60, "45", amount);
      return route.fulfill({
        headers,
        json: {
          screenId: "OPS-ORDER-DETAIL",
          pickupContact: null,
          order,
          lines: {
            items: [{ ...counterLines.items[0], total: money(amount) }],
            totals: { ...counterLines.totals, total: money(amount), tip: money("0") },
          },
        },
      });
    });
    const label = zh ? "收款" : "Take payment";
    for (const [width, height] of sizes) {
      const where = `${language} ${width}`;
      await page.setViewportSize({ width, height });
      await page.goto("/operations/order-entry");
      const awaiting = page.getByRole("region", {
        name: zh ? "已发送，尚未付款" : "Sent, not paid yet",
      });
      const buttons = awaiting.locator(".counter-order__primary");
      await expect(buttons, where).toHaveText([label, label]);
      // Open the first row's form, read its amount, and close it again.
      await buttons.first().click();
      await expect(
        awaiting.getByRole("button", {
          name: zh ? "已用刷卡机付款 · $8.03" : "Paid on card machine · $8.03",
        }),
        where,
      ).toBeVisible();
      await awaiting.getByRole("button", { name: zh ? "关闭" : "Close", exact: true }).click();
      await expect(awaiting.locator(".counter-order__primary"), where).toHaveText([label, label]);
      // Each button is the same size and sits inside its row with room to spare.
      const boxes = await awaiting.locator(".counter-order__primary").evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          const li = (node.closest("li") as HTMLElement).getBoundingClientRect();
          return { width: Math.round(box.width), right: box.right, rowRight: li.right };
        }),
      );
      expect(new Set(boxes.map((box) => box.width)).size, where).toBe(1);
      for (const box of boxes) expect(box.right, where).toBeLessThanOrEqual(box.rowRight + 0.5);
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b67-counter-take-payment-${language}-${width}.png`,
        fullPage: true,
      });
    }
  });

/* ---------- 22: a still-seated table's order of before 04:00 stays on Orders > Today ---------- */

/** R66 A: seated at 03:58 (business day Thu Nov 26), paid $16.01 by phone at 04:01, still seated. */
const seated = {
  ...common(24, "24", "2026-11-27T08:58:00.000Z", "2026-11-26"),
  listedBusinessDate: "2026-11-26",
  orderType: "DineIn",
  sourceChannel: "Qr",
  batches: [batch(74, "2026-11-27T08:58:00.000Z")],
  tableBill: {
    totalMinor: "1413",
    paid: { amountMinor: "1601", method: "Online", tipMinor: "188" },
    checkingOut: true,
  },
};
/** R66 D: the table next to it, paid and closed before 04:00: it stays with its own day. */
const closed = {
  ...common(23, "23", "2026-11-27T08:30:00.000Z", "2026-11-26"),
  listedBusinessDate: "2026-11-26",
  orderType: "DineIn",
  sourceChannel: "Qr",
  batches: [batch(73, "2026-11-27T08:30:00.000Z")],
  tableBill: {
    totalMinor: "1413",
    paid: { amountMinor: "1413", method: "Online" },
  },
};
/** Today's one order, after the day's start. */
const todays = {
  ...common(90, "1", "2026-11-27T09:10:00.000Z", "2026-11-27"),
  listedBusinessDate: "2026-11-27",
  orderType: "Pickup",
  sourceChannel: "Pos",
  counter: {
    recordedAfterOutage: false,
    paidOnCardMachine: {
      amountMinor: "1413",
      takenAt: "2026-11-27T09:11:00.000Z",
      recordedAfterOutage: false,
      refundedMinor: "0",
    },
  },
  batches: [batch(140, "2026-11-27T09:10:00.000Z")],
};

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    const zh = language === "zh-Hans";
    test(`@production b67: after the day's start, a still-seated table's order of before 04:00 stays on Orders, with its date (${language}, ${width})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/session", (route) =>
        route.fulfill({ headers, json: session("2026-11-27") }),
      );
      await page.route("**/merchant/business-day", (route) =>
        route.fulfill({ headers, json: businessDay("2026-11-27", "2026-11-27T09:00:00.000Z") }),
      );
      await page.route("**/merchant/orders*", (route) =>
        route.fulfill({
          headers,
          json: {
            items: [todays, seated, closed],
            nextAfterOrderReference: null,
            todayOrderCount: 1,
          },
        }),
      );
      await page.route("**/merchant/orders/detail*", (route) =>
        route.fulfill({
          headers,
          json: {
            screenId: "OPS-ORDER-DETAIL",
            pickupContact: null,
            order: seated,
            lines: counterLines,
          },
        }),
      );
      await page.goto("/operations/orders");
      await expect(row(page, "1")).toBeVisible();
      // The seated table is listed by default, numbered with its own day, under that day's heading.
      const still = row(page, /11\/26\s·\s24/u);
      await expect(still).toBeVisible();
      await expect(still.locator(".order-row__open")).toHaveText(/^11\/26 · 24$/u);
      const heading = page
        .locator(".order-list__day")
        .filter({ hasText: zh ? "11月26日" : "Nov 26" });
      await expect(heading).toBeVisible();
      const order = await page
        .locator("li.order-list__day, li.order-row:not([hidden])")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent?.slice(0, 24) ?? ""));
      const at = order.findIndex((text) => /11\/26/u.test(text));
      expect(order.slice(0, at).some((text) => /11月26日|Nov 26/u.test(text))).toBe(true);
      // A table that closed before the day's start stays with its day (never dropped: All days).
      await expect(row(page, /11\/26\s·\s23/u)).toBeHidden();
      // Its row fits: nothing cut off or past the screen.
      const fit = await still.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const number = node.querySelector(".order-row__open") as HTMLElement;
        return {
          right: box.right,
          width: window.innerWidth,
          numberOverflow: number.scrollWidth - number.clientWidth,
        };
      });
      expect(fit.right).toBeLessThanOrEqual(fit.width);
      expect(fit.numberOverflow).toBeLessThanOrEqual(0);
      // Staff open it from here to refund it.
      await still.locator(".order-row__open").click();
      await expect(still.locator(".order-row__open")).toHaveAttribute("aria-expanded", "true");
      await noSideways(page);
      await page.screenshot({
        path: `test-results/b67-seated-earlier-day-${language}-${width}.png`,
        fullPage: true,
      });
    });
  }
