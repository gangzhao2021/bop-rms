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
              after === null
                ? {
                    items: Array.from({ length: 50 }, (_, i) => row(i + 1)),
                    nextAfterOrderReference: id(50),
                  }
                : { items: [row(51)], nextAfterOrderReference: null },
          },
    );
  });
  await page.goto("/operations/orders");
  await expect(page.getByRole("heading", { name: "ORD-1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "ORD-51", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ORD-1", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh orders" })).toBeFocused();
  deny = true;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Permission denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ORD-51", exact: true })).toHaveCount(0);
  deny = false;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "ORD-1", exact: true })).toBeVisible();
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
