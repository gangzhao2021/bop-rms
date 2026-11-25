import { windowEdgeSweep } from "./focus-ring-clip";
import { expect, test, type Page } from "@playwright/test";
import {
  headers,
  id,
  inLanguage,
  quietFrame,
  sizes,
  type Language,
} from "./merchant-shell-fixture";

/**
 * Batch 63 (page design review of v15 batch 62; Figma 37:2, 39:64, 46:2, 58:65): the shared
 * merchant shell and Orders, Exceptions and Approvals, measured at 390, 1024 and 1440 in English
 * and Chinese. Synthetic HTTP interception, TEST-only data. Each measurement keeps room for Linux
 * fonts (DejaVu Sans runs about 10% wider than the macOS system font).
 */
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const batch = (n: number, status: "Accepted" | "NotAccepted" = "Accepted") => ({
  orderBatchReference: id(200 + n),
  sequence: 1,
  acceptanceStatus: status,
  canRequestAcceptance: status === "NotAccepted",
  canCancel: false,
  staffCancellation: null,
  canCancelItems: false,
});
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const order = (n: number, extra: Record<string, unknown> = {}) => ({
  orderReference: id(n),
  orderNumber: String(n),
  orderType: "Pickup",
  sourceChannel: "Web",
  submittedAt: minutesAgo(30),
  observedAt: minutesAgo(1),
  initialBatchReference: id(200 + n),
  batches: [batch(n)],
  canRequestAcceptance: false,
  currentPhase: "Accepted",
  currentVersion: 1,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  paidOnline: money("1413"),
  summary: {
    items: [
      { name: "Beef noodles (TEST)", option: null, quantity: 2 },
      { name: "Soy milk (TEST)", option: "Hot", quantity: 1 },
    ],
    lineCount: 3,
    pickupName: "TEST Guest",
    tableLabel: null,
  },
  ...extra,
});
/** A table merged into another and paid there (v15 b61 order 73). */
const merged = order(75, {
  orderType: "DineIn",
  sourceChannel: "Qr",
  paidOnline: undefined,
  currentPhase: "Fulfilled",
  batches: [
    {
      ...batch(75),
      unpaidRemovableItems: [],
      unpaidRemovedItems: [],
      compableItems: [],
      compedItems: [],
    },
  ],
  tableBill: {
    totalMinor: "0",
    paid: null,
    mergedInto: { tableLabel: "S61 C (TEST)", paid: true },
    billRoundNumbers: [{ orderBatchReference: id(275), roundNumber: 2 }],
  },
  summary: {
    items: [{ name: "Beef noodles (TEST)", option: null, quantity: 2 }],
    lineCount: 1,
    pickupName: null,
    tableLabel: "S61 D (TEST)",
  },
});
/** A dinner list: nothing to accept, so no row has a next step. */
const quietList = () => [...[80, 79, 78, 77, 76].map((n) => order(n)), merged];
/** One order waiting to be accepted. */
const waitingList = () => [
  order(81, {
    currentPhase: "Submitted",
    batches: [batch(81, "NotAccepted")],
    canRequestAcceptance: true,
  }),
  ...quietList(),
];

async function ordersPage(
  page: Page,
  language: Language,
  items: unknown[],
  more?: (page: Page) => Promise<unknown>,
) {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.route("**/merchant/orders/changes", (route) =>
    route.fulfill({ headers, json: { schemaVersion: 1, mark: "1".padStart(32, "0") } }),
  );
  for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
    await page.route(pattern, (route) =>
      route.fulfill({ headers, json: { items, nextAfterOrderReference: null } }),
    );
  await more?.(page);
  await page.goto("/operations/orders");
  await expect(page.locator("li.order-row").first()).toBeVisible();
}

const box = async (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
const noSideScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production F38 the shell is a top bar below 1200 and the sidebar above, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, language, waitingList());
      const links = page.locator(".workspace-sidebar__links");
      const menu = page.locator(".workspace-sidebar__compact > summary");
      const stamp = page.locator(".workspace-sidebar__status");
      const barLanguage = page.locator("button.workspace-sidebar__language");
      const headerLanguage = page.locator(".workspace-page__header .workspace-page__language");
      const stampWords = language === "en" ? /^Updated \d\d:\d\d$/u : /^已更新 \d\d:\d\d$/u;
      if (width === 1440) {
        // The sidebar, and the language switch at the right end of the page's title row.
        await expect(links).toBeVisible();
        await expect(menu).toBeHidden();
        expect((await box(page, ".workspace-sidebar")).right).toBeGreaterThanOrEqual(200);
        await expect(headerLanguage).toBeVisible();
        expect(
          (await box(page, ".workspace-page__header .workspace-page__language")).right,
        ).toBeGreaterThanOrEqual(width - 64);
        await expect(page.locator(".workspace-page__header .orders-page__updated")).toHaveText(
          stampWords,
        );
      } else {
        // v3 frame 46:2 / Figma 58:65: no sidebar; a top bar with BOP, the Store, and Menu at its
        // right end; the page has the whole width.
        await expect(links).toBeHidden();
        await expect(menu).toBeVisible();
        await expect(menu).toHaveText(language === "en" ? "Menu" : "菜单");
        await expect(barLanguage).toBeVisible();
        await expect(headerLanguage).toBeHidden();
        const bar = await box(page, ".workspace-sidebar");
        expect(bar.top).toBe(0);
        expect(bar.bottom).toBeGreaterThanOrEqual(48);
        expect(bar.bottom).toBeLessThanOrEqual(60);
        expect(
          (await box(page, ".workspace-sidebar__compact > summary")).right,
        ).toBeGreaterThanOrEqual(width - 32);
        const title = await box(page, ".workspace-page__title h1");
        expect(title.top).toBeGreaterThanOrEqual(bar.bottom);
        if (width === 1024) {
          // The page starts 24px from the window's edge, and "Updated 01:36" is in the bar.
          expect(Math.round(title.left)).toBe(24);
          await expect(stamp).toBeVisible();
          await expect(stamp).toHaveText(stampWords);
          // Bar items keep their order: the stamp, the language, then Menu.
          const stampBox = await box(page, ".workspace-sidebar__status");
          const languageBox = await box(page, "button.workspace-sidebar__language");
          expect(stampBox.right).toBeLessThanOrEqual(languageBox.left);
        } else {
          await expect(stamp).toBeHidden();
        }
      }
      await noSideScroll(page);
    });

    test(`@production F21 F29 the navigation counts orders to accept, labels on one line, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, language, waitingList());
      if (width !== 1440) await page.locator(".workspace-sidebar__compact > summary").click();
      const panel = width === 1440 ? ".workspace-sidebar__links" : ".workspace-drawer__panel";
      const orders = page.locator(`${panel} a[href="/operations/orders"]`);
      // The frame's own read counts the order waiting to be accepted, as a grey number.
      const count = orders.locator(".workspace-nav__badge");
      await expect(count).toHaveText(language === "en" ? "1 waiting1" : "1 项待处理1", {
        timeout: 20_000,
      });
      const look = await count.evaluate((node) => {
        const style = getComputedStyle(node);
        const link = node.closest("a")?.getBoundingClientRect();
        return {
          size: style.fontSize,
          weight: style.fontWeight,
          color: style.color,
          background: style.backgroundColor,
          gapToEnd: (link?.right ?? 0) - node.getBoundingClientRect().right,
        };
      });
      expect(look).toMatchObject({ size: "14px", weight: "400", color: "rgb(102, 102, 102)" });
      expect(look.background).toBe("rgba(0, 0, 0, 0)");
      // At the right end of its item (the item's own padding only).
      expect(look.gapToEnd).toBeLessThanOrEqual(16);
      // Group labels: 14/400 grey words on one line ("商品与菜 / 单" broke at 1024).
      const groups = await page
        .locator(`${panel} .workspace-nav__group-toggle`)
        .evaluateAll((list) =>
          list
            .filter((node) => (node as HTMLElement).offsetParent !== null)
            .map((node) => {
              const label = node.querySelector("span") as HTMLElement;
              const style = getComputedStyle(node);
              return {
                text: label.textContent,
                size: style.fontSize,
                weight: style.fontWeight,
                transform: style.textTransform,
                lines: Math.round(
                  label.getBoundingClientRect().height / parseFloat(style.lineHeight || "20"),
                ),
              };
            }),
        );
      expect(groups.length).toBeGreaterThan(3);
      for (const group of groups)
        expect(group, JSON.stringify(group)).toMatchObject({
          size: "14px",
          weight: "400",
          transform: "none",
          lines: 1,
        });
      await noSideScroll(page);
    });

    test(`@production F21 F19 Orders tabs and rows, ${language} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, language, quietList());
      // Every tab says how many, "To accept" too, and the tabs stay one line (Figma 39:83).
      const tabs = page.locator(".order-status-filters button");
      await expect(tabs).toHaveCount(5);
      const tabBoxes = await tabs.evaluateAll((list) =>
        list.map((node) => ({
          top: Math.round(node.getBoundingClientRect().top),
          count: node.querySelector(".order-status-filters__count")?.textContent ?? null,
        })),
      );
      expect(new Set(tabBoxes.map((tab) => tab.top)).size).toBe(1);
      expect(tabBoxes.map((tab) => tab.count)).toEqual(["6", "0", "5", "0", "1"]);
      // Rows: the dishes on one line, the grey line under them, how it was paid at its end; the
      // money column holds the amount alone. Nothing to accept, so no empty action column.
      const rows = await page.locator("li.order-row").evaluateAll((list) =>
        list.map((row) => {
          const type = row.querySelector(".order-workbench-type") as HTMLElement;
          const style = getComputedStyle(type);
          return {
            height: row.getBoundingClientRect().height,
            dishLines: Math.round(
              type.getBoundingClientRect().height / parseFloat(style.lineHeight),
            ),
            dishWidth: type.getBoundingClientRect().width,
            money: row.querySelector(".order-workbench-amount")?.textContent ?? "",
            when: row.querySelector(".order-row__when")?.textContent ?? "",
            next: (row.querySelector(".order-workbench-next") as HTMLElement).offsetWidth,
          };
        }),
      );
      expect(rows).toHaveLength(6);
      for (const [index, row] of rows.entries()) {
        const table = index === rows.length - 1;
        expect(row.money).toBe(table ? "—" : "$14.13");
        expect(row.next).toBe(0);
        if (width === 390) continue;
        // How a table was paid ends its grey line instead of wrapping in the money column.
        if (table)
          expect(row.when).toContain(
            language === "en" ? "Merged into S61 C (TEST) · paid there" : "S61 C (TEST)",
          );
        expect(row.dishLines, JSON.stringify(row)).toBe(1);
        expect(row.height, JSON.stringify(row)).toBeLessThanOrEqual(84);
        // No age on orders that wait for nobody.
        expect(row.when).not.toMatch(/·\s*\d+\s*(min|分钟)/u);
        if (width === 1024) expect(row.dishWidth).toBeGreaterThanOrEqual(300);
      }
      await noSideScroll(page);
    });
  }

/**
 * A table paid $28.25, $8.75 of it given back — $5.00 to the guest's card at 22:59 and $3.75 cash
 * at 22:28 (v15 b62 review T12) — and $3.00 more still on its way to the card.
 */
const refundedTable = order(74, {
  orderType: "DineIn",
  sourceChannel: "Qr",
  paidOnline: undefined,
  currentPhase: "Fulfilled",
  batches: [
    {
      ...batch(74),
      unpaidRemovableItems: [],
      unpaidRemovedItems: [],
      compableItems: [],
      compedItems: [],
    },
  ],
  tableBill: {
    totalMinor: "2825",
    paid: {
      amountMinor: "2825",
      method: "Online",
      refundedMinor: "875",
      refundPendingMinor: "300",
    },
  },
  summary: {
    items: [{ name: "Beef noodles (TEST)", option: null, quantity: 2 }],
    lineCount: 1,
    pickupName: null,
    tableLabel: "T12 (TEST)",
  },
});
const line = (n: number, name: string, taxMinor: string) => ({
  orderItemReference: id(400 + n),
  orderBatchReference: id(274),
  name,
  options: [],
  quantity: 1,
  customerNote: null,
  unitPrice: money("1250"),
  subtotal: money("1250"),
  discount: money("0"),
  tax: money(taxMinor),
  fee: money("0"),
  total: money(String(1250 + Number(taxMinor))),
  canCancel: false,
  cancellation: null,
});
const refundedDetail = {
  screenId: "OPS-ORDER-DETAIL",
  pickupContact: null,
  order: refundedTable,
  lines: {
    items: [line(1, "Beef noodles (TEST)", "163"), line(2, "Beef noodles (TEST)", "162")],
    totals: {
      subtotal: money("2500"),
      discount: money("0"),
      tax: money("325"),
      fee: money("0"),
      taxRounding: money("0"),
      total: money("2825"),
    },
  },
  record: {
    accepted: [],
    handedOver: [],
    payments: [
      { method: "Online", part: null, round: null, by: null, at: "2026-11-25T01:40:00.000Z" },
    ],
    cancellations: [],
    refunds: [
      {
        method: "Cash",
        amountMinor: "375",
        by: "You",
        approvedBy: null,
        at: "2026-11-25T03:28:00.000Z",
      },
      {
        method: "Online",
        amountMinor: "500",
        by: "You",
        approvedBy: null,
        at: "2026-11-25T03:59:00.000Z",
      },
    ],
    writeOff: null,
    paidOnlineByGuest: true,
  },
};

for (const language of ["en", "zh-Hans"] as const)
  test(`@production F20 an open order sits beside the list at 1024, no shadow, ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await ordersPage(page, language, [...quietList(), refundedTable]);
    await page.locator("li.order-row .order-row__open").nth(1).click();
    const panel = page.locator("aside.order-panel");
    await expect(panel).toBeVisible();
    const look = await panel.evaluate((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const list = document.querySelector(".order-workbench-main")?.getBoundingClientRect();
      const statuses = [...document.querySelectorAll("li.order-row .order-row__status")].map(
        (status) => status.getBoundingClientRect().right,
      );
      return {
        position: style.position,
        shadow: style.boxShadow,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        listRight: list?.right ?? 0,
        statusRight: Math.max(...statuses),
      };
    });
    expect(look.position).not.toBe("absolute");
    expect(look.shadow).toBe("none");
    // 360px with its room for focus rings (Figma 58:65), beside the list, never over it.
    expect(look.width).toBeGreaterThanOrEqual(355);
    expect(look.width).toBeLessThanOrEqual(400);
    expect(look.height).toBeLessThan(768);
    expect(look.left).toBeGreaterThanOrEqual(look.listRight);
    expect(look.statusRight).toBeLessThanOrEqual(look.left);
    // Figma 58:65: the amount ends the grey line under the dishes, with its one refund line; the
    // dishes get the width the money column took.
    const rows = page.locator("li.order-row");
    for (const index of [1, (await rows.count()) - 1]) {
      const row = rows.nth(index);
      const at = await row.evaluate((node) => {
        const box = (selector: string) => node.querySelector(selector)?.getBoundingClientRect();
        const type = box(".order-workbench-type");
        const when = box(".order-row__when");
        const amount = box(".order-workbench-amount");
        const status = box(".order-row__status");
        return {
          typeBottom: type?.bottom ?? 0,
          typeRight: type?.right ?? 0,
          whenTop: when?.top ?? 0,
          whenBottom: when?.bottom ?? 0,
          amountTop: amount?.top ?? 0,
          amountLeft: amount?.left ?? 0,
          amountRight: amount?.right ?? 0,
          statusLeft: status?.left ?? 0,
          statusRight: status?.right ?? 0,
        };
      });
      expect(at.amountTop).toBeGreaterThanOrEqual(at.typeBottom - 2);
      expect(at.amountTop).toBeLessThan(at.whenBottom);
      expect(Math.abs(at.amountRight - at.statusRight)).toBeLessThanOrEqual(2);
      // The dishes run up to the status, not to an amount column beside it.
      expect(at.typeRight).toBeLessThanOrEqual(at.statusLeft);
    }
    await expect(rows.nth(1).locator(".order-workbench-amount")).toHaveText("$14.13");
    const refunded = rows.last();
    await expect(refunded.locator(".order-row__money")).toHaveText("$19.50");
    await expect(refunded.locator(".order-row__refunded")).toBeVisible();
    await expect(refunded.locator(".order-row__on-its-way")).toBeVisible();
    await noSideScroll(page);
  });

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes)
    test(`@production F27 the order's totals say each refund's way and time, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, language, [refundedTable], (page) =>
        page.route("**/merchant/orders/detail*", (route) =>
          route.fulfill({ headers, json: refundedDetail }),
        ),
      );
      const panel = page.locator("aside.order-panel");
      if (!(await panel.isVisible()))
        await page.locator("li.order-row .order-row__open").first().click();
      const labels = panel.locator(".order-lines-totals dt");
      const zh = language === "zh-Hans";
      await expect(
        labels.filter({ hasText: zh ? /^已退到卡上 · / : /^Refunded to card · / }),
      ).toHaveText(zh ? /^已退到卡上 · (.* )?22:59$/u : /^Refunded to card · (.* )?22:59$/u);
      await expect(
        labels.filter({ hasText: zh ? /^已退现金 · / : /^Cash given back · / }),
      ).toHaveText(zh ? /^已退现金 · (.* )?22:28$/u : /^Cash given back · (.* )?22:28$/u);
      // Never the bare word with no way or time.
      await expect(labels.filter({ hasText: zh ? /^已退款$/u : /^Refunded$/u })).toHaveCount(0);
      await noSideScroll(page);
    });

const approvals = async (page: Page, language: Language) => {
  await inLanguage(page, language);
  await quietFrame(page);
  await page.goto("/app/approvals");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
};

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production F22 Approvals uses the page header of every page, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await approvals(page, language);
      const h1 = await page
        .getByRole("heading", { level: 1 })
        .evaluate((node) => [getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]);
      expect(h1).toEqual(["28px", "600"]);
      const section = await page
        .locator("#refund-approvals-heading")
        .evaluate((node) => [getComputedStyle(node).fontSize, getComputedStyle(node).fontWeight]);
      expect(section).toEqual(["16px", "600"]);
      // Refresh is accent words, never a white bordered box.
      const refresh = await page
        .locator(".workspace-page__header .workspace-page__actions button")
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return [style.borderTopWidth, style.color, style.backgroundColor];
        });
      expect(refresh).toEqual(["0px", "rgb(31, 99, 224)", "rgba(0, 0, 0, 0)"]);
      const link = await page.locator(".approvals-sole-link a").evaluate((node) => {
        const style = getComputedStyle(node);
        return [style.color, style.textDecorationLine];
      });
      expect(link).toEqual(["rgb(31, 99, 224)", "none"]);
      if (width === 1440) {
        // The header row runs the full width: the language switch ends it at the top right.
        expect(
          (await box(page, ".workspace-page__header .workspace-page__language")).right,
        ).toBeGreaterThanOrEqual(width - 64);
        await expect(page.locator(".workspace-page__header .workspace-page__freshness")).toHaveText(
          language === "en" ? /^Updated \d\d:\d\d$/u : /^已更新 \d\d:\d\d$/u,
        );
      }
      await noSideScroll(page);
    });
  }

/** Brief §2 v3: type sizes 28/20/16/14 at weights 600 and 400 only. */
const typeAudit = (page: Page) =>
  page.evaluate(() => {
    const allowedSizes = new Set(["14px", "16px", "20px", "28px"]);
    const allowedWeights = new Set(["400", "600"]);
    const off: string[] = [];
    const walker = document.createTreeWalker(
      document.querySelector(".workspace-layout") ?? document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? "";
      const element = node.parentElement;
      if (text === "" || element === null) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || element.closest("[hidden], .visually-hidden"))
        continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden") continue;
      if (!allowedSizes.has(style.fontSize) || !allowedWeights.has(style.fontWeight))
        off.push(`${text.slice(0, 30)} ${style.fontSize}/${style.fontWeight}`);
    }
    return [...new Set(off)];
  });

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production F53 Orders, Approvals and the shell use 28/20/16/14 at 600/400, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, language, waitingList());
      if (width !== 1440) await page.locator(".workspace-sidebar__compact > summary").click();
      expect(await typeAudit(page)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.goto("/app/approvals");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(".bop-state-card").first()).toBeVisible();
      expect(await typeAudit(page)).toEqual([]);
    });
  }

const exceptions = (createdAt: string, dueAt: string) => ({
  screenId: "OPS-ORDER-EXCEPTION",
  projectionName: "merchant_order_exception_v1",
  storeLabel: "Test Merchant 2 Main (TEST)",
  businessDate: "2026-11-24",
  projectedAt: new Date().toISOString(),
  freshnessStatus: "Fresh",
  items: [3, 4, 5].map((n) => ({
    exceptionReference: id(900 + n),
    orderReference: id(800 + n),
    orderNumber: String(n),
    kind: "PaidWithoutFulfillableOrder",
    severity: "Critical",
    status: "Open",
    providerState: "Confirmed",
    compensationStatus: "Pending",
    sourceOwner: "Payment",
    createdAt,
    dueAt,
    ownerStatus: "Unassigned",
    sourceFinal: false,
    cause: { kind: "NotAcceptedInTime" },
  })),
});

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production F18 F26 Exceptions say refunded once confirmed, in the store's clock, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await inLanguage(page, language);
      await quietFrame(page);
      await page.route("**/merchant/order-exceptions*", (route) =>
        route.fulfill({
          headers,
          json: exceptions("2026-11-05T04:43:00.000Z", "2026-11-05T09:00:00.000Z"),
        }),
      );
      await page.goto("/operations/order-exceptions");
      const rows = page.locator("li.order-row");
      await expect(rows).toHaveCount(3);
      for (const row of await rows.all()) {
        await expect(row.locator(".order-workbench-type")).toHaveText(
          language === "en"
            ? "Not accepted in time · refunded automatically"
            : "未及时接单 · 已自动退款",
        );
        await expect(row).not.toContainText(language === "en" ? "in progress" : "处理中");
        // The store's 24-hour clock, no year in this year, "Overdue since" with its capital.
        await expect(row.locator(".order-row__when time")).toHaveText(/\b23:43$/u);
        await expect(row.locator(".order-exception__due")).toContainText(
          language === "en" ? "Overdue since" : "逾期自",
        );
        await expect(row).not.toContainText(/2026|[AP]M/u);
        // Each time stays on one line.
        for (const time of await row.locator("time").all()) {
          const lines = await time.evaluate((node) => node.getClientRects().length);
          expect(lines).toBe(1);
        }
      }
      // The header's business date never breaks inside "11月24日".
      expect(
        await page
          .locator(".workspace-page__meta .order-exception__nowrap")
          .evaluate((node) => node.getClientRects().length),
      ).toBe(1);
      const refresh = await page
        .locator(".workspace-page__header .workspace-page__actions button")
        .evaluate((node) => [getComputedStyle(node).borderTopWidth, getComputedStyle(node).color]);
      expect(refresh).toEqual(["0px", "rgb(31, 99, 224)"]);
      // The panel: plain words, and its one primary faded in the accent until it can be used.
      await rows.first().locator(".order-row__open").click();
      const panel = page.locator("aside.order-panel:not([hidden])");
      await expect(panel).toContainText(language === "en" ? "Payment" : "付款");
      await expect(panel).not.toContainText(
        language === "en" ? "Payment provider status" : "支付方状态",
      );
      await noSideScroll(page);
    });
  }

for (const language of ["en", "zh-Hans"] as const)
  for (const [width, height] of sizes) {
    test(`@production F24 Home says when it was read once, and its figures start together, ${language} at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await ordersPage(page, language, waitingList());
      await page.goto("/app");
      const now = page.locator(".overview-now");
      await expect(now.locator(".overview-counts li").first()).toBeVisible();
      await expect(now.locator(".overview-count__value").first()).toBeVisible();
      // One stamp, in the header: "Updated 01:36" / "已更新 01:36", never "Updated" alone or a
      // second "Last checked" in "Right now".
      await expect(page.locator(".workspace-page__freshness")).toHaveText(
        language === "en" ? /^Updated \d\d:\d\d$/u : /^已更新 \d\d:\d\d$/u,
      );
      await expect(now.locator(".overview-updated")).toHaveCount(0);
      // Each column starts at the same height (v15: 697, 712 and 733), its link 44px tall.
      const columns = await now.locator(".overview-counts li").evaluateAll((list) =>
        list.map((item) => {
          const first = item.firstElementChild?.getBoundingClientRect();
          const link = item.querySelector(".overview-count__label")?.getBoundingClientRect();
          return {
            top: Math.round(item.getBoundingClientRect().top),
            firstTop: Math.round(first?.top ?? 0),
            linkTop: Math.round(link?.top ?? 0),
            linkHeight: link?.height ?? 0,
          };
        }),
      );
      expect(columns.length).toBeGreaterThan(1);
      const rows = new Map<number, typeof columns>();
      for (const column of columns) rows.set(column.top, [...(rows.get(column.top) ?? []), column]);
      for (const row of rows.values()) {
        expect(new Set(row.map((column) => column.linkTop)).size, JSON.stringify(row)).toBe(1);
        for (const column of row) expect(column.linkHeight).toBeGreaterThanOrEqual(44);
      }
      await noSideScroll(page);
    });
  }

for (const language of ["en", "zh-Hans"] as const)
  test(`@production F21 the phone's scrolling tabs keep every focus ring whole, ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ordersPage(page, language, waitingList());
    const sweep = await windowEdgeSweep(page);
    expect(sweep.stops).toBeGreaterThan(10);
    expect(sweep.cut, JSON.stringify(sweep.cut)).toEqual([]);
  });
