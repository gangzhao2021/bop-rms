import { expect, test } from "@playwright/test";

test("CUST-MENU-SEARCH follows the Make search hierarchy @demo", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Preview routes" })
    .getByRole("link", {
      name: "Menu",
      exact: true,
    })
    .click();
  await page
    .getByRole("navigation", { name: "Menu" })
    .getByRole("link", {
      name: "Search menu",
      exact: true,
    })
    .click();

  const main = page.getByRole("main");
  await expect(main.getByLabel("Menu section")).toBeEnabled();
  await expect(main.getByText("Dietary tags are not provided by this menu.")).toBeVisible();
  await page.getByLabel("Search the menu").fill("iced");
  await main.getByLabel("Menu section").selectOption({ label: "Training favourites" });
  await main.getByRole("button", { name: "Search", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Search results" })).toBeVisible();
  await expect(main.getByText("Matched term · iced")).toBeVisible();
  await expect(main.getByRole("heading", { name: "Synthetic iced tea" })).toBeVisible();
  await expect(main.locator(".menu-result-section")).toContainText("Training favourites");
  await expect(main.getByText("Price confirmed in your final quote")).toBeVisible();
  await expect(main.getByText("Image not available")).toBeVisible();
  await expect(main.getByRole("link", { name: "View Synthetic iced tea" })).toBeVisible();
  await expect(main).not.toContainText("Synthetic mushroom rice bowl");

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(main.getByRole("heading", { name: "Search results" })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
    await page.screenshot({
      path: `test-results/customer-menu-search-${viewport.width}.png`,
      fullPage: true,
    });
  }

  await main.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Search this menu" })).toBeVisible();
  await expect(main.getByLabel("Search the menu")).toHaveValue("");
  await expect(main.getByLabel("Menu section")).toHaveValue("");
  expect(errors).toEqual([]);
});
