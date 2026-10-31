import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { tonightSummaryFixture } from "../src/tonight-summary.fixtures.js";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 7: a person working in several Stores of the
 * Brand sees tonight at each of them on Reports → Stores, each Store read on its own with the
 * same figures as its own Tonight, and their total ("2 of 3 stores" when one Store's sales are not
 * theirs to see). With one Store there is no such tab. Synthetic figures.
 */
const id = (n: number) => "018f7731-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store = (n: number, label: string) => ({
  brandLabel: "Synthetic Brand",
  storeLabel: label,
  storeReference: id(n),
});
const one = store(99, "Training Store"),
  two = store(98, "DEMO Store 2 – not production"),
  three = store(97, "Third Store");
const headers = { "cache-control": "no-store" };
const evening = "2026-10-28T01:42:00.000Z";
test.use({ timezoneId: "America/Toronto" });

async function workspace(page: Page, stores: readonly (typeof one)[]) {
  await page.clock.setFixedTime(new Date(evening));
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...one, timeZone: "America/Toronto" },
          authorizedStores: stores,
          businessDate: "2026-10-27",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "RPT-OPS-DASHBOARD",
              label: "Reports",
              href: "/app/reports/operations",
              permission: "reporting.sales.read",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/merchant/business-day", (route) =>
    route.fulfill({
      headers,
      json: {
        businessDate: "2026-10-27",
        startsAt: "2026-10-27T08:00:00.000Z",
        endsAt: "2026-10-28T08:00:00.000Z",
        timeZone: "America/Toronto",
        observedAt: evening,
      },
    }),
  );
  await page.route("**/merchant/reports/tonight", (route) =>
    route.fulfill({ headers, json: tonightSummaryFixture() }),
  );
}

test("@production Reports → Stores shows tonight at each Store and their total", async ({
  page,
}) => {
  await workspace(page, [one, two, three]);
  const requested: string[] = [];
  await page.route("**/merchant/reports/stores/*/tonight", (route) => {
    const reference = new URL(route.request().url()).pathname.split("/")[4] ?? "";
    requested.push(reference);
    if (reference === three.storeReference)
      return route.fulfill({ status: 403, headers, json: { error: "request_denied" } });
    return route.fulfill({ headers, json: tonightSummaryFixture() });
  });
  await page.goto("/app/reports/operations");
  await page.getByRole("button", { name: "Stores" }).click();
  const table = page.getByRole("table");
  await expect(table.getByRole("row", { name: /Training Store/u })).toContainText("$394.25");
  await expect(table.getByRole("row", { name: /DEMO Store 2/u })).toContainText("$394.25");
  await expect(table.getByRole("row", { name: /Third Store/u })).toContainText(
    "You don't see this store's sales",
  );
  // The total is the two readable Stores' figures added up, and says it covers 2 of 3.
  const total = table.getByRole("row", { name: /Total/u });
  await expect(total).toContainText("2 of 3 stores");
  await expect(total).toContainText("$788.50");
  expect(new Set(requested)).toEqual(
    new Set([one.storeReference, two.storeReference, three.storeReference]),
  );
  await expectNoInternalText(page);
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? "")),
  ).toEqual([]);
});

test("@production with one Store there is no Stores tab", async ({ page }) => {
  await workspace(page, [one]);
  await page.goto("/app/reports/operations");
  await expect(page.getByRole("button", { name: "Tonight" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stores" })).toHaveCount(0);
});
