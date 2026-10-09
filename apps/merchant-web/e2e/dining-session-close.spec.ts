import { expect, test } from "@playwright/test";

test("@production session closing advances both steps and recovers a lost finalize response", async ({
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

  let phase: "Active" | "Closing" | "Closed" = "Active";
  let version = 2;
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
            ],
            canRequestAcceptance: false,
            currentPhase: "Accepted",
            currentVersion: 2,
            unfulfillable: null,
            pickupNotCollected: false,
          },
        ],
        nextAfterOrderReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/order-progress", (route) =>
    route.fulfill({
      headers,
      json: {
        orderReference: id(1),
        orderVersion: 2,
        sessionVersion: version,
        diningSessionReference: id(55),
        sessionPhase: phase,
        tableAssignmentVersion: 3,
        closureStatus: "Closed",
        closureVersion: 1,
        currentOrderVersion: 4,
        tableLabel: "T1",
        phase: "Fulfilled",
        observedAt: "2026-09-14T00:01:00.000Z",
        items: [
          {
            orderItemReference: id(3),
            orderBatchReference: id(90),
            displayName: "Meal",
            batchSequence: 1,
            itemOrdinal: 1,
            phase: "Fulfilled",
            orderedQuantity: 2,
            deliveredQuantity: 2,
            remainingQuantity: 0,
            itemServiceVersion: 1,
          },
        ],
      },
    }),
  );
  await page.route("**/merchant/dining/closing", async (route) => {
    const raw = route.request().postData() ?? "";
    bodies.push(raw);
    const command = JSON.parse(raw);
    expect(route.request().headers()["x-bop-csrf"]).toBe("a".repeat(43));
    if (command.action === "Begin") {
      expect(command.expectedSessionVersion).toBe(2);
      phase = "Closing";
      version = 3;
      return route.fulfill({
        headers,
        json: { status: "Applied", phase, sessionVersion: version },
      });
    }
    expect(command.action).toBe("Finalize");
    expect(command.expectedSessionVersion).toBe(3);
    phase = "Closed";
    version = 4;
    if (bodies.length === 2) return route.abort("failed");
    return route.fulfill({
      headers,
      json: { status: "AlreadyApplied", phase, sessionVersion: version },
    });
  });
  await page.goto("/operations/orders");
  await page.getByRole("button", { name: "View serving progress", exact: true }).click();
  const confirm = page.getByRole("checkbox", {
    name: "I confirm this dining session is ready for the next closing step",
    exact: true,
  });
  const begin = page.getByRole("button", { name: "Begin session closing", exact: true });
  await expect(begin).toBeDisabled();
  await confirm.check();
  await begin.click();
  const finalize = page.getByRole("button", { name: "Finalize session closing", exact: true });
  await expect(finalize).toBeDisabled();
  await expect(page.getByText("Dining session: Closing", { exact: true })).toBeVisible();
  await confirm.check();
  await finalize.click();
  const retry = page.getByRole("button", { name: "Retry same session close request", exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("button", { name: "Refresh orders", exact: true })).toBeDisabled();
  await retry.click();
  await expect(page.getByText("Dining session: Closed", { exact: true })).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh orders", exact: true })).toBeEnabled();
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).toBe(bodies[1]);
  expect(JSON.parse(bodies[0] ?? "{}").operationReference).not.toBe(
    JSON.parse(bodies[1] ?? "{}").operationReference,
  );
});
