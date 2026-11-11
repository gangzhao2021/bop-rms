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

// v15 batch 7: a table just added (its name ending in ")") gets its code, and its row says so at
// once — no reload of the list.
test("@production a table just added gets its code and its row shows it without a reload", async ({
  page,
}) => {
  await workspace(page);
  let reads = 0;
  page.on("request", (request) => {
    if (request.method() === "GET" && /\/merchant\/dining\/table-qr$/u.test(request.url()))
      reads += 1;
  });
  await page.route("**/merchant/dining/table-qr/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        item: {
          tableReference: body.tableReference,
          stableLabel: "DBT 9 (TEST)",
          areaCode: "MAIN",
          aggregateVersion: 3,
          seated: false,
          codeState: "Active",
          issuedAt: "2026-11-01T15:00:00.000Z",
          validUntil: "2027-05-01T15:00:00.000Z",
        },
      },
    });
  });
  await page.goto("/app/operations/tables");
  await page.getByRole("button", { name: "Add a table" }).first().click();
  await page.getByLabel("Name staff and guests see", { exact: false }).fill("DBT 9 (TEST)");
  await page.getByLabel("Seats").fill("4");
  await page.getByRole("button", { name: "Add table" }).click();
  const row = page.getByRole("row", { name: /DBT 9 \(TEST\)/u });
  await expect(row).toContainText("No code yet");
  const before = reads;
  await row.getByRole("button", { name: "Create code" }).click();
  await page
    .getByRole("form", { name: "Create a code for DBT 9 (TEST)?" })
    .getByRole("button", { name: "Create code" })
    .click();
  await expect(page.getByText("DBT 9 (TEST) has a code. Print it now.")).toBeVisible();
  await expect(row).toContainText("Ready to print");
  await expect(row).not.toContainText("No code yet");
  expect(reads).toBe(before);
});
