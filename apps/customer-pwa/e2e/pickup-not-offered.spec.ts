import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity; spec routes answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ trace: "off", screenshot: "off", video: "off" });
/**
 * WP-2423 item 8 ⑦ 1b: a guest scanning a pickup code at a Store that turned pickup off is told
 * the Store takes dine-in orders only and how to eat in; no session is started. TEST data.
 */
test("@production A pickup code at a dine-in-only store says so and starts no session", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/bff/customer/entry", async (route) => {
    calls++;
    await route.fulfill({
      status: 409,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({
        schemaVersion: 1,
        code: "entry_service_not_offered",
        messageKey: "customer.entry.pickup_not_offered",
        recovery: { action: "AskStaff", storeSelection: "Hidden" },
        store: { storeDisplayName: "TEST Noodle House" },
      }),
    });
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "TEST Noodle House takes dine-in orders only" }),
  ).toBeFocused();
  await expect(
    page.getByText(
      "Pickup orders aren’t taken here. To eat in, scan the QR code on your table or ask a staff member for a table.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(calls).toBe(1);
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name.includes("bop-guest"))).toBe(false);
});
