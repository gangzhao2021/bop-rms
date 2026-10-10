import { expect, test } from "@playwright/test";

test("@production current queue pages and clears old orders after denied refresh", async ({
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
  let deny = false;
  const row = (n: number) => ({
    orderReference: id(n),
    orderNumber: "ORD-" + n,
    orderType: "Pickup",
    sourceChannel: "Web",
    submittedAt: "2026-09-14T00:00:00.000Z",
    observedAt: "2026-09-14T00:01:00.000Z",
    initialBatchReference: id(90),
    batches: [
      {
        orderBatchReference: id(90),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Accepted",
    currentVersion: 2,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  await page.route("**/merchant/orders*", (route) => {
    expect(route.request().method()).toBe("GET");
    const after = new URL(route.request().url()).searchParams.get("after");
    return route.fulfill(
      deny
        ? { headers, status: 403, json: { error: "request_denied" } }
        : {
            headers,
            json:
              // WP-2423: newest first; the next page continues with older Orders.
              after === null
                ? {
                    items: Array.from({ length: 50 }, (_, i) => row(100 - i)),
                    nextAfterOrderReference: id(51),
                  }
                : { items: [row(50)], nextAfterOrderReference: null },
          },
    );
  });
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "ORD-100", exact: true })).toBeVisible();
  const orderRows = page.locator("details.order-workbench-entry");
  const visibleOrderRows = page.locator("details.order-workbench-entry:visible");
  await expect(visibleOrderRows).toHaveCount(50);
  await expect(page.getByText("Showing 50 of 50 orders on this page.")).toBeVisible();
  await page.getByRole("searchbox", { name: "Exact order number" }).fill("ORD-100");
  await expect(visibleOrderRows).toHaveCount(1);
  await expect(orderRows.first()).toContainText("ORD-100");
  await expect(orderRows.first()).toHaveAttribute("open", "");
  await page.getByRole("combobox", { name: "Order type" }).selectOption("DineIn");
  await expect(page.getByRole("heading", { name: "No orders match these filters" })).toBeVisible();
  await expect(visibleOrderRows).toHaveCount(0);
  await page.getByRole("button", { name: "Clear order filters" }).click();
  await expect(visibleOrderRows).toHaveCount(50);
  await page.getByRole("combobox", { name: "Channel" }).selectOption("Web");
  await page.getByRole("combobox", { name: "Order status" }).selectOption("InProgress");
  await expect(page.getByRole("heading", { name: "No orders match these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear order filters" }).click();
  await expect(visibleOrderRows).toHaveCount(50);
  const firstOrder = page.locator("details.order-workbench-entry").first();
  await expect(firstOrder.locator(".order-workbench-detail")).toBeHidden();
  await firstOrder.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(firstOrder.locator(".order-workbench-detail")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(firstOrder.locator(".order-workbench-detail")).toBeHidden();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(firstOrder).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/order-make-alignment-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Next page", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "ORD-50", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ORD-100", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh orders" })).toBeFocused();
  deny = true;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Permission denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ORD-50", exact: true })).toHaveCount(0);
  deny = false;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "ORD-100", exact: true })).toBeVisible();
});

test("@production acceptance retries the same operation after a lost response", async ({
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

  let committed = false;
  const bodies: string[] = [];
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(1),
            orderNumber: "ORD-1",
            orderType: "DineIn",
            sourceChannel: "Web",
            submittedAt: "2026-09-14T00:00:00.000Z",
            observedAt: "2026-09-14T00:01:00.000Z",
            initialBatchReference: id(90),
            batches: [
              {
                orderBatchReference: id(90),
                sequence: 1,
                acceptanceStatus: "Accepted",
                canRequestAcceptance: false,
              },
              {
                orderBatchReference: id(91),
                sequence: 2,
                acceptanceStatus: committed ? "Accepted" : "NotAccepted",
                canRequestAcceptance: !committed,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Accepted",
            currentVersion: committed ? 4 : 3,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.route("**/merchant/orders/accept", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    bodies.push(route.request().postData() ?? "");
    committed = true;
    if (bodies.length === 1) return route.abort("failed");
    return route.fulfill({
      headers,
      json: { status: "AlreadyCommitted", acceptedOrderVersion: 4 },
    });
  });
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "Accept ORD-1 · batch 2", exact: true }).click();
  await expect(
    page.getByText("Acceptance could not be confirmed.", { exact: false }),
  ).toBeVisible();
  const searchOrder = page.getByRole("searchbox", { name: "Exact order number" });
  await searchOrder.fill("ORD-2");
  await expect(page.locator("details.order-workbench-entry").first()).toHaveAttribute("hidden", "");
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · batch 2", exact: true }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Clear order filters" }).click();
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · batch 2", exact: true }),
  ).toBeVisible();
  const disclosure = page.locator("details.order-workbench-entry > summary");
  await disclosure.click();
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · batch 2", exact: true }),
  ).toBeHidden();
  await disclosure.click();
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · batch 2", exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(1);
  await expect(
    page
      .getByRole("region", { name: "Batch 2" })
      .getByText("Acceptance: Not accepted", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry acceptance for ORD-1 · batch 2", exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Batch 2" })
      .getByText("Acceptance: Accepted", { exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
    orderBatchReference: id(91),
    expectedOrderVersion: 3,
  });
  expect(bodies[1]).toBe(bodies[0]);
  expect(Object.keys(JSON.parse(bodies[0] ?? "{}")).sort()).toEqual([
    "acceptanceReference",
    "expectedOrderVersion",
    "operationReference",
    "orderBatchReference",
    "orderReference",
  ]);
  await expect(
    page.getByRole("button", { name: "Accept ORD-1 · batch 2", exact: true }),
  ).toHaveCount(0);
});

test("@production refresh after rejected acceptance uses current order version", async ({
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

  let committed = false;
  let version = 3;
  const bodies: string[] = [];
  await page.route("**/merchant/orders", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: id(1),
            orderNumber: "ORD-1",
            orderType: "DineIn",
            sourceChannel: "Web",
            submittedAt: "2026-09-14T00:00:00.000Z",
            observedAt: "2026-09-14T00:01:00.000Z",
            initialBatchReference: id(90),
            batches: [
              {
                orderBatchReference: id(90),
                sequence: 1,
                acceptanceStatus: "Accepted",
                canRequestAcceptance: false,
              },
              {
                orderBatchReference: id(91),
                sequence: 2,
                acceptanceStatus: committed ? "Accepted" : "NotAccepted",
                canRequestAcceptance: !committed,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Accepted",
            currentVersion: version,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.route("**/merchant/orders/accept", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    bodies.push(route.request().postData() ?? "");
    if (bodies.length === 1) {
      version = 4;
      return route.fulfill({ headers, status: 403, json: { error: "request_denied" } });
    }
    committed = true;
    version = 5;
    return route.fulfill({ headers, json: { status: "Created", acceptedOrderVersion: 5 } });
  });
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "Accept ORD-1 · batch 2", exact: true }).click();
  await expect(page.getByText("Acceptance was not confirmed.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Refresh orders", exact: true }).click();
  await page.getByRole("button", { name: "Accept ORD-1 · batch 2", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Batch 2" })
      .getByText("Acceptance: Accepted", { exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  const first = JSON.parse(bodies[0] ?? "{}"),
    second = JSON.parse(bodies[1] ?? "{}");
  expect(first.expectedOrderVersion).toBe(3);
  expect(second.expectedOrderVersion).toBe(4);
  expect(second.operationReference).not.toBe(first.operationReference);
});

test("@production Orders reloads the current page after an authorized Store switch", async ({
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
  if (!storeOne || !storeTwo) throw new Error("Orders Store-switch fixtures are incomplete");
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
  await page.route("**/merchant/orders*", (route) => {
    expect(route.request().method()).toBe("GET");
    expect(route.request().headers()["x-bop-csrf"]).toBeUndefined();
    const requestUrl = new URL(route.request().url());
    expect(requestUrl.searchParams.has("store")).toBe(false);
    expect(requestUrl.searchParams.has("storeReference")).toBe(false);
    expect(route.request().postData()).toBeNull();
    readScopes.push(stores[selected]?.storeReference ?? "missing-store");
    const orderNumber = selected === 0 ? "STORE-ONE-ORDER" : "STORE-TWO-ORDER";
    const reference = id(10 + selected);
    return route.fulfill({
      headers,
      json: {
        items: [
          {
            orderReference: reference,
            orderNumber,
            orderType: "Pickup",
            sourceChannel: "Web",
            submittedAt: "2026-09-26T12:00:00.000Z",
            observedAt: "2026-09-26T12:01:00.000Z",
            initialBatchReference: id(20 + selected),
            batches: [
              {
                orderBatchReference: id(20 + selected),
                sequence: 1,
                acceptanceStatus: "Accepted",
                canRequestAcceptance: false,
              },
            ],
            canRequestAcceptance: false,
            currentPhase: "Accepted",
            currentVersion: 2,
            unfulfillable: null,
            pickupNotCollected: false,
            acceptBy: null,
            awaitingPayment: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    });
  });

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Store 1", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Orders", exact: true }).click();
  await expect(page.getByRole("heading", { name: "STORE-ONE-ORDER", exact: true })).toBeVisible();

  await page.goto("/app");
  await page.getByLabel("Authorized Store").selectOption(storeTwo.storeReference);
  await page.getByRole("button", { name: "Switch Store", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Store 2", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Orders", exact: true }).click();
  await expect(page.getByRole("heading", { name: "STORE-TWO-ORDER", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "STORE-ONE-ORDER", exact: true })).toHaveCount(0);
  // The home page's "Right now" card also reads the queue; the Store sequence is what matters.
  expect(readScopes.filter((scope, index) => scope !== readScopes[index - 1])).toEqual([
    storeOne.storeReference,
    storeTwo.storeReference,
  ]);
});

test("@production WP-2423 Q1: new orders and acceptance deadlines surface without a refresh tap", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
  };
  const headers = { "cache-control": "no-store" };
  await page.clock.install({ time: new Date("2026-10-10T12:00:00.000Z") });
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
          businessDate: "2026-10-10",
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
  let mode: "empty" | "waiting" | "down" = "empty";
  const waiting = {
    orderReference: id(21),
    orderNumber: "ORD-21",
    orderType: "Pickup",
    sourceChannel: "Qr",
    submittedAt: "2026-10-10T11:59:00.000Z",
    observedAt: "2026-10-10T12:00:00.000Z",
    initialBatchReference: id(92),
    batches: [
      {
        orderBatchReference: id(92),
        sequence: 1,
        acceptanceStatus: "NotAccepted",
        canRequestAcceptance: true,
      },
    ],
    canRequestAcceptance: true,
    currentPhase: "Submitted",
    currentVersion: 1,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: "2026-10-10T12:08:00.000Z",
    awaitingPayment: false,
  };
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill(
      mode === "down"
        ? { headers, status: 503, json: { error: "order_queue_unavailable" } }
        : {
            headers,
            json: { items: mode === "empty" ? [] : [waiting], nextAfterOrderReference: null },
          },
    ),
  );
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "No orders on this page" })).toBeVisible();
  mode = "waiting";
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("heading", { name: "ORD-21", exact: true })).toBeVisible();
  await expect(page.getByText("1 order is waiting to be accepted.")).toBeVisible();
  await expect(page.locator(".order-accept-by")).toHaveText("Accept within 8 min");
  await expect(page.locator(".order-accept-by")).toHaveAttribute("data-tier", "warning");
  expect(await page.title()).toMatch(/^\(1\) /u);
  await page.clock.fastForward(240_000);
  await expect(page.locator(".order-accept-by")).toHaveText("Accept within 4 min");
  await expect(page.locator(".order-accept-by")).toHaveAttribute("data-tier", "urgent");
  mode = "down";
  await page.clock.fastForward(10_000);
  await expect(
    page.getByText("Orders could not be refreshed. Showing the last update"),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "ORD-21", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sound off" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});
