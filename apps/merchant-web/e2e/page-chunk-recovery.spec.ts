import { expect, test } from "@playwright/test";

// WP-2423 C2: screens outside the first download load on first use. When a screen's code does
// not arrive (old files gone after a deploy, or dropped Wi-Fi), the app reloads once to pick up
// new files, then shows plain words with "Try again" (a page reload once online, since browsers
// keep a failed module download) instead of a raw error.
test("@production a screen whose code does not arrive reloads once, then offers Try again", async ({
  page,
}) => {
  let blocked = true,
    documents = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documents += 1;
  });
  await page.route(/\/assets\/ReportPages-[^/]+\.js$/u, async (route) =>
    blocked ? route.abort("failed") : route.continue(),
  );
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toBeVisible({
    timeout: 15_000,
  });
  expect(documents).toBe(2);
  await expect(page.getByText(/PAGE_CHUNK|TypeError|Failed to fetch|import/u)).toHaveCount(0);
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("This device is still offline.", { exact: false })).toBeVisible();
  expect(documents).toBe(2);
  await page.context().setOffline(false);
  blocked = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  expect(documents).toBe(3);
  await expect(page.getByRole("heading", { name: "This page didn't load" })).toHaveCount(0);
});
