import { expect, test } from "@playwright/test";

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
    operatorStatus: "Unavailable",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    projectionGenerationReference: id(6),
    projectedAt: at,
    partial: false,
    stale: false,
    freshnessStatus: "Fresh",
  };
  let denied = false,
    requests = 0;
  await page.route("**/merchant/kitchen/query", (route) => {
    requests++;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    const query = route.request().postDataJSON();
    return route.fulfill(
      denied
        ? { headers, status: 403, json: { error: "request_denied" } }
        : {
            headers,
            json:
              query.kind === "List"
                ? { ...metadata, items: [item], nextCursor: null }
                : { ...metadata, item },
          },
    );
  });
  await page.goto("/operations/kitchen");
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Board locked — read-only" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Open work item" }).click();
  await expect(page.getByRole("heading", { name: "Safety and lifecycle authority" })).toBeVisible();
  await page.getByRole("link", { name: "Return to Kitchen Board" }).click();
  await expect(page).toHaveURL(/\/operations\/kitchen$/);
  await expect(page.getByRole("heading", { name: "Kitchen Board", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  denied = true;
  await page.getByRole("button", { name: "Refresh from source" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Permission denied" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh from source" })).toBeFocused();
  denied = false;
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Synthetic rice", exact: true })).toBeVisible();
  expect(requests).toBe(5);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
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
  await page.route("**/merchant/kitchen/work", async (route) => {
    const command = route.request().postDataJSON();
    commands.push(command);
    expect(command.authority).toBe("CurrentMerchantSession");
    expect(command.storeReference).toBe(scope.storeReference);
    expect(command).not.toHaveProperty("actorReference");
    if (commands.length === 1) return route.abort("failed");
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
    complete = page.getByRole("button", { name: "Complete remaining quantity", exact: true }),
    refresh = page.getByRole("button", { name: "Refresh from source" });
  await accept.click();
  await expect(page.getByRole("heading", { name: "Action result unknown" })).toBeVisible();
  await expect(accept).toBeDisabled();
  expect(commands).toHaveLength(1);
  await page.getByRole("button", { name: "Retry same operation" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for refreshed queue" })).toBeVisible();
  expect(commands[1]).toEqual(commands[0]);
  await refresh.click();
  await expect(accept).toBeDisabled();
  await expect(start).toBeDisabled();
  Object.assign(item, {
    acceptedAt: at,
    ticketAggregateVersion: "9007199254740994",
    workItemVersion: "2",
  });
  await refresh.click();
  await expect(start).toBeEnabled();
  conflict = true;
  await start.focus();
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
  expect(commands[4]?.quantityDelta).toBe(2);
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
  await expect(complete).toBeDisabled();
  await expect(page.getByRole("button", { name: "Mark ready", exact: true })).toBeDisabled();
  expect(new Set(commands.slice(1).map((command) => command.idempotencyKey)).size).toBe(4);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
});
