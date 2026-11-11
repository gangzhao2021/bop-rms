import { expect, test } from "@playwright/test";

/**
 * Live v15 2026-11-10 (merchant-outage-recovery): a staff page reloaded with the device fully
 * offline shows this app's own page, saying the device is offline, never the browser's error page.
 * The page also comes from this device when the store system is down (the front page answers 503).
 */
const id = (n: number) => "0190b2f0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const session = {
  authenticated: true,
  csrf: "a".repeat(43),
  workspace: {
    screenId: "HOME-OVERVIEW",
    selectedScope: scope,
    authorizedStores: [scope],
    businessDate: "2026-09-14",
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
};
test.use({ serviceWorkers: "allow", locale: "en-CA" });

for (const width of [390, 1024, 1440])
  test(`@production Orders reloaded with the device offline says so, at ${width}`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
    for (const pattern of ["**/merchant/orders?*", "**/merchant/orders"])
      await page.route(pattern, (route) =>
        route.fulfill({ headers, json: { items: [], nextAfterOrderReference: null } }),
      );
    await page.goto("/operations/orders");
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible();
    // The page keeps its own offline copy once it has been opened here.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "This device is offline", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Check the wifi.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "While the connection is down" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/offline-reload-${width}.png`, fullPage: true });
    await context.setOffline(false);
    // It returns to Orders by itself once the network is back.
    await expect(page.getByRole("heading", { name: "Orders", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
  });

test("@production Home reloaded with the device offline shows the same page, in the device's language", async ({
  page,
  context,
}) => {
  await page.route("**/merchant/session", (route) => route.fulfill({ headers, json: session }));
  await page.goto("/app");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "This device is offline", level: 1 }),
  ).toBeVisible();
  await context.setOffline(false);
});
