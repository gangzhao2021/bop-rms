import { expect, test } from "@playwright/test";

test("@demo keeps the configured-unavailable payment view safe and readable", async ({ page }) => {
  await page.goto("/checkout/payment");
  await expect(page.getByRole("heading", { name: "Secure payment", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Online payment is unavailable" })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(5);
  await expect(page.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to checkout" })).toHaveAttribute(
    "href",
    "/checkout",
  );

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 900 });
    await expect(
      page.getByRole("heading", { name: "Online payment is unavailable" }),
    ).toBeVisible();
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: Math.round(element.getBoundingClientRect().right),
        }))
        .filter((element) => element.right > window.innerWidth)
        .slice(0, 8),
    }));
    expect(
      overflow.document,
      `no horizontal overflow at ${width}px: ${JSON.stringify(overflow)}`,
    ).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `test-results/customer-payment-unavailable-${width}.png`,
      fullPage: true,
    });
  }
});
