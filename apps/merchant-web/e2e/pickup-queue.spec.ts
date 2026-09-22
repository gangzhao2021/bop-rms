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
            readyAt: "2026-09-19T11:55:00.000Z",
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
  await expect(
    page.getByRole("button", { name: "Open proof verification", exact: true }),
  ).toBeEnabled();
  const proofs: string[] = [];
  await page.route("**/merchant/pickup/proof", (route) => {
    proofs.push(route.request().postData() ?? "");
    if (proofs.length === 1) return route.abort();
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyApplied",
        verificationReference: id(7),
        fulfillmentReference: id(1),
        expectedAggregateVersion: "9007199254740993",
        generation: 1,
        grantsCompletionAuthority: false,
      },
    });
  });
  await page.getByRole("button", { name: "Open proof verification", exact: true }).click();
  await expect(page.getByLabel("Pickup credential", { exact: true })).toBeFocused();
  await page.getByLabel("Pickup credential", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Verify pickup proof", exact: true }).click();
  await expect(page.getByText("Verification result unknown.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Pickup credential", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry same verification", exact: true }).click();
  await expect(page.getByText("Proof verified.", { exact: false })).toBeVisible();
  expect(proofs).toHaveLength(2);
  expect(proofs[0]).toBe(proofs[1]);
  const handoffs: string[] = [];
  await page.route("**/merchant/pickup/handoff", (route) => {
    handoffs.push(route.request().postData() ?? "");
    if (handoffs.length === 1) return route.abort();
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyApplied",
        handoffReference: id(12),
        fulfillmentReference: id(1),
        nextAggregateVersion: "9007199254740994",
        nextPhase: "Completed",
      },
    });
  });
  await page.getByRole("button", { name: "Review pickup handoff" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Order line 1: 2 remaining ready units")).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "Confirm and record handoff" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Recipient type").selectOption("Customer");
  await dialog.getByLabel("Masked recipient label").fill("S***");
  await dialog.getByRole("checkbox").check();
  await confirm.click();
  await expect(dialog.getByText("Handoff result unknown.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close handoff confirmation" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Retry same handoff" }).click();
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
  await dialog.getByRole("button", { name: "Close handoff confirmation" }).click();
  await expect(page.getByRole("button", { name: "Review pickup handoff" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(heading(second)).toBeVisible();
  await expect(heading(first)).toHaveCount(0);
  await expect(refresh).toBeFocused();
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await expect(heading(first)).toBeVisible();
  await page.getByRole("checkbox", { name: "Include completed pickups" }).check();
  await expect(page.locator("article").getByText("Completed", { exact: false })).toBeVisible();
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
