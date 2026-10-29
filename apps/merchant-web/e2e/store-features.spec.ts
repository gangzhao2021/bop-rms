import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the owner chooses the modules the Store uses. The
 * full-service setup turns off counter ordering and inventory and recipes; a module can be turned
 * back on; someone else's change in between is shown and asked again. Synthetic, TEST-only data.
 */
const id = (n: number) => "0190a7f2-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = id(99);
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: store,
  timeZone: "America/Toronto",
};

async function session(page: Page) {
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
          businessDate: "2026-10-29",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "STORE-CAPABILITY",
              label: "Store features",
              href: "/app/organization/stores/" + store + "/capabilities",
              permission: "organization.manage",
            },
          ],
        },
      },
    }),
  );
}

test("@production the owner applies the full-service setup, turns a module back on, and sees a change made meanwhile", async ({
  page,
}) => {
  await session(page);
  let current = {
    version: 0,
    templateCode: null as string | null,
    modules: { counterOrder: true, pickup: true, inventory: true },
    changedAt: null as string | null,
    canChange: true,
  };
  const commands: Record<string, unknown>[] = [];
  let conflictOnce = false;
  await page.route("**/merchant/store/features", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    commands.push(body);
    if (body.action === "Read") return route.fulfill({ headers, json: current });
    if (conflictOnce) {
      conflictOnce = false;
      // Another owner session turned counter ordering back on first.
      current = {
        ...current,
        version: current.version + 1,
        templateCode: "Custom",
        modules: { ...current.modules, counterOrder: true },
      };
      return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
    }
    if (body.expectedVersion !== current.version)
      return route.fulfill({ headers, status: 409, json: { error: "store_features_changed" } });
    current =
      body.action === "ApplyTemplate"
        ? {
            ...current,
            version: current.version + 1,
            templateCode: "FullService",
            modules: { ...current.modules, counterOrder: false, inventory: false },
            changedAt: "2026-10-29T15:00:00.000Z",
          }
        : {
            ...current,
            version: current.version + 1,
            templateCode: "Custom",
            modules: { ...current.modules, ...(body.modules as object) },
            changedAt: "2026-10-29T15:05:00.000Z",
          };
    return route.fulfill({ headers, json: current });
  });

  await page.goto("/app/organization/stores/" + store + "/capabilities");
  await expect(page.getByRole("heading", { name: "Store features", exact: true })).toBeVisible();
  const counter = page.getByRole("checkbox", { name: /Counter ordering/u });
  const inventory = page.getByRole("checkbox", { name: /Inventory and recipes/u });
  await expect(counter).toBeChecked();
  await expect(inventory).toBeChecked();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page }).include(".store-features").analyze();
  expect(axe.violations).toEqual([]);
  await expectNoInternalText(page);

  // The full-service setup turns off counter ordering and inventory and recipes.
  await page.getByRole("button", { name: "Use the full-service setup" }).click();
  await expect(page.getByText("The full-service restaurant setup is in use.")).toBeVisible();
  await expect(page.getByText("This store uses the full-service restaurant setup.")).toBeVisible();
  await expect(counter).not.toBeChecked();
  await expect(inventory).not.toBeChecked();
  expect(commands.at(-1)).toMatchObject({
    action: "ApplyTemplate",
    template: "FullService",
    expectedVersion: 0,
  });

  // Inventory back on: saved as the next version, pickup is not sent.
  await inventory.check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Saved. Staff see the change the next time a page opens."),
  ).toBeVisible();
  expect(commands.at(-1)).toMatchObject({
    action: "Change",
    expectedVersion: 1,
    modules: { counterOrder: false, inventory: true },
  });
  await expect(page.getByText(/Last changed/u)).toBeVisible();

  // Someone else changed it meanwhile: the page says so and shows the latest.
  conflictOnce = true;
  await inventory.uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText(
      "Someone else changed these settings. The page now shows them; check and save again.",
    ),
  ).toBeVisible();
  await expect(counter).toBeChecked();
  await expect(inventory).toBeChecked();
});
