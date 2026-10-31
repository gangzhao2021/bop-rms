import { expect, test } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ trace: "off", screenshot: "off", video: "off" });
/** WP-2423 Q11: a guest scanning a table code that staff replaced is told to ask staff. */
test("@production A replaced table code tells the guest to ask staff, with no session", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/bff/customer/entry", async (route) => {
    calls++;
    await route.fulfill({
      status: 410,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({
        schemaVersion: 1,
        code: "entry_qr_retired",
        messageKey: "customer.entry.qr_replaced",
        recovery: { action: "AskStaff", storeSelection: "Hidden" },
      }),
    });
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(page.getByRole("heading", { name: "This table code was replaced" })).toBeFocused();
  await expect(
    page.getByText("This table code was replaced. Please ask a staff member.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(calls).toBe(1);
  expect(new URL(page.url()).hash).toBe("");
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => cookie.name.includes("bop-guest"))).toBe(false);
});
