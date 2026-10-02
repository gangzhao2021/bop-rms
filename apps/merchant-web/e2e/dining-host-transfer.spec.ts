import { expect, test } from "@playwright/test";

test("@production staff confirms Host transfer and retains unknown operation across denial", async ({
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        canOperateTables: false,
        items: [
          {
            tableReference: id(1),
            stableLabel: "T1",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            currentDiningSessionReference: id(3),
            elapsedMinutes: 8,
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  const at = "2026-09-21T04:00:00.000Z";
  await page.route("**/merchant/dining/sessions/host-selection", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(3),
        sessionVersion: 3,
        phase: "Active",
        hostParticipantReference: id(4),
        observedAt: at,
        participants: [
          { participantReference: id(4), joinedAt: at, isHost: true },
          { participantReference: id(5), joinedAt: at, isHost: false },
        ],
      },
    }),
  );
  const bodies: string[] = [];
  await page.route("**/merchant/dining/sessions/host-transfer", (route) => {
    bodies.push(route.request().postData() ?? "");
    if (bodies.length === 1) return route.abort("failed");
    if (bodies.length === 2)
      return route.fulfill({ status: 403, headers, json: { error: "request_denied" } });
    const command = JSON.parse(bodies[0] ?? "{}");
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyApplied",
        operationReference: command.operationReference,
        diningSessionReference: id(3),
        previousHostParticipantReference: id(4),
        hostParticipantReference: id(5),
        sessionVersion: 4,
        transferredAt: at,
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  await page.getByRole("button", { name: "Select T1", exact: true }).click();
  const transfer = page.getByRole("button", { name: "Transfer order host", exact: true });
  await expect(transfer).toBeDisabled();
  await page.getByRole("button", { name: "Refresh participants", exact: true }).click();
  await page.getByRole("combobox", { name: "New order host", exact: true }).selectOption(id(5));
  await expect(transfer).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I have identified the selected guest and confirm the host transfer",
      exact: true,
    })
    .check();
  await transfer.click();
  const retry = page.getByRole("button", { name: "Retry same host transfer", exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.getByRole("button", { name: "Refresh tables", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Select T1", exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Replace entry code", exact: true }),
  ).toBeDisabled();
  await retry.click();
  await expect(retry).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Refresh participants", exact: true }),
  ).toBeDisabled();
  await retry.click();
  await expect(page.getByText(/Host transfer recorded at/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh tables", exact: true })).toBeEnabled();
  expect(new Set(bodies).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
