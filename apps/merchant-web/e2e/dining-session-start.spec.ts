import { expect, test } from "@playwright/test";

test("@production staff starts a table and recovers a lost entry code without duplicate start", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
  };
  const headers = { "cache-control": "no-store" };
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
          businessDate: "2026-09-14",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "OPS-ORDER-QUEUE",
              label: "Orders",
              href: "/operations/orders",
              permission: "ordering.operate",
            },
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

  let tableReads = 0;
  let denyNext = false;
  const starts: string[] = [],
    regens: string[] = [],
    availability: string[] = [];
  await page.route("**/merchant/dining/tables", (route) => {
    tableReads += 1;
    if (denyNext) {
      denyNext = false;
      return route.fulfill({ status: 403, headers });
    }
    return route.fulfill({
      headers,
      json: {
        canOperateTables: true,
        items: [
          {
            tableReference: id(1),
            stableLabel: "T1",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            // Opened once the start went through (the list is read again after it).
            currentDiningSessionReference: starts.length >= 2 ? id(3) : null,
            elapsedMinutes: null,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
          },
          {
            tableReference: id(2),
            stableLabel: "T2",
            areaCode: "PATIO",
            capacity: 2,
            lifecycle: "Published",
            operationalState: "TemporarilyBlocked",
            aggregateVersion: 4,
            currentDiningSessionReference: id(4),
            elapsedMinutes: 17,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
          },
          {
            tableReference: id(5),
            stableLabel: "DEMO-03",
            areaCode: "MAIN",
            capacity: 2,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 1,
            currentDiningSessionReference: null,
            elapsedMinutes: null,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
          },
          {
            tableReference: id(6),
            stableLabel: "Window counter seat 14",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "TemporarilyBlocked",
            aggregateVersion: 1,
            currentDiningSessionReference: null,
            elapsedMinutes: null,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
          },
        ],
        nextAfterTableReference: null,
      },
    });
  });
  await page.route("**/merchant/dining/tables/availability", async (route) => {
    const body = route.request().postData() ?? "";
    availability.push(body);
    if (availability.length === 1) return route.abort("failed");
    const command = JSON.parse(body) as {
      action: "SetBlock" | "ClearBlock";
      tableReference: string;
      expectedAggregateVersion: number;
    };
    return route.fulfill({
      headers,
      json: {
        status: availability.length === 2 ? "AlreadyApplied" : "Applied",
        tableReference: command.tableReference,
        operationalState: command.action === "SetBlock" ? "TemporarilyBlocked" : "Available",
        aggregateVersion: command.expectedAggregateVersion + 1,
      },
    });
  });
  await page.route("**/merchant/dining/sessions/start", (route) => {
    starts.push(route.request().postData() ?? "");
    if (starts.length === 1) return route.abort("failed");
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyApplied",
        tableReference: id(1),
        tableAssignmentVersion: 2,
        diningSessionReference: id(3),
        sessionVersion: 1,
        joinKind: "HumanCode",
      },
    });
  });
  await page.route("**/merchant/dining/sessions/join-state", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(3),
        tableReference: id(1),
        sessionVersion: 1,
        tableAssignmentVersion: 2,
        capabilityVersion: 1,
        generation: 1,
        joinKind: "HumanCode",
      },
    }),
  );
  await page.route("**/merchant/dining/sessions/regenerate", (route) => {
    regens.push(route.request().postData() ?? "");
    return route.fulfill({
      headers,
      json: {
        status: "Issued",
        generation: 2,
        capabilityVersion: 1,
        joinKind: "HumanCode",
        joinCredential: "123456",
      },
    });
  });
  await page.goto("/operations/dining");
  // UI refresh 2026-10-21: Tables sits in the shared workspace frame like every back-office page.
  await expect(page.getByRole("heading", { name: "Tables", level: 1 })).toBeVisible();
  await expect(page.locator(".bop-shell__header")).toHaveCount(0);
  // WP-2423 Q8: the board is in the navigation; staff never see internal screen codes.
  const workspace = page.getByRole("navigation", { name: "Workspace" });
  await expect(
    workspace
      .locator(".workspace-sidebar__links")
      .getByRole("link", { name: "Tables", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByText(/DIN-FLOOR-BOARD|TemporarilyBlocked|projection/u)).toHaveCount(0);
  // WP-2423 item 8 ① (Owner decision 2, Figma 44-2): tables listed by what they need, the free
  // ones on one line, each opened in one tap; no floor plan, search or area filter for now.
  await expect(page.getByRole("button", { name: /^Needs action/u })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("search")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select T2", exact: true })).toBeVisible();
  const elapsedTile = page
    .locator(".table-row")
    .filter({ has: page.getByRole("button", { name: "Select T2", exact: true }) });
  await expect(elapsedTile).toContainText("Seats 2 · 17 min");
  const free = page.getByRole("region", { name: "Free tables" });
  await expect(free).toContainText("Table T1Open");
  await expect(free).toContainText("Table Window counter seat 14Unavailable");
  await elapsedTile.screenshot({ path: "test-results/dining-elapsed-1440.png" });
  expect(tableReads).toBe(1);

  // Marking a table unavailable: a lost answer is sent again as the same request.
  await page.getByRole("button", { name: "Select T1", exact: true }).click();
  const details = page.getByRole("complementary", { name: "Selected table details" });
  await details.getByRole("combobox", { name: "Mark unavailable" }).selectOption("CLEANING");
  await details.getByRole("button", { name: "Mark unavailable", exact: true }).click();
  await expect(
    page.getByText("The result is unknown. Press it again: the same request is sent, never twice."),
  ).toBeVisible();
  await details.getByRole("button", { name: "Mark unavailable", exact: true }).click();
  await expect(page.getByText("Table T1 is back to needing cleaning.")).toBeVisible();
  // Cleaning is an everyday step: one tap from the list, said in words, and it can be undone.
  const cleaningRow = page
    .locator(".table-row")
    .filter({ has: page.getByRole("button", { name: "Select T1", exact: true }) });
  await expect(cleaningRow).toContainText("Needs cleaning");
  await cleaningRow.getByRole("button", { name: "Cleaned" }).click();
  const result = page.locator(".table-result");
  await expect(result).toContainText("Table T1 is clean and free for the next guests.");
  await result.getByRole("button", { name: "Undo" }).click();
  await expect(result).toContainText("Table T1 is back to needing cleaning.");
  await expect(result.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(availability.map((body) => JSON.parse(body).expectedAggregateVersion)).toEqual([
    2, 2, 3, 4,
  ]);
  expect(availability.map((body) => JSON.parse(body).action)).toEqual([
    "SetBlock",
    "SetBlock",
    "ClearBlock",
    "SetBlock",
  ]);
  expect(availability[1]).toBe(availability[0]);
  await page.getByRole("button", { name: "Select T1", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(details).toContainText("Table T1");
  // The selected table's details sit beside the list on desktop and under it on a phone.
  const [desktopBoard, desktopDetails] = await Promise.all([
    page.locator(".table-list").boundingBox(),
    details.boundingBox(),
  ]);
  if (!desktopBoard || !desktopDetails)
    throw new Error("Desktop list and selected detail must be visible");
  expect(desktopDetails.x).toBeGreaterThanOrEqual(desktopBoard.x + desktopBoard.width);
  await page.screenshot({ path: "test-results/dining-board-1440.png", fullPage: true });
  // v15 f971cecb live check (blank strip above the sidebar on Tables): nothing sits above the
  // workspace frame, and the sidebar stays pinned to the top of the window when the page scrolls.
  const sidebarTop = () =>
    page
      .getByRole("navigation", { name: "Workspace" })
      .evaluate((element) => Math.abs(Math.round(element.getBoundingClientRect().top)));
  expect(await sidebarTop()).toBe(0);
  await page.setViewportSize({ width: 1024, height: 900 });
  expect(await sidebarTop()).toBe(0);
  await page.screenshot({ path: "test-results/dining-board-1024.png", fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const [mobileBoard, mobileDetails] = await Promise.all([
      page.locator(".table-list").boundingBox(),
      details.boundingBox(),
    ]);
    if (!mobileBoard || !mobileDetails)
      throw new Error("Mobile list and selected detail must be visible");
    expect(mobileDetails.y).toBeGreaterThanOrEqual(mobileBoard.y + mobileBoard.height);
    await page.screenshot({ path: `test-results/dining-board-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const readsBefore = tableReads;
  denyNext = true;
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").last()).toContainText(
    "Your current permissions do not allow table operations.",
  );
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toBeVisible();
  expect(tableReads).toBe(readsBefore + 2);
  // Opening a free table is one tap (no checkbox); a lost answer is tried again as the same start.
  const freeT1 = free.getByRole("listitem").filter({ hasText: "Table T1" });
  await freeT1.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh tables", exact: true })).toBeDisabled();
  await freeT1.getByRole("button", { name: "Try opening again", exact: true }).click();
  await expect(
    page.getByText(
      "The request already completed. Its code cannot be displayed again. Replace the entry code to get a new one.",
      { exact: true },
    ),
  ).toBeVisible();
  await details.getByRole("button", { name: "New entry code", exact: true }).click();
  await expect(page.getByText("123456", { exact: true })).toBeVisible();
  await expect(page.locator(".table-result")).toContainText(
    "Table T1 has a new entry code; the old one no longer works.",
  );
  // 2026-10-21 live check: the sharing instruction sits with the code and goes away with it.
  const shareCode = page.getByText("Share this one-time code with the party at this table.");
  await expect(page.locator(".dining-entry-code")).toContainText(
    "Share this one-time code with the party at this table.",
  );
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  expect(regens).toHaveLength(1);
  await page.getByRole("button", { name: "Hide entry code", exact: true }).click();
  await expect(page.getByText("123456", { exact: true })).toHaveCount(0);
  await expect(shareCode).toHaveCount(0);
  // The skip link is painted only while it has keyboard focus (it showed in a scrolled capture).
  const skipLink = page.locator(".bop-skip-link");
  await expect(skipLink).toHaveCount(1);
  await expect(skipLink).toHaveCSS("clip-path", "inset(50%)");
  expect(page.url()).not.toContain("123456");
});

test("@production Dining reloads tables after an authorized Store switch", async ({ page }) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const stores = [
    { brandLabel: "Synthetic Brand", storeLabel: "Store One", storeReference: id(99) },
    { brandLabel: "Synthetic Brand", storeLabel: "Store Two", storeReference: id(98) },
  ];
  const storeOne = stores[0];
  const storeTwo = stores[1];
  if (!storeOne || !storeTwo) throw new Error("Dining Store-switch fixtures are incomplete");
  let selectedStore = 0;
  const csrfFor = (index: number) => (index === 0 ? "a" : "b").repeat(43);
  const workspace = (index: number) => ({
    screenId: "HOME-OVERVIEW",
    selectedScope: stores[index],
    authorizedStores: stores,
    businessDate: "2026-09-19",
    storeStatus: "Open",
    freshness: "Current",
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation: [
      {
        screenId: "OPS-ORDER-QUEUE",
        label: "Orders",
        href: "/operations/orders",
        permission: "ordering.operate",
      },
    ],
  });
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers,
      json: {
        authenticated: true,
        csrf: csrfFor(selectedStore),
        workspace: workspace(selectedStore),
      },
    }),
  );
  await page.route("**/merchant/store-context", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrfFor(selectedStore));
    expect(route.request().postDataJSON()).toEqual({
      targetStoreReference: storeTwo.storeReference,
    });
    selectedStore = 1;
    await route.fulfill({ headers, json: { workspace: workspace(selectedStore) } });
  });
  const readScopes: string[] = [];
  await page.route("**/merchant/dining/tables", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrfFor(selectedStore));
    const query = route.request().postDataJSON();
    expect(query).toEqual({ afterTableReference: null, limit: 50 });
    expect(query).not.toHaveProperty("storeReference");
    expect(query).not.toHaveProperty("tenantReference");
    expect(query).not.toHaveProperty("brandReference");
    const currentStore = selectedStore === 0 ? storeOne : storeTwo;
    readScopes.push(currentStore.storeReference);
    const number = selectedStore + 1;
    return route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [
          {
            tableReference: id(10 + number),
            stableLabel: `T${number}`,
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 1,
            currentDiningSessionReference: null,
            elapsedMinutes: null,
            qrCodeValidUntil: "2027-04-12T13:00:00.000Z",
          },
        ],
        nextAfterTableReference: null,
      },
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Store One", exact: true })).toBeVisible();
  await page.goto("/operations/dining");
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(storeOne.storeReference);

  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption(storeTwo.storeReference);
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Store Two", exact: true })).toBeVisible();
  await page.goto("/operations/dining");
  await expect(page.getByRole("button", { name: "Select T2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(storeTwo.storeReference);
  expect(readScopes).toEqual([storeOne.storeReference, storeTwo.storeReference]);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/dining-store-switch-${width}.png`,
      fullPage: true,
    });
  }
});
