import { expect, test, type Locator, type Page } from "@playwright/test";

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (await target.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Kitchen control was not reachable through keyboard Tab order");
}

test("@production Kitchen reads, refreshes and clears denied data with keyboard access", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
  };
  const headers = { "cache-control": "no-store" };
  let showOrders = false;
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
          businessDate: "2026-09-19",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: showOrders
            ? [
                {
                  screenId: "OPS-ORDER-QUEUE",
                  label: "Orders",
                  href: "/operations/orders",
                  permission: "ordering.operate",
                },
                {
                  screenId: "KIT-KITCHEN-QUEUE",
                  label: "Kitchen",
                  href: "/operations/kitchen",
                  permission: "kitchen.operate",
                },
              ]
            : [
                {
                  screenId: "KIT-KITCHEN-QUEUE",
                  label: "Kitchen",
                  href: "/operations/kitchen",
                  permission: "kitchen.operate",
                },
              ],
        },
      },
    }),
  );
  const at = "2026-09-19T12:00:00.000Z";
  const projectedAt = "2026-09-19T12:18:00.000Z";
  const item = {
    workItemReference: id(1),
    ticketReference: id(2),
    orderReference: id(3),
    orderItemReference: id(4),
    stationReference: id(5),
    localizedDisplayNames: { "en-CA": "Synthetic rice" },
    selectedOptions: [
      {
        optionReference: id(11),
        quantity: 2,
        localizedNames: { "en-CA": "Extra mushrooms" },
      },
    ],
    status: "Queued",
    requiredQuantity: 2,
    completedQuantity: 0,
    workItemCreatedAt: at,
    acceptedAt: null,
    orderItemReadyAt: null,
    ticketAggregateVersion: "9007199254740993",
    workItemVersion: "1",
  };
  const items = [
    item,
    {
      ...item,
      workItemReference: id(7),
      ticketReference: id(12),
      orderReference: id(13),
      orderItemReference: id(8),
      stationReference: id(15),
      localizedDisplayNames: { "en-CA": "Synthetic stew" },
      status: "In Progress",
      completedQuantity: 1,
    },
    {
      ...item,
      workItemReference: id(9),
      ticketReference: id(14),
      orderReference: id(15),
      orderItemReference: id(10),
      stationReference: id(16),
      localizedDisplayNames: { "en-CA": "Synthetic bread" },
      status: "Completed",
      completedQuantity: 2,
    },
  ];
  const metadata = {
    storeReference: scope.storeReference,
    operatorStatus: "Unverified",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    projectionGenerationReference: id(6),
    projectedAt,
    partial: false,
    stale: false,
    freshnessStatus: "Fresh",
  };
  let denied = false,
    requests = 0,
    searchedFilters: Record<string, unknown> | null = null;
  await page.route("**/merchant/kitchen/query", (route) => {
    requests++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    const query = route.request().postDataJSON();
    if (query.kind === "List") searchedFilters = query.filters;
    const filteredItems =
      query.kind === "List"
        ? items.filter(
            (candidate) =>
              (query.filters.orderReference === null ||
                candidate.orderReference === query.filters.orderReference) &&
              (query.filters.ticketReference === null ||
                candidate.ticketReference === query.filters.ticketReference),
          )
        : items;
    return route.fulfill(
      denied
        ? { headers, status: 403, json: { error: "request_denied" } }
        : {
            headers,
            json:
              query.kind === "List"
                ? { ...metadata, items: filteredItems, nextCursor: null }
                : { ...metadata, item },
          },
    );
  });
  await page.goto("/operations/kitchen");
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OPERATIONS", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeVisible();
  const statusColors = [
    ["Synthetic rice", "rgb(239, 246, 255)"],
    ["Synthetic stew", "rgb(240, 253, 244)"],
    ["Synthetic bread", "rgb(245, 245, 245)"],
  ] as const;
  for (const [itemName, background] of statusColors) {
    await expect(
      page
        .locator(".kitchen-work-item")
        .filter({ hasText: itemName })
        .locator(".kitchen-work-item__state strong"),
    ).toHaveCSS("background-color", background);
  }
  const queueStatusBadges = page.locator(".kitchen-work-item__state strong");
  await expect(queueStatusBadges).toHaveCount(3);
  for (const badge of await queueStatusBadges.all()) {
    const box = await badge.boundingBox();
    expect(box?.width).toBe(112);
    expect(box?.height).toBe(26);
  }
  await expect(page.getByText("KDS session unverified", { exact: true })).toBeVisible();
  await expect(
    page.getByText("KDS session or device lock is unverified. Kitchen commands are disabled.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText(/Updated .* UTC/u)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Complete quantity", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mark ready", exact: true })).toBeDisabled();
  await expect(page.getByText("Training Store", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Station", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Allergen", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Exception", exact: true })).toBeDisabled();
  for (const label of ["Station", "Allergen", "Exception"]) {
    const filter = page.getByRole("combobox", { name: label, exact: true });
    expect(
      await filter.evaluate(
        (select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent,
      ),
    ).toBe("Unavailable");
  }
  const primaryNav = page.getByRole("navigation", { name: "Primary" });
  await expect(primaryNav.getByRole("link", { name: "Kitchen" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(primaryNav.getByRole("link", { name: "Orders" })).toHaveCount(0);
  await expect(page.locator("body")).toContainText("safe Order/ticket reference display");
  await expect(page.getByText("Quantity", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("0 / 2", { exact: true })).toBeVisible();
  const unavailableSafetyCue = page.locator('.kitchen-work-item__cue[data-kind="unavailable"]');
  await expect(unavailableSafetyCue).toHaveCount(3);
  await expect(unavailableSafetyCue.first()).toHaveText("Allergen / exception cues unavailable");
  await expect(unavailableSafetyCue.first()).toHaveAttribute(
    "aria-label",
    "Allergen status unavailable; Exception status unavailable",
  );
  await expect(page.locator("body")).not.toContainText("Ticket display reference unavailable");
  await expect(page.locator("body")).not.toContainText("Order display reference unavailable");
  await expect(page.locator("body")).not.toContainText(id(2));
  await expect(page.locator("body")).not.toContainText(id(3));
  const clearFilters = page.getByRole("button", { name: "Clear filters", exact: true });
  await expect(clearFilters).toHaveCount(0);
  await page.getByRole("combobox", { name: "Work state", exact: true }).selectOption("Held");
  await expect(page.getByRole("heading", { name: "No matching work", exact: true })).toBeVisible();
  await expect(clearFilters).toBeEnabled();
  await clearFilters.click();
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Allergen", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Exception", exact: true })).toBeDisabled();
  const unavailableStationLanes = page.getByRole("region", {
    name: /^Kitchen work items; station labels unavailable; lane \d+ of 3$/u,
  });
  await expect(unavailableStationLanes).toHaveCount(3);
  await expect(unavailableStationLanes.first()).toBeVisible();
  for (const stationReference of [id(5), id(15), id(16)]) {
    await expect(page.locator("body")).not.toContainText(stationReference);
  }
  await expect(page.getByRole("heading", { name: "Board locked — read-only" })).toBeVisible();
  const accept = page.getByRole("button", { name: "Accept", exact: true });
  const refresh = page.getByRole("button", { name: "Refresh from source", exact: true });
  await expect(accept).toBeDisabled();
  expect(await accept.evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe(
    await refresh.evaluate((button) => getComputedStyle(button).backgroundColor),
  );
  for (const width of [720, 390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 900 : 844 });
    await expect(page.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible();
    await expect(
      page.locator(
        ".kitchen-board-workspace:not(.kitchen-work-item-screen) .screen-heading > button",
      ),
    ).toHaveCSS("font-size", "12px");
    const mobileFreshnessBadge = await page
      .locator(
        ".kitchen-board-workspace:not(.kitchen-work-item-screen) .kitchen-board-freshness > span:first-child",
      )
      .boundingBox();
    expect(mobileFreshnessBadge?.width).toBe(width <= 340 ? 76 : 78);
    const mobileFreshnessPill = page.locator(
      '.kitchen-board-workspace:not(.kitchen-work-item-screen) .kitchen-board-freshness > span[data-freshness="Fresh"]',
    );
    await expect(mobileFreshnessPill).toHaveCSS("background-color", "rgb(232, 247, 237)");
    await expect(mobileFreshnessPill).toHaveCSS("color", "rgb(20, 120, 74)");
    const mobileQueueCard = page.locator(".kitchen-work-item").first();
    const mobileQueueTitle = mobileQueueCard.locator(".kitchen-work-item__summary h3");
    await expect(mobileQueueTitle).toHaveCSS("font-weight", "400");
    await expect(mobileQueueTitle).toHaveCSS("font-size", width <= 340 ? "15px" : "16px");
    const mobileAction = mobileQueueCard.locator(".kitchen-work-item__actions button").first();
    const mobileActionBox = await mobileAction.boundingBox();
    expect(mobileActionBox?.width).toBe(width <= 340 ? 260 : 145);
    expect(mobileActionBox?.height).toBe(44);
    for (const [label, control] of [
      ["Queue refresh", page.getByRole("button", { name: "Refresh from source", exact: true })],
      ["Queue filters", page.locator(".kitchen-filter-toggle")],
      ["Queue item detail", mobileQueueCard.locator(".kitchen-work-item__detail-link")],
    ] as const) {
      const box = await control.boundingBox();
      expect(box?.width, label).toBeGreaterThanOrEqual(44);
      expect(box?.height, label).toBeGreaterThanOrEqual(44);
    }
    await expect(mobileQueueCard).toHaveCSS("border-top-color", "rgb(227, 227, 227)");
    await expect(mobileAction).toHaveCSS("background-color", "rgb(242, 242, 242)");
    await expect(mobileAction).toHaveCSS("border-top-color", "rgb(227, 227, 227)");
    await expect(page.locator(".bop-shell__header-mobile-title")).toHaveText("KITCHEN");
    await expect(page.locator(".bop-shell__header-mobile-title")).toBeVisible();
    await expect(page.locator(".bop-shell__header h1")).toHaveCSS("position", "absolute");
    const laneItems = page.locator(".kitchen-station-lane__items").first();
    const mobileColumns = await laneItems.evaluate(
      (element) =>
        getComputedStyle(element)
          .gridTemplateColumns.split(/\s+/u)
          .filter((track) => Number.parseFloat(track) > 0).length,
    );
    expect(mobileColumns).toBe(1);
    await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeHidden();
    await expect(primaryNav).toBeHidden();
    const filterToggle = page.locator(".kitchen-filter-toggle");
    await expect(filterToggle).toBeVisible();
    await expect(filterToggle).toHaveText("Filters · All work");
    const refreshLabel = page.locator(
      width > 340 && width < 768 ? ".kitchen-refresh-label--short" : ".kitchen-refresh-label--long",
    );
    await expect(refreshLabel).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh from source", exact: true }),
    ).toBeVisible();
    const lockNotice = page.getByRole("heading", { name: "Board locked — read-only" });
    expect((await filterToggle.boundingBox())?.y).toBeLessThan(
      (await lockNotice.boundingBox())?.y ?? 0,
    );
    const filterSheet = page.getByRole("dialog", { name: "Filter Kitchen work" });
    await expect(filterSheet).not.toBeVisible();
    await tabTo(page, filterToggle);
    await expect(filterToggle).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Enter");
    await expect(filterSheet).toBeVisible();
    await expect(filterSheet.getByRole("combobox", { name: "Reference type" })).toBeFocused();
    if (width <= 390) {
      const sheetBox = await filterSheet.boundingBox();
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      expect(sheetBox?.x).toBe(0);
      expect(sheetBox?.width).toBe(width);
      expect(
        Math.abs((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0) - viewportHeight),
      ).toBeLessThanOrEqual(1);
    }
    const mobileFilters = filterSheet.locator(".kitchen-board-filters--mobile");
    await expect(mobileFilters).toHaveCSS("grid-template-columns", /\d+px\s+\d+px/);
    for (const label of ["Station", "Work state", "Allergen", "Exception"]) {
      await expect(filterSheet.getByText(label, { exact: true })).toBeVisible();
    }
    expect(
      await filterSheet
        .getByRole("combobox", { name: "Station" })
        .evaluate((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent),
    ).toBe("Unavailable");
    await expect(
      filterSheet.getByText(
        "Filters apply only to fields present for every loaded work item. Allergen and exception filters are unavailable here; the KDS Session and device lock are unverified, and board actions are disabled.",
      ),
    ).toBeVisible();
    const clearBox = await filterSheet.getByRole("button", { name: "Clear filters" }).boundingBox();
    const doneBox = await filterSheet.getByRole("button", { name: "Done" }).boundingBox();
    expect(clearBox).not.toBeNull();
    expect(doneBox).not.toBeNull();
    expect(clearBox?.y).toBe(doneBox?.y);
    expect(clearBox?.x).toBeLessThan(doneBox?.x ?? 0);
    await page.screenshot({
      path: `test-results/kitchen-filter-sheet-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(filterSheet).not.toBeVisible();
    await expect(filterToggle).toBeFocused();
    await filterToggle.click();
    await expect(filterSheet.getByRole("combobox", { name: "Work state" })).toBeVisible();
    await expect(filterSheet.getByRole("combobox", { name: "Allergen" })).toBeDisabled();
    await expect(filterSheet.getByRole("combobox", { name: "Exception" })).toBeDisabled();
    await filterSheet.getByRole("button", { name: "Done" }).click();
    await expect(filterSheet).not.toBeVisible();
    await expect(page.locator(".kitchen-reference-search--desktop")).toBeHidden();
    await filterToggle.click();
    const mobileSearch = filterSheet.locator(".kitchen-reference-search--mobile");
    await expect(mobileSearch).toBeVisible();
    const mobileSearchButton = mobileSearch.getByRole("button", { name: "Search", exact: true });
    const mobileClearButton = mobileSearch.getByRole("button", { name: "Clear search" });
    await expect(mobileClearButton).toHaveText("Clear");
    await expect(mobileClearButton).toBeDisabled();
    const searchButtonBox = await mobileSearchButton.boundingBox();
    const clearSearchButtonBox = await mobileClearButton.boundingBox();
    expect(searchButtonBox?.y).toBe(clearSearchButtonBox?.y);
    expect(
      Math.abs((searchButtonBox?.width ?? 0) - (clearSearchButtonBox?.width ?? 0)),
    ).toBeLessThanOrEqual(1);
    expect(searchButtonBox?.height).toBeGreaterThanOrEqual(44);
    const mobileReference = width === 390 ? id(3) : id(2);
    const mobileReferenceKind = width === 390 ? "Order" : "Ticket";
    await expect(mobileSearch.getByRole("textbox", { name: "Exact reference" })).toHaveAttribute(
      "placeholder",
      "UUIDv7 reference",
    );
    await mobileSearch
      .getByRole("combobox", { name: "Reference type" })
      .selectOption(mobileReferenceKind);
    const mobileReferenceInput = mobileSearch.getByRole("textbox", { name: "Exact reference" });
    await mobileReferenceInput.fill("unsent-reference");
    await expect(mobileClearButton).toBeEnabled();
    await mobileClearButton.click();
    await expect(mobileReferenceInput).toHaveValue("");
    await mobileReferenceInput.fill(mobileReference);
    await mobileSearchButton.click();
    await expect
      .poll(() => searchedFilters ?? {})
      .toMatchObject(
        mobileReferenceKind === "Order"
          ? { orderReference: mobileReference, ticketReference: null }
          : { ticketReference: mobileReference, orderReference: null },
      );
    await expect(page).not.toHaveURL(new RegExp(mobileReference, "u"));
    await expect(page.locator("body")).not.toContainText(mobileReference);
    await expect(filterToggle).toHaveText("Filters · Active");
    await expect(filterSheet).not.toBeVisible();
    await filterToggle.click();
    await expect(filterSheet).toBeVisible();
    await mobileSearch.getByRole("button", { name: "Clear search" }).click();
    await expect(page.locator(".kitchen-work-item")).toHaveCount(3);
    await expect(filterSheet).not.toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const workItemCard = page.locator(".kitchen-work-item").first();
    for (const badge of await page.locator(".kitchen-work-item__state strong").all()) {
      const box = await badge.boundingBox();
      expect(box?.width).toBe(width <= 340 ? 100 : 112);
      expect(box?.height).toBe(26);
    }
    expect(
      await workItemCard.evaluate((element) => element.getBoundingClientRect().height),
    ).toBeLessThanOrEqual(245);
    await page.screenshot({ path: `test-results/kitchen-board-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.locator(
      ".kitchen-board-workspace:not(.kitchen-work-item-screen) .screen-heading > button",
    ),
  ).toHaveCSS("font-size", "12px");
  await expect(page.locator(".bop-shell__header h1")).toHaveText("OPERATIONS");
  await expect(page.locator(".bop-shell__header h1")).toBeVisible();
  await expect(page.locator(".bop-shell__header-mobile-title")).toBeHidden();
  await expect(page.locator(".bop-shell")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator(".bop-shell__main")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const desktopScreenHeading = page.locator(
    ".kitchen-board-workspace:not(.kitchen-work-item-screen) .screen-heading",
  );
  const desktopQueueWorkspace = await page
    .locator(".kitchen-board-workspace:not(.kitchen-work-item-screen)")
    .boundingBox();
  expect(desktopQueueWorkspace).toMatchObject({ x: 260, width: 1120 });
  await expect(
    desktopScreenHeading.locator(".kitchen-board-freshness > span:first-child"),
  ).toHaveCSS("text-transform", "uppercase");
  const desktopFreshnessPill = desktopScreenHeading.locator(
    '.kitchen-board-freshness > span[data-freshness="Fresh"]',
  );
  await expect(desktopFreshnessPill).toHaveCSS("background-color", "rgb(232, 247, 237)");
  await expect(desktopFreshnessPill).toHaveCSS("color", "rgb(20, 120, 74)");
  const desktopQueueCard = page.locator(".kitchen-work-item").first();
  const desktopAction = desktopQueueCard.locator(".kitchen-work-item__actions button").first();
  const desktopCompleteAction = page.locator(".kitchen-work-item__actions button").nth(1);
  expect((await desktopAction.boundingBox())?.width).toBe(145);
  await expect(desktopAction).toHaveCSS("font-size", "12px");
  expect(
    await desktopCompleteAction.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getClientRects().length;
    }),
  ).toBe(1);
  expect(
    await page
      .locator(".kitchen-work-item")
      .evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().height))),
  ).toEqual([234, 234, 234]);
  await expect(desktopQueueCard).toHaveCSS("border-top-color", "rgb(227, 227, 227)");
  await expect(desktopAction).toHaveCSS("background-color", "rgb(242, 242, 242)");
  await expect(desktopAction).toHaveCSS("border-top-color", "rgb(227, 227, 227)");
  const desktopFreshnessBadge = await desktopScreenHeading
    .locator(".kitchen-board-freshness > span:first-child")
    .boundingBox();
  expect(desktopFreshnessBadge?.width).toBe(78);
  const desktopFreshness = await desktopScreenHeading
    .locator(".kitchen-board-freshness")
    .boundingBox();
  const desktopLock = await page.locator(".kitchen-board-lock").boundingBox();
  const desktopQueue = await page.locator(".kitchen-queue-heading").boundingBox();
  expect(desktopFreshness).not.toBeNull();
  expect(desktopLock).not.toBeNull();
  expect(desktopQueue).not.toBeNull();
  expect(
    (desktopLock?.y ?? 0) - ((desktopFreshness?.y ?? 0) + (desktopFreshness?.height ?? 0)),
  ).toBeLessThanOrEqual(16);
  expect(
    (desktopQueue?.y ?? 0) - ((desktopLock?.y ?? 0) + (desktopLock?.height ?? 0)),
  ).toBeGreaterThanOrEqual(28);
  expect(
    (desktopQueue?.y ?? 0) - ((desktopLock?.y ?? 0) + (desktopLock?.height ?? 0)),
  ).toBeLessThanOrEqual(36);
  await expect(desktopScreenHeading).toHaveCSS("border-bottom-width", "0px");
  const desktopLaneGrid = page.locator(".kitchen-board-lanes");
  const desktopLanes = await desktopLaneGrid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(desktopLanes).toBe(3);
  const desktopLaneBoxes = await page.locator(".kitchen-station-lane").evaluateAll((lanes) =>
    lanes.map((lane) => {
      const { x, y, width } = lane.getBoundingClientRect();
      return { x, y, width };
    }),
  );
  expect(desktopLaneBoxes).toHaveLength(3);
  expect(Math.abs((desktopLaneBoxes[0]?.y ?? 0) - 434)).toBeLessThanOrEqual(2);
  for (const [index, expectedX] of [260, 638, 1016].entries()) {
    expect(desktopLaneBoxes[index]?.x).toBeCloseTo(expectedX, 0);
    expect(desktopLaneBoxes[index]?.width).toBe(354);
  }
  for (let index = 1; index < desktopLaneBoxes.length; index++) {
    expect(
      (desktopLaneBoxes[index]?.x ?? 0) -
        ((desktopLaneBoxes[index - 1]?.x ?? 0) + (desktopLaneBoxes[index - 1]?.width ?? 0)),
    ).toBe(24);
  }
  const desktopCardGrid = page.locator(".kitchen-station-lane__items").first();
  await expect(
    page.locator(".kitchen-work-item").first().locator(".kitchen-work-item__summary h3"),
  ).toHaveCSS("font-weight", "400");
  expect(
    Math.abs(((await page.locator(".kitchen-work-item").first().boundingBox())?.y ?? 0) - 482),
  ).toBeLessThanOrEqual(2);
  await expect(desktopCardGrid).toHaveCSS("column-gap", "24px");
  const desktopColumns = await desktopCardGrid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  expect(desktopColumns).toBe(1);
  const desktopFilters = page.locator(".kitchen-board-filters--desktop select");
  const desktopSearch = page.locator(".kitchen-reference-search--desktop");
  await expect(desktopSearch.locator("label")).toHaveText("Order or ticket reference");
  const desktopSearchInput = desktopSearch.getByRole("textbox", { name: "Exact reference" });
  await expect(desktopSearchInput).toHaveAttribute("placeholder", "Exact UUIDv7 reference");
  await expect(desktopSearchInput).toHaveAttribute(
    "aria-describedby",
    "kitchen-reference-search-hint-desktop",
  );
  await expect(page.locator("#kitchen-reference-search-hint-desktop")).toHaveText(
    "Exact reference only. The value stays in this page session and is not added to the URL.",
  );
  const desktopSearchBox = await desktopSearchInput.boundingBox();
  const filterBoxes = await Promise.all(
    (await desktopFilters.all()).map((filter) => filter.boundingBox()),
  );
  expect(filterBoxes).toHaveLength(4);
  expect(desktopSearchBox?.height).toBe(44);
  expect(Math.abs((filterBoxes[0]?.y ?? 0) - 382)).toBeLessThanOrEqual(4);
  for (const [index, filter] of (await desktopFilters.all()).entries()) {
    const box = filterBoxes[index];
    const style = await filter.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { borderRadius: computed.borderRadius, fontSize: computed.fontSize };
    });
    expect(box?.width).toBe(142);
    expect(box?.height).toBe(44);
    expect(box?.y).toBe(desktopSearchBox?.y);
    expect(style).toEqual({ borderRadius: "7px", fontSize: "12px" });
  }
  for (let index = 1; index < filterBoxes.length; index++) {
    expect((filterBoxes[index]?.x ?? 0) - ((filterBoxes[index - 1]?.x ?? 0) + 142)).toBe(12);
  }
  const queueCount = await page.locator(".kitchen-queue-count").boundingBox();
  expect(queueCount).not.toBeNull();
  expect(queueCount?.x).toBeGreaterThan((filterBoxes[3]?.x ?? 0) + 142);
  expect(
    Math.abs(
      (queueCount?.y ?? 0) +
        (queueCount?.height ?? 0) / 2 -
        ((filterBoxes[0]?.y ?? 0) + (filterBoxes[0]?.height ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(2);
  await page.screenshot({ path: "test-results/kitchen-board-1440.png", fullPage: true });
  const exactReferenceInput = page.getByRole("textbox", { name: "Exact reference" });
  const requestsBeforeInvalidReference = requests;
  await exactReferenceInput.fill("not-a-reference");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect(
    await exactReferenceInput.evaluate((element: HTMLInputElement) => element.validity.valid),
  ).toBe(false);
  expect(requests).toBe(requestsBeforeInvalidReference);
  await exactReferenceInput.fill("");
  const exactOrderReference = id(3);
  await exactReferenceInput.fill(exactOrderReference);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => searchedFilters?.orderReference).toBe(exactOrderReference);
  await expect(page.locator(".kitchen-work-item")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Exact reference" })).toHaveValue("");
  await expect(page).not.toHaveURL(new RegExp(exactOrderReference, "u"));
  await expect(page.locator("body")).not.toContainText(exactOrderReference);
  await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();
  await page.screenshot({ path: "test-results/kitchen-board-search-1440.png", fullPage: true });
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator(".kitchen-work-item")).toHaveCount(3);
  const exactTicketReference = id(2);
  await page.getByRole("combobox", { name: "Reference type" }).selectOption("Ticket");
  const ticketReferenceInput = page.getByRole("textbox", { name: "Exact reference" });
  await ticketReferenceInput.fill(exactTicketReference);
  await ticketReferenceInput.press("Enter");
  await expect
    .poll(() => searchedFilters ?? {})
    .toMatchObject({ ticketReference: exactTicketReference, orderReference: null });
  await expect(page.getByRole("textbox", { name: "Exact reference" })).toHaveValue("");
  await expect(page).not.toHaveURL(new RegExp(exactTicketReference, "u"));
  await expect(page.locator("body")).not.toContainText(exactTicketReference);
  await expect(page.getByRole("button", { name: "Clear search" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator(".kitchen-work-item")).toHaveCount(3);
  const exactReferenceWithoutMatch = id(16);
  await page.getByRole("combobox", { name: "Reference type" }).selectOption("Ticket");
  await exactReferenceInput.fill(exactReferenceWithoutMatch);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => searchedFilters?.ticketReference).toBe(exactReferenceWithoutMatch);
  await expect(page.locator(".kitchen-work-item")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No matching work", exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "No work item matches this exact reference. Clear search to restore the queue.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(exactReferenceWithoutMatch);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.locator(".kitchen-work-item")).toHaveCount(3);
  await page.getByRole("combobox", { name: "Work state", exact: true }).selectOption("Queued");
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  const detailsLink = page.getByRole("link", { name: "Synthetic rice", exact: true });
  await tabTo(page, detailsLink);
  await expect(detailsLink).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Additional detail", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Modifiers" })).toBeVisible();
  await expect(page.getByText("Extra mushrooms", { exact: true })).toBeVisible();
  await expect(page.getByText("× 2", { exact: true })).toBeVisible();
  await expect(page.getByText(id(11), { exact: true })).toHaveCount(0);
  for (const detail of [
    "Recipe & handling snapshots",
    "Allergen acknowledgements",
    "Timers & dependencies",
    "Work item history",
  ]) {
    await expect(page.getByText(detail, { exact: true })).toBeVisible();
  }
  const detailsGroup = page.locator(".kitchen-work-item-screen__details dl");
  await expect(detailsGroup).toHaveCSS("gap", "8px");
  await expect(detailsGroup).toHaveCSS("padding", "12px");
  await expect(detailsGroup).toHaveCSS("border-radius", "9px");
  await expect(detailsGroup.locator("> div")).toHaveCount(4);
  await expect(detailsGroup.locator("> div").first()).toHaveCSS("border-radius", "6px");
  await expect(page.getByText("18 min", { exact: true })).toBeVisible();
  await expect(page.getByText("KDS session unverified", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  for (const width of [1440, 720, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expect(page.locator(".kitchen-work-item-screen__heading-actions button")).toHaveCSS(
      "font-size",
      "13px",
    );
    for (const control of [
      page.getByRole("link", { name: "Return to Kitchen queue" }),
      page.getByRole("button", { name: "Refresh from source", exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    if (width < 768) {
      await expect(page.locator(".bop-shell__header")).toHaveCSS("min-height", "76px");
      await expect(page.locator(".bop-shell__main")).toHaveCSS("padding-top", "20px");
      await expect(page.locator(".kitchen-work-item-screen .screen-heading h2")).toHaveCSS(
        "font-size",
        "26px",
      );
      await expect(page.locator(".kitchen-work-item-screen .kitchen-board-eyebrow")).toHaveCSS(
        "margin-bottom",
        "4px",
      );
    }
    await expect(
      page.getByRole("heading", { name: "Additional detail", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".kitchen-work-item-screen__details > header h3")).toHaveCSS(
      "font-size",
      "14px",
    );
    await expect(page.locator(".kitchen-work-item-screen__details > header p")).toHaveCSS(
      "font-size",
      "12px",
    );
    await expect(detailsGroup.locator("> div").first()).toHaveCSS(
      "min-height",
      width < 768 ? "52px" : "42px",
    );
    await expect(detailsGroup.locator("> div").first()).toHaveCSS(
      "flex-direction",
      width < 768 ? "column" : "row",
    );
    await expect(detailsGroup.locator("> div").last()).toContainText("Work item created");
    await expect(page.locator(".bop-shell__main")).toHaveCSS(
      "background-color",
      "rgb(245, 245, 245)",
    );
    const eyebrow = page.getByText("KIT-WORK-ITEM · Execution snapshot", { exact: true });
    const workItemHeading = page.locator(".kitchen-work-item-screen .screen-heading h2");
    expect((await eyebrow.boundingBox())?.y).toBeLessThan(
      (await workItemHeading.boundingBox())?.y ?? 0,
    );
    const detailCard = page.locator(".kitchen-work-item--detail");
    const detailTitle = await detailCard.locator(".kitchen-work-item__summary h3").boundingBox();
    const detailState = await detailCard.locator(".kitchen-work-item__state strong").boundingBox();
    const detailAge = await detailCard.locator(".kitchen-work-item__state span").boundingBox();
    if (!detailTitle || !detailState || !detailAge) throw new Error("Kitchen detail card missing");
    const detailCardBox = await detailCard.boundingBox();
    const detailCue = await detailCard.locator(".kitchen-work-item__cue").first().boundingBox();
    if (!detailCardBox || !detailCue) throw new Error("Kitchen detail card facts missing");
    expect(detailState.width).toBe(78);
    expect(detailState.height).toBe(28);
    expect(detailCardBox.height).toBeLessThanOrEqual(230);
    expect(detailCue.height).toBeLessThanOrEqual(20);
    await expect(detailCard).toHaveCSS("border-radius", "7px");
    await expect(detailCard.locator(".kitchen-work-item__modifiers")).toHaveCSS(
      "border-top-width",
      "0px",
    );
    expect(detailState.x).toBeGreaterThanOrEqual(detailTitle.x + detailTitle.width);
    expect(detailState.y).toBeLessThan(detailTitle.y + detailTitle.height);
    expect(detailState.y + detailState.height).toBeGreaterThan(detailTitle.y);
    expect(detailAge.y).toBeGreaterThan(detailState.y);
    expect(detailAge.x + detailAge.width).toBeCloseTo(detailState.x + detailState.width, 0);
    if (width < 768) {
      const actionGroup = await page
        .locator(".kitchen-work-item-screen__heading-actions")
        .boundingBox();
      const returnLink = await page
        .getByRole("link", { name: "Return to Kitchen queue" })
        .boundingBox();
      const refreshButton = await page
        .getByRole("button", { name: "Refresh from source" })
        .boundingBox();
      expect(actionGroup?.width).toBeGreaterThan(0);
      expect(returnLink?.x).toBe(actionGroup?.x);
      expect(refreshButton?.width).toBe(actionGroup?.width);
      expect(refreshButton?.y).toBeGreaterThanOrEqual(
        (returnLink?.y ?? 0) + (returnLink?.height ?? 0),
      );
    } else {
      const actionGroup = await page
        .locator(".kitchen-work-item-screen__heading-actions")
        .boundingBox();
      const returnLink = await page
        .getByRole("link", { name: "Return to Kitchen queue" })
        .boundingBox();
      const refreshButton = await page
        .getByRole("button", { name: "Refresh from source" })
        .boundingBox();
      if (!actionGroup || !returnLink || !refreshButton)
        throw new Error("Kitchen detail heading actions missing");
      expect(actionGroup.width).toBe(340);
      expect(returnLink.x).toBeCloseTo(actionGroup.x, 0);
      expect(returnLink.width).toBeCloseTo(actionGroup.width, 0);
      expect(refreshButton.y).toBeGreaterThanOrEqual(returnLink.y + returnLink.height);
      expect(refreshButton.x + refreshButton.width).toBeCloseTo(
        actionGroup.x + actionGroup.width,
        0,
      );
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/kitchen-detail-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const returnLink = page.getByRole("link", { name: "Return to Kitchen queue" });
  await tabTo(page, returnLink);
  await expect(returnLink).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/operations\/kitchen$/);
  await expect(page.getByRole("heading", { name: "Kitchen", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Work state", exact: true })).toHaveValue(
    "Queued",
  );
  denied = true;
  await page.getByRole("link", { name: "Synthetic rice", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permission denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OPERATIONS", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Return to Kitchen queue" }).click();
  await expect(page.getByRole("heading", { name: "Permission denied" })).toBeVisible();
  denied = false;
  await page.getByRole("button", { name: "Refresh from source" }).click();
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Work state", exact: true })).toHaveValue(
    "Queued",
  );
  await page.getByRole("button", { name: "Clear filters" }).click();
  denied = true;
  const keyboardRefresh = page.getByRole("button", { name: "Refresh from source" });
  await tabTo(page, keyboardRefresh);
  await expect(keyboardRefresh).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Permission denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh from source" })).toBeFocused();
  denied = false;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  expect(requests).toBe(20);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  showOrders = true;
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(primaryNav).toBeVisible();
  await expect(primaryNav.getByRole("link", { name: "Orders" })).toBeVisible();
  await expect(primaryNav.getByRole("link", { name: "Kitchen" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(requests).toBe(21);
});

test("@production Kitchen reloads projection after an authorized Store switch", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const stores = [
    { brandLabel: "Synthetic Brand", storeLabel: "Store One", storeReference: id(99) },
    { brandLabel: "Synthetic Brand", storeLabel: "Store Two", storeReference: id(98) },
  ];
  const storeOne = stores[0];
  const storeTwo = stores[1];
  if (!storeOne || !storeTwo) throw new Error("Kitchen Store-switch fixtures are incomplete");
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
        screenId: "KIT-KITCHEN-QUEUE",
        label: "Kitchen",
        href: "/operations/kitchen",
        permission: "kitchen.operate",
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
      targetStoreReference: stores[1]?.storeReference,
    });
    selectedStore = 1;
    await route.fulfill({ headers, json: { workspace: workspace(selectedStore) } });
  });
  const readStores: string[] = [];
  await page.route("**/merchant/kitchen/query", (route) => {
    const query = route.request().postDataJSON();
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrfFor(selectedStore));
    expect(query).not.toHaveProperty("storeReference");
    const currentStore = selectedStore === 0 ? storeOne : storeTwo;
    readStores.push(currentStore.storeReference);
    const itemIndex = selectedStore + 1;
    const projectedAt = "2026-09-19T12:18:00.000Z";
    const item = {
      workItemReference: id(10 + itemIndex),
      ticketReference: id(20 + itemIndex),
      orderReference: id(30 + itemIndex),
      orderItemReference: id(40 + itemIndex),
      stationReference: id(50 + itemIndex),
      localizedDisplayNames: { "en-CA": `Synthetic work at Store ${itemIndex}` },
      selectedOptions: [],
      status: "Queued",
      requiredQuantity: 1,
      completedQuantity: 0,
      workItemCreatedAt: "2026-09-19T12:00:00.000Z",
      acceptedAt: null,
      orderItemReadyAt: null,
      ticketAggregateVersion: "1",
      workItemVersion: "1",
    };
    return route.fulfill({
      headers,
      json: {
        storeReference: currentStore.storeReference,
        operatorStatus: "Unverified",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        projectionGenerationReference: id(60 + itemIndex),
        projectedAt,
        partial: false,
        stale: false,
        freshnessStatus: "Fresh",
        items: [item],
        nextCursor: null,
      },
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Store One", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Kitchen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic work at Store 1", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText(storeOne.storeReference);

  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption(storeTwo.storeReference);
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Store Two", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Kitchen", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Synthetic work at Store 2", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Synthetic work at Store 1", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(storeTwo.storeReference);
  expect(readStores).toEqual([storeOne.storeReference, storeTwo.storeReference]);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/kitchen-store-switch-${width}.png`,
      fullPage: true,
    });
  }
});

test("@production Kitchen queue matches the full Figma status palette", async ({ page }) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
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
          businessDate: "2026-09-19",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "KIT-KITCHEN-QUEUE",
              label: "Kitchen",
              href: "/operations/kitchen",
              permission: "kitchen.operate",
            },
          ],
        },
      },
    }),
  );
  const at = "2026-09-19T12:00:00.000Z";
  const base = {
    ticketReference: id(2),
    orderReference: id(3),
    stationReference: id(5),
    selectedOptions: [],
    requiredQuantity: 1,
    completedQuantity: 0,
    workItemCreatedAt: at,
    acceptedAt: null,
    orderItemReadyAt: null,
    ticketAggregateVersion: "1",
    workItemVersion: "1",
  };
  const items = [
    {
      ...base,
      workItemReference: id(1),
      orderItemReference: id(11),
      localizedDisplayNames: { "en-CA": "Synthetic queued" },
      status: "Queued",
    },
    {
      ...base,
      workItemReference: id(4),
      orderItemReference: id(12),
      localizedDisplayNames: { "en-CA": "Synthetic in progress" },
      status: "In Progress",
      completedQuantity: 1,
    },
    {
      ...base,
      workItemReference: id(6),
      orderItemReference: id(13),
      localizedDisplayNames: { "en-CA": "Synthetic held" },
      status: "Held",
    },
    {
      ...base,
      workItemReference: id(7),
      orderItemReference: id(14),
      localizedDisplayNames: { "en-CA": "Synthetic completed" },
      status: "Completed",
      completedQuantity: 1,
    },
    {
      ...base,
      workItemReference: id(8),
      orderItemReference: id(15),
      localizedDisplayNames: { "en-CA": "Synthetic cancelled" },
      status: "Cancelled",
    },
  ];
  const metadata = {
    storeReference: scope.storeReference,
    operatorStatus: "Unverified",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    projectionGenerationReference: id(9),
    projectedAt: at,
    partial: false,
    stale: false,
    freshnessStatus: "Fresh",
  };
  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({ headers, json: { ...metadata, items, nextCursor: null } }),
  );
  await page.goto("/operations/kitchen");
  await expect(page.locator(".kitchen-work-item")).toHaveCount(5);
  const statusColors = [
    ["Synthetic queued", "rgb(239, 246, 255)", "rgb(191, 219, 254)"],
    ["Synthetic in progress", "rgb(240, 253, 244)", "rgb(187, 247, 208)"],
    ["Synthetic held", "rgb(255, 251, 235)", "rgb(252, 211, 77)"],
    ["Synthetic completed", "rgb(245, 245, 245)", "rgb(229, 229, 229)"],
    ["Synthetic cancelled", "rgb(254, 242, 242)", "rgb(254, 202, 202)"],
  ] as const;
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [320, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator(".kitchen-work-item")).toHaveCount(5);
    for (const [itemName, background, borderColor] of statusColors) {
      const badge = page
        .locator(".kitchen-work-item")
        .filter({ hasText: itemName })
        .locator(".kitchen-work-item__state strong");
      await expect(badge).toHaveCSS("background-color", background);
      await expect(badge).toHaveCSS("border-top-color", borderColor);
      await expect(badge).toHaveCSS("border-top-width", "1px");
      await expect(badge).toHaveCSS("border-top-style", "solid");
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/kitchen-status-palette-${width}.png`,
      fullPage: true,
    });
  }
});

test("@production Kitchen commands preserve intent and wait for projection versions", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
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
          businessDate: "2026-09-19",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "KIT-KITCHEN-QUEUE",
              label: "Kitchen",
              href: "/operations/kitchen",
              permission: "kitchen.operate",
            },
          ],
        },
      },
    }),
  );
  const at = "2026-09-19T12:00:00.000Z";
  const item = {
    workItemReference: id(1),
    ticketReference: id(2),
    orderReference: id(3),
    orderItemReference: id(4),
    stationReference: id(5),
    localizedDisplayNames: { "en-CA": "Synthetic rice" },
    selectedOptions: [],
    status: "Queued",
    requiredQuantity: 2,
    completedQuantity: 0,
    workItemCreatedAt: at,
    acceptedAt: null,
    orderItemReadyAt: null,
    ticketAggregateVersion: "9007199254740993",
    workItemVersion: "1",
  };
  const metadata = {
    storeReference: scope.storeReference,
    // Synthetic interaction state only; the normal API never supplies Named until its owner source exists.
    operatorStatus: "Named",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    projectionGenerationReference: id(6),
    projectedAt: at,
    partial: false,
    stale: false,
    freshnessStatus: "Fresh",
  };

  await page.route("**/merchant/kitchen/query", (route) =>
    route.fulfill({ headers, json: { ...metadata, items: [item], nextCursor: null } }),
  );
  const commands: Record<string, unknown>[] = [];
  let conflict = false;
  let releaseFirstCommand!: () => void;
  let notifyFirstCommand!: () => void;
  const firstCommandBarrier = new Promise<void>((resolve) => (releaseFirstCommand = resolve));
  const firstCommandStarted = new Promise<void>((resolve) => (notifyFirstCommand = resolve));
  await page.route("**/merchant/kitchen/work", async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    expect(command.authority).toBe("CurrentMerchantSession");
    expect(command.storeReference).toBe(scope.storeReference);
    expect(command).not.toHaveProperty("actorReference");
    if (commands.length === 1) {
      notifyFirstCommand();
      await firstCommandBarrier;
      return route.abort("failed");
    }
    if (commands.length === 2) return route.abort("failed");
    if (conflict)
      return route.fulfill({ headers, status: 409, json: { error: "version_conflict" } });
    return route.fulfill({
      headers,
      json: {
        action: command.action,
        ticketReference: item.ticketReference,
        workItemReference: item.workItemReference,
        orderItemReference: item.orderItemReference,
        ticketVersion: (BigInt(command.expectedTicketVersion) + 1n).toString(),
        workItemVersion: (BigInt(command.expectedWorkItemVersion) + 1n).toString(),
        outcome:
          command.action === "AcceptKitchenWorkItem"
            ? "Accepted"
            : command.action === "StartKitchenWorkItem"
              ? "Started"
              : "CompletedAndOrderItemReady",
        projectionName: "kitchen_work_queue_v1",
        projectionPending: true,
      },
    });
  });
  await page.goto("/operations/kitchen");
  const accept = page.getByRole("button", { name: "Accept", exact: true }),
    start = page.getByRole("button", { name: "Start", exact: true }),
    complete = page.getByRole("button", { name: "Complete quantity", exact: true }),
    refresh = page.getByRole("button", { name: "Refresh from source" });
  await expect(accept).toBeEnabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    if (width < 768) {
      const filters = page.getByRole("button", { name: "Filters · All work" });
      await expect(filters).toBeVisible();
      await expect(page.getByRole("combobox", { name: "Work state" })).toBeHidden();
      await filters.click();
      const sheet = page.getByRole("dialog", { name: "Filter Kitchen work" });
      await expect(sheet.getByRole("combobox", { name: "Work state" })).toBeVisible();
      await sheet.getByRole("button", { name: "Done" }).click();
      await expect(sheet).not.toBeVisible();
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/kitchen-command-board-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await tabTo(page, accept);
  await expect(accept).toHaveCSS("outline-style", "solid");
  await page.keyboard.press("Enter");
  await firstCommandStarted;
  await tabTo(page, refresh);
  releaseFirstCommand();
  await expect(page.getByRole("heading", { name: "Action result unknown" })).toBeVisible();
  await expect(refresh).toBeFocused();
  await expect(accept).toBeDisabled();
  expect(commands).toHaveLength(1);
  const retry = page.getByRole("button", { name: "Retry same operation" });
  await tabTo(page, retry);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Action result unknown" })).toBeVisible();
  await expect(retry).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Waiting for refreshed queue" })).toBeVisible();
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[2]).toEqual(commands[0]);
  await refresh.click();
  await expect(accept).toBeDisabled();
  await expect(start).toHaveCount(0);
  Object.assign(item, {
    acceptedAt: at,
    ticketAggregateVersion: "9007199254740994",
    workItemVersion: "2",
  });
  await refresh.click();
  await expect(start).toBeEnabled();
  conflict = true;
  await tabTo(page, start);
  await page.keyboard.press("Enter");
  await expect(page.getByText("The work item changed.", { exact: false })).toBeVisible();
  await expect(start).toBeDisabled();
  await refresh.click();
  await expect(start).toBeEnabled();
  conflict = false;
  await start.click();
  await expect(page.getByRole("heading", { name: "Waiting for refreshed queue" })).toBeVisible();
  Object.assign(item, {
    status: "In Progress",
    ticketAggregateVersion: "9007199254740995",
    workItemVersion: "3",
  });
  await refresh.click();
  await expect(complete).toBeEnabled();
  await complete.click();
  await expect(page.getByRole("heading", { name: "Waiting for refreshed queue" })).toBeVisible();
  expect(commands[5]?.quantityDelta).toBe(2);
  Object.assign(item, {
    status: "Completed",
    completedQuantity: 2,
    orderItemReadyAt: at,
    ticketAggregateVersion: "9007199254740996",
    workItemVersion: "4",
  });
  await refresh.click();
  await expect(
    page.getByRole("heading", { name: "Kitchen action confirmed", exact: true }),
  ).toBeVisible();
  await expect(complete).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Mark ready", exact: true })).toHaveCount(0);
  expect(new Set(commands.slice(1).map((command) => command.idempotencyKey)).size).toBe(4);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});
