import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ⑧ (Owner decision 3): staff move a table's party to another table — only to one
 * that is free, in use and has a table code; each other table says why it can't be chosen (one
 * with a party: joining two tables is not available yet). After the move the party's table is
 * shown and the table it left waits for cleaning. Synthetic TEST data.
 */
const id = (n: number) => "0190996c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const csrf = "a".repeat(43);
const table = (n: number, label: string, overrides: Record<string, unknown> = {}) => ({
  tableReference: id(n),
  stableLabel: label,
  areaCode: "MAIN",
  capacity: 4,
  lifecycle: "Published",
  operationalState: "Available",
  blockReasonCode: null,
  aggregateVersion: 2,
  currentDiningSessionReference: null,
  elapsedMinutes: null,
  qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
  paymentTiming: "PayLater",
  session: null,
  staffRoundsAwaitingPayment: [],
  ...overrides,
});

test("@production staff move a table's party to a free table with a code", async ({ page }) => {
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf,
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
              screenId: "DIN-FLOOR-BOARD",
              label: "Tables",
              href: "/operations/dining",
              permission: "dining.operate",
            },
          ],
        },
      },
    }),
  );
  let moved = false;
  const seated = { phase: "Active", version: 3, orderReference: null };
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        canCloseSessions: false,
        items: [
          table(
            1,
            "T6",
            moved
              ? {
                  operationalState: "TemporarilyBlocked",
                  blockReasonCode: "CLEANING",
                  aggregateVersion: 4,
                }
              : { currentDiningSessionReference: id(2), elapsedMinutes: 40, session: seated },
          ),
          table(
            3,
            "T7",
            moved
              ? {
                  currentDiningSessionReference: id(2),
                  elapsedMinutes: 41,
                  session: seated,
                  aggregateVersion: 3,
                }
              : {},
          ),
          table(4, "T8", {
            currentDiningSessionReference: id(5),
            elapsedMinutes: 10,
            session: seated,
          }),
          table(6, "T9", { qrCodeValidUntil: null }),
          table(7, "T10", { operationalState: "TemporarilyBlocked", blockReasonCode: "CLEANING" }),
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/sessions/qr-join", (route) =>
    route.fulfill({
      headers,
      json: { diningSessionReference: id(2), paused: false, phones: [], rounds: [] },
    }),
  );
  await page.route("**/merchant/dining/party-size", (route) =>
    route.fulfill({ headers, json: { askPartySize: false, partySizes: [] } }),
  );
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/table-move", (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    sent.push(body);
    moved = true;
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        diningSessionReference: id(2),
        tableReference: id(3),
        tableLabel: "T7",
        fromTableReference: id(1),
        fromTableLabel: "T6",
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T6", exact: true }).click();
  const panel = page.getByRole("region", { name: "Move this party to another table" });
  const target = panel.getByRole("combobox", { name: "Move to…" });
  // Only a free table with a code can be chosen; every other table says why.
  await expect(target.getByRole("option")).toHaveText([
    "Choose a table",
    "T7 · seats 4",
    "T8 — has a party (two parties can't share a table)",
    "T9 — no table code",
    "T10 — being cleaned",
  ]);
  for (const name of [/^T8 /u, /^T9 /u, /^T10 /u])
    await expect(target.getByRole("option", { name })).toHaveAttribute("disabled", "");
  await expect(panel.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
  await target.selectOption({ label: "T7 · seats 4" });
  const axe = await new AxeBuilder({ page }).include(".table-move").analyze();
  expect(axe.violations).toEqual([]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel.getByRole("button", { name: "Move to table T7" }).click();
  await expect(
    page.getByText(
      "Moved to table T7. Guests scan the code on table T7 to keep ordering; table T6 is marked for cleaning.",
    ),
  ).toBeVisible();
  expect(sent).toEqual([
    {
      action: "Move",
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      tableReference: id(1),
      expectedTableVersion: 2,
      targetTableReference: id(3),
      expectedTargetTableVersion: 2,
    },
  ]);
  // The party's table (T7) is shown now; T6 waits for cleaning.
  await expect(
    page.getByRole("region", { name: "Move this party to another table" }).getByRole("option", {
      name: /^T6 — being cleaned$/u,
    }),
  ).toHaveAttribute("disabled", "");
  // The floor's own "Mark unavailable" step (an existing staff word, allowed as on other pages).
  await expectNoInternalText(page, ["Mark unavailable"]);
});
