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

test("@production CUST-DINE-IN-SESSION stays source-limited at responsive widths", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/dine-in/session");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Your dining session" })).toBeVisible();
  await expect(main.getByRole("alert")).toContainText("Authorized session data is unavailable.");
  await expect(main.getByRole("listitem")).toHaveCount(4);
  await expect(main.getByRole("link", { name: "Return to entry" })).toHaveAttribute("href", "/");
  await expect(main.getByRole("button")).toHaveCount(0);
  await expect(main.getByText("Design Review", { exact: false })).toHaveCount(0);

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expectNoHorizontalOverflow(page);
    const card = await main.locator(".dining-session__unavailable").boundingBox();
    if (card === null) throw new Error("Dining Session unavailable card missing");
    expect(card.width).toBeLessThanOrEqual(width - 16);
    const header = await page.locator(".bop-shell__header").boundingBox();
    const navigation = await page
      .getByRole("navigation", { name: "Customer journey" })
      .boundingBox();
    if (header === null || navigation === null) {
      throw new Error("Customer frame is incomplete");
    }
    expect(header.width).toBe(width);
    expect(navigation.width).toBe(width);
    await page.screenshot({
      path: `test-results/customer-dining-session-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
