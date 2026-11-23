import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 40 (v15 batch 38-39 live check, staff-refusal-wording): the navigation lists below are the
 * ones v15 composed for the TEST Cook's workspace sign-in (Kitchen role) and for the TM2 kitchen
 * display. The batch-38 tests used a kitchen list without Item availability, so they passed while
 * no real cook or kitchen display ever got the way back to the kitchen. A refused page also shows
 * nothing it cannot back: no counts, tabs or actions, no internal words, and Chinese ends in "。".
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const kitchen = {
  screenId: "KIT-KITCHEN-QUEUE",
  label: "Kitchen",
  href: "/operations/kitchen",
  permission: "kitchen.operate",
};
const availability = {
  screenId: "CAT-AVAILABILITY",
  label: "Item availability",
  href: "/app/commerce/availability",
  permission: "catalog.sku.read",
};
const waste = {
  screenId: "INV-WASTE-RECORD",
  label: "Waste",
  href: "/operations/inventory/waste",
  permission: "inventory.waste.record",
};
const tables = {
  screenId: "DIN-FLOOR-BOARD",
  label: "Tables",
  href: "/operations/dining",
  permission: "dining.operate",
};
/** v15 /merchant/session, TEST Cook (Kitchen role), workspace sign-in at DEMO Store. */
const cookWorkspace = [kitchen, availability, waste];
/** v15 /merchant/session, the owner-merchant-2 kitchen display at Test Merchant 2. */
const kitchenDisplay = [kitchen, availability];

async function refusedEverywhere(page: Page, navigation: readonly object[]) {
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ headers, status: 403, json: { error: "request_denied" } }),
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
          businessDate: "2026-11-20",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation,
        },
      },
    }),
  );
}

const internalWords =
  /queue|session|permission|scope|source facts|internal references|队列|门店权限|来源数据|内部参考号/iu;
/** An English full stop straight after Chinese text. */
const asciiStopAfterChinese = /[㐀-鿿”）]\./u;

/**
 * Until a page's own header arrives the workspace's top bar carries the language switch; the header
 * then hides it and shows its own. A click that first found the top bar's switch kept waiting for it
 * on a slower machine (CI), so each try looks for the switch on screen again.
 */
async function switchLanguage(page: Page, name: string) {
  await expect(async () => {
    // The switch reloads once it has heard from the store system: wait for that reload.
    await Promise.all([
      page.waitForEvent("load", { timeout: 8_000 }),
      page.getByRole("button", { name }).click({ timeout: 2_000 }),
    ]);
  }).toPass({ timeout: 20_000 });
}
async function toChinese(page: Page) {
  await switchLanguage(page, "切换到中文");
}
async function toEnglish(page: Page) {
  await switchLanguage(page, "Switch to English");
}

async function shoot(page: Page, name: string) {
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${name} ${width}`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/b40-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

for (const [who, navigation] of [
  ["the Kitchen role's workspace sign-in", cookWorkspace],
  ["a kitchen display", kitchenDisplay],
] as const)
  test(`@production ${who} is led back to the kitchen from Orders, Pickup, Exceptions and Reports`, async ({
    page,
  }) => {
    await refusedEverywhere(page, navigation);
    for (const path of [
      "/operations/orders",
      "/operations/pickup",
      "/operations/order-exceptions",
      "/app/reports/operations",
    ]) {
      await page.goto(path);
      const main = page.getByRole("main");
      await expect(
        main.getByText("You're signed in for kitchen work, which doesn't include this page.", {
          exact: false,
        }),
        path,
      ).toBeVisible();
      await expect(main.getByRole("link", { name: "Go to the kitchen" }), path).toHaveAttribute(
        "href",
        "/operations/kitchen",
      );
      await expect(main, path).not.toContainText(/Your role can't/u);
      await expect(main, path).not.toContainText(internalWords);
      await expectNoInternalText(page);
      await toChinese(page);
      await expect(main.getByRole("link", { name: "去后厨屏" }), path).toBeVisible();
      await expect(main, path).not.toContainText(asciiStopAfterChinese);
      await toEnglish(page);
    }
  });

test("@production a cook opening Pickup is told about Pickup, not shown an empty Tables page", async ({
  page,
}) => {
  await refusedEverywhere(page, cookWorkspace);
  for (const path of ["/operations/pickup", "/operations/order-entry"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(new RegExp(path.replace(/\//gu, "\\/") + "$", "u"));
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "Go to the kitchen" }), path).toBeVisible();
    await expect(main.getByRole("heading", { name: "Tables" }), path).toHaveCount(0);
    await expect(main, path).not.toContainText(/Needs action|Needs cleaning|Table settings/u);
    await expect(main.getByRole("tab"), path).toHaveCount(0);
  }
  await page.goto("/operations/pickup");
  await expect(
    page.getByRole("main").getByRole("link", { name: "Go to the kitchen" }),
  ).toBeVisible();
  await shoot(page, "cook-pickup-en");
  await toChinese(page);
  await expect(page.getByRole("main")).not.toContainText(/桌台设置|待清洁|需要处理/u);
  await shoot(page, "cook-pickup-zh");
  await toEnglish(page);
});

test("@production a refused Tables page shows no counts, tabs or table settings", async ({
  page,
}) => {
  // A server without the Tables read for this person: the counts would be zeros it cannot back.
  await refusedEverywhere(page, [tables]);
  await page.goto("/operations/dining");
  const main = page.getByRole("main");
  await expect(main.getByText("Your role can't use Tables.", { exact: false })).toBeVisible();
  await expect(main).not.toContainText(/Needs action|Seated|Needs cleaning|Table settings/u);
  await expect(main.getByRole("tab")).toHaveCount(0);
  await shoot(page, "tables-refused-en");
  await toChinese(page);
  await expect(main).not.toContainText(/桌台设置|待清洁|需要处理/u);
  await expect(main).not.toContainText(asciiStopAfterChinese);
  await shoot(page, "tables-refused-zh");
  await toEnglish(page);
});

test("@production refused pages reached by address show plain words and no actions they cannot back", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await refusedEverywhere(page, cookWorkspace);
  const pages: readonly (readonly [string, RegExp])[] = [
    ["/app/tasks", /Task and source facts/u],
    ["/app/operations/tables", /Print all codes|Add a table/u],
    ["/app/approvals", /Sole operator/u],
    ["/app/operations/payment-reconciliation", /Yesterday|Business day/u],
    ["/app/reports/operations", /Sales by period/u],
  ];
  for (const [path, offered] of pages) {
    await page.goto(path);
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "Go to the kitchen" }), path).toBeVisible();
    await expect(page.locator("body"), path).not.toContainText(internalWords);
    await expect(page.locator("body"), path).not.toContainText(offered);
    await expectNoInternalText(page);
  }
  await page.goto("/app/operations/tables");
  await shoot(page, "table-codes-refused-en");
  // The Tasks page has no language switch of its own: choose Chinese once, then walk the pages.
  await toChinese(page);
  for (const [path] of pages) {
    await page.goto(path);
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "去后厨屏" }), path).toBeVisible();
    await expect(page.locator("body"), path).not.toContainText(asciiStopAfterChinese);
    await expect(page.locator("body"), path).not.toContainText(internalWords);
    await expect(page.locator("body"), path).not.toContainText(
      /独立经营者|打印所有桌台二维码|添加餐桌|营业日|按时段报表/u,
    );
    if (path === "/app/approvals") await shoot(page, "approvals-refused-zh");
  }
  await page.goto("/app/operations/tables");
  await toEnglish(page);
});
