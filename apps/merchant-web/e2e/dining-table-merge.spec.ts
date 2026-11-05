import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 item 8 ⑨ (DEC-DINING-TABLE-MERGE): staff merge a table's party into another seated
 * table — only one that pays at the end, still ordering, with nothing paid or split, and that has
 * ordered when this one has; each other table says why it can't be chosen. After the merge the
 * other table is shown with this table's rounds ("From table T6") and this one waits for cleaning.
 * Synthetic TEST data.
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

/** The whole of a merge's screen, with what the per-head charge answers after it. */
async function stubMerge(page: Page, teaAnswer: (route: Route) => Promise<void>) {
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
          businessDate: "2026-10-30",
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
  let merged = false;
  const party = (n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    currentDiningSessionReference: id(n),
    elapsedMinutes: 30,
    session: {
      phase: "Active",
      version: 3,
      orderReference: id(n + 50),
      paymentStarted: false,
      mergedTables: [],
      ...overrides,
    },
  });
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
            merged
              ? {
                  operationalState: "TemporarilyBlocked",
                  blockReasonCode: "CLEANING",
                  aggregateVersion: 3,
                }
              : party(2),
          ),
          table(3, "T7", {
            ...party(
              4,
              merged ? { mergedTables: [{ fromTableLabel: "T6", orderReference: id(52) }] } : {},
            ),
            aggregateVersion: 2,
          }),
          table(5, "T8", { ...party(6), paymentTiming: "PayFirst" }),
          table(7, "T9", party(8, { phase: "Closing" })),
          table(9, "T10", party(10, { paymentStarted: true })),
          table(11, "T11", party(12, { orderReference: null })),
          table(13, "T12"),
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
  const tea: Record<string, unknown>[] = [];
  await page.route("**/merchant/dining/tea-charge", (route) => {
    tea.push(route.request().postDataJSON() as Record<string, unknown>);
    return teaAnswer(route);
  });
  // The merged bill (T7's and T6's rounds), as the staff bill read gives it.
  await page.route("**/merchant/dining/table-bill", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(4),
        sessionPhase: "Active",
        sessionVersion: 4,
        paymentTiming: "PayLater",
        tableLabel: "T7",
        orderReference: id(54),
        rounds: [
          {
            roundNumber: 1,
            orderBatchReference: id(21),
            submissionReference: id(31),
            items: [
              {
                orderItemReference: id(903),
                quantity: 1,
                displayName: "Milk tea",
                subtotalMinor: "750",
                totalMinor: "848",
              },
            ],
            subtotalMinor: "750",
            taxMinor: "98",
            totalMinor: "848",
            paid: false,
          },
          {
            roundNumber: 2,
            orderBatchReference: id(22),
            submissionReference: id(32),
            items: [
              {
                orderItemReference: id(904),
                quantity: 1,
                displayName: "Mapo tofu",
                subtotalMinor: "2038",
                totalMinor: "2303",
              },
            ],
            subtotalMinor: "2038",
            taxMinor: "265",
            totalMinor: "2303",
            paid: false,
          },
        ],
        owed: { subtotalMinor: "2788", taxMinor: "363", totalMinor: "3151" },
        consistent: true,
        settlement: null,
      },
    }),
  );
  await page.route("**/merchant/dining/table-merge", (route) => {
    sent.push(route.request().postDataJSON() as Record<string, unknown>);
    merged = true;
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        diningSessionReference: id(4),
        tableReference: id(3),
        tableLabel: "T7",
        fromTableReference: id(1),
        fromTableLabel: "T6",
        partySize: 5,
      },
    });
  });
  return { sent, tea };
}

test("@production staff merge a table's party into another seated table", async ({ page }) => {
  const { sent, tea } = await stubMerge(page, (route) =>
    route.fulfill({
      headers,
      json: {
        status: "NoTeaCharge",
        charged: 0,
        expected: null,
        guests: null,
        override: null,
        overrideVersion: 0,
        problem: null,
      },
    }),
  );
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Select T6", exact: true }).click();
  const panel = page.getByRole("region", { name: "Merge this party into another table" });
  const target = panel.getByRole("combobox", { name: "Merge into…" });
  // Only a seated table that pays at the end, still ordering, with nothing paid or split, and that
  // has ordered; every other table says why.
  await page.locator("details.table-panel__manage").evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await expect(target.getByRole("option")).toHaveText([
    "Choose a table",
    "T7",
    "T8 — pays for each round",
    "T9 — checking out",
    "T10 — paid or split already",
    "T11 — hasn't ordered yet (merge it into this table instead)",
  ]);
  for (const name of [/^T8 /u, /^T9 /u, /^T10 /u, /^T11 /u])
    await expect(target.getByRole("option", { name })).toHaveAttribute("disabled", "");
  await expect(panel.getByRole("button", { name: "Merge", exact: true })).toBeDisabled();
  await target.selectOption({ label: "T7" });
  const axe = await new AxeBuilder({ page }).include(".table-move").analyze();
  expect(axe.violations).toEqual([]);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await panel.getByRole("button", { name: "Merge into table T7" }).click();
  await expect(
    page.getByText(
      "Merged into table T7: 5 guests. Phones from table T6 scan the code on table T7 to keep ordering; table T6 is marked for cleaning.",
    ),
  ).toBeVisible();
  expect(sent).toEqual([
    {
      action: "Merge",
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      tableReference: id(1),
      expectedTableVersion: 2,
      targetTableReference: id(3),
      expectedTargetTableVersion: 2,
    },
  ]);
  // The tea follows the guests at T7 (the same sync as a party size change).
  expect(tea.find((command) => command.action === "Sync")).toMatchObject({
    diningSessionReference: id(4),
  });
  // T7 is shown with T6's rounds on its bill.
  await expect(page.getByRole("region", { name: "From table T6" })).toBeVisible();
  // One bill for both tables (the cashier never adds the groups up).
  const whole = page.getByRole("region", { name: "The table's whole bill" });
  await expect(whole).toContainText("Whole bill");
  await expect(whole).toContainText("$31.51");
  await expectNoInternalText(page, ["Mark unavailable"]);
});

// WP-2423 DEC-MERCHANT-LOCK-SCOPE: the per-head charge is money, so a merge is never announced as
// all done while it isn't confirmed. It says so; the table the party joined offers the way to match.
for (const [name, answer, said] of [
  [
    "the system is busy",
    (route: Route) =>
      route.request().postDataJSON().action === "Sync"
        ? route.fulfill({ headers, status: 503, json: { error: "unavailable" } })
        : route.fulfill({
            headers,
            json: {
              status: "Mismatch",
              charged: 3,
              expected: 5,
              guests: 5,
              override: null,
              overrideVersion: 0,
              problem: null,
              itemName: "Sauce (TEST)",
            },
          }),
    "Per-head charge on the bill isn't confirmed: the system is busy.",
  ],
  [
    "the charge doesn't match",
    (route: Route) =>
      route.fulfill({
        headers,
        json: {
          status: "Mismatch",
          charged: 3,
          expected: 5,
          guests: 5,
          override: null,
          overrideVersion: 0,
          problem: "Unavailable",
          itemName: "Sauce (TEST)",
        },
      }),
    "Sauce (TEST) on the bill isn't confirmed: the system is busy.",
  ],
] as const) {
  test(`@production a merge says the charge isn't confirmed when ${name}`, async ({ page }) => {
    await stubMerge(page, answer);
    await page.goto("/operations/dining");
    await page.getByRole("button", { name: "Select T6", exact: true }).click();
    await page.locator("details.table-panel__manage").evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
    const panel = page.getByRole("region", { name: "Merge this party into another table" });
    await panel.getByRole("combobox", { name: "Merge into…" }).selectOption({ label: "T7" });
    await panel.getByRole("button", { name: "Merge into table T7" }).click();
    await expect(page.getByText(said, { exact: false }).first()).toBeVisible();
    // T7 opens with the charge above its payment, and the way to match it.
    await expect(
      page
        .locator(".table-panel__tea-check")
        .getByRole("button", { name: "Match Sauce (TEST) to the guests" }),
    ).toBeVisible();
    await expectNoInternalText(page, ["Mark unavailable"]);
  });
}
