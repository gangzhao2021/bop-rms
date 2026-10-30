import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * WP-2423 item 8 ⑧ (Owner decision 5, coordinator 2026-10-30): one kitchen screen shows every
 * section (档口) or one, chosen on that screen and kept on this device; dishes with no section are
 * in "No section". With one section shown, the screen says how many orders wait in the others,
 * so nothing is hidden quietly. TEST-only data.
 */
const id = (n: number) => "01a0f0c2-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "TEST Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const at = "2026-10-29T00:14:00.000Z";

test("@production a kitchen screen shows one section and counts the orders in the others", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(at));
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
          businessDate: "2026-10-28",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "KIT-KITCHEN-QUEUE",
              label: "Kitchen",
              href: "/operations/kitchen",
              permission: "kitchen.operate",
            },
          ],
        },
      },
    }),
  );
  const item = (n: number, name: string, ticket: number, section?: string | null) => ({
    workItemReference: id(n),
    ticketReference: id(50 + ticket),
    orderReference: id(70 + ticket),
    orderItemReference: id(20 + n),
    stationReference: id(52),
    localizedDisplayNames: { "zh-Hans": name },
    allergens: { status: "Unavailable" },
    orderLabel: { orderNumber: String(10 + ticket), orderType: "DineIn", tableLabel: "T" + ticket },
    customerNote: null,
    selectedOptions: [],
    ...(section === undefined ? {} : { kitchenSection: section }),
    status: "In Progress",
    requiredQuantity: 1,
    completedQuantity: 0,
    workItemCreatedAt: "2026-10-29T00:10:00.000Z",
    acceptedAt: "2026-10-29T00:11:00.000Z",
    orderItemReadyAt: null,
    ticketAggregateVersion: "7",
    workItemVersion: "3",
  });
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({
      headers,
      json: {
        storeReference: scope.storeReference,
        operatorStatus: "Named",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(6),
        projectedAt: at,
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        // The Store's sections in its order: the roast has no work yet.
        kitchenSections: ["炒锅", "蒸柜", "烧腊"],
        items: [
          item(1, "担担面", 1, "炒锅"),
          item(2, "炒饭", 2, "炒锅"),
          item(3, "虾饺", 3, "蒸柜"),
          item(4, "拍黄瓜", 4, null),
        ],
        nextCursor: null,
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/operations/kitchen");
  const ticket = (name: string) => page.locator(".kitchen-ticket").filter({ hasText: name });
  for (const name of ["担担面", "炒饭", "虾饺", "拍黄瓜"]) await expect(ticket(name)).toBeVisible();
  const section = page.getByRole("combobox", { name: "Kitchen section" }).first();
  await expect(section).toHaveValue("All");
  await expect(section.getByRole("option")).toHaveText([
    "All sections",
    "炒锅",
    "蒸柜",
    "烧腊",
    "No section",
  ]);
  // The wok screen: its two orders only; the others are counted, not hidden quietly.
  await section.selectOption({ label: "炒锅" });
  await expect(ticket("担担面")).toBeVisible();
  await expect(ticket("炒饭")).toBeVisible();
  await expect(ticket("虾饺")).toHaveCount(0);
  await expect(ticket("拍黄瓜")).toHaveCount(0);
  const others = page.locator(".kitchen-section-others");
  await expect(others).toHaveText(
    "Showing 炒锅. Other sections: 蒸柜 1 order · No section 1 order.",
  );
  // Kept on this device: the screen still shows the wok after a reload.
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Kitchen section" }).first()).toHaveValue("炒锅");
  await expect(ticket("虾饺")).toHaveCount(0);
  // Dishes with no section have their own choice.
  await page.getByRole("combobox", { name: "Kitchen section" }).first().selectOption({
    label: "No section",
  });
  await expect(ticket("拍黄瓜")).toBeVisible();
  await expect(ticket("担担面")).toHaveCount(0);
  await expect(others).toHaveText(
    "Showing No section. Other sections: 炒锅 2 orders · 蒸柜 1 order.",
  );
  // A section with no work yet can be chosen before service: nothing is on its screen, and the
  // others' orders are counted.
  await page.getByRole("combobox", { name: "Kitchen section" }).first().selectOption({
    label: "烧腊",
  });
  for (const name of ["担担面", "炒饭", "虾饺", "拍黄瓜"])
    await expect(ticket(name)).toHaveCount(0);
  await expect(others).toHaveText(
    "Showing 烧腊. Other sections: 炒锅 2 orders · 蒸柜 1 order · No section 1 order.",
  );
  const axe = await new AxeBuilder({ page }).include(".kitchen-board-filters").analyze();
  expect(axe.violations).toEqual([]);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  // Back to every section.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("combobox", { name: "Kitchen section" }).first().selectOption({
    label: "All sections",
  });
  await expect(others).toHaveCount(0);
  // The default keeps nothing on the device.
  expect(await page.evaluate(() => localStorage.getItem("bop.kitchen.section"))).toBeNull();
  for (const name of ["担担面", "炒饭", "虾饺", "拍黄瓜"]) await expect(ticket(name)).toBeVisible();
});
