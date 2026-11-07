import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-11-01): a Store with no tables adds its
 * tables on Table QR codes and sees its own pickup link. Synthetic Store; the server is mocked.
 */
const id = (n: number) => "018f7731-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const store = {
  brandLabel: "Synthetic Brand",
  storeLabel: "DEMO Store 2 – not production",
  storeReference: id(98),
};
const pickupLink = "https://order.example/#pickup=" + id(97);

async function workspace(page: Page) {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...store, timeZone: "America/Toronto" },
          authorizedStores: [store],
          businessDate: "2026-11-01",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "DIN-TABLE-LIST",
              label: "Table QR codes",
              href: "/app/operations/tables",
              permission: "dining.table.qr.manage",
            },
          ],
        },
      },
    }),
  );
  const tables: unknown[] = [];
  await page.route("**/merchant/dining/table-qr", (route) =>
    route.fulfill({ headers, json: { items: tables, pickupLink } }),
  );
  const added: unknown[] = [];
  await page.route("**/merchant/dining/table-qr/tables", (route) => {
    const body = route.request().postDataJSON() as { label: string; capacity: number };
    added.push(body);
    const row = {
      tableReference: id(10),
      stableLabel: body.label,
      areaCode: "MAIN",
      aggregateVersion: 2,
      seated: false,
      codeState: "None",
      issuedAt: null,
      validUntil: null,
    };
    tables.push(row);
    return route.fulfill({ headers, json: { status: "Applied", item: row } });
  });
  return { added };
}

for (const [width, height] of [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const)
  test(`@production a Store with no tables adds one and sees its pickup link (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    const state = await workspace(page);
    await page.goto("/app/operations/tables");
    await expect(page.getByText("This Store has no tables yet.", { exact: false })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pickup ordering" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy pickup link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Print pickup poster" })).toBeVisible();
    await page.getByRole("button", { name: "Add a table" }).first().click();
    await page.getByLabel("Name staff and guests see", { exact: false }).fill("Table 5");
    await page.getByLabel("Seats").fill("4");
    await page.getByRole("button", { name: "Add table" }).click();
    await expect(page.getByText("Table 5 is added", { exact: false })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "Table 5" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create code" })).toBeVisible();
    expect(state.added).toEqual([expect.objectContaining({ label: "Table 5", capacity: 4 })]);
    await expectNoInternalText(page);
    await page.screenshot({ path: `test-results/table-qr-manage-${width}.png`, fullPage: true });
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((v) => ["critical", "serious"].includes(v.impact ?? "")),
    ).toEqual([]);
  });
