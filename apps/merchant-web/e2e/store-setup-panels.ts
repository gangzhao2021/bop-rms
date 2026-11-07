import type { Page } from "@playwright/test";

/** The panels every Store setup page reads, for specs about something else on that page. */
export async function serveStoreSetupPanels(page: Page) {
  const headers = { "cache-control": "no-store" };
  await page.route("**/merchant/store/kitchen-setup", (route) =>
    route.fulfill({
      headers,
      json: {
        canChange: true,
        version: 1,
        inEffectFrom: "2026-11-01T15:00:00.000Z",
        uncoveredDishes: [],
      },
    }),
  );
  await page.route("**/merchant/store/support-access", (route) =>
    route.fulfill({ headers, json: { version: 1, mode: "Off", allowedUntil: null, log: [] } }),
  );
}
/**
 * WP-2423 item 14: what Store setup reads first. These specs drive the page of a Store whose setup
 * has been published; store-first-opening.spec.ts drives a first Store's.
 */
export const establishedOpeningList = Object.freeze({
  setupPublished: true,
  allergenList: true,
  menuListed: true,
  taxRatesSet: true,
});
