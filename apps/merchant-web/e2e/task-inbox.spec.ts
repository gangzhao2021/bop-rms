import { expect, test } from "@playwright/test";

test("@production Task Inbox renders one permission-trimmed Store page and keeps unsupported actions locked", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const store = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
  };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: store,
          authorizedStores: [store],
          businessDate: "2026-09-26",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "HOME-OVERVIEW",
              label: "Overview",
              href: "/app",
              permission: "merchant.access",
            },
            {
              screenId: "TASK-INBOX",
              label: "Tasks",
              href: "/app/tasks",
              permission: "workflow.operate",
            },
          ],
        },
      },
    }),
  );
  let requests = 0;
  await page.route("**/merchant/tasks", async (route) => {
    requests++;
    expect(route.request().method()).toBe("GET");
    expect(route.request().url()).not.toContain("store=");
    expect(route.request().url()).not.toContain("task=");
    await route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        screenId: "TASK-INBOX",
        storeLabel: "Training Store",
        observedAt: "2026-09-26T12:00:00.000Z",
        items: [
          {
            taskReference: id(1),
            version: 3,
            taskType: "DINING_UNPAID_BATCH_EXCEPTION",
            severity: "CRITICAL",
            priority: "CRITICAL",
            status: "Assigned",
            ownerStatus: "Unclaimed",
            dueAt: "2026-09-26T13:00:00.000Z",
            sourceType: "DINING_SESSION",
            canClaim: true,
          },
        ],
        nextAfterTaskReference: null,
      },
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Training Store" })).toBeVisible();
  await expect(page.getByText("No business outcome is inferred")).toHaveCount(0);
  await expect(page.getByText("DINING SESSION · Display-safe reference unavailable")).toBeVisible();
  const rendered = await page.locator("body").innerHTML();
  expect(rendered).not.toContain(id(1));
  expect(rendered).not.toContain(id(2));
  expect(rendered).not.toMatch(/task-heading-01909968/u);
  await expect(page.getByRole("button", { name: "Claim" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Assign" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Acknowledge" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Open source" })).toBeDisabled();
  await expect(page.getByText("Policy unavailable")).toBeVisible();
  expect(requests).toBe(1);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/task-inbox-${width}.png` });
  }
});

test("@production Task Inbox clears the prior Store view when the next Store has no configured queue", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const stores = [1, 2].map((n) => ({
    brandLabel: "Synthetic Brand",
    storeLabel: "Store " + n,
    storeReference: id(98 + n),
  }));
  const storeOne = stores[0];
  const storeTwo = stores[1];
  if (!storeOne || !storeTwo) throw new Error("Task Inbox Store-switch fixtures are incomplete");
  const csrfFor = (index: number) => (index === 0 ? "a" : "b").repeat(43);
  let selected = 0;
  const workspace = (index: number) => ({
    screenId: "HOME-OVERVIEW",
    selectedScope: stores[index],
    authorizedStores: stores,
    businessDate: "2026-09-26",
    storeStatus: "Open",
    freshness: "Current",
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation: [
      { screenId: "HOME-OVERVIEW", label: "Overview", href: "/app", permission: "merchant.access" },
      {
        screenId: "TASK-INBOX",
        label: "Tasks",
        href: "/app/tasks",
        permission: "workflow.operate",
      },
    ],
  });
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: csrfFor(selected),
        workspace: workspace(selected),
      },
    }),
  );
  await page.route("**/merchant/store-context", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrfFor(selected));
    expect(route.request().postDataJSON()).toEqual({
      targetStoreReference: storeTwo.storeReference,
    });
    selected = 1;
    await route.fulfill({ headers, json: { workspace: workspace(selected) } });
  });
  let taskReads = 0;
  await page.route("**/merchant/tasks", async (route) => {
    taskReads++;
    expect(route.request().method()).toBe("GET");
    expect(route.request().url()).not.toContain("store=");
    expect(route.request().url()).not.toContain("task=");
    if (selected === 1)
      return route.fulfill({ headers, status: 503, json: { error: "feature_disabled" } });
    return route.fulfill({
      headers,
      json: {
        screenId: "TASK-INBOX",
        storeLabel: storeOne.storeLabel,
        observedAt: "2026-09-26T12:00:00.000Z",
        items: [
          {
            taskReference: id(1),
            version: 3,
            taskType: "DINING_UNPAID_BATCH_EXCEPTION",
            severity: "CRITICAL",
            priority: "CRITICAL",
            status: "Assigned",
            ownerStatus: "Unclaimed",
            dueAt: "2026-09-26T13:00:00.000Z",
            sourceType: "DINING_SESSION",
            canClaim: true,
          },
        ],
        nextAfterTaskReference: null,
      },
    });
  });

  await page.goto("/app");
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: storeOne.storeLabel, exact: true })).toBeVisible();
  await expect(page.getByText("DINING SESSION · Display-safe reference unavailable")).toBeVisible();
  expect(await page.locator("body").innerHTML()).not.toContain(id(1));

  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption(storeTwo.storeReference);
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: storeTwo.storeLabel, exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(
    page.getByRole("heading", { name: "Task Inbox unavailable", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("DINING SESSION · Display-safe reference unavailable")).toHaveCount(
    0,
  );
  expect(await page.locator("body").innerHTML()).not.toContain(id(1));
  await expect(page.getByRole("button", { name: "Claim" })).toHaveCount(0);
  expect(taskReads).toBe(2);
});
