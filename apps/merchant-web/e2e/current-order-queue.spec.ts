import { expect, test } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { chooseOrderFilter, openOrder, orderPanel } from "./order-queue-helpers";

test("@production current queue pages and clears old orders after denied refresh", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
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
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Accepted",
    currentVersion: 2,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    // WP-2423: what the customer paid online (Payment's read), shown like a card-machine payment.
    paidOnline: { amountMinor: "1130", currencyCode: "CAD" },
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
  // Owner 2026-10-25: a status tag's words are dark in every tone; the dot carries the tone.
  await expect(page.locator(".order-workbench-phase").first()).toHaveCSS(
    "color",
    "rgb(23, 23, 23)",
  );
  const orderRows = page.locator("li.order-row");
  const visibleOrderRows = page.locator("li.order-row:visible");
  await expect(visibleOrderRows).toHaveCount(50);
  // v15 751dd768: the count in plain words, with where older orders are.
  await expect(
    page.getByText("50 orders, newest first. Older orders are on the next page."),
  ).toBeVisible();
  await expectNoInternalText(page);
  await page.getByRole("searchbox", { name: "Exact order number" }).fill("ORD-100");
  await expect(visibleOrderRows).toHaveCount(1);
  await expect(
    page.getByText("1 of 50 orders on this page match. Other pages are not searched."),
  ).toBeVisible();
  await expect(orderRows.first()).toContainText("ORD-100");
  // Orders v2: the one match opens in the side panel.
  await expect(orderRows.first()).toHaveAttribute("data-open", "true");
  // WP-2423: an online order's row shows the amount; the panel says it was paid online, with
  // store-time dates in words (the guard also refuses machine dates such as 2026-09-13 20:00).
  await expect(orderRows.first().locator(".order-workbench-amount")).toHaveText("$11.30");
  await expect(orderPanel(page)).toContainText("PaymentPaid online $11.30");
  await expect(orderPanel(page)).toContainText(/Sun, Sep 13 20:00/u);
  await expectNoInternalText(page);
  await chooseOrderFilter(page, "Order type", "Dine-in");
  await expect(page.getByRole("heading", { name: "No orders match these filters" })).toBeVisible();
  await expect(visibleOrderRows).toHaveCount(0);
  await page.getByRole("button", { name: "Clear order filters" }).click();
  await expect(visibleOrderRows).toHaveCount(50);
  await chooseOrderFilter(page, "Channel", "Online");
  await page
    .getByRole("group", { name: "Show orders" })
    .getByRole("button", { name: /^In progress/u })
    .click();
  await expect(page.getByRole("heading", { name: "No orders match these filters" })).toBeVisible();
  await page.getByRole("button", { name: "Clear order filters" }).click();
  await expect(visibleOrderRows).toHaveCount(50);
  const firstOrder = page.locator("li.order-row").first();
  await expect(orderPanel(page)).toBeHidden();
  // Orders v2: Enter opens the order in the panel and moves to its heading; Escape closes it and
  // returns to the order's row.
  await firstOrder.locator(".order-row__open").focus();
  await page.keyboard.press("Enter");
  await expect(orderPanel(page)).toBeVisible();
  await expect(orderPanel(page).getByRole("heading", { name: "Order ORD-100" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(orderPanel(page)).toBeHidden();
  await expect(firstOrder.locator(".order-row__open")).toBeFocused();
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
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
              {
                orderBatchReference: id(91),
                sequence: 2,
                acceptanceStatus: committed ? "Accepted" : "NotAccepted",
                canRequestAcceptance: !committed,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
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
  await page.getByRole("button", { name: "Accept ORD-1 · round 2", exact: true }).first().click();
  await expect(
    page.getByText("Acceptance could not be confirmed.", { exact: false }),
  ).toBeVisible();
  const searchOrder = page.getByRole("searchbox", { name: "Exact order number" });
  await searchOrder.fill("ORD-2");
  await expect(page.locator("li.order-row").first()).toHaveAttribute("hidden", "");
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · round 2", exact: true }).first(),
  ).toBeHidden();
  await page.getByRole("button", { name: "Clear order filters" }).click();
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · round 2", exact: true }).first(),
  ).toBeVisible();
  // Orders v2: opening the order moves its Accept into the panel and closing it brings it back to
  // the row; either way the pending retry is kept.
  await openOrder(page, "ORD-1");
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · round 2", exact: true }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Retry acceptance for ORD-1 · round 2", exact: true }).first(),
  ).toBeVisible();
  expect(bodies).toHaveLength(1);
  await openOrder(page, "ORD-1");
  await expect(
    page
      .getByRole("region", { name: "Round 2" })
      .getByText("Acceptance: Not accepted", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry acceptance for ORD-1 · round 2", exact: true })
    .first()
    .click();
  // Orders v3: an accepted round no longer says it waits for acceptance.
  await expect(
    page
      .getByRole("region", { name: "Round 2" })
      .getByText("Acceptance: Not accepted", { exact: true }),
  ).toHaveCount(0);
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
    page.getByRole("button", { name: "Accept ORD-1 · round 2", exact: true }).first(),
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
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
              },
              {
                orderBatchReference: id(91),
                sequence: 2,
                acceptanceStatus: committed ? "Accepted" : "NotAccepted",
                canRequestAcceptance: !committed,
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
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
  await page.getByRole("button", { name: "Accept ORD-1 · round 2", exact: true }).first().click();
  await expect(page.getByText("Acceptance was not confirmed.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Refresh orders", exact: true }).click();
  await page.getByRole("button", { name: "Accept ORD-1 · round 2", exact: true }).first().click();
  // Orders v3: an accepted round no longer says it waits for acceptance.
  await expect(
    page
      .getByRole("region", { name: "Round 2" })
      .getByText("Acceptance: Not accepted", { exact: true }),
  ).toHaveCount(0);
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
                canCancel: false,
                staffCancellation: null,
                canCancelItems: false,
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
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
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
  await expect(page.getByRole("heading", { name: "No orders yet" })).toBeVisible();
  mode = "waiting";
  await page.clock.fastForward(10_000);
  await expect(page.getByRole("heading", { name: "ORD-21", exact: true })).toBeVisible();
  // Orders v2: the header's one line says how many wait to be accepted.
  await expect(page.locator(".workspace-page__meta")).toContainText("1 to accept");
  // DEC-ORDER-CHANNEL-LABEL: a pickup order placed from the customer start page (recorded Qr) is
  // listed as online, never as a table QR code.
  await expect(page.locator("li.order-row").first()).toContainText("Pickup · Online");
  await expect(page.locator("li.order-row").first()).not.toContainText("QR code");
  const deadline = page.locator("li.order-row .order-accept-by");
  await expect(deadline).toHaveText("Accept within 8 min");
  await expect(deadline).toHaveAttribute("data-tier", "warning");
  expect(await page.title()).toMatch(/^\(1\) /u);
  await page.clock.fastForward(240_000);
  await expect(deadline).toHaveText("Accept within 4 min");
  await expect(deadline).toHaveAttribute("data-tier", "urgent");
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

test("@production WP-2423 v15: earlier-day orders still holding stock are listed first, with what to do, and an ended one's stock is released", async ({
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
          selectedScope: { ...scope, timeZone: "America/Toronto" },
          authorizedStores: [scope],
          businessDate: "2026-10-16",
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
  const order = (n: number, number: string, state: "Open" | "Ended", phase: string) => ({
    orderReference: id(n),
    orderNumber: number,
    orderType: "Pickup",
    sourceChannel: "Qr",
    businessDate: "2026-10-10",
    listedBusinessDate: "2026-10-16",
    heldStock: {
      since: "2026-10-10T21:33:01.258Z",
      state,
      orderBatchReference: id(n + 100),
      productionStarted: false,
    },
    submittedAt: "2026-10-10T21:33:01.000Z",
    observedAt: "2026-10-16T06:00:00.000Z",
    initialBatchReference: id(n + 100),
    batches: [
      {
        orderBatchReference: id(n + 100),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: state === "Open",
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: phase,
    currentVersion: 2,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  // v15 (2026-10-16): a full page of today's and yesterday's orders with a next page, as on v15
  // where 50 page rows plus 18 earlier-day rows blanked the whole Orders page.
  const pageOrder = (i: number) => ({
    ...order(400 - i, "B-" + (i + 1), "Open", "Accepted"),
    businessDate: "2026-10-15",
    listedBusinessDate: "2026-10-15",
    heldStock: null,
  });
  const fullPage = Array.from({ length: 50 }, (_, i) => pageOrder(i));
  let ended = true;
  let shape: "current" | "older" = "current";
  const releases: unknown[] = [];
  await page.route("**/merchant/orders?*", (route) => route.fallback());
  await page.route("**/merchant/orders", (route) => {
    const earlier = [
      order(1, "2", "Open", "Accepted"),
      ...(ended ? [order(2, "7", "Ended", "Cancelled")] : []),
    ];
    return route.fulfill({
      headers,
      json:
        shape === "current"
          ? { earlierDayItems: earlier, items: fullPage, nextAfterOrderReference: id(351) }
          : // An older server mixed them in one list (the captured v15 answer's shape).
            { items: [...earlier, ...fullPage], nextAfterOrderReference: id(351) },
    });
  });
  await page.route("**/merchant/orders/release-stock", (route) => {
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    releases.push(route.request().postDataJSON());
    ended = false;
    return route.fulfill({ headers, json: { status: "Released" } });
  });
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "Earlier days · not finished" })).toBeVisible();
  // Orders v2 (Owner 2026-10-26): one "Needs attention" notice says it in staff words, with a way
  // to each order; the rows say it in a few words.
  const attention = page.getByRole("region", { name: "Needs attention" });
  await expect(
    // Orders v3: an earlier day's order carries its date with its number ("10/10 · 2").
    attention.getByText("Order 10/10 · 2 isn't finished and still holds its ingredients."),
  ).toBeVisible();
  await expect(page.locator("li.order-row").getByText("Still holds its ingredients")).toBeVisible();
  await expect(
    page.locator("li.order-row").getByText("Finished · ingredients still set aside"),
  ).toBeVisible();
  await attention.getByRole("button", { name: "Show order 10/10 · 2" }).click();
  await expect(
    // One short sentence beside the action, not the long notice again.
    orderPanel(page).getByText("If the guest doesn't come back, cancel it", { exact: false }),
  ).toBeVisible();
  await expect(orderPanel(page).getByRole("button", { name: "Cancel order" })).toBeVisible();
  await openOrder(page, "10/10 · 7");
  await expect(
    orderPanel(page).getByText("It is finished; release its ingredients below."),
  ).toBeVisible();
  await expectNoInternalText(page);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/orders-held-stock-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // The page itself is intact: its orders and the next page are there (yesterday's orders are
  // under Filter › Date › All days; Orders opens on today, Owner 2026-10-25).
  await chooseOrderFilter(page, "Date", "All days");
  await expect(page.getByRole("heading", { name: /B-50$/u })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toBeVisible();
  await page.getByRole("button", { name: "Release held ingredients" }).click();
  await expect(page.getByText("It is finished; release its ingredients below.")).toHaveCount(0);
  // Staff are told plainly what happened, after the order has left the list.
  await expect(
    page.getByText("Ingredients for Order 7 (Sat, Oct 10) returned to stock."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /(^|· )7$/u })).toHaveCount(0);
  await page.screenshot({ path: "test-results/orders-held-stock-released.png", fullPage: true });
  // An older server's mixed answer is read too, never "Orders unavailable".
  shape = "older";
  await page.getByRole("button", { name: "Refresh orders" }).click();
  await expect(page.getByText("Orders unavailable")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /(^| )B-1$/u })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Earlier days · not finished" })).toBeVisible();
  expect(releases).toEqual([
    {
      orderReference: id(2),
      orderBatchReference: id(102),
      operationReference: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    },
  ]);
});

// WP-2423 (2026-10-18 v15): a table dish the kitchen is remaking was counted "ready to serve" on
// the Home and its order read "Ready" on Orders, while the serving page said "Being remade".
test("@production WP-2423: a table whose dish is being remade reads Being remade and is not counted ready to serve", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-18",
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
  const table = (n: number, extra: Record<string, unknown>) => ({
    orderReference: id(n),
    orderNumber: "T-" + n,
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-10-18T14:00:00.000Z",
    observedAt: "2026-10-18T14:05:00.000Z",
    initialBatchReference: id(50 + n),
    batches: [
      {
        orderBatchReference: id(50 + n),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "Ready",
    currentVersion: 4,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
    ...extra,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          // The kitchen is remaking this table's only dish (dropped at the pass).
          table(32, { readyToServeItemCount: 0, remakingItemCount: 1 }),
          table(31, { readyToServeItemCount: 1, remakingItemCount: 0 }),
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.goto("/operations/orders");
  const remade = page.locator(".order-workbench-phase").filter({ hasText: "Being remade" });
  await expect(remade).toHaveCount(1);
  await expect(page.locator(".order-workbench-phase").filter({ hasText: /^Ready$/u })).toHaveCount(
    1,
  );
  await expectNoInternalText(page);

  await page.goto("/app");
  const open = page.locator(".overview-counts li").filter({ hasText: "Open orders" });
  await expect(open).toContainText("1 ready to serve");
  await expectNoInternalText(page);
});

test("@production DEC-DINE-IN-PAY-LATER: staff take a dish off an unpaid table's bill, with a reason", async ({
  page,
}) => {
  const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const scope = {
    brandLabel: "Synthetic Brand",
    storeLabel: "Synthetic Store",
    storeReference: id(99),
    timeZone: "America/Toronto",
  };
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
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
          businessDate: "2026-10-18",
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
  const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
  const line = (n: number, name: string) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(51),
    name,
    options: [],
    quantity: 1,
    customerNote: null,
    unitPrice: money("1000"),
    subtotal: money("1000"),
    discount: money("0"),
    tax: money("130"),
    fee: money("0"),
    total: money("1130"),
    canCancel: false,
    cancellation: null,
  });
  let removed = false;
  const order = () => ({
    orderReference: id(1),
    orderNumber: "T-1",
    orderType: "DineIn",
    sourceChannel: "Qr",
    submittedAt: "2026-10-18T14:00:00.000Z",
    observedAt: "2026-10-18T14:05:00.000Z",
    initialBatchReference: id(51),
    batches: [
      {
        orderBatchReference: id(51),
        sequence: 1,
        acceptanceStatus: "Accepted",
        canRequestAcceptance: false,
        canCancel: false,
        staffCancellation: null,
        canCancelItems: false,
        unpaidRemovableItems: removed ? [] : [id(201), id(202)],
        unpaidRemovedItems: removed ? [id(202)] : [],
      },
    ],
    canRequestAcceptance: false,
    currentPhase: "InProgress",
    currentVersion: removed ? 4 : 3,
    unfulfillable: null,
    pickupNotCollected: false,
    acceptBy: null,
    awaitingPayment: false,
  });
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order()], nextAfterOrderReference: null } }),
  );
  await page.route("**/merchant/orders/detail*", (route) =>
    route.fulfill({
      headers,
      json: {
        screenId: "OPS-ORDER-DETAIL",
        pickupContact: null,
        order: order(),
        lines: {
          items: [line(1, "Synthetic rice bowl"), line(2, "Synthetic soup")],
          totals: {
            subtotal: money("2000"),
            discount: money("0"),
            tax: money("260"),
            fee: money("0"),
            total: money("2260"),
          },
        },
      },
    }),
  );
  const sent: unknown[] = [];
  await page.route("**/merchant/orders/remove-unpaid-items", (route) => {
    sent.push(route.request().postDataJSON());
    removed = true;
    return route.fulfill({
      headers,
      json: {
        status: "Removed",
        orderReference: id(1),
        orderBatchReference: id(51),
        orderItemReferences: [id(202)],
        cancelledOrderVersion: 4,
      },
    });
  });
  for (const width of [1440, 390]) {
    removed = false;
    const before = sent.length;
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/operations/orders/" + id(1));
    await page.getByRole("button", { name: "Take dishes off the bill" }).click();
    const group = page.getByRole("group", { name: "Take dishes off the bill" });
    await group.getByLabel(/Synthetic soup/u).check();
    // Nothing is sent without a reason.
    await expect(group.getByRole("button", { name: "Take off $11.30" })).toBeDisabled();
    await group.getByLabel("Reason").selectOption("CUSTOMER_REQUEST");
    await group.getByRole("button", { name: "Take off $11.30" }).click();
    await expect(page.getByText("Taken off the bill · not charged")).toBeVisible();
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toMatchObject({
      orderReference: id(1),
      orderBatchReference: id(51),
      orderItemReferences: [id(202)],
      expectedOrderVersion: 3,
      reasonCode: "CUSTOMER_REQUEST",
    });
    await expect(page.getByText("Total after dishes taken off")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoInternalText(page);
  }
});
