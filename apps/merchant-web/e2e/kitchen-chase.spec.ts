import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES (Owner decision 4): a dish a server chased turns its kitchen
 * ticket red, says how often it was chased, and the board sounds when a new chase comes in while
 * it is open. TEST-only data.
 */
const id = (n: number) => "01a0f0c1-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "TEST Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const headers = { "cache-control": "no-store" };
const at = "2026-10-29T00:14:00.000Z";

test("@production a chased dish turns its ticket red and says how often it was chased", async ({
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
  let chases = 0;
  const item = (n: number, name: string, chased: boolean) => ({
    workItemReference: id(n),
    ticketReference: id(50 + n),
    orderReference: id(70 + n),
    orderItemReference: id(20 + n),
    stationReference: id(52),
    localizedDisplayNames: { "zh-Hans": name },
    allergens: { status: "Unavailable" },
    orderLabel: { orderNumber: String(10 + n), orderType: "DineIn", tableLabel: "T" + n },
    customerNote: null,
    selectedOptions: [],
    ...(chased && chases > 0
      ? { chase: { count: chases, lastChasedAt: "2026-10-29T00:13:00.000Z" } }
      : {}),
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
        items: [item(1, "担担面", true), item(2, "炒饭", false)],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/operations/kitchen");
  const chasedTicket = page.locator(".kitchen-ticket").filter({ hasText: "担担面" });
  const otherTicket = page.locator(".kitchen-ticket").filter({ hasText: "炒饭" });
  await expect(chasedTicket).toBeVisible();
  await expect(chasedTicket).not.toHaveAttribute("data-chased", "true");
  // A server chases the noodles: on the next read the ticket is red and says so.
  chases = 2;
  await page.reload();
  await expect(chasedTicket).toHaveAttribute("data-chased", "true");
  await expect(chasedTicket.locator(".kitchen-work-item__chased")).toContainText("Chased 2 times");
  await expect(otherTicket).not.toHaveAttribute("data-chased", "true");
  const axe = await new AxeBuilder({ page }).include(".kitchen-ticket").analyze();
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
});
