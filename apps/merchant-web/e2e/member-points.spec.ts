import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * WP-2423 取舍 18 DEC-MEMBER-POINTS: the back office: rules, members with only the last four digits
 * of a phone, and what was issued, used and is outstanding. Synthetic answers.
 */
const store = "01909968-0000-7000-8000-000000000099";
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Training Store",
  storeReference: store,
  timeZone: "America/Toronto",
};
const rule = {
  version: 0,
  earnPointsPerDollar: 3,
  redeemPointsPerDollar: 100,
  minimumRedemptionPoints: 300,
  redemptionIncrementPoints: 100,
  inactivityExpiryDays: 548,
  expiryNoticeDays: 30,
  rewards: [],
};
const view = (canManage: boolean) => ({
  canManage,
  dishChoices: canManage
    ? [{ productReference: "01909968-0000-7000-8000-000000000021", displayName: "Soup 例汤" }]
    : [],
  offeredHere: true,
  rule,
  members: [
    {
      accountReference: "01909968-0000-7000-8000-000000000011",
      phoneLast4: "0151",
      status: "Active",
      availablePoints: 640,
      pointsDebt: 0,
      lifetimeEarnedPoints: 940,
      joinedAt: "2026-10-01T18:00:00.000Z",
      lastActivityAt: "2026-11-01T18:00:00.000Z",
      marketingConsent: false,
    },
  ],
  report: {
    members: 1,
    issuedPoints: 1090,
    usedPoints: 300,
    returnedPoints: 0,
    reversedPoints: 0,
    expiredPoints: 0,
    forfeitedPoints: 150,
    outstandingPoints: 640,
    owedPoints: 0,
    usedValueMinor: "339",
  },
});
async function workspace(page: Page, canManage: boolean) {
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
          businessDate: "2026-11-02",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "LOY-PROGRAM-LIST",
              label: "Points",
              href: "/app/customers/loyalty-programs",
              permission: "loyalty.member.read",
            },
          ],
        },
      },
    }),
  );
  const saved: unknown[] = [];
  let current = view(canManage);
  await page.route("**/merchant/member-points", (route) =>
    route.fulfill({ headers, json: current }),
  );
  await page.route("**/merchant/member-points/rule", async (route) => {
    const body = route.request().postDataJSON() as { change: typeof rule };
    saved.push(body);
    current = { ...current, rule: { ...body.change, version: 1 } };
    await route.fulfill({ headers, json: current.rule });
  });
  return saved;
}

for (const width of [1440, 1024, 390])
  test(`@production the Owner reads and changes points at ${String(width)}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const saved = await workspace(page, true);
    await page.goto("/app/customers/loyalty-programs");
    await expect(page.getByRole("heading", { name: "Points", level: 1 })).toBeVisible();
    await expect(page.getByText("Issued")).toBeVisible();
    await expect(page.getByText("1,090")).toBeVisible();
    await expect(page.getByText("Outstanding")).toBeVisible();
    await expect(page.getByText("•••• 0151")).toBeVisible();
    await expect(page.getByText(/only for orders guests place by scanning/iu)).toBeVisible();
    await page.screenshot({
      path: `test-results/member-points-${String(width)}.png`,
      fullPage: true,
    });
    await expectNoInternalText(page);
    await page.getByLabel("Points for each $1 of dishes paid").fill("5");
    await page.getByRole("button", { name: "Save rules" }).click();
    await expect(page.getByRole("status")).toContainText("Saved.");
    expect(saved[0]).toMatchObject({ expectedVersion: 0, change: { earnPointsPerDollar: 5 } });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

test("@production the Owner offers a dish for points and takes it off again", async ({ page }) => {
  const saved = await workspace(page, true);
  await page.goto("/app/customers/loyalty-programs");
  await expect(page.getByRole("button", { name: "Save rules" })).toBeDisabled();
  await page
    .getByRole("group", { name: "Add a dish" })
    .getByRole("combobox")
    .selectOption({ label: "Soup 例汤" });
  await page.getByLabel("Points it costs").fill("500");
  await page.getByRole("button", { name: "Add this dish" }).click();
  await expect(page.getByText("Soup 例汤 · 500 points")).toBeVisible();
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.getByRole("status")).toContainText("Saved.");
  expect(saved[0]).toMatchObject({
    change: {
      rewards: [
        {
          productReference: "01909968-0000-7000-8000-000000000021",
          displayName: "Soup 例汤",
          pointsCost: 500,
        },
      ],
    },
  });
  await expectNoInternalText(page);
});

test("@production a manager reads but can't change the rules; a failed read can be retried", async ({
  page,
}) => {
  await workspace(page, false);
  await page.goto("/app/customers/loyalty-programs");
  await expect(page.getByText("Only the Owner can change the rules.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save rules" })).toHaveCount(0);
  await expect(page.getByLabel("Points for each $1 of dishes paid")).toBeDisabled();
  await page.unroute("**/merchant/member-points");
  let attempts = 0;
  await page.route("**/merchant/member-points", (route) => {
    attempts += 1;
    return attempts === 1
      ? route.fulfill({ status: 503, headers, json: { error: "member_points_unavailable" } })
      : route.fulfill({ headers, json: view(false) });
  });
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("We can't show points right now.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Issued")).toBeVisible();
});

test("@production in Chinese, no internal words", async ({ page }) => {
  await workspace(page, true);
  await page.goto("/app/customers/loyalty-programs");
  await expect(page.getByText("Issued")).toBeVisible();
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect(page.getByText("发出", { exact: true })).toBeVisible();
  await expect(page.getByText("未用", { exact: true })).toBeVisible();
  await expect(page.getByText("只限客人扫码点的单", { exact: false })).toBeVisible();
  await expectNoInternalText(page);
});
