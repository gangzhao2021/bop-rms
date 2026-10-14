import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/** WP-2423 Q11 (Section 88 DIN-TABLE-LIST): print, replace and turn off table QR codes. */
const id = (n: number) => "018f7800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
};
const headers = { "cache-control": "no-store" };
const soon = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
const later = new Date(Date.now() + 170 * 24 * 60 * 60 * 1000).toISOString();
const issued = new Date(Date.now() - 170 * 24 * 60 * 60 * 1000).toISOString();
const row = (n: number, label: string, extra: Record<string, unknown>) => ({
  tableReference: id(n),
  stableLabel: label,
  areaCode: "PATIO",
  aggregateVersion: 3,
  seated: false,
  codeState: "Active",
  issuedAt: issued,
  validUntil: later,
  ...extra,
});

test("@production Table QR codes: print one, replace a lost code at a seated table, create a new one", async ({
  page,
}) => {
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-14",
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
  let rows = [
    row(1, "T1", { validUntil: soon }),
    row(2, "T2", { seated: true }),
    row(3, "Patio 3", { codeState: "None", issuedAt: null, validUntil: null }),
  ];
  const commands: Record<string, unknown>[] = [];
  const sheets: unknown[] = [];
  let denied = false;
  await page.route("**/merchant/dining/table-qr", (route) =>
    denied
      ? route.fulfill({ status: 403, headers, json: { error: "request_denied" } })
      : route.fulfill({ headers, json: { items: rows } }),
  );
  await page.route("**/merchant/dining/table-qr/command", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    commands.push(body);
    const current = rows.find((item) => item.tableReference === body.tableReference);
    const next = {
      ...current,
      aggregateVersion: (current?.aggregateVersion ?? 0) + 1,
      codeState: "Active",
      issuedAt: new Date().toISOString(),
      validUntil: later,
    };
    rows = rows.map((item) => (item.tableReference === body.tableReference ? next : item)) as never;
    return route.fulfill({ headers, json: { status: "Applied", item: next } });
  });
  await page.route("**/merchant/dining/table-qr/sheet", (route) => {
    sheets.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: {
        fileName: "table-qr-codes-2026-10-14.html",
        html: "<!doctype html><html><body><svg></svg></body></html>",
      },
    });
  });

  await page.goto("/app/operations/tables");
  await expect(page.getByRole("heading", { name: "Table QR codes", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Table QR codes" })).toBeVisible();
  await expect(page.getByRole("row", { name: /T1/u })).toContainText("Ready to print");
  await expect(page.getByRole("row", { name: /T2/u })).toContainText("Guests seated");
  await expect(page.getByRole("row", { name: /Patio 3/u })).toContainText("No code yet");
  await expect(page.getByText("Codes stop working soon")).toBeVisible();
  await expect(page.getByText(/T1: this code stops working on/u)).toBeVisible();
  // No internal codes or references on the page.
  await expect(page.locator("main")).not.toContainText(id(1));
  await expect(page.locator("main")).not.toContainText("DIN-TABLE-LIST");

  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.getByRole("row", { name: /Patio 3/u })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/table-qr-codes-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => v.id),
  ).toEqual([]);

  // Reprint one damaged sticker: the same code, downloaded as a printable sheet.
  const download = page.waitForEvent("download");
  await page.getByRole("row", { name: /T1/u }).getByRole("button", { name: "Print" }).click();
  expect((await download).suggestedFilename()).toBe("table-qr-codes-2026-10-14.html");
  expect(sheets).toEqual([{ tableReferences: [id(1)] }]);
  await expect(page.getByText(/with the code for table T1/u)).toBeVisible();
  expect(commands).toEqual([]);

  // A lost code at a seated table: staff are told what happens to the guests first.
  await page.getByRole("row", { name: /T2/u }).getByRole("button", { name: "Replace" }).click();
  await expect(page.getByRole("heading", { name: "Replace the code for table T2?" })).toBeVisible();
  await expect(page.getByText(/Guests are seated at this table now/u)).toBeVisible();
  const replace = page.getByRole("button", { name: "Replace code" });
  await expect(replace).toBeDisabled();
  await page.screenshot({ path: "test-results/table-qr-codes-confirm-1440.png", fullPage: true });
  await page.getByLabel("I understand the old code stops working").check();
  await replace.click();
  await expect(
    page.getByText("Table T2 has a new code. The old code no longer works. Print the new one now."),
  ).toBeVisible();
  expect(commands[0]).toMatchObject({
    action: "Issue",
    tableReference: id(2),
    expectedAggregateVersion: 3,
  });

  // Turning off a seated table's code: no new code, guests ask staff (not "scan the new code").
  await page.getByRole("row", { name: /T2/u }).getByRole("button", { name: "Turn off" }).click();
  await expect(
    page.getByRole("heading", { name: "Turn off the code for table T2?" }),
  ).toBeVisible();
  await expect(
    page.getByText(/there is no new code to scan: they ask a staff member/u),
  ).toBeVisible();
  await expect(page.getByText(/scan the new code/u)).toHaveCount(0);
  await expect(page.getByLabel("I understand this table's code stops working")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(commands).toHaveLength(1);

  // A table without a code gets one; it can be printed at once.
  await page
    .getByRole("row", { name: /Patio 3/u })
    .getByRole("button", { name: "Create code" })
    .click();
  await page
    .getByRole("form", { name: "Create a code for table Patio 3?" })
    .getByRole("button", { name: "Create code" })
    .click();
  await expect(page.getByText("Table Patio 3 has a code. Print it now.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Patio 3/u })).toContainText("Ready to print");
  expect(commands[1]).toMatchObject({ action: "Issue", tableReference: id(3) });

  // Without permission the page says so and shows no tables.
  denied = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No access" })).toBeVisible();
  await expect(page.getByRole("row", { name: /T1/u })).toHaveCount(0);
});
