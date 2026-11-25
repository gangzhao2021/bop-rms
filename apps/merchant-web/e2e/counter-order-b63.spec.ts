import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * WP-2423 batch 63 (v15 batch 62 page design review, bundle F-merchant-counter-kitchen): the
 * counter order screen at Test Merchant 2 and the owner-tea milk tea.
 *
 * - F41: in the English UI, '牛肉面' found nothing although the field says "Chinese or English",
 *   and no row named a dish in Chinese.
 * - CK-18: on a phone no category was marked chosen; in two columns a row with one dish had its
 *   hairline under the left column only.
 * - F48: the cart printed the exact subtotal and then "About" the same figure.
 * - F47: on a phone, with Send order on screen, the bottom "View order" bar was a second filled
 *   button.
 * - F44: a milk tea's four groups were one long column; Add to order sat two screens down.
 * - F42: once sent, the menu stayed (silently disabled), the pre-tax subtotal was as strong as the
 *   amount to take, the amount was printed four times and the record button fell below 768.
 */
const id = (n: number) => "01a0f063-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Test Merchant 2",
  storeLabel: "Test Merchant 2 Main - not production",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const price = (amount: string) => ({ status: "Available", amount, currency: "CAD", reason: null });
const option = (n: number, name: string, extra: string, byDefault = false, most = 1) => ({
  optionReference: id(n),
  name,
  maximumQuantity: most,
  conflictOptionReferences: [],
  selectedByDefault: byDefault,
  incrementalPrice: price(extra),
});
const rule = (
  n: number,
  name: string,
  min: number,
  max: number,
  options: ReturnType<typeof option>[],
) => ({
  name,
  bindingReference: id(n),
  optionSetVersionReference: id(n + 1),
  minimumSelections: min,
  maximumSelections: max,
  enabledOptionReferences: options.map((entry) => entry.optionReference),
  defaultOptionReferences: options
    .filter((entry) => entry.selectedByDefault)
    .map((entry) => entry.optionReference),
  options,
});
const dish = (n: number, name: string, amount: string, optionRules: unknown[] = []) => ({
  sellableReference: id(n),
  productVersionReference: id(n + 1),
  name,
  presentationRole: "Standard",
  pinned: false,
  availability: "Available",
  optionRules,
  allergenDisclosure: {},
  displayPrice: price(amount),
  taxDisplayContext: {},
});
/** Milk tea as owner-tea sells it: Size has a default, Sugar and Ice have none. */
const tea = dish(40, "Half Sugar Tea (TEST)", "5.99", [
  rule(50, "Size", 1, 1, [option(51, "Medium", "0.00", true), option(52, "Large", "1.00")]),
  rule(60, "Sugar", 1, 1, [
    option(61, "Full sugar", "0.00"),
    option(62, "70% sugar", "0.00"),
    option(63, "Half sugar", "0.00"),
    option(64, "30% sugar", "0.00"),
    option(65, "No sugar", "0.00"),
  ]),
  rule(70, "Ice", 1, 1, [
    option(71, "Regular ice", "0.00"),
    option(72, "Less ice", "0.00"),
    option(73, "No ice", "0.00"),
  ]),
  rule(80, "Toppings", 0, 3, [
    option(81, "Pearls", "0.50", false, 2),
    option(82, "Coconut jelly", "0.50"),
    option(83, "Pudding", "0.80"),
  ]),
]);
const menuOf = (language: "en" | "zh-Hans") => {
  const zh = language === "zh-Hans";
  return {
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
        locale: zh ? "zh-Hans-CA" : "en-CA",
        name: "Menu",
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        effectiveUntil: null,
        sections: [
          {
            sectionReference: id(4),
            name: zh ? "面类" : "Noodles (TEST)",
            sellables: [
              dish(10, zh ? "牛肉面" : "Beef noodles (TEST)", "12.50"),
              dish(12, zh ? "担担面" : "Dan dan noodles (TEST)", "11.00"),
              dish(14, zh ? "馄饨" : "Wonton (TEST)", "9.50"),
            ],
          },
          { sectionReference: id(5), name: zh ? "饮品" : "Drinks (TEST)", sellables: [tea] },
        ],
      },
    },
    tips: { enabled: true, tierPercents: [10, 15, 18] },
    otherNames: zh
      ? { [id(10)]: "Beef noodles (TEST)", [id(12)]: "Dan dan noodles (TEST)" }
      : { [id(10)]: "牛肉面", [id(12)]: "担担面", [id(14)]: "馄饨" },
  };
};

async function open(page: Page, language: "en" | "zh-Hans") {
  if (language === "zh-Hans")
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      } catch {
        /* English */
      }
    });
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
          businessDate: "2026-11-20",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-ENTRY",
              label: "Counter order",
              href: "/operations/order-entry",
              permission: "ordering.order.create_staff",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/counter/menu", (route) =>
    route.fulfill({ headers, json: menuOf(language) }),
  );
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
  );
  await page.goto("/operations/order-entry");
}

const rect = (locator: Locator) =>
  locator.evaluate((node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
  });

const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("@production WP-2423 batch 63 (F41): the English counter finds a dish by its Chinese name and shows it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "en");
  const search = page.getByRole("searchbox", { name: "Search dishes (Chinese or English)" });
  for (const typed of ["牛肉面", "牛"]) {
    await search.fill(typed);
    await expect(page.getByRole("button", { name: "Add Beef noodles (TEST)" })).toBeVisible();
    await expect(page.getByText(`No dish matches “${typed}”.`)).toHaveCount(0);
  }
  await search.fill("");
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    const row = page.getByRole("button", { name: "Add Beef noodles (TEST)" });
    const other = row.locator(".counter-order__item-other");
    await expect(other, `${width}: the Chinese name under the English one`).toHaveText("牛肉面");
    const style = await other.evaluate((node) => {
      const css = getComputedStyle(node);
      return { size: css.fontSize, weight: css.fontWeight, color: css.color };
    });
    expect(style, `${width}: 14/400 muted`).toEqual({
      size: "14px",
      weight: "400",
      color: "rgb(102, 102, 102)",
    });
    const name = await rect(row.locator(".counter-order__item-name"));
    const line = await rect(other);
    expect(line.top, `${width}: a second line`).toBeGreaterThanOrEqual(name.top + 14);
    expect(await noSidewaysScroll(page)).toBe(true);
  }
});

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 63 (CK-18, F48): the first category is chosen at every width, each grid row is ruled across, and the subtotal is said once (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await open(page, language);
    const categories = page.getByRole("navigation", { name: zh ? "菜单分类" : "Menu categories" });
    for (const [width, height] of [
      [390, 844],
      [1024, 768],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.reload();
      await expect(
        categories.getByRole("button").first(),
        `${width}: first category chosen`,
      ).toHaveAttribute("aria-current", "true");
      // Each dish's hairline runs to the list's right edge, so the last row (one dish, left
      // column) is ruled like the others.
      const list = page.locator(".counter-order__items").first();
      const listBox = await rect(list);
      const rows = list.locator(":scope > li");
      await expect(rows).toHaveCount(3);
      for (let n = 1; n < 3; n += 1) {
        const reach = await rows.nth(n).evaluate((node) => {
          const before = getComputedStyle(node, "::before");
          const box = node.getBoundingClientRect();
          return {
            right: box.left + Number.parseFloat(before.width || "0"),
            height: before.height,
            content: before.content,
          };
        });
        expect(reach.content, `${width} row ${n}: a hairline`).not.toBe("none");
        expect(reach.height).toBe("1px");
        expect(reach.right, `${width} row ${n}: across the whole row`).toBeGreaterThanOrEqual(
          listBox.right,
        );
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("button", { name: zh ? "添加馄饨" : "Add Wonton (TEST)" }).click();
    const subtotal = page.locator(".counter-order__subtotal");
    await expect(subtotal).toHaveText(
      zh ? "小计（不含税和小费）$9.50" : "Subtotal (before tax and tip)$9.50",
    );
    await expect(page.getByText(zh ? /约 \$9\.50/u : /About \$9\.50/u)).toHaveCount(0);
    await expect(page.locator(".counter-order__estimate")).toHaveCount(0);
  });

test("@production WP-2423 batch 63 (F47): on a phone the bottom bar steps aside once Send order is on screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "en");
  await page.getByRole("button", { name: "Add Wonton (TEST)" }).click();
  const bar = page.locator(".counter-order__summary-bar");
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "View order" }).click();
  const send = page.getByRole("button", { name: "Send order" });
  await expect(send).toBeInViewport();
  await expect(bar, "one filled button on screen").toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar).toBeVisible();
});

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 63 (F44): a milk tea is chosen on one screen, Add to order stays at the bottom (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await open(page, language);
    for (const [width, height] of [
      [1024, 768],
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.getByRole("button", { name: /Half Sugar Tea \(TEST\)/u }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const add = dialog.getByRole("button", { name: zh ? /^加入订单/u : /^Add to order/u });
      // Sugar and Ice have no merchant default: nothing chosen, Add waits and says why.
      await expect(add).toBeDisabled();
      await expect(dialog.locator(".counter-order__choose-missing")).toHaveText(
        zh ? "还要选：Sugar、Ice" : "Still to choose: Sugar, Ice",
      );
      // Size keeps its merchant default.
      await expect(dialog.getByRole("radio", { name: "Medium" })).toBeChecked();
      const addBox = await rect(add);
      expect(addBox.top, `${width}: Add to order in view`).toBeGreaterThanOrEqual(0);
      expect(addBox.bottom, `${width}: Add to order in view`).toBeLessThanOrEqual(height);
      // Every choice is a 44 px target on one wrapping row per group; no number field.
      await expect(dialog.locator('input[type="number"]')).toHaveCount(0);
      for (const name of ["Medium", "Large", "Full sugar", "No ice", "Pearls"]) {
        const label = dialog.locator("label", { hasText: name }).first();
        expect((await rect(label)).height, `${width} ${name}: 44 px`).toBeGreaterThanOrEqual(44);
      }
      // Every group's choices are in view at once, above the fixed Add to order (they were
      // 1417 px tall in a 653 px dialog).
      const actions = await rect(dialog.locator(".counter-order__choose-actions"));
      const pudding = await rect(dialog.locator("label", { hasText: "Pudding" }));
      if (width >= 1024)
        expect(pudding.bottom, `${width}: the last group above the actions`).toBeLessThanOrEqual(
          actions.top,
        );
      const sugarRows = await dialog
        .locator("fieldset", { hasText: "Sugar" })
        .locator("label")
        .evaluateAll(
          (nodes) =>
            new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().top))).size,
        );
      expect(sugarRows, `${width}: Sugar in one wrapping row`).toBeLessThanOrEqual(
        width >= 1024 ? 2 : 3,
      );
      const chosen = await dialog
        .locator("label", { hasText: "Medium" })
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(chosen, "the chosen size is the dark pill").toBe("rgb(23, 23, 23)");
      const plain = await dialog
        .locator("label", { hasText: "Large" })
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      expect(plain, "the others are plain text").toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: `test-results/b63-tea-${width}-${language}.png` });
      await dialog.locator("label", { hasText: "Half sugar" }).click();
      await dialog.locator("label", { hasText: "Less ice" }).click();
      await expect(add).toBeEnabled();
      await expect(dialog.locator(".counter-order__choose-missing")).toHaveText("");
      // Quantity: − 1 +, no keyboard.
      const quantity = dialog.getByRole("group", { name: zh ? "数量" : "Quantity" });
      await quantity.getByRole("button", { name: zh ? /加一份/u : /^One more/u }).click();
      await expect(quantity.locator("output")).toHaveText("2");
      await expect(add).toHaveText(zh ? "加入订单 · $11.98" : "Add to order · $11.98");
      await dialog.getByRole("button", { name: zh ? "取消" : "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
    }
  });

for (const language of ["en", "zh-Hans"] as const)
  test(`@production WP-2423 batch 63 (F42): once sent, the sent lines replace the menu and one amount and one button stay above the fold (${language})`, async ({
    page,
  }) => {
    const zh = language === "zh-Hans";
    await page.setViewportSize({ width: 1024, height: 768 });
    await open(page, language);
    await page.route("**/merchant/counter/orders", (route) =>
      route.fulfill({
        headers,
        json: {
          status: "Placed",
          orderReference: id(200),
          orderBatchReference: id(201),
          orderNumber: "91",
          orderVersion: 1,
          orderMinor: "1780",
          tipMinor: "0",
          totalMinor: "1780",
          payBy: new Date(Date.now() + 30 * 60_000).toISOString(),
          recordedAfterOutage: false,
        },
      }),
    );
    await page.route("**/merchant/orders/card-machine-payment", (route) =>
      route.fulfill({
        headers,
        json: {
          status: "Recorded",
          orderReference: id(200),
          orderBatchReference: id(201),
          amountMinor: "1780",
          recordingReason: "AtCounter",
          takenAt: new Date().toISOString(),
          recordedAt: new Date().toISOString(),
          acceptance: "Accepted",
        },
      }),
    );
    await page.getByRole("button", { name: zh ? "添加牛肉面" : "Add Beef noodles (TEST)" }).click();
    await page
      .getByRole("button", { name: zh ? "添加担担面" : "Add Dan dan noodles (TEST)" })
      .click();
    await page.getByRole("button", { name: zh ? "发送订单" : "Send order" }).click();
    const charge = page.locator(".counter-order__charge");
    await expect(charge.getByRole("heading", { name: zh ? "收款" : "Take payment" })).toBeVisible();
    // The menu is gone; the sent lines and the order's status stand where it was.
    await expect(page.locator(".counter-order__menu")).toBeHidden();
    await expect(page.getByRole("heading", { name: zh ? "订单 91" : "Order 91" })).toBeVisible();
    await expect(page.locator(".counter-order__sent-status")).toHaveText(
      zh ? "已发出 · 等收款" : "Sent · waiting for payment",
    );
    // One amount, at 28/600; no subtotal line; the amount is not printed four times.
    const due = charge.locator(".counter-order__due");
    await expect(due).toHaveText("$17.80");
    expect(await due.evaluate((node) => getComputedStyle(node).fontSize)).toBe("28px");
    await expect(page.locator(".counter-order__subtotal")).toHaveCount(0);
    const printed = await page
      .locator("main")
      .evaluate((node) => (node.textContent ?? "").split("$17.80").length - 1);
    expect(printed, "the amount: once large, in step 1 and on the button").toBeLessThanOrEqual(3);
    await expect(charge).toContainText(zh ? "绝不是卡号。" : "Never the card number.");
    const pay = charge.getByRole("button", {
      name: zh ? "已用刷卡机付款 · $17.80" : "Paid on card machine · $17.80",
    });
    const payBox = await rect(pay);
    expect(payBox.bottom, "the record button above the 768 fold").toBeLessThanOrEqual(768);
    const payColor = await pay.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(payColor, "the accent primary").toBe("rgb(31, 99, 224)");
    // Payment-method choices are 44 px; the deadline is grey 14/400 once.
    for (const label of await charge.locator(".counter-order__tender > label").all())
      expect((await rect(label)).height).toBeGreaterThanOrEqual(44);
    const deadline = charge.locator(".counter-order__deadline");
    await expect(deadline).toHaveCount(1);
    expect(
      await deadline.evaluate((node) => [
        getComputedStyle(node).fontSize,
        getComputedStyle(node).color,
      ]),
    ).toEqual(["14px", "rgb(102, 102, 102)"]);
    await page.screenshot({ path: `test-results/b63-charge-1024-${language}.png` });
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      expect(await noSidewaysScroll(page)).toBe(true);
      await page.screenshot({
        path: `test-results/b63-charge-${width}-${language}.png`,
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1024, height: 768 });
    await pay.click();
    // Paid: New counter order is the one accent button; Open Orders is accent text.
    const next = page.getByRole("button", { name: zh ? "新建柜台订单" : "New counter order" });
    await expect(next).toBeVisible();
    expect(await next.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      "rgb(31, 99, 224)",
    );
    const orders = charge.getByRole("link", { name: zh ? "打开订单页" : "Open Orders" });
    expect(await orders.evaluate((node) => getComputedStyle(node).color)).toBe("rgb(31, 99, 224)");
    await page.screenshot({ path: `test-results/b63-paid-1024-${language}.png` });
  });
