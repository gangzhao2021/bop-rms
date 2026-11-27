import { expect, test } from "@playwright/test";
import { notPausedServiceControl } from "./service-control-state";

/**
 * Batch 36 review: Home's opening reads share one request with the other parts of the screen that
 * ask the same thing. A Store switch happens in place, without a reload, and gives a new token, so
 * a read still on its way for the Store being left must never be joined by the Home that opens for
 * the next Store (it would show the first Store's facts under the second's name). Here the first
 * Store's kitchen setup answers slowly ("not set up"); the second Store's is set up.
 * Synthetic HTTP interception on the production build, TEST-only data.
 */
const id = (n: number) => "019a3602-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const stores = {
  a: { brandLabel: "Synthetic Brand", storeLabel: "Training Store A", storeReference: id(1) },
  b: { brandLabel: "Synthetic Brand", storeLabel: "Training Store B", storeReference: id(2) },
} as const;
const csrf = { a: "a".repeat(43), b: "b".repeat(43) } as const;
const day = "2026-10-27";
const observedAt = "2026-10-27T18:01:00.000Z";
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("@production a Store switch while Home's opening reads are on their way: the next Store's Home reads its own", async ({
  page,
}) => {
  test.setTimeout(30_000);
  let selected: keyof typeof stores = "a";
  const kitchenReads: (keyof typeof stores)[] = [];
  const workspace = () => ({
    screenId: "HOME-OVERVIEW",
    selectedScope: { ...stores[selected], timeZone: "America/Toronto" },
    authorizedStores: [stores.a, stores.b],
    businessDate: day,
    storeStatus: "Open",
    freshness: "Current",
    dashboardAvailability: "UnavailableUntilWP1905",
    pauseOrderingShown: true,
    navigation: [
      {
        screenId: "STORE-SETUP",
        label: "Store setup",
        href: "/app/organization/stores/" + stores[selected].storeReference + "/setup",
        permission: "organization.manage",
      },
    ],
  });
  await page.route("**/merchant/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    switch (path) {
      case "/merchant/session":
        return route.fulfill({
          headers,
          json: { authenticated: true, csrf: csrf[selected], workspace: workspace() },
        });
      case "/merchant/store-context":
        selected = "b";
        return route.fulfill({ headers, json: { workspace: workspace() } });
      case "/merchant/business-day":
        return route.fulfill({
          headers,
          json: {
            businessDate: day,
            startsAt: "2026-10-27T08:00:00.000Z",
            endsAt: "2026-10-28T08:00:00.000Z",
            timeZone: "America/Toronto",
            observedAt,
          },
        });
      case "/merchant/service-control":
        return route.fulfill({
          headers,
          json: notPausedServiceControl(stores[selected].storeReference),
        });
      case "/merchant/store/kitchen-setup": {
        // What the server answers depends on the Store selected when the read arrives.
        const store = selected;
        kitchenReads.push(store);
        if (store === "a") await later(2_500);
        return route
          .fulfill({
            headers,
            json: {
              canChange: true,
              version: store === "a" ? 0 : 3,
              inEffectFrom: store === "a" ? null : "2026-10-01T12:00:00.000Z",
              uncoveredDishes: [],
            },
          })
          .catch(() => undefined);
      }
      default:
        return route.fulfill({ status: 403, headers, json: { error: "permission_denied" } });
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  const switcher = page.getByLabel("Authorized Store");
  await expect(switcher).toBeVisible();
  // Store A's kitchen setup is still on its way when the switch answers.
  await expect.poll(() => kitchenReads.length).toBe(1);
  await switcher.selectOption(stores.b.storeReference);
  await switcher.evaluate((element) => (element as HTMLSelectElement).form?.requestSubmit());
  await expect(page.getByText("Training Store B").first()).toBeVisible();
  // Past the moment Store A's answer arrives: Store B's Home asked for its own and shows it.
  await page.waitForTimeout(3_500);
  expect(kitchenReads).toEqual(["a", "b"]);
  await expect(page.getByText("The kitchen isn't set up")).toHaveCount(0);
});
