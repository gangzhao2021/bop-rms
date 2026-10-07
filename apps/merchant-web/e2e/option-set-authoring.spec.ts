import { expect, test, type Page, type Route } from "@playwright/test";
// Production-built browser and genuine DOM; closed synthetic HTTP observations.
// Actual Session/IAM/database composition is verified by option_http separately.
const id = (n: number) => "01902421-7990-7000-8000-" + n.toString(16).padStart(12, "0");
const csrf = "A".repeat(43);
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const send = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
function row(name = "Synthetic choices") {
  const at = new Date().toISOString();
  return {
    optionSetReference: id(10),
    internalCode: "SYNTH_CHOICE",
    lifecycle: "Draft",
    aggregateVersion: 2,
    draftVersionReference: id(11),
    createdAt: at,
    updatedAt: at,
    name,
    nameLocale: "en-CA",
    localeFallback: false,
    selectionRule: {
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 2,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 2,
    },
    optionCount: 2,
    activeOptionCount: 1,
    productBindingCount: 0,
    recordedPricingReference: { status: "Known", present: false },
    recordedConsumptionReference: { status: "Unknown" },
    recordedConflict: { status: "Known", present: false },
    publishingStatus: { status: "Unavailable" },
    referenceEligibility: "NotEvaluated",
  };
}
async function sources(page: Page) {
  const state = {
    navigation: true,
    create: true,
    listEnabled: true,
    error: null as null | "Denied" | "Unavailable" | "Stale" | "ScopeChanged",
    requests: [] as Record<string, unknown>[],
    staleOnce: false,
  };
  await page.route("**/merchant/session", (route) =>
    send(route, {
      authenticated: true,
      csrf,
      workspace: {
        screenId: "HOME-OVERVIEW",
        selectedScope: {
          brandLabel: "Synthetic Brand",
          storeLabel: "Synthetic Store",
          storeReference: id(3),
        },
        authorizedStores: [
          { brandLabel: "Synthetic Brand", storeLabel: "Synthetic Store", storeReference: id(3) },
        ],
        businessDate: "2026-10-05",
        storeStatus: "Unavailable",
        freshness: "Stale",
        dashboardAvailability: "UnavailableUntilWP1905",
        navigation: state.navigation
          ? [
              {
                screenId: "CAT-OPTIONSET-LIST",
                label: "Option sets",
                href: "/app/commerce/option-sets",
                permission: "catalog.manage",
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/merchant/store-capability", async (route) => {
    const key = (route.request().postDataJSON() as { capabilityKey: string }).capabilityKey;
    expect(key.startsWith("catalog.cat_optionset_")).toBe(true);
    const action = key.slice("catalog.cat_optionset_".length),
      enabled = action === "create" ? state.create : action === "list" ? state.listEnabled : true;
    await send(route, {
      brandReference: id(2),
      storeReference: id(3),
      capabilityKey: key,
      controlKey: "catalog.optionset." + action,
      backendExecution: enabled ? "Allow" : "Deny",
      frontendVisibility: enabled ? "Show" : "Hide",
      reason: enabled ? "Enabled" : "Disabled",
      source: "BrandOverride",
      controlReference: id(12),
      controlVersion: 1,
      observedAt: new Date().toISOString(),
    });
  });
  await page.route("**/merchant/catalog/option-sets/list", async (route) => {
    const filters = route.request().postDataJSON() as Record<string, unknown>;
    state.requests.push(filters);
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-bop-csrf"]).toBe(csrf);
    expect(route.request().url()).not.toContain(id(2));
    if (state.error === "Denied") return send(route, { error: "request_denied" }, 403);
    if (state.error === "Unavailable")
      return send(route, { error: "option_set_list_unavailable" }, 503);
    if ((state.staleOnce && filters.cursor !== null) || state.error === "Stale") {
      state.staleOnce = false;
      return send(route, { error: "option_set_list_stale" }, 409);
    }
    const empty = filters.search === "absent",
      next = filters.cursor !== null;
    await send(route, {
      projection: {
        name: "catalog_option_set_search_v1",
        version: 1,
        asOfUtc: new Date().toISOString(),
        stale: false,
        partial: true,
        sourceGeneration: "sha256:" + "a".repeat(64),
      },
      scope: state.error === "ScopeChanged" ? { ...scope, actorReference: id(99) } : scope,
      locale: filters.locale,
      items: empty ? [] : [row(next ? "Synthetic next choices" : "Synthetic choices")],
      hasMore: !empty && !next,
      nextCursor: !empty && !next ? "os1." + "a".repeat(60) : null,
    });
  });
  return state;
}
test("@production Option list ordinary entry, filters, pagination and first-page source recovery", async ({
  page,
}) => {
  const state = await sources(page);
  await page.goto("/app/commerce/option-sets");
  await expect(page.getByRole("heading", { name: "Option Sets", exact: true })).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Current Option Set authoring records" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Create Option Set", exact: true })).toBeVisible();
  await expect(page.getByText("Partial authoring view.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(
    page.getByRole("table").getByRole("link", { name: "Synthetic next choices", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh first page", exact: true }).click();
  await expect(
    page.getByRole("table").getByRole("link", { name: "Synthetic choices", exact: true }),
  ).toBeVisible();
  state.staleOnce = true;
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "source changed" })).toBeVisible();
  await expect(
    page.getByRole("table").getByRole("link", { name: "Synthetic choices", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search names, codes or Options").fill("absent");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No Option Sets", exact: true })).toBeVisible();
  expect(state.requests.at(-1)?.cursor).toBeNull();
  expect(state.requests.at(-1)?.search).toBe("absent");
  await page.getByRole("button", { name: "Reset filters", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
});
test("@production Option list current denial clears records and creation; refresh recovers", async ({
  page,
}) => {
  const state = await sources(page);
  await page.goto("/app/commerce/option-sets");
  await expect(page.getByRole("table")).toBeVisible();
  state.error = "Denied";
  await page.getByRole("button", { name: "Refresh first page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Permission denied", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Create Option Set", exact: true })).toHaveCount(0);
  state.error = null;
  state.create = false;
  await page.getByRole("button", { name: "Refresh first page", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("link", { name: "Create Option Set", exact: true })).toHaveCount(0);
  state.listEnabled = false;
  await page.getByRole("button", { name: "Refresh first page", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Option Set List disabled", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});
test("@production Option list preserves known identity, rejects changed Actor and recovers in a fresh current read", async ({
  page,
}) => {
  const state = await sources(page);
  await page.goto("/app/commerce/option-sets");
  await expect(page.getByRole("table")).toBeVisible();
  state.error = "ScopeChanged";
  await page.getByRole("button", { name: "Refresh first page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scope changed", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  state.error = null;
  await page.getByRole("button", { name: "Refresh first page", exact: true }).click();
  await expect(page.getByRole("table")).toBeVisible();
});
test("@production Option list mobile cards, keyboard filter and offline do not imply absent records", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await sources(page);
  await page.goto("/app/commerce/option-sets");
  await expect(
    page
      .locator(".product-list-cards")
      .getByRole("link", { name: "Synthetic choices", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search names, codes or Options").focus();
  await expect(page.getByLabel("Search names, codes or Options")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  // navigator.onLine remains true for a synthetic event; actual browser offline
  // is covered by the following context-level transition.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByRole("heading", { name: "Offline", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "No Option Sets", exact: true })).toHaveCount(0);
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(
    page
      .locator(".product-list-cards")
      .getByRole("link", { name: "Synthetic choices", exact: true }),
  ).toBeVisible();
});
test("@production Option route without actual workspace admission refuses data reads", async ({
  page,
}) => {
  const state = await sources(page);
  state.navigation = false;
  await page.goto("/app/commerce/option-sets");
  await expect(
    page.getByRole("heading", { name: "Option sets unavailable", exact: true }),
  ).toBeVisible();
  expect(state.requests).toEqual([]);
});

test("@production Archived filter includes recorded archive facts and cannot silently conflict", async ({
  page,
}) => {
  const state = await sources(page);
  await page.goto("/app/commerce/option-sets");
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("combobox", { name: "Lifecycle", exact: true }).selectOption("Archived");
  await expect(
    page.getByRole("checkbox", { name: "Include Archived Option Sets", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect.poll(() => state.requests.at(-1)?.lifecycle).toBe("Archived");
  expect(state.requests.at(-1)?.includeArchived).toBe(true);
  await page.getByRole("checkbox", { name: "Include Archived Option Sets", exact: true }).uncheck();
  await expect(page.getByRole("combobox", { name: "Lifecycle", exact: true })).toHaveValue("");
});
