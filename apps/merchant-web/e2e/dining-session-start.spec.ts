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
          ],
        },
      },
    }),
  );

  let tableReads = 0;
  const starts: string[] = [],
    regens: string[] = [],
    availability: string[] = [];
  await page.route("**/merchant/dining/tables", (route) => {
    tableReads += 1;
    if (tableReads === 2) return route.fulfill({ status: 403, headers });
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
            currentDiningSessionReference: null,
            elapsedMinutes: null,
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
          },
          {
            tableReference: id(5),
            stableLabel: "T3",
            areaCode: "MAIN",
            capacity: 2,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 1,
            currentDiningSessionReference: null,
            elapsedMinutes: null,
          },
          {
            tableReference: id(6),
            stableLabel: "T4",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "TemporarilyBlocked",
            aggregateVersion: 1,
            currentDiningSessionReference: null,
            elapsedMinutes: null,
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
  await expect(page.getByRole("heading", { name: "OPERATIONS", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dining", level: 2 })).toBeVisible();
  expect(
    await page
      .locator(".bop-shell__header")
      .evaluate((header) => getComputedStyle(header).backgroundColor),
  ).toBe("rgb(23, 23, 23)");
  await expect(page.getByRole("complementary", { name: "Dining data availability" })).toContainText(
    "Party, Order, payment, reservation, waitlist and attention details are not available",
  );
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveText("Orders");
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("link")).toHaveCount(1);
  await expect(page.locator('section[aria-label="MAIN area"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tables and sessions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Select T2", exact: true })).toBeVisible();
  const elapsedTile = page
    .locator(".dining-table-tile")
    .filter({ has: page.getByRole("button", { name: "Select T2", exact: true }) });
  await expect(elapsedTile).toContainText("17 min elapsed");
  await elapsedTile.screenshot({ path: "test-results/dining-elapsed-1440.png" });
  expect(tableReads).toBe(1);
  const assertConfirmationTarget = async () => {
    const label = page.locator(
      '.dining-session-detail section[aria-label="Dining session action"] label',
    );
    await expect(label).toBeVisible();
    const geometry = await label.evaluate((element) => {
      const checkbox = element.querySelector("input[type=checkbox]");
      const textNode = [...element.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      if (!(checkbox instanceof HTMLInputElement) || !textNode) return null;
      const range = document.createRange();
      range.selectNode(textNode);
      return {
        labelHeight: element.getBoundingClientRect().height,
        gap: getComputedStyle(element).gap,
        checkboxRight: checkbox.getBoundingClientRect().right,
        textLeft: range.getBoundingClientRect().left,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry?.labelHeight).toBeGreaterThanOrEqual(44);
    // 0.5rem at the 15px root size; the checkbox and its text must not touch.
    expect(Number.parseFloat(geometry?.gap ?? "0")).toBeGreaterThanOrEqual(7);
    // 0.5rem token gap at the 15px root is 7.5px.
    expect(geometry?.textLeft).toBeGreaterThanOrEqual((geometry?.checkboxRight ?? 0) + 7);
  };
  await page.getByRole("combobox", { name: "Area", exact: true }).selectOption("PATIO");
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Select T2", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Table state", exact: true }).selectOption("Available");
  await expect(
    page.getByText("No tables match the current filters.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Table state", exact: true }).selectOption("All");
  await page.getByLabel("Table", { exact: true }).fill("T2");
  await expect(page.getByRole("button", { name: "Select T2", exact: true })).toBeVisible();
  await page.getByLabel("Table", { exact: true }).fill("");
  await page.getByRole("combobox", { name: "Area", exact: true }).selectOption("All");
  await page.getByRole("button", { name: "Select T1", exact: true }).click();
  await page.getByLabel("Block reason code").fill("MAINTENANCE");
  await page.getByRole("button", { name: "Mark table unavailable" }).click();
  await expect(
    page.getByText("The result is unknown. Retry the same table request", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry same availability request" }).click();
  await expect(page.getByText("Table marked temporarily unavailable.")).toBeVisible();
  await page.getByRole("button", { name: "Mark table available" }).click();
  await expect(page.getByText("Table marked available.")).toBeVisible();
  const reasonField = page.getByLabel("Block reason code");
  await expect(reasonField).toBeVisible();
  await expect(
    page.getByText("Required; use uppercase letters, numbers, underscores or hyphens."),
  ).toBeVisible();
  expect(await reasonField.getAttribute("aria-describedby")).toBe("dining-table-reason-help");
  expect((await reasonField.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await reasonField.evaluate((input) => getComputedStyle(input).borderTopStyle)).toBe(
    "solid",
  );
  expect(availability.map((body) => JSON.parse(body).expectedAggregateVersion)).toEqual([2, 2, 3]);
  expect(availability.map((body) => JSON.parse(body).action)).toEqual([
    "SetBlock",
    "SetBlock",
    "ClearBlock",
  ]);
  expect(availability[1]).toBe(availability[0]);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await assertConfirmationTarget();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await assertConfirmationTarget();
  await page.getByRole("button", { name: "Select T1", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Selected table details" })).toContainText(
    "Table T1",
  );
  await page.locator(".dining-floor-heading h2").click();
  const tableTile = page
    .locator(".dining-table-tile")
    .filter({ has: page.getByRole("button", { name: "Select T1", exact: true }) });
  const desktopTile = await tableTile.boundingBox();
  // Tile columns are rem-based; at the 15px root font a tile is about 342px wide.
  expect(desktopTile?.width).toBeGreaterThanOrEqual(330);
  expect(desktopTile?.width).toBeLessThanOrEqual(380);
  const [desktopBoard, desktopDetails] = await Promise.all([
    page.locator(".dining-floor-board").boundingBox(),
    page.getByRole("complementary", { name: "Selected table details" }).boundingBox(),
  ]);
  if (!desktopBoard || !desktopDetails)
    throw new Error("Desktop floor and selected detail must be visible");
  expect(desktopDetails.y).toBeGreaterThanOrEqual(desktopBoard.y + desktopBoard.height);
  const mainTiles = page.locator('section[aria-label="MAIN area"]').locator(".dining-table-tile");
  const mainTileBoxes = await mainTiles.evaluateAll((tiles) =>
    tiles.map((tile) => {
      const { x, y, width } = tile.getBoundingClientRect();
      return { x, y, width };
    }),
  );
  expect(mainTileBoxes).toHaveLength(3);
  expect(mainTileBoxes.every((tile) => tile.width >= 330 && tile.width <= 380)).toBe(true);
  const [firstMainTile, secondMainTile] = mainTileBoxes;
  if (!firstMainTile || !secondMainTile)
    throw new Error("Dining Main area must have at least two measured tiles");
  expect(mainTileBoxes.every((tile) => Math.abs(tile.y - firstMainTile.y) < 2)).toBe(true);
  // Tile gap is the 0.75rem token: 11.25px at the 15px root font.
  const tileGap = secondMainTile.x - (firstMainTile.x + firstMainTile.width);
  expect(tileGap).toBeGreaterThanOrEqual(11);
  expect(tileGap).toBeLessThanOrEqual(12);
  const [desktopLabel, desktopState] = await Promise.all([
    tableTile.locator("h4").boundingBox(),
    tableTile.locator(".dining-table-tile__identity > span").boundingBox(),
  ]);
  if (!desktopLabel || !desktopState) throw new Error("Dining card heading/state must be visible");
  expect(desktopState.y).toBeGreaterThan(desktopLabel.y + desktopLabel.height);
  await page.screenshot({ path: "test-results/dining-board-1440.png", fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const [mobileBoard, mobileDetails] = await Promise.all([
      page.locator(".dining-floor-board").boundingBox(),
      page.getByRole("complementary", { name: "Selected table details" }).boundingBox(),
    ]);
    if (!mobileBoard || !mobileDetails)
      throw new Error("Mobile floor and selected detail must be visible");
    expect(mobileDetails.y).toBeGreaterThanOrEqual(mobileBoard.y + mobileBoard.height);
    await page.screenshot({ path: `test-results/dining-board-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").last()).toContainText(
    "Your current permissions do not allow table operations.",
  );
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toBeVisible();
  expect(tableReads).toBe(3);
  await page.getByRole("button", { name: "Select T1", exact: true }).click();
  const confirm = page.getByRole("checkbox", {
    name: "I confirm the selected table and session action",
    exact: true,
  });
  const start = page.getByRole("button", { name: "Start dining session", exact: true });
  await expect(start).toBeDisabled();
  await confirm.check();
  await start.click();
  await expect(page.getByRole("button", { name: "Refresh tables", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same session request", exact: true }).click();
  await expect(
    page.getByText(
      "The request already completed. Its code cannot be displayed again. Confirm replacement to generate a new code.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByText("Linked · elapsed time unavailable", { exact: true })).toBeVisible();
  const replace = page.getByRole("button", { name: "Replace entry code", exact: true });
  await expect(replace).toBeDisabled();
  await confirm.check();
  await replace.click();
  await expect(page.getByText("123456", { exact: true })).toBeVisible();
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  expect(regens).toHaveLength(1);
  await page.getByRole("button", { name: "Hide entry code", exact: true }).click();
  await expect(page.getByText("123456", { exact: true })).toHaveCount(0);
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
