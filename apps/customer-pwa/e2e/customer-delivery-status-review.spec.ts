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

test("@production CUST-DELIVERY-STATUS uses the Customer hierarchy and stays fail-closed", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/orders/018f9900-0000-7000-8000-000000000014/delivery");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Track your delivery" })).toBeVisible();
  await expect(
    main.getByRole("alert").getByRole("heading", { name: "Delivery tracking is disabled" }),
  ).toBeVisible();
  await expect(
    main.getByText("No courier, location or proof details are available."),
  ).toBeVisible();
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(main.getByRole("link", { name: "Back to order status" })).toHaveAttribute(
    "href",
    "/orders/018f9900-0000-7000-8000-000000000014",
  );

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expectNoHorizontalOverflow(page);
    const card = await main.locator(".delivery-status__unavailable").boundingBox();
    if (card === null) throw new Error("Delivery unavailable card missing");
    expect(card.width).toBeLessThanOrEqual(width - 16);
    await page.screenshot({ path: `test-results/delivery-status-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});
