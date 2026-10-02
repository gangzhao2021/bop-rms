import { expect, test } from "@playwright/test";

test("@production Recipe Review hierarchy stays source-limited and responsive", async ({
  page,
}) => {
  const screens = [
    {
      path: "/app/commerce/recipes",
      heading: "Recipe management",
      eyebrow: "RECIPE-LIST · PHASE 2",
      notice: "Source-backed values unavailable",
      screenshot: "recipe-list",
    },
    {
      path: "/app/commerce/recipes/01909968-0000-7000-8000-000000000001/edit",
      heading: "Recipe editor",
      eyebrow: "RECIPE-EDITOR · PHASE 2",
      notice: "Editing and publish commands unavailable",
      screenshot: "recipe-editor",
    },
  ];

  for (const screen of screens) {
    await page.goto(screen.path);
    await expect(page.getByRole("heading", { name: screen.heading })).toBeVisible();
    await expect(page.getByText(screen.eyebrow, { exact: true })).toBeVisible();
    await expect(page.getByText(screen.notice, { exact: true })).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
    if (screen.path === "/app/commerce/recipes") {
      await expect(page.getByRole("heading", { name: "Recipes", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Name / code / ingredient" })).toBeDisabled();
      await expect(page.getByRole("combobox", { name: "Status" })).toBeDisabled();
      await expect(page.getByRole("combobox", { name: "Review issue" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Create · unavailable" })).toBeDisabled();
      await expect(page.locator(".recipe-list-unavailable__empty")).toContainText(
        "Recipe records are unavailable",
      );
    } else {
      for (const heading of [
        "Identity and yield",
        "Ingredients",
        "Preparation and substitution",
        "Allergen and cost review",
        "Product usage and version",
      ])
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "All Recipes" })).toBeVisible();
      await expect(
        page.getByText("Recipe name, code, status, yield and unit are unavailable."),
      ).toBeVisible();
    }
    await expect(page.getByText("Recipe name unavailable", { exact: true })).toHaveCount(0);

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: `test-results/${screen.screenshot}-${width}.png` });
    }
  }
});
