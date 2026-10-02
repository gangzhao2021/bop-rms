import { expect, test } from "@playwright/test";
test("@production Pickup paging, current scope and permission recovery", async ({ page }) => {
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
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
            },
          ],
        },
      },
    }),
  );

  const first = "A".repeat(22),
    second = "B".repeat(21) + "A",
    queries: Record<string, unknown>[] = [];
  let denied = false,
    foreign = false;
  await page.route("**/merchant/pickup/query", (route) => {
    const query = route.request().postDataJSON();
    queries.push(query);
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    if (denied) return route.fulfill({ status: 403, headers, json: { error: "request_denied" } });
    const next = query.afterFulfillmentReference !== null;
    return route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: foreign ? id(98) : scope.storeReference,
        observedAt: "2026-09-19T12:00:00.000Z",
        nextAfterFulfillmentReference: next ? null : id(1),
        items: [
          {
            fulfillmentReference: next ? id(2) : id(1),
            orderReference: id(3),
            phase: query.includeCompleted ? "Completed" : "Ready",
            aggregateVersion: "9007199254740993",
            readyAt: "2026-09-19T11:40:00.000Z",
            publicOrderReference: next ? second : first,
            proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-09-19T12:55:00.000Z" },
            items: [
              {
                fulfillmentItemReference: id(4),
                orderedQuantity: 2,
                readyQuantity: 2,
                handedOverQuantity: query.includeCompleted ? 2 : 0,
              },
            ],
          },
        ],
      },
    });
  });
  await page.goto("/operations/pickup");
  const heading = (name: string) => page.getByRole("heading", { name, exact: true });
  const refresh = page.getByRole("button", { name: "Refresh from source", exact: true });
  await expect(heading(first)).toBeVisible();
  const orderSearch = page.getByRole("searchbox", { name: "Search Order reference" });
  await orderSearch.fill("missing");
  await expect(heading("No matching pickups")).toBeVisible();
  const clearFilters = page.getByRole("button", { name: "Clear page filters", exact: true });
  await expect(clearFilters).toBeEnabled();
  await clearFilters.click();
  await expect(heading(first)).toBeVisible();
  const stateFilter = page.getByRole("combobox", { name: "Current page filter", exact: true });
  await stateFilter.focus();
  await page.keyboard.press("W");
  await expect(stateFilter).toHaveValue("Waiting");
  await expect(heading(first)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Claim", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("combobox", { name: "Exception", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(clearFilters).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(stateFilter).toHaveValue("All");
  await expect(heading(first)).toBeVisible();
  await expect(page.locator("option").filter({ hasText: "Overdue" })).toHaveAttribute(
    "disabled",
    "",
  );
  await expect(stateFilter).toHaveAttribute("aria-describedby", "pickup-overdue-availability");
  await expect(page.locator("#pickup-overdue-availability")).toContainText(
    "no authorized due time",
  );
  await expect(page.locator("article").first()).toContainText("Ready 20 minutes");
  await expect(page.locator("article").first()).toContainText("Waiting");
  await expect(page.locator("article").first()).not.toContainText("Overdue");
  const claim = page.getByRole("button", { name: "Claim", exact: true }).first();
  const reportException = page
    .getByRole("button", { name: "Report exception", exact: true })
    .first();
  await expect(claim).toBeDisabled();
  await expect(reportException).toBeDisabled();
  await expect(claim).toHaveAttribute("aria-describedby", "pickup-command-availability");
  await expect(reportException).toHaveAttribute("aria-describedby", "pickup-command-availability");
  await expect(page.getByText(/authorized source-bound Task or Fulfillment command/)).toBeVisible();
  await page.getByRole("combobox").nth(1).selectOption("Unavailable");
  await page.getByRole("combobox").nth(2).selectOption("Unavailable");
  await expect(heading(first)).toBeVisible();
  await clearFilters.click();
  await expect(page.getByRole("combobox").nth(1)).toHaveValue("All");
  await expect(page.getByRole("combobox").nth(2)).toHaveValue("All");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/pickup-board-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("button", { name: "Open proof verification", exact: true }),
  ).toBeEnabled();
  const proofs: string[] = [];
  let releaseFirstProof!: () => void;
  let notifyProofStarted!: () => void;
  const firstProofBarrier = new Promise<void>((resolve) => {
    releaseFirstProof = resolve;
  });
  const firstProofStarted = new Promise<void>((resolve) => {
    notifyProofStarted = resolve;
  });
  await page.route("**/merchant/pickup/proof", async (route) => {
    proofs.push(route.request().postData() ?? "");
    if (proofs.length === 1) {
      notifyProofStarted();
      await firstProofBarrier;
      await route.abort();
      return;
    }
    if (proofs.length === 2) {
      await route.abort();
      return;
    }
    const proofRequest = route.request().postDataJSON();
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyApplied",
        verificationReference: proofRequest.fulfillmentReference === id(1) ? id(7) : id(8),
        fulfillmentReference: proofRequest.fulfillmentReference,
        expectedAggregateVersion: "9007199254740993",
        generation: 1,
        grantsCompletionAuthority: false,
      },
    });
  });
  const openProof = page.getByRole("button", { name: "Open proof verification", exact: true });
  await openProof.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Pickup credential", { exact: true })).toBeFocused();
  await page.getByLabel("Pickup credential", { exact: true }).fill("123456");
  await page.keyboard.press("Enter");
  await firstProofStarted;
  await orderSearch.focus();
  releaseFirstProof();
  await expect(page.getByText("Verification result unknown.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Pickup credential", { exact: true })).toHaveCount(0);
  await expect(orderSearch).toBeFocused();
  const retryVerification = page.getByRole("button", {
    name: "Retry same verification",
    exact: true,
  });
  await orderSearch.fill("missing");
  await expect(heading("No matching pickups")).toBeVisible();
  const firstCard = page.locator("article.store-card").first();
  await expect(firstCard).toHaveAttribute("hidden", "");
  const hiddenRetry = firstCard.locator("button").filter({ hasText: "Retry same verification" });
  await expect(hiddenRetry).toBeAttached();
  await orderSearch.fill(first);
  await expect(heading(first)).toBeVisible();
  await expect(retryVerification).toBeVisible();
  await retryVerification.focus();
  await page.keyboard.press("Enter");
  await expect(retryVerification).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Proof verified.", { exact: false })).toBeVisible();
  expect(proofs).toHaveLength(3);
  expect(proofs[0]).toBe(proofs[1]);
  expect(proofs[1]).toBe(proofs[2]);
  const handoffs: string[] = [];
  await page.route("**/merchant/pickup/handoff", (route) => {
    handoffs.push(route.request().postData() ?? "");
    if (handoffs.length === 1) return route.abort();
    if (handoffs.length === 3)
      return route.fulfill({
        status: 422,
        headers,
        json: { error: "handoff_rejected" },
      });
    const handoffRequest = route.request().postDataJSON();
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyApplied",
        handoffReference: id(12),
        fulfillmentReference: handoffRequest.fulfillmentReference,
        nextAggregateVersion: "9007199254740994",
        nextPhase: "Completed",
      },
    });
  });
  const reviewHandoff = page.getByRole("button", { name: "Review pickup handoff" });
  await reviewHandoff.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Order line 1: 2 remaining ready units")).toBeVisible();
  const recipientType = dialog.getByLabel("Recipient type");
  await expect(recipientType).toBeFocused();
  await recipientType.press("C");
  await expect(recipientType).toHaveValue("Customer");
  await page.keyboard.press("Tab");
  const recipientMask = dialog.getByLabel("Masked recipient label");
  await expect(recipientMask).toBeFocused();
  await recipientMask.pressSequentially("S***");
  await page.keyboard.press("Tab");
  const matchConfirmation = dialog.getByRole("checkbox");
  await expect(matchConfirmation).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  const confirm = dialog.getByRole("button", { name: "Confirm and record handoff" });
  await expect(confirm).toBeFocused();
  await expect(confirm).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("Handoff result unknown.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close handoff confirmation" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  const retryHandoff = dialog.getByRole("button", { name: "Retry same handoff" });
  await retryHandoff.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText("Handoff recorded. Close and refresh the queue.")).toBeVisible();
  expect(handoffs).toHaveLength(2);
  expect(handoffs[0]).toBe(handoffs[1]);
  expect(JSON.parse(handoffs[0] ?? "{}")).toMatchObject({
    verificationReference: id(7),
    deviceReference: id(10),
    pickupLocationReference: id(11),
    expectedAggregateVersion: "9007199254740993",
    recipientType: "Customer",
    recipientDisplayMask: "S***",
    quantities: [{ fulfillmentItemReference: id(4), quantity: 2 }],
  });
  const closeHandoff = dialog.getByRole("button", { name: "Close handoff confirmation" });
  await closeHandoff.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({
      hasText: "Handoff recorded. Refresh the queue to see current status.",
    }),
  ).toBeFocused();
  await expect(page.getByRole("button", { name: "Review pickup handoff" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await orderSearch.fill("");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(heading(second)).toBeVisible();
  await expect(heading(first)).toHaveCount(0);
  await expect(refresh).toBeFocused();
  const openSecondProof = page.getByRole("button", {
    name: "Open proof verification",
    exact: true,
  });
  await openSecondProof.focus();
  await page.keyboard.press("Enter");
  const secondCredential = page.getByLabel("Pickup credential", { exact: true });
  await secondCredential.fill("654321");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Proof verified.", { exact: false })).toBeVisible();
  expect(proofs).toHaveLength(4);
  const secondReview = page.getByRole("button", { name: "Review pickup handoff" });
  await secondReview.click();
  const rejectedDialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
  await rejectedDialog.getByLabel("Recipient type").selectOption("Customer");
  await rejectedDialog.getByLabel("Masked recipient label").fill("D***");
  await rejectedDialog.getByRole("checkbox").check();
  await rejectedDialog.getByRole("button", { name: "Confirm and record handoff" }).click();
  await expect(
    rejectedDialog.getByText(
      "Handoff was not confirmed. Close and refresh the queue before another attempt.",
    ),
  ).toBeVisible();
  await rejectedDialog.getByRole("button", { name: "Close handoff confirmation" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({
      hasText: "Handoff was not confirmed. Refresh the queue before another attempt.",
    }),
  ).toBeFocused();
  await expect(secondReview).toBeDisabled();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(heading(first)).toBeVisible();
  const includeCompleted = page.getByRole("checkbox", { name: "Include completed pickups" });
  await includeCompleted.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("article").getByText("Completed", { exact: false })).toBeVisible();
  await expect(page.locator("#pickup-overdue-availability")).toBeVisible();
  await expect(stateFilter).toHaveAttribute("aria-describedby", "pickup-overdue-availability");
  await expect(refresh).toBeFocused();
  expect(queries.at(-1)).toMatchObject({
    afterFulfillmentReference: null,
    includeCompleted: true,
    limit: 50,
  });
  denied = true;
  await refresh.focus();
  await page.keyboard.press("Enter");
  await expect(heading("Permission denied")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
  await expect(refresh).toBeFocused();
  denied = false;
  await page.keyboard.press("Enter");
  await expect(heading(first)).toBeVisible();
  foreign = true;
  await refresh.click();
  await expect(heading("Pickup Queue unavailable")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});

test("@production Pickup reloads the current page after an authorized Store switch", async ({
  page,
}) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const stores = [1, 2].map((n) => ({
    brandLabel: "Synthetic Brand",
    storeLabel: "Store " + n,
    storeReference: id(98 + n),
  }));
  const storeOne = stores[0];
  const storeTwo = stores[1];
  if (!storeOne || !storeTwo) throw new Error("Pickup Store-switch fixtures are incomplete");
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
      {
        screenId: "FUL-PICKUP-QUEUE",
        label: "Pickup",
        href: "/operations/pickup",
        permission: "fulfillment.operate",
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
  const readScopes: string[] = [];
  await page.route("**/merchant/pickup/query", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrfFor(selected));
    const query = route.request().postDataJSON();
    expect(query).toEqual({
      afterFulfillmentReference: null,
      limit: 50,
      includeCompleted: false,
    });
    expect(query).not.toHaveProperty("storeReference");
    expect(query).not.toHaveProperty("tenantReference");
    const currentStore = selected === 0 ? storeOne : storeTwo;
    readScopes.push(currentStore.storeReference);
    const number = selected + 1;
    return route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: currentStore.storeReference,
        observedAt: "2026-09-26T12:30:00.000Z",
        nextAfterFulfillmentReference: null,
        items: [
          {
            fulfillmentReference: id(20 + number),
            orderReference: id(30 + number),
            phase: "Ready",
            aggregateVersion: "2",
            readyAt: "2026-09-26T12:10:00.000Z",
            publicOrderReference: "PICKUPSTORE" + String(number).padStart(11, "0"),
            proof: { kind: "HumanCode", generation: 1, expiresAt: "2026-09-26T13:00:00.000Z" },
            items: [
              {
                fulfillmentItemReference: id(40 + number),
                orderedQuantity: 1,
                readyQuantity: 1,
                handedOverQuantity: 0,
              },
            ],
          },
        ],
      },
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Store 1", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Pickup", exact: true }).click();
  await expect(page.getByText("PICKUPSTORE00000000001", { exact: true })).toBeVisible();

  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption(storeTwo.storeReference);
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Store 2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Pickup", exact: true }).click();
  await expect(page.getByText("PICKUPSTORE00000000002", { exact: true })).toBeVisible();
  await expect(page.getByText("PICKUPSTORE00000000001", { exact: true })).toHaveCount(0);
  expect(readScopes).toEqual([storeOne.storeReference, storeTwo.storeReference]);
});
