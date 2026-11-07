import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

/**
 * WP-2423 C5: automated accessibility checks (axe-core, WCAG 2.0/2.1 A and AA) on the customer
 * journey pages the local demo renders. Serious and critical findings fail.
 */
const routes = ["/", "/menu", "/cart", "/checkout"] as const;

for (const route of routes) {
  test(`@demo ${route} has no serious or critical accessibility violations`, async ({ page }) => {
    await page.goto(route);
    await expect(page.getByRole("main")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(
      blocking.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target.join(" ")).slice(0, 5),
      })),
    ).toEqual([]);
  });
}
