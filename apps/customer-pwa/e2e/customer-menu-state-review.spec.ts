import { expect, test, type Page } from "@playwright/test";

const storeReference = "018f7500-0000-7000-8000-000000000001";
const instant = "2026-09-24T12:00:00.000Z";

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

test("CUST-MENU Empty and Unavailable match the Figma Review at 1440, 390, and 320px @production", async ({
  page,
}) => {
  const errors: string[] = [];
  let state: "Empty" | "Unavailable" = "Empty";
  let menuRequests = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/responded with a status of 503 \(Service Unavailable\)/u.test(message.text())
    )
      errors.push(message.text());
  });
  await page.context().route("**/api/v1/customer/session/csrf", (route) =>
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
  await page.context().route(`**/api/v1/public/stores/${storeReference}/menu**`, async (route) => {
    menuRequests += 1;
    if (state === "Unavailable")
      return route.fulfill({
        status: 503,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          schemaVersion: 1,
          error: { code: "menu_service_unavailable", messageKey: "customer.menu.unavailable" },
        }),
      });
    return route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        status: "Found",
        schemaVersion: 1,
        projection: {
          name: "catalog_published_menu_v1",
          version: 1,
          asOfUtc: instant,
          sourceCheckpoint: "018f7500-0000-7000-8000-000000000005",
          sourceAggregateVersion: 1,
          freshnessStatus: "Fresh",
          freshnessTargetMilliseconds: 5000,
          stale: false,
          partial: true,
        },
        scope: {
          publicStoreReference: storeReference,
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "DINE_IN",
          effectiveAt: instant,
        },
        menu: {
          menuReference: "018f7500-0000-7000-8000-000000000006",
          menuVersionReference: "018f7500-0000-7000-8000-000000000007",
          releaseReference: "018f7500-0000-7000-8000-000000000008",
          locale: "en-CA",
          name: "Synthetic menu",
          effectiveFrom: instant,
          effectiveUntil: null,
          sections: [],
        },
      }),
    });
  });

  await page.goto("/menu");
  const empty = page.locator(".menu-state--empty");
  await expect(empty.getByRole("heading", { name: "No items available" })).toBeVisible();
  await expect(empty).toContainText("The current published menu has no matching items.");
  await expect(empty.getByRole("button")).toHaveCount(0);
  await empty
    .getByRole("heading", { name: "No items available" })
    .evaluate((node) => (node as HTMLElement).blur());
  await expect(page.locator(".menu-help")).toHaveCSS("padding-left", "20px");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `test-results/customer-menu-empty-${width}.png`,
      fullPage: true,
    });
  }

  state = "Unavailable";
  const unavailablePage = await page.context().newPage();
  unavailablePage.on("pageerror", (error) => errors.push(error.message));
  unavailablePage.on("console", (message) => {
    if (
      message.type() === "error" &&
      !/responded with a status of 503 \(Service Unavailable\)/u.test(message.text())
    )
      errors.push(message.text());
  });
  await unavailablePage.goto("/menu");
  const unavailable = unavailablePage.locator(".menu-state--error");
  await expect(unavailable.getByRole("heading", { name: "Menu is unavailable" })).toBeVisible();
  await expect(unavailable.getByRole("button", { name: "Try again" })).toBeVisible();
  await unavailable
    .getByRole("heading", { name: "Menu is unavailable" })
    .evaluate((node) => (node as HTMLElement).blur());
  const requestCountBeforeRetry = menuRequests;
  await unavailable.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => menuRequests).toBe(requestCountBeforeRetry + 1);
  await expect(unavailable.getByRole("heading", { name: "Menu is unavailable" })).toBeVisible();
  for (const width of [1440, 390, 320]) {
    await unavailablePage.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expectNoHorizontalOverflow(unavailablePage);
    await unavailablePage.screenshot({
      path: `test-results/customer-menu-unavailable-${width}.png`,
      fullPage: true,
    });
  }
  expect(menuRequests).toBe(requestCountBeforeRetry + 1);
  expect(errors).toEqual([]);
  await unavailablePage.close();
});
