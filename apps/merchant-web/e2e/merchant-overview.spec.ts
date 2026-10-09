import { expect, test } from "@playwright/test";

test("@production Merchant Overview uses the authorized workspace snapshot at desktop and mobile widths", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const primary = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
  };
  const secondary = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Second Store",
    storeReference: id(98),
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: primary,
          authorizedStores: [primary, secondary],
          businessDate: "2026-09-23",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "HOME-OVERVIEW",
              label: "Overview",
              href: "/app",
              permission: "merchant.access",
            },
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

  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "Training Store" })).toBeVisible();
  const workspace = page.getByRole("navigation", { name: "Workspace" });
  await expect(workspace.getByRole("link", { name: "Home" }).first()).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(workspace.getByRole("link", { name: "Orders" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Kitchen" })).toHaveCount(0);
  await expect(page.getByText("Open", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Authorized Store" })).toHaveValue(id(99));
  await expect(page.getByText("WP-1905")).toHaveCount(0);
  await expect(page.getByText("not available in this release", { exact: false })).toBeVisible();

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".workspace-page__freshness")).toHaveText("Updated");
    await expect(page.locator(".workspace-page__freshness")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/home-overview-${width}.png` });
  }
});
