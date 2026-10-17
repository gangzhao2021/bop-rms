import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

// v15 run (738b4c8b): the stock count list showed "Started" as 2026-10-07T22:59:17.279Z and the
// count said "counted by Staff 0100". Staff read Store-local times and people's names.
test("@production stock counts show Store-local times and people's names, never identifiers", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-07",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "INV-COUNT-LIST",
              label: "Stock counts",
              href: "/operations/inventory/counts",
              permission: "inventory.count.read",
            },
          ],
        },
      },
    }),
  );
  const viewer = id(1),
    owner = id(256),
    milk = id(20),
    fridge = id(30);
  const base = {
    sourceAsOf: "2026-10-07T23:10:00.000Z",
    viewer,
    permissions: { mayCreate: true, mayCount: true, mayApprove: true },
    varianceReasons: ["UNRECORDED_WASTE", "COUNTING_ERROR"],
    items: [
      {
        itemReference: milk,
        internalCode: "MILK-2",
        name: "Whole milk",
        unitCode: "L",
        ledgerPrecision: 3,
      },
    ],
    locations: [{ locationReference: fridge, code: "FRIDGE-1", name: "Walk-in fridge" }],
    staff: [{ actorReference: viewer, label: "You" }],
    // The Brand Owner counted; they are not on this Store's staff list.
    people: [{ actorReference: owner, label: "Mina Chen" }],
  };
  await page.route("**/merchant/supply/counts/query", (route) => {
    const query = route.request().postDataJSON() as { countReference: string | null };
    if (query.countReference === null)
      return route.fulfill({
        headers,
        json: {
          screenId: "INV-COUNT-LIST",
          ...base,
          hasMore: false,
          counts: [
            {
              countReference: id(40),
              locationReference: fridge,
              status: "Submitted",
              countType: "Cycle",
              assigneeReference: owner,
              lineCount: 1,
              countedLines: 1,
              createdAt: "2026-10-07T22:59:17.279Z",
              createdBy: owner,
              updatedAt: "2026-10-07T23:05:00.000Z",
            },
          ],
        },
      });
    return route.fulfill({
      headers,
      json: {
        screenId: "INV-COUNT-WORKBENCH",
        ...base,
        lots: { [id(50)]: { lotCode: "L-1007", expiryDate: "2026-10-20" } },
        count: {
          countReference: id(40),
          stockScope: { scopeType: "Location", scopeReference: fridge },
          countType: "Cycle",
          status: "Submitted",
          assigneeReference: owner,
          submittedBy: owner,
          approvedBy: null,
          aggregateVersion: 4,
          createdAt: "2026-10-07T22:59:17.279Z",
          updatedAt: "2026-10-07T23:05:00.000Z",
          lines: [
            {
              lineReference: id(60),
              itemReference: milk,
              lotReference: id(50),
              locationReference: fridge,
              unitCode: "L",
              expectedQuantity: "2.5",
              countedQuantity: "2.47",
              variance: "-0.03",
              varianceReasonCode: null,
              recountNumber: 0,
              movementReference: null,
            },
          ],
        },
      },
    });
  });

  await page.goto("/operations/inventory/counts");
  await expect(page.getByRole("heading", { name: "Stock counts", level: 2 })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "Walk-in fridge" });
  // 22:59 UTC is 6:59 PM in Toronto.
  await expect(row.getByRole("link", { name: "Oct 7, 6:59 PM" })).toBeVisible();
  await expect(row).toContainText("Mina Chen");
  await expect(row).toContainText("Cycle count");
  await expectNoInternalText(page);

  await row.getByRole("link", { name: "Oct 7, 6:59 PM" }).click();
  await expect(
    page.getByRole("heading", { name: "Count · Walk-in fridge", level: 2 }),
  ).toBeVisible();
  await expect(page.getByText("counted by Mina Chen", { exact: false })).toBeVisible();
  await expect(page.getByText("submitted by Mina Chen", { exact: false })).toBeVisible();
  await expect(page.getByRole("cell", { name: "L-1007 (exp. Oct 20, 2026)" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reason Whole milk" })).toBeVisible();
  await expectNoInternalText(page);
});
