import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
test("@production Pickup paging, current scope and permission recovery", async ({ page }) => {
  const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Training Brand",
    storeLabel: "Training Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
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
    foreign = false,
    firstHandedOver = false;
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
        // WP-2423: once handed over, the first order leaves the waiting list.
        items: (firstHandedOver && !next && !query.includeCompleted ? [] : [0]).map(() => ({
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
        })),
      },
    });
  });
  await page.goto("/operations/pickup");
  const heading = (name: string) => page.getByRole("heading", { name, exact: true });
  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(heading("Order " + first)).toBeVisible();
  const orderSearch = page.getByRole("searchbox", { name: "Order number" });
  await orderSearch.fill("missing");
  await expect(heading("No pickups waiting")).toBeVisible();
  const clearFilters = page.getByRole("button", { name: "Clear filters", exact: true });
  await expect(clearFilters).toBeEnabled();
  await clearFilters.click();
  await expect(heading("Order " + first)).toBeVisible();
  const stateFilter = page.getByRole("combobox", { name: "Status", exact: true });
  await stateFilter.focus();
  await page.keyboard.press("W");
  await expect(stateFilter).toHaveValue("Waiting");
  await expect(heading("Order " + first)).toBeVisible();
  // WP-2423: the pilot source has no claim or exception facts, so those filters are not offered.
  await expect(page.getByRole("combobox", { name: "Claim", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Exception", exact: true })).toHaveCount(0);
  await expect(page.locator("option").filter({ hasText: "Unavailable" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(clearFilters).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(stateFilter).toHaveValue("All");
  await expect(heading("Order " + first)).toBeVisible();
  await expect(page.locator("option").filter({ hasText: "Overdue" })).toHaveCount(0);
  await expect(page.locator("article").first()).toContainText("Ready for 20 min");
  await expect(page.locator("article").first()).toContainText("Waiting");
  await expect(page.locator("article").first()).not.toContainText("Overdue");
  // Dead placeholder actions are gone from the pilot queue.
  await expect(page.getByRole("button", { name: "Claim", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Report exception", exact: true })).toHaveCount(0);
  await expect(page.locator("article").first()).not.toContainText("Unavailable");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/pickup-board-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("button", { name: "Check pickup code", exact: true })).toBeEnabled();
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
  const openProof = page.getByRole("button", { name: "Check pickup code", exact: true });
  await openProof.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Pickup code", { exact: true })).toBeFocused();
  await page.getByLabel("Pickup code", { exact: true }).fill("123456");
  await page.keyboard.press("Enter");
  await firstProofStarted;
  await orderSearch.focus();
  releaseFirstProof();
  await expect(page.getByText("The check could not be confirmed.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Pickup code", { exact: true })).toHaveCount(0);
  await expect(orderSearch).toBeFocused();
  const retryVerification = page.getByRole("button", {
    name: "Try the check again",
    exact: true,
  });
  await orderSearch.fill("missing");
  await expect(heading("No pickups waiting")).toBeVisible();
  const firstCard = page.locator("article.store-card").first();
  await expect(firstCard).toHaveAttribute("hidden", "");
  const hiddenRetry = firstCard.locator("button").filter({ hasText: "Try the check again" });
  await expect(hiddenRetry).toBeAttached();
  await orderSearch.fill(first);
  await expect(heading("Order " + first)).toBeVisible();
  await expect(retryVerification).toBeVisible();
  await retryVerification.focus();
  await page.keyboard.press("Enter");
  await expect(retryVerification).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("The code matches.", { exact: false })).toBeVisible();
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
    if (handoffRequest.fulfillmentReference === id(1)) firstHandedOver = true;
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
  await expect(dialog.getByText("Item 1: 2 to hand over")).toBeVisible();
  await expectNoInternalText(page);
  const recipientType = dialog.getByLabel("Collected by");
  await expect(recipientType).toBeFocused();
  await recipientType.press("T");
  await expect(recipientType).toHaveValue("Customer");
  await page.keyboard.press("Tab");
  const recipientMask = dialog.getByLabel("Collector’s initial");
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
  await expect(
    dialog.getByText("The handover could not be confirmed.", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close handoff confirmation" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  const retryHandoff = dialog.getByRole("button", { name: "Try confirming again" });
  await retryHandoff.focus();
  const readsBeforeHandoff = queries.length;
  await page.keyboard.press("Enter");
  // WP-2423: a recorded handover closes the dialog, re-reads the queue at once and says so.
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("status").filter({ hasText: `Order ${first} handed over.` }),
  ).toBeVisible();
  await expect(heading("Order " + first)).toHaveCount(0);
  expect(queries.length).toBeGreaterThan(readsBeforeHandoff);
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
  await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await orderSearch.fill("");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(heading("Order " + second)).toBeVisible();
  await expect(heading("Order " + first)).toHaveCount(0);
  await expect(refresh).toBeFocused();
  const openSecondProof = page.getByRole("button", {
    name: "Check pickup code",
    exact: true,
  });
  await openSecondProof.focus();
  await page.keyboard.press("Enter");
  const secondCredential = page.getByLabel("Pickup code", { exact: true });
  await secondCredential.fill("654321");
  await page.keyboard.press("Enter");
  await expect(page.getByText("The code matches.", { exact: false })).toBeVisible();
  expect(proofs).toHaveLength(4);
  const secondReview = page.getByRole("button", { name: "Review pickup handoff" });
  await secondReview.click();
  const rejectedDialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
  await rejectedDialog.getByLabel("Collected by").selectOption("Customer");
  await rejectedDialog.getByLabel("Collector’s initial").fill("D***");
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
  await expect(heading("No pickups waiting")).toBeVisible();
  const includeCompleted = page.getByRole("checkbox", { name: "Include completed pickups" });
  await includeCompleted.focus();
  await page.keyboard.press("Space");
  await expect(page.locator("article").getByText("Completed", { exact: false })).toBeVisible();
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
  await expect(heading("Order " + first)).toBeVisible();
  // Another Store's answer is a scope loss: the queue clears rather than going stale (IDR-0039).
  foreign = true;
  await refresh.click();
  await expect(heading("Permission denied")).toBeVisible();
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
  await expect(page.getByText("Order PICKUPSTORE00000000001", { exact: true })).toBeVisible();

  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption(storeTwo.storeReference);
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Store 2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Pickup", exact: true }).click();
  await expect(page.getByText("Order PICKUPSTORE00000000002", { exact: true })).toBeVisible();
  await expect(page.getByText("Order PICKUPSTORE00000000001", { exact: true })).toHaveCount(0);
  // The home page's "Right now" card also reads the pickup queue; the Store sequence is what matters.
  expect(readScopes.filter((scope, index) => scope !== readScopes[index - 1])).toEqual([
    storeOne.storeReference,
    storeTwo.storeReference,
  ]);
});

// IDR-0039 (Handoff §87.11.1): Pickup notices an outage on its own, keeps the last queue
// read-only with handoff paused, sends nothing while offline and recovers when the network returns.
test("@production Pickup goes read-only offline, sends nothing and recovers on its own", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
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
  let serverDown = false,
    reads = 0;
  await page.route("**/merchant/pickup/query", (route) => {
    reads++;
    if (serverDown) return route.abort("connectionrefused");
    const now = Date.now();
    return route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: scope.storeReference,
        observedAt: new Date(now).toISOString(),
        nextAfterFulfillmentReference: null,
        items: [
          {
            fulfillmentReference: id(1),
            orderReference: id(3),
            phase: "Ready",
            aggregateVersion: "7",
            readyAt: new Date(now - 70 * 60_000).toISOString(),
            publicOrderReference: "C".repeat(22),
            proof: {
              kind: "HumanCode",
              generation: 1,
              expiresAt: new Date(now - 10 * 60_000).toISOString(),
            },
            items: [
              {
                fulfillmentItemReference: id(4),
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
  const commands: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/merchant/pickup/") && path !== "/merchant/pickup/query")
      commands.push(path);
  });
  const handOver = page.getByRole("button", {
    name: "Hand over after checking in person",
    exact: true,
  });
  const notCollected = page.getByRole("button", { name: "Mark not collected", exact: true });
  const notice = page.getByRole("status").filter({ hasText: "Read-only until reconnected" });
  await page.goto("/operations/pickup");
  await expect(handOver).toBeEnabled();
  await expect(notCollected).toBeEnabled();

  // The pilot host stops answering while the device stays online: the 10 s re-read notices it.
  serverDown = true;
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("Connection lost — showing the last update from");
  await expect(handOver).toBeDisabled();
  serverDown = false;
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  await expect(handOver).toBeEnabled();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(handOver).toBeEnabled();
    // The device loses its network: read-only at once, without waiting for a read to fail.
    await context.setOffline(true);
    await expect(notice).toBeVisible({ timeout: 2_000 });
    await expect(notice).toContainText(
      /Offline — showing the last update from \d\d:\d\d.*\. Actions are paused until the connection returns\./u,
    );
    await expect(page.getByText(/^Data may be out of date/u)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Order " + "C".repeat(22) })).toBeVisible();
    await expect(handOver).toBeDisabled();
    await expect(notCollected).toBeDisabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${viewport.width}`,
    ).toBe(true);
    // Back online: it re-reads at once and returns to normal.
    const before = reads;
    await context.setOffline(false);
    await expect(notice).toHaveCount(0, { timeout: 5_000 });
    expect(reads).toBeGreaterThan(before);
    await expect(handOver).toBeEnabled();
    await expect(notCollected).toBeEnabled();
  }
  expect(commands).toEqual([]);
});

// WP-2423 (DEC-PICKUP-COUNTER-CODE): staff type the guest's six-digit code; a wrong code is said
// plainly and can be asked again; five wrong codes lock code checks and the order is handed over
// after an in-person check instead.
test("@production Pickup accepts the typed six-digit code, explains wrong codes and moves a locked order to the in-person check", async ({
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
  let locked = false,
    reads = 0;
  await page.route("**/merchant/pickup/query", (route) => {
    reads++;
    const observedAt = new Date().toISOString();
    return route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: scope.storeReference,
        observedAt,
        nextAfterFulfillmentReference: null,
        items: [
          {
            fulfillmentReference: id(1),
            orderReference: id(3),
            orderNumber: "9",
            phase: "Ready",
            aggregateVersion: "4",
            readyAt: new Date(Date.now() - 5 * 60_000).toISOString(),
            publicOrderReference: "A".repeat(22),
            proof: {
              kind: "Opaque",
              generation: 1,
              expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
            },
            ...(locked ? { codeChecksLocked: true } : {}),
            items: [
              {
                fulfillmentItemReference: id(4),
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
  // WP-2423: the in-person check shows the name and only the last four phone digits.
  const identityReads: Record<string, unknown>[] = [];
  await page.route("**/merchant/pickup/identity-check", (route) => {
    identityReads.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: { status: "Available", name: "Sam Lee", phoneLast4: "0123" },
    });
  });
  const sent: Record<string, unknown>[] = [];
  await page.route("**/merchant/pickup/proof", (route) => {
    sent.push(route.request().postDataJSON());
    if (sent.length >= 2) locked = true;
    return route.fulfill(
      sent.length === 1
        ? { status: 422, headers, json: { error: "PICKUP_PROOF_REJECTED" } }
        : { status: 423, headers, json: { error: "PICKUP_PROOF_LOCKED" } },
    );
  });
  await page.goto("/operations/pickup");
  await expect(page.getByRole("heading", { name: "Order 9", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check pickup code", exact: true }).click();
  await expect(
    page.getByText("Ask the customer to read the 6-digit pickup code", { exact: false }),
  ).toBeVisible();
  const code = page.getByLabel("Pickup code", { exact: true });
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute("type", "text");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  // Not a pickup code at all: nothing is sent.
  await code.fill("4821");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Pickup codes have 6 digits.", { exact: false })).toBeVisible();
  expect(sent).toHaveLength(0);
  // Typed with a space; sent as six digits. The server says it does not match.
  await code.fill("048 213");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("That code doesn't match this order.", { exact: false }),
  ).toBeVisible();
  await expect(code).toBeFocused();
  await expect(code).toHaveValue("");
  expect(sent[0]).toMatchObject({ kind: "HumanCode", credential: "048213" });
  await expectNoInternalText(page);
  // The fifth wrong code locks code checks: the queue re-reads and offers the in-person check.
  const readsBeforeLock = reads;
  await code.fill("048214");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Too many wrong codes · check in person")).toBeVisible();
  expect(reads).toBeGreaterThan(readsBeforeLock);
  // The reason stays said on the card after the queue re-reads, not the wrong-code text.
  await expect(
    page.getByText("Too many wrong codes for this order. Check the customer in person instead", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("That code doesn't match this order.", { exact: false })).toHaveCount(
    0,
  );
  // The pickup code value reads on one or two lines, never one word per line.
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const value = page.locator(".pickup-queue__card dl > div").first().locator("dd");
    const lines = await value.evaluate(
      (element) =>
        element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight),
    );
    expect(lines).toBeLessThan(2.5);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/pickup-locked-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("button", { name: "Hand over after checking in person" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Check pickup code", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Hand over after checking in person" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
  await expect(
    dialog.getByText("Too many wrong pickup codes were entered for this order", { exact: false }),
  ).toBeVisible();
  await expect(dialog.getByText("Sam Lee", { exact: true })).toBeVisible();
  await expect(dialog.getByText("0123", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("definition").filter({ hasText: "0123" })).toHaveText("•••• 0123");
  expect(identityReads).toEqual([
    { orderReference: id(3), storeReference: scope.storeReference, fulfillmentReference: id(1) },
  ]);
  await page.screenshot({ path: "test-results/pickup-in-person-check-1440.png", fullPage: true });
  await expectNoInternalText(page);
  // The code never reaches browser storage or the address bar.
  expect(page.url()).not.toContain("048213");
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});
