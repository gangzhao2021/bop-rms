import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION, coordinator 2026-10-31 decision 3: the Stores page offers
 * "Open a store" only to someone the server says may open one (Brand Owner authority). A Store
 * Manager who sees Store setup gets the list of their Stores and no form, no dead button. Synthetic
 * Stores.
 */
const id = (n: number) => "018f7731-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const one = { brandLabel: "Synthetic Brand", storeLabel: "Training Store", storeReference: id(99) };
const two = {
  brandLabel: "Synthetic Brand",
  storeLabel: "DEMO Store 2 – not production",
  storeReference: id(98),
};

async function workspace(page: Page, mayOpen: boolean) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...one, timeZone: "America/Toronto" },
          authorizedStores: [one, two],
          businessDate: "2026-10-30",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            // A Store Manager reads Store setup; that never meant they may open a Store.
            {
              screenId: "STORE-SETUP",
              label: "Store setup",
              href: "/app/organization/stores/" + one.storeReference + "/setup",
              permission: "organization.manage",
            },
            {
              screenId: "ORG-STORE-LIST",
              label: "Stores",
              href: "/app/organization/stores",
              permission: "organization.store.read",
            },
          ],
        },
      },
    }),
  );
  const asked: string[] = [];
  await page.route("**/merchant/organization/stores/may-open", (route) => {
    asked.push(route.request().method());
    return route.fulfill({ headers, json: { mayOpen } });
  });
  const opened: unknown[] = [];
  await page.route("**/merchant/organization/stores", (route) => {
    opened.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      headers,
      json: { status: "Opened", storeReference: id(97) },
    });
  });
  return { asked, opened };
}

test("@production someone who may not open a Store sees their Stores and no form", async ({
  page,
}) => {
  const state = await workspace(page, false);
  await page.goto("/app/organization/stores");
  await expect(page.getByRole("heading", { name: "Your stores" })).toBeVisible();
  await expect(page.getByText("DEMO Store 2 – not production")).toBeVisible();
  await expect.poll(() => state.asked.length).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { name: "Open a store" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open store" })).toHaveCount(0);
  await expectNoInternalText(page);
});

test("@production the Brand Owner opens a Store from the form", async ({ page }) => {
  const state = await workspace(page, true);
  await page.goto("/app/organization/stores");
  await expect(page.getByRole("heading", { name: "Open a store" })).toBeVisible();
  await page.getByLabel("Store name (as guests see it)").fill("DEMO Store 3 – not production");
  await page.getByLabel("Short code").fill("demo_03");
  await page.getByRole("button", { name: "Open store" }).click();
  await expect(page.getByText("is opened", { exact: false })).toBeVisible();
  expect(state.opened).toEqual([
    expect.objectContaining({ code: "DEMO_03", displayName: "DEMO Store 3 – not production" }),
  ]);
  await expectNoInternalText(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? "")),
  ).toEqual([]);
});
