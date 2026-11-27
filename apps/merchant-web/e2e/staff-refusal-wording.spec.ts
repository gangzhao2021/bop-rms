import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * Batch 38 (v15 b37 finding 4b): a person the server refuses Orders (403) reads what they can't do
 * and what to do next, in English and Chinese, never "queue", "session" or "Store permissions"; a
 * kitchen display sign-in (or a cook whose role is the kitchen alone) is told the page is outside
 * kitchen work and gets the way back to the kitchen. A refusal is never worded as an outage.
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
const tables = {
  screenId: "DIN-FLOOR-BOARD",
  label: "Tables",
  href: "/operations/dining",
  permission: "dining.operate",
};

async function refusedOrders(page: Page, navigation: readonly object[]) {
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
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, status: 403, json: { error: "request_denied" } }),
  );
}

const internalWords = /queue|session|permission|scope|队列|门店权限|当前的登录/iu;

async function shoot(page: Page, name: string) {
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `test-results/b38-${name}-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test("@production a staff member without Orders reads what they can't do and who to ask", async ({
  page,
}) => {
  await refusedOrders(page, [tables]);
  await page.goto("/operations/orders");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "No access" })).toBeVisible();
  await expect(
    main.getByText(
      "Your role can't open this page. Ask the owner or a manager to give you access, or sign in as a staff member who has it.",
    ),
  ).toBeVisible();
  await expect(main).not.toContainText(internalWords);
  // A refusal, not an outage: nothing says to wait, retry or check the connection.
  await expect(main).not.toContainText(/offline|unavailable|try again|retrying/iu);
  await expect(main.getByRole("link", { name: "Go to the kitchen" })).toHaveCount(0);
  await expectNoInternalText(page);
  await shoot(page, "orders-refused-en");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect(main.getByRole("heading", { name: "无权限" })).toBeVisible();
  await expect(
    main.getByText("你的角色不能打开这个页面。请店主或店长给你开通，或换有权限的员工登录。"),
  ).toBeVisible();
  await expect(main).not.toContainText(internalWords);
  await shoot(page, "orders-refused-zh");
  await page.getByRole("button", { name: "Switch to English" }).click();
});

test("@production a kitchen sign-in on Orders is told it is kitchen work only, with the way back", async ({
  page,
}) => {
  await refusedOrders(page, [kitchen]);
  await page.goto("/operations/orders");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "No access" })).toBeVisible();
  await expect(
    main.getByText(
      "You're signed in for kitchen work, which doesn't include this page. To use it, ask the owner or a manager, or sign in as a staff member who has it.",
    ),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: "Go to the kitchen" })).toHaveAttribute(
    "href",
    "/operations/kitchen",
  );
  await expect(main).not.toContainText(internalWords);
  await expectNoInternalText(page);
  await shoot(page, "orders-kitchen-en");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect(
    main.getByText(
      "你当前是厨房登录，不包括这个页面。要用这个页面，请找店主或店长开通，或换有权限的员工登录。",
    ),
  ).toBeVisible();
  await expect(main.getByRole("link", { name: "去厨房屏" })).toBeVisible();
  await expect(main).not.toContainText(internalWords);
  await shoot(page, "orders-kitchen-zh");
  await page.getByRole("button", { name: "Switch to English" }).click();
});

test("@production a kitchen display on pickup, exceptions or reports is led back to the kitchen too", async ({
  page,
}) => {
  // Batch 38 review: every whole-page refusal uses the one shared notice, not Orders alone. A
  // pickup address not in the navigation opens Tables, whose refused read says the same.
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ headers, status: 403, json: { error: "request_denied" } }),
  );
  await refusedOrders(page, [kitchen]);
  for (const path of [
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
  }
  await expectNoInternalText(page);
});
