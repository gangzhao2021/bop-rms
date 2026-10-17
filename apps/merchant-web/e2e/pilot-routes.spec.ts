import { expect, test, type Page } from "@playwright/test";
import { merchantRoutes } from "../src/pilot-routes";
import { findInternalText } from "./internal-text-patterns";

/**
 * v15 aa3d9fac D3 (pilot rule "no reachable stubs"): staff who type or bookmark an address never
 * meet a layout review. Every route the app registers is opened in the production build with a
 * signed-in Store workspace: a screen without real sources goes to a working screen, and a working
 * screen shows a page (a heading) with no design-review or placeholder text. The server is down
 * for everything but the session here, so working screens show their own failure state; those are
 * checked for plain words separately by their own specs.
 */
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandLabel: "Training Brand",
  storeLabel: "Training Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const nav = (screenId: string, label: string, href: string, permission: string) => ({
  screenId,
  label,
  href,
  permission,
});

async function signedIn(page: Page) {
  await page.route("**/merchant/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.route("**/merchant/session", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        authenticated: true,
        csrf: "a".repeat(43),
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: scope,
          authorizedStores: [scope],
          businessDate: "2026-10-17",
          storeStatus: "Open",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            nav("OPS-ORDER-QUEUE", "Orders", "/operations/orders", "ordering.operate"),
            nav("KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen", "kitchen.operate"),
            nav("RPT-OPS-DASHBOARD", "Reports", "/app/reports/operations", "reporting.sales.read"),
          ],
        },
      },
    }),
  );
}

/** Words that only a layout review or an internal placeholder shows. */
const placeholderText =
  /design review|\bphase \d\b|\bprojection\b|placeholder|review layout|source values|\b[A-Z]{2,5}(?:-[A-Z]{2,})+\b/u;

// The pilot session lists neither TAX-CONFIG nor any other conditional screen.
const hidden = merchantRoutes.flatMap((entry) =>
  entry.hiddenTo !== undefined
    ? [{ path: entry.path, sample: entry.sample, to: entry.hiddenTo }]
    : entry.listed !== undefined
      ? [{ path: entry.path, sample: entry.sample, to: entry.listed.to }]
      : [],
);
const working = merchantRoutes.filter(
  (entry) => entry.hiddenTo === undefined && entry.listed === undefined,
);

test("@production every screen without real sources is hidden from the Store workspace", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signedIn(page);
  for (const entry of hidden) {
    await page.goto(entry.sample);
    await expect(page, entry.path).toHaveURL((url) => url.pathname === entry.to, {
      timeout: 5_000,
    });
    await expect(page.getByText(placeholderText)).toHaveCount(0);
  }
});

test("@production every working screen opens a page without placeholder text", async ({ page }) => {
  test.setTimeout(240_000);
  await signedIn(page);
  const findings: string[] = [];
  for (const entry of working) {
    await page.goto(entry.sample);
    await expect(page.getByRole("heading").first(), entry.path).toBeVisible();
    await expect(page.getByText("Loading this page…")).toHaveCount(0);
    expect(new URL(page.url()).pathname, entry.path).toBe(entry.sample);
    const text = await page.evaluate(() => document.body.innerText);
    const marker = placeholderText.exec(text);
    if (marker) findings.push(`${entry.path}: ${marker[0]}`);
    // The server is down here: "unavailable" failure states are judged by each screen's own spec.
    for (const finding of findInternalText([text], [/\bunavailable\b/giu]))
      findings.push(`${entry.path}: ${finding.rule} "${finding.token}" in "${finding.text}"`);
  }
  expect(findings).toEqual([]);
});
