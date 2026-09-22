import { expect, test } from "@playwright/test";

test("@production staff starts a table and recovers a lost entry code without duplicate start", async ({
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

  const starts: string[] = [],
    regens: string[] = [];
  await page.route("**/merchant/dining/tables", (route) =>
    route.fulfill({
      headers,
      json: {
        items: [
          {
            tableReference: id(1),
            stableLabel: "T1",
            areaCode: "MAIN",
            capacity: 4,
            lifecycle: "Published",
            operationalState: "Available",
            aggregateVersion: 2,
            currentDiningSessionReference: null,
          },
        ],
        nextAfterTableReference: null,
      },
    }),
  );
  await page.route("**/merchant/dining/sessions/start", (route) => {
    starts.push(route.request().postData() ?? "");
    if (starts.length === 1) return route.abort("failed");
    return route.fulfill({
      headers,
      json: {
        status: "AlreadyApplied",
        tableReference: id(1),
        tableAssignmentVersion: 2,
        diningSessionReference: id(3),
        sessionVersion: 1,
        joinKind: "HumanCode",
      },
    });
  });
  await page.route("**/merchant/dining/sessions/join-state", (route) =>
    route.fulfill({
      headers,
      json: {
        diningSessionReference: id(3),
        tableReference: id(1),
        sessionVersion: 1,
        tableAssignmentVersion: 2,
        capabilityVersion: 1,
        generation: 1,
        joinKind: "HumanCode",
      },
    }),
  );
  await page.route("**/merchant/dining/sessions/regenerate", (route) => {
    regens.push(route.request().postData() ?? "");
    return route.fulfill({
      headers,
      json: {
        status: "Issued",
        generation: 2,
        capabilityVersion: 1,
        joinKind: "HumanCode",
        joinCredential: "123456",
      },
    });
  });
  await page.goto("/operations/dining");
  await page.getByRole("button", { name: "Refresh tables", exact: true }).click();
  await page.getByRole("button", { name: "Select T1", exact: true }).click();
  const confirm = page.getByRole("checkbox", {
    name: "I confirm the selected table and session action",
    exact: true,
  });
  const start = page.getByRole("button", { name: "Start dining session", exact: true });
  await expect(start).toBeDisabled();
  await confirm.check();
  await start.click();
  await expect(page.getByRole("button", { name: "Refresh tables", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Retry same session request", exact: true }).click();
  await expect(
    page.getByText(
      "The request already completed. Its code cannot be displayed again. Confirm replacement to generate a new code.",
      { exact: true },
    ),
  ).toBeVisible();
  const replace = page.getByRole("button", { name: "Replace entry code", exact: true });
  await expect(replace).toBeDisabled();
  await confirm.check();
  await replace.click();
  await expect(page.getByText("123456", { exact: true })).toBeVisible();
  expect(starts).toHaveLength(2);
  expect(starts[1]).toBe(starts[0]);
  expect(regens).toHaveLength(1);
  await page.getByRole("button", { name: "Hide entry code", exact: true }).click();
  await expect(page.getByText("123456", { exact: true })).toHaveCount(0);
  expect(page.url()).not.toContain("123456");
});
