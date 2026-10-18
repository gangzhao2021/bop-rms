import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ORDER_REFERENCE = "018f7600-0000-7000-8000-000000000001";
const WORK_ITEM_REFERENCE = "018f0f58-767a-7f3b-a1d0-000000000401";

/**
 * WP-2423 C5: automated accessibility checks (axe-core, WCAG 2.0/2.1 A and AA) on the pilot pages the
 * local demo can render. Serious and critical findings fail; the rest are reported in the message.
 */
const routes = [
  "/app",
  "/operations/orders",
  `/operations/orders/${ORDER_REFERENCE}`,
  "/operations/kitchen",
  `/operations/kitchen/work-items/${WORK_ITEM_REFERENCE}`,
  "/app/commerce/menus",
] as const;

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
