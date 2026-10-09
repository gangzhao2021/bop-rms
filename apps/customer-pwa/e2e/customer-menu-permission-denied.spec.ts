import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test("@production CUST-MENU renders a generic Permission Denied recovery for explicit HTTP 403", async ({
  page,
}) => {
  const storeReference = "018f7500-0000-7000-8000-000000000001";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/responded with a status of 403 \(Forbidden\)/u.test(message.text())
    )
      errors.push(message.text());
  });
  await page.route("**/api/v1/customer/session/csrf", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        schemaVersion: 1,
        csrfToken: "a".repeat(43),
        menuContext: {
          publicStoreReference: storeReference,
          channel: "DineIn",
          locale: "en-CA",
          brandDisplayName: "Synthetic brand",
          storeDisplayName: "Synthetic Store",
        },
      }),
    }),
  );
  await page.route(`**/api/v1/public/stores/${storeReference}/menu**`, (route) =>
    route.fulfill({ status: 403, contentType: "text/plain", body: "opaque denial payload" }),
  );
  await page.goto("/menu");

  const main = page.getByRole("main");
  const alert = main.getByRole("alert");
  await expect(alert.getByRole("heading", { name: "This menu can’t be opened" })).toBeVisible();
  await expect(alert.getByRole("heading", { name: "This menu can’t be opened" })).toBeFocused();
  await expect(alert.getByText(/session can’t access this menu/u)).toBeVisible();
  await expect(alert.getByRole("link", { name: "Return to entry" })).toHaveAttribute("href", "/");
  await expect(alert).not.toContainText("opaque denial payload");
  await expect(main.getByRole("button", { name: "Try again" })).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await alert
      .getByRole("heading", { name: "This menu can’t be opened" })
      .evaluate((node) => (node as HTMLElement).blur());
    await expectNoHorizontalOverflow(page);
    const card = await main.locator(".menu-state--permission-denied").boundingBox();
    expect(card).not.toBeNull();
    expect(card?.width).toBeLessThanOrEqual(width - 16);
    await page.screenshot({
      path: `test-results/customer-menu-permission-denied-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
