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
              name: "Latte",
              options: [{ name: "Oat milk", quantity: 1 }],
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
  await expect(heading("No matching pickups")).toBeVisible();
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
  await expect(heading("No matching pickups")).toBeVisible();
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
  await expect(dialog.getByText("Latte (Oat milk): 2 to hand over")).toBeVisible();
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
  await expect(heading("No access")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
  await expect(refresh).toBeFocused();
  denied = false;
  await page.keyboard.press("Enter");
  await expect(heading("Order " + first)).toBeVisible();
  // Another Store's answer is a scope loss: the queue clears rather than going stale (IDR-0039).
  foreign = true;
  await refresh.click();
  await expect(heading("No access")).toBeVisible();
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
  await expect(
    page.getByRole("heading", { name: "Order PICKUPSTORE00000000001", exact: true }),
  ).toBeVisible();

  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption(storeTwo.storeReference);
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Store 2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Pickup", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Order PICKUPSTORE00000000002", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Order PICKUPSTORE00000000001", exact: true }),
  ).toHaveCount(0);
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

// WP-2423: an order staff took at the counter gets no guest pickup code. Its card says so and
// offers the in-person handover at once (call the order number); a guest's QR order on the same
// queue keeps the pickup code check.
test("@production Pickup hands a counter order over in person at once while a guest order keeps its code check", async ({
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
  let counterHandedOver = false;
  const line = (n: number) => ({
    fulfillmentItemReference: id(n),
    orderedQuantity: 1,
    readyQuantity: 1,
    handedOverQuantity: 0,
  });
  await page.route("**/merchant/pickup/query", (route) =>
    route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: scope.storeReference,
        observedAt: new Date().toISOString(),
        nextAfterFulfillmentReference: null,
        items: [
          ...(counterHandedOver
            ? []
            : [
                {
                  fulfillmentReference: id(1),
                  orderReference: id(3),
                  orderNumber: "7",
                  phase: "Ready",
                  aggregateVersion: "3",
                  readyAt: new Date(Date.now() - 60_000).toISOString(),
                  publicOrderReference: null,
                  proof: null,
                  takenAtCounter: true,
                  items: [line(4)],
                },
              ]),
          {
            fulfillmentReference: id(5),
            orderReference: id(6),
            orderNumber: "8",
            phase: "Ready",
            aggregateVersion: "3",
            readyAt: new Date(Date.now() - 60_000).toISOString(),
            publicOrderReference: "A".repeat(22),
            proof: {
              kind: "Opaque",
              generation: 1,
              expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
            },
            takenAtCounter: false,
            items: [line(7)],
          },
        ],
      },
    }),
  );
  const identityReads: unknown[] = [];
  await page.route("**/merchant/pickup/identity-check", (route) => {
    identityReads.push(route.request().postDataJSON());
    return route.fulfill({ headers, json: { status: "NotGiven" } });
  });
  const handoffs: Record<string, unknown>[] = [];
  await page.route("**/merchant/pickup/handoff", (route) => {
    const request = route.request().postDataJSON();
    handoffs.push(request);
    counterHandedOver = true;
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        handoffReference: id(12),
        fulfillmentReference: request.fulfillmentReference,
        nextAggregateVersion: "4",
        nextPhase: "Completed",
      },
    });
  });
  await page.goto("/operations/pickup");
  const counterCard = page
    .locator(".pickup-queue__card")
    .filter({ has: page.getByRole("heading", { name: "Order 7", exact: true }) });
  const guestCard = page
    .locator(".pickup-queue__card")
    .filter({ has: page.getByRole("heading", { name: "Order 8", exact: true }) });
  await expect(counterCard).toBeVisible();
  await expect(
    counterCard.getByText("Taken at the counter — call the order number and hand it over."),
  ).toBeVisible();
  await expect(counterCard.getByText("Not needed · taken at the counter")).toBeVisible();
  await expect(counterCard.getByRole("button", { name: "Check pickup code" })).toHaveCount(0);
  await expect(counterCard.getByRole("button", { name: "Hand over", exact: true })).toBeEnabled();
  // The guest's order keeps its pickup code check.
  await expect(guestCard.getByRole("button", { name: "Check pickup code" })).toBeVisible();
  await expect(guestCard.getByText("Taken at the counter", { exact: false })).toHaveCount(0);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    await page.screenshot({
      path: `test-results/pickup-counter-order-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);

  await counterCard.getByRole("button", { name: "Hand over", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
  await expect(
    dialog.getByText("This order was taken at the counter, so no pickup code was sent.", {
      exact: false,
    }),
  ).toBeVisible();
  // A walk-up guest left no contact: nothing is looked up for them.
  expect(identityReads).toEqual([]);
  await dialog
    .getByLabel("Checked in person")
    .selectOption({ label: "Order number called at the counter" });
  await dialog.getByLabel("Collected by").selectOption("Customer");
  await dialog.getByLabel("Collector’s initial").fill("S***");
  await dialog.getByLabel("I matched this order", { exact: false }).check();
  await dialog.getByRole("button", { name: "Confirm and record handoff" }).click();
  await expect(page.getByText("Order 7 handed over.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Order 7", exact: true })).toHaveCount(0);
  expect(handoffs).toHaveLength(1);
  expect(handoffs[0]).toMatchObject({
    orderReference: id(3),
    fulfillmentReference: id(1),
    identityCheck: "OrderNumberAndName",
    recipientType: "Customer",
  });
  expect(handoffs[0]).not.toHaveProperty("verificationReference");
  await expectNoInternalText(page);
});

test("@production Pickup hands over a guest who can't show a still-valid code after staff say why and check in person", async ({
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
  let handedOver = false;
  const order = (n: number, fulfillment: number, orderReference: number) => ({
    fulfillmentReference: id(fulfillment),
    orderReference: id(orderReference),
    orderNumber: String(n),
    phase: "Ready",
    aggregateVersion: "3",
    readyAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    publicOrderReference: null,
    proof: {
      kind: "HumanCode",
      generation: 1,
      expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
    },
    items: [
      {
        fulfillmentItemReference: id(fulfillment + 100),
        orderedQuantity: 1,
        readyQuantity: 1,
        handedOverQuantity: 0,
      },
    ],
  });
  await page.route("**/merchant/pickup/query", (route) =>
    route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: scope.storeReference,
        observedAt: new Date().toISOString(),
        nextAfterFulfillmentReference: null,
        items: [...(handedOver ? [] : [order(9, 1, 3)]), order(10, 5, 6)],
      },
    }),
  );
  const identityReads: Record<string, unknown>[] = [];
  await page.route("**/merchant/pickup/identity-check", (route) => {
    identityReads.push(route.request().postDataJSON());
    return route.fulfill({
      headers,
      json: { status: "Available", name: "Sam Lee", phoneLast4: "0123" },
    });
  });
  const proofChecks: unknown[] = [];
  await page.route("**/merchant/pickup/proof", (route) => {
    proofChecks.push(route.request().postDataJSON());
    return route.fulfill({ status: 500, headers, json: {} });
  });
  const handoffs: Record<string, unknown>[] = [];
  let refuseNext = true;
  await page.route("**/merchant/pickup/handoff", (route) => {
    const request = route.request().postDataJSON();
    handoffs.push(request);
    // The first try meets a code that locked or expired meanwhile: refused, staff refresh.
    if (refuseNext) {
      refuseNext = false;
      return route.fulfill({
        status: 422,
        headers,
        json: { error: "PICKUP_HANDOFF_VERIFICATION_FAILED" },
      });
    }
    handedOver = true;
    return route.fulfill({
      headers,
      json: {
        status: "Applied",
        handoffReference: id(12),
        fulfillmentReference: request.fulfillmentReference,
        nextAggregateVersion: "4",
        nextPhase: "Completed",
      },
    });
  });
  await page.goto("/operations/pickup");
  const card = page
    .locator(".pickup-queue__card")
    .filter({ has: page.getByRole("heading", { name: "Order 9", exact: true }) });
  await expect(card).toBeVisible();
  await expect(card.getByText("Sent to customer")).toBeVisible();
  // The code check stays the main action; the fallback is a quieter, deliberate one beside it.
  const codeCheck = card.getByRole("button", { name: "Check pickup code" });
  const noCode = card.getByRole("button", { name: "Guest can’t show the code" });
  await expect(codeCheck).toBeVisible();
  await expect(noCode).toBeEnabled();
  expect(await noCode.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe(
    "underline",
  );
  expect(
    await codeCheck.evaluate((element) => getComputedStyle(element).textDecorationLine),
  ).not.toBe("underline");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `no horizontal overflow at ${width}`,
    ).toBe(true);
    const box = await noCode.boundingBox();
    expect(box?.height ?? 0, `touch target at ${width}`).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);

  const attempt = async (cause: string) => {
    await noCode.click();
    const dialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
    await expect(
      dialog.getByText("The customer's pickup code is still valid.", { exact: false }),
    ).toBeVisible();
    // Nothing personal is read until staff say why the code can't be shown.
    await expect(
      dialog.getByText("Choose why first. The name and phone on the order then show here."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Confirm and record handoff" })).toBeDisabled();
    const readsBefore = identityReads.length;
    await dialog.getByLabel("Why the code can't be shown").selectOption({ label: cause });
    await expect(dialog.getByText("Sam Lee")).toBeVisible();
    expect(identityReads.length).toBe(readsBefore + 1);
    await dialog
      .getByLabel("Checked in person")
      .selectOption({ label: "Order number and last four digits of the phone" });
    await dialog.getByLabel("Collected by").selectOption("Customer");
    await dialog.getByLabel("Collector’s initial").fill("S***");
    await dialog.getByLabel("I matched this order", { exact: false }).check();
    return dialog;
  };
  const first = await attempt("Phone is dead, lost or left behind");
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.screenshot({ path: `test-results/pickup-code-not-shown-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoInternalText(page);
  await first.getByRole("button", { name: "Confirm and record handoff" }).click();
  await expect(
    first.getByText(
      "Handoff was not confirmed. Close and refresh the queue before another attempt.",
    ),
  ).toBeVisible();
  await first.getByRole("button", { name: "Close handoff confirmation" }).click();
  await page.reload();

  const second = await attempt("Order page was closed or lost");
  await second.getByRole("button", { name: "Confirm and record handoff" }).click();
  await expect(page.getByText("Order 9 handed over.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Order 9", exact: true })).toHaveCount(0);
  // The other guest's order keeps its code check, and no pickup code was ever tried.
  await expect(
    page
      .locator(".pickup-queue__card")
      .filter({ has: page.getByRole("heading", { name: "Order 10", exact: true }) })
      .getByRole("button", { name: "Check pickup code" }),
  ).toBeVisible();
  expect(proofChecks).toEqual([]);
  expect(identityReads).toEqual([
    {
      orderReference: id(3),
      storeReference: id(99),
      fulfillmentReference: id(1),
      codeNotShownCause: "PhoneUnavailable",
    },
    {
      orderReference: id(3),
      storeReference: id(99),
      fulfillmentReference: id(1),
      codeNotShownCause: "OrderPageLost",
    },
  ]);
  expect(handoffs).toHaveLength(2);
  expect(handoffs[0]).toMatchObject({
    orderReference: id(3),
    fulfillmentReference: id(1),
    identityCheck: "OrderNumberAndPhoneLast4",
    codeNotShownCause: "PhoneUnavailable",
  });
  expect(handoffs[1]).toMatchObject({ codeNotShownCause: "OrderPageLost" });
  // A new attempt after the refusal is a new request, never a replay of the refused one.
  expect(handoffs[1]?.idempotencyReference).not.toBe(handoffs[0]?.idempotencyReference);
  for (const handoff of handoffs) expect(handoff).not.toHaveProperty("verificationReference");
  await expectNoInternalText(page);
});

// WP-2423: closing an uncollected order re-reads the queue at once (like a handover), so the card
// leaves without waiting for the 10 s re-read; a remake still being made is said before closing.
test("@production Pickup removes an order closed as not collected at once and says its remake is cancelled", async ({
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
  let closed = false;
  await page.route("**/merchant/pickup/query", (route) => {
    const now = Date.now();
    return route.fulfill({
      headers,
      json: {
        source: "CurrentFulfillment",
        workstation: { deviceReference: id(10), pickupLocationReference: id(11) },
        storeReference: scope.storeReference,
        observedAt: new Date(now).toISOString(),
        nextAfterFulfillmentReference: null,
        items: closed
          ? []
          : [
              {
                fulfillmentReference: id(1),
                orderReference: id(3),
                phase: "Ready",
                aggregateVersion: "7",
                readyAt: new Date(now - 70 * 60_000).toISOString(),
                publicOrderReference: "D".repeat(22),
                orderNumber: "42",
                remakeInProgress: 2,
                proof: {
                  kind: "HumanCode",
                  generation: 1,
                  expiresAt: new Date(now - 10 * 60_000).toISOString(),
                },
                items: [
                  {
                    fulfillmentItemReference: id(4),
                    orderedQuantity: 2,
                    readyQuantity: 2,
                    handedOverQuantity: 0,
                  },
                ],
              },
            ],
      },
    });
  });
  const sent: unknown[] = [];
  await page.route("**/merchant/pickup/not-collected", async (route) => {
    sent.push(route.request().postDataJSON());
    closed = true;
    await route.fulfill({
      headers,
      json: { status: "Applied", fulfillmentReference: id(1), closedAt: new Date().toISOString() },
    });
  });
  await page.goto("/operations/pickup");
  const card = page.getByRole("heading", { name: "Order 42" });
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "Mark not collected", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "The kitchen is still remaking 2 items for this order. Closing it also cancels the remake and takes it off the Kitchen screen. Tell the kitchen to stop making it.",
  );
  await expectNoInternalText(page);
  await dialog.getByLabel("I checked the pickup shelf and nobody collected this order").check();
  const started = Date.now();
  await dialog.getByRole("button", { name: "Close as not collected", exact: true }).click();
  // Well under the 10 s re-read: the queue is read again as soon as the server answers.
  await expect(card).toHaveCount(0, { timeout: 2_000 });
  expect(Date.now() - started).toBeLessThan(2_000);
  await expect(
    page.getByRole("status").filter({ hasText: "Order 42 closed as not collected." }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(sent).toHaveLength(1);
});
