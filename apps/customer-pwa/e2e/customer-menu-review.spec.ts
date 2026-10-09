import { expect, test } from "@playwright/test";

test("CUST-MENU follows the Figma Review hierarchy at 1440, 390, and 320px @demo", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("pageerror", (error) => violations.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") violations.push(message.text());
  });

  await page.goto("/");
  await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Preview routes" })
    .getByRole("link", {
      name: "Menu",
      exact: true,
    })
    .click();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const main = page.getByRole("main");
    const menuHeading = main.getByRole("heading", { name: "Synthetic all-day menu", exact: true });
    await expect(menuHeading).toBeVisible();
    if (viewport.width === 1440) {
      await expect(menuHeading).toBeFocused();
      await menuHeading.evaluate((element) => (element as HTMLElement).blur());
    }
    await expect(
      main.getByRole("heading", { name: "Training favourites", exact: true }),
    ).toBeVisible();
    await expect(
      main.getByRole("link", { name: "View Synthetic mushroom rice bowl" }),
    ).toBeVisible();
    await expect(main.getByText("Priced at checkout", { exact: true }).first()).toBeVisible();
    await expect(main.getByText("Contains: Soy", { exact: true })).toBeVisible();
    await expect(main).not.toContainText("$0");
    await expect(
      page.getByRole("navigation", { name: "Customer journey" }).getByText("Menu", { exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/customer-menu-${viewport.width}.png`,
      fullPage: true,
    });
  }

  expect(violations).toEqual([]);
});
