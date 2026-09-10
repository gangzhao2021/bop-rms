import { readdir, readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// Credentials are typed only into a protected field; do not retain traces or failure screenshots.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("@demo Dining admission supports keyboard validation and explicit recovery", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("pageerror"));
  page.on("console", (value) => {
    if (value.type() === "error") errors.push("console error");
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (["fetch", "xhr"].includes(request.resourceType())) writes.push(request.method());
  });
  await page.goto("/?scenario=dining-admission");
  await expect(
    page.getByRole("heading", { name: "Dining UI Training Store", exact: true }),
  ).toBeVisible();
  const field = page.getByLabel("Join code or invitation", { exact: true });
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("12");
  await field.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Enter the six-digit code");
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await field.fill("123");
  await page.getByRole("button", { name: "Join table", exact: true }).click();
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  await field.fill("123456");
  await field.press("Enter");
  await expect(page.getByRole("button", { name: "Recover this attempt" })).toBeVisible();
  await expect(field).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Join this table", exact: true })).toBeFocused();
  expect(page.url()).not.toContain("123456");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.screenshot({
    path: `/private/tmp/bop-wp2308-${info.project.name}-unknown.png`,
    fullPage: true,
  });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Recover this attempt" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toBeFocused();
  await expect(page.getByText("No order has been placed.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: `/private/tmp/bop-wp2308-${info.project.name}-bound.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue to menu" }).click();
  await expect(page).toHaveURL(/\/menu$/u);
  await expect(
    page.getByRole("heading", { name: "Synthetic all-day menu", level: 1 }),
  ).toBeVisible();
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
  await expect(page.locator("vite-error-overlay")).toHaveCount(0);
});

test("@demo Dining admission pauses offline and never resumes on reconnect", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/?scenario=dining-admission");
  const field = page.getByLabel("Join code or invitation", { exact: true });
  await field.fill("123456");
  await context.setOffline(true);
  await expect(page.getByRole("button", { name: "Join table", exact: true })).toBeDisabled();
  await expect(field).toHaveValue("");
  await expect(page.getByText("Joining and recovery are paused", { exact: false })).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "Join table", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Recover this attempt" })).toHaveCount(0);
  await field.fill("123456");
  await page.getByRole("button", { name: "Join table", exact: true }).click();
  const recover = page.getByRole("button", { name: "Recover this attempt" });
  await expect(recover).toBeVisible();
  await context.setOffline(true);
  await expect(recover).toBeDisabled();
  await context.setOffline(false);
  await expect(recover).toBeEnabled();
  await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await recover.click();
  await expect(page.getByRole("heading", { name: "You’ve joined this table" })).toBeVisible();
});

test("@production Dining training query cannot activate the production entry", async ({ page }) => {
  const assets = new URL("../dist/assets/", import.meta.url);
  const scripts = (await readdir(assets)).filter((name) => name.endsWith(".js"));
  expect(scripts.length).toBeGreaterThan(0);
  for (const name of scripts) {
    const text = await readFile(new URL(name, assets), "utf8");
    expect(text).not.toContain("Dining UI Training Store");
    expect(text).not.toContain("synthetic unknown admission");
  }
  await page.goto("/?scenario=dining-admission");
  await expect(page.getByText("Dining UI Training Store", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Join code or invitation", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Scan the location QR code", exact: true }),
  ).toBeVisible();
});
