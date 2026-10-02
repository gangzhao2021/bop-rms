import { expect, test } from "@playwright/test";
const id = (n: number) => `019a0024-2421-7000-8000-${n.toString(16).padStart(12, "0")}`;
const store = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(2),
};
test("@production current Store capability decisions, gating and scope recovery", async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  let disabled = false,
    malformed = false;
  await page.route("**/merchant/session", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        authenticated: true,
        csrf: "c".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: store,
          authorizedStores: [store],
          businessDate: "2026-09-29",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "HOME-OVERVIEW",
              label: "Overview",
              href: "/app",
              permission: "merchant.access",
            },
          ],
        },
      }),
    }),
  );
  await page.route("**/merchant/store-capability", async (route) => {
    const key = route.request().postDataJSON().capabilityKey as string;
    requests.push(key);
    const gate = key === "organization.store_capability",
      allow = gate && !disabled;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        brandReference: id(1),
        storeReference: id(2),
        capabilityKey: key,
        controlKey: gate ? "organization.store.capability" : "catalog.product.edit",
        backendExecution: allow ? "Allow" : "Deny",
        frontendVisibility: malformed ? "Show" : allow ? "Show" : "Hide",
        reason: allow ? "Enabled" : "Disabled",
        source: "StoreOverride",
        controlReference: id(gate ? 3 : 4),
        controlVersion: 1,
        observedAt: new Date().toISOString(),
      }),
    });
  });
  const url = `/app/organization/stores/${id(2)}/capabilities`;
  await page.goto(url);
  await expect(
    page.getByRole("heading", { name: "Capability disabled", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  await expect(page.getByText("Hide", { exact: true })).toBeVisible();
  expect(requests).toEqual(["organization.store_capability", "catalog.cat_product_edit"]);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("combobox", { name: "Capability", exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `/private/tmp/wp2421-current-store-capability-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("combobox", { name: "Capability", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Refresh capability" })).toBeFocused();
  await expect(
    page.getByText("This capability observation has expired. Refresh to check the current result."),
  ).toBeVisible({ timeout: 7000 });
  await expect(page.getByText("Hide", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh capability" }).click();
  await expect(
    page.getByRole("heading", { name: "Capability disabled", exact: true }),
  ).toBeVisible();
  await context.setOffline(true);
  await expect(
    page.getByText("Offline. Connect and refresh before relying on a capability result."),
  ).toBeVisible();
  await expect(page.getByText("Hide", { exact: true })).toHaveCount(0);
  await context.setOffline(false);
  await page.getByRole("button", { name: "Refresh capability" }).click();
  await expect(
    page.getByRole("heading", { name: "Capability disabled", exact: true }),
  ).toBeVisible();
  disabled = true;
  const before = requests.length;
  await page.getByRole("button", { name: "Refresh capability" }).click();
  await expect(
    page.getByText(
      "Store capability administration is disabled or its current eligibility is unavailable.",
    ),
  ).toBeVisible();
  expect(requests.slice(before)).toEqual(["organization.store_capability"]);
  disabled = false;
  malformed = true;
  await page.getByRole("button", { name: "Refresh capability" }).click();
  await expect(
    page.getByText("Current capability facts could not be loaded. No enablement was inferred."),
  ).toBeVisible();
  const beforeWrongStore = requests.length;
  await page.goto(`/app/organization/stores/${id(5)}/capabilities`);
  await expect(
    page.getByText("Select this Store in the workspace before checking its capabilities."),
  ).toBeVisible();
  expect(requests.length).toBe(beforeWrongStore);
});
