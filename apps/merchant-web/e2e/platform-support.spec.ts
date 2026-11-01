import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * WP-2423 取舍 15: platform support's page and the Owner's section in Store setup, 1440/1024/390.
 * Synthetic TEST-ONLY values; the server answers are routed in the browser (the real routes and
 * refusals are covered by platform-support-acceptance).
 */
const id = (n: number) => "018f7717-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const store = id(99);
const headers = { "cache-control": "no-store" };
const noOverflow = async (page: Page, shot: string, part = "main") => {
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page
      .locator(part)
      .first()
      .screenshot({ path: `test-results/${shot}-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};
const axe = async (page: Page, part: string) => {
  const result = await new AxeBuilder({ page })
    .include(part)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);
};
const supportView = (allowed: boolean, pickup: boolean) => ({
  name: "Training Store",
  ownerAllowsChanges: allowed,
  allowedUntil: null,
  kitchenSetUp: true,
  kitchenSince: "2026-11-01T15:00:00.000Z",
  kitchenVersion: 1,
  features: { version: 2, pickup },
  menus: [{ name: "Dinner", listed: true }],
  orders: [
    {
      orderNumber: "A-1042",
      orderType: "Pickup",
      phase: "Accepted",
      createdAt: "2026-11-01T18:00:00.000Z",
      lineCount: 3,
      guest: "S…",
    },
  ],
});

test("@production support picks a Store, reads it masked, and changes only what the Owner allows", async ({
  page,
}) => {
  let allowed = false,
    pickup = true,
    views = 0;
  const commands: unknown[] = [];
  await page.route("**/merchant/support/session", (route) =>
    route.fulfill({
      headers,
      json: {
        csrf: "a".repeat(43),
        name: "TEST Support Sam",
        canChange: true,
        stores: [{ storeReference: store, name: "Training Store" }],
      },
    }),
  );
  await page.route("**/merchant/support/store/view", (route) => {
    views += 1;
    return route.fulfill({ headers, json: supportView(allowed, pickup) });
  });
  await page.route("**/merchant/support/store/command", (route) => {
    commands.push(route.request().postDataJSON());
    if (!allowed)
      return route.fulfill({ status: 403, headers, json: { error: "not_allowed_by_owner" } });
    pickup = !pickup;
    return route.fulfill({ headers, json: { status: "Recorded" } });
  });
  await page.goto("/platform/support-cases");
  await expect(page.getByRole("heading", { name: "Platform support" })).toBeVisible();
  await expect(page.getByText("Signed in as TEST Support Sam")).toBeVisible();
  await page.getByLabel("Store").selectOption(store);
  await expect(
    page.getByText("Read-only: the Owner hasn't allowed changes right now."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Turn pickup off" })).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "S…" })).toBeVisible();
  await expect(page.getByText("Guide the Owner to do those themselves")).toBeVisible();
  await noOverflow(page, "support-readonly", ".store-support");
  await axe(page, ".store-support");

  // The Owner allows: the change appears, and after it the page reads the Store again.
  allowed = true;
  await page.getByLabel("Store").selectOption("");
  await page.getByLabel("Store").selectOption(store);
  await page.getByRole("button", { name: "Turn pickup off" }).click();
  await expect(page.getByRole("status")).toContainText("Pickup changed.");
  await expect(page.getByRole("button", { name: "Turn pickup on" })).toBeVisible();
  expect(commands).toHaveLength(1);
  expect(views).toBeGreaterThanOrEqual(3);
  // Reload: nothing is remembered in the browser; the Store is opened and recorded again.
  await page.reload();
  await page.getByLabel("Store").selectOption(store);
  await expect(page.getByRole("button", { name: "Turn pickup on" })).toBeVisible();
  await noOverflow(page, "support-allowed", ".store-support");

  // The Owner stopped it meanwhile: said plainly, and the page shows read-only again.
  allowed = false;
  await page.getByRole("button", { name: "Turn pickup on" }).click();
  await expect(page.getByRole("status")).toContainText("The Owner hasn't allowed changes");
  await expect(page.getByText("Read-only:")).toBeVisible();
});

test("@production someone who isn't support is told so; a failed read can be retried", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/merchant/support/session", (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill({ status: 503, headers, json: { error: "support_unavailable" } })
      : route.fulfill({ status: 403, headers, json: { error: "support_denied" } });
  });
  await page.goto("/platform/support-cases");
  await expect(page.getByRole("alert")).toContainText("Owners can still do everything");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("This page is for platform support staff.")).toBeVisible();
});

test("@production the Owner allows, limits and stops support, and reads the log", async ({
  page,
}) => {
  const state = {
    version: 0,
    mode: "Off" as "Off" | "Standing" | "Limited",
    allowedUntil: null as string | null,
    log: [
      {
        occurredAt: "2026-11-01T18:00:00.000Z",
        supportName: "TEST Support Sam",
        kind: "Viewed",
        subjectCode: "StoreDetails",
      },
      {
        occurredAt: "2026-11-01T18:01:00.000Z",
        supportName: "TEST Support Sam",
        kind: "Changed",
        subjectCode: "Pickup",
      },
      {
        occurredAt: "2026-11-01T18:02:00.000Z",
        supportName: "TEST Support Sam",
        kind: "Refused",
        subjectCode: "Refund",
      },
    ],
  };
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: store,
  };
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
          businessDate: "2026-11-01",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "STORE-SETUP",
              label: "Store setup",
              href: "/app/organization/stores/" + store + "/setup",
              permission: "organization.manage",
            },
          ],
        },
      },
    }),
  );
  for (const pattern of ["**/merchant/store-setup**", "**/merchant/store/receipt-profile"])
    await page.route(pattern, (route) =>
      route.fulfill({ status: 503, headers, json: { error: "unavailable" } }),
    );
  await page.route("**/merchant/store/support-access", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { mode: typeof state.mode; hours: number };
      state.version += 1;
      state.mode = body.mode;
      state.allowedUntil = body.mode === "Limited" ? "2026-11-01T19:00:00.000Z" : null;
    }
    await route.fulfill({ headers, json: state });
  });
  await page.goto("/app/organization/stores/" + store + "/setup");
  const panel = page.locator("#support-access");
  await expect(panel).toContainText("Platform support can't change your settings.");
  await expect(panel).toContainText("TEST ONLY");
  await expect(
    panel.getByRole("cell", { name: "Changed whether guests can order pickup" }),
  ).toBeVisible();
  await expect(panel.getByRole("cell", { name: "Tried something that was refused" })).toBeVisible();
  await noOverflow(page, "support-owner-off", "#support-access");
  await axe(page, "#support-access");

  await panel.getByRole("button", { name: "Allow for one hour" }).click();
  await expect(panel.getByRole("status")).toContainText("It ends by itself");
  await expect(panel).toContainText("Platform support can change your settings until");
  await page.reload();
  await expect(panel).toContainText("Platform support can change your settings until");

  await panel.getByRole("button", { name: "Allow platform support to change my settings" }).click();
  await expect(panel).toContainText("until you turn this off");
  await page.reload();
  await expect(panel).toContainText("until you turn this off");
  await noOverflow(page, "support-owner-on", "#support-access");

  await panel.getByRole("button", { name: "Turn off now" }).click();
  await page.reload();
  await expect(panel).toContainText("Platform support can't change your settings.");
});
