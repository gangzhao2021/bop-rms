import { expect, test, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SELLABLE_REFERENCE = "018f9900-0000-7000-8000-000000000003";
const ORDER_REFERENCE = "018f9900-0000-7000-8000-000000000014";

const routes = [
  { path: "/", heading: "Training Store" },
  { path: "/menu", heading: "Synthetic all-day menu" },
  { path: "/menu/search", heading: "Search this menu" },
  {
    path: `/menu/items/${SELLABLE_REFERENCE}`,
    heading: "Synthetic mushroom rice bowl",
  },
  { path: "/cart", heading: "Your cart" },
  { path: "/checkout", heading: "Review your order" },
  { path: "/checkout/payment", heading: "Continue to payment" },
  { path: "/checkout/result", heading: "Verify your payment" },
  { path: `/orders/${ORDER_REFERENCE}`, heading: "Track your order" },
  { path: `/orders/${ORDER_REFERENCE}/delivery`, heading: "Track your delivery" },
  { path: `/orders/${ORDER_REFERENCE}/receipt`, heading: "Your receipt" },
] as const;

function monitorDemoBoundary(page: Page) {
  const violations: string[] = [];
  page.on("pageerror", (error) => violations.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") violations.push(`console: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") violations.push(`non-loopback request: ${request.url()}`);
    if (["fetch", "xhr"].includes(request.resourceType()))
      violations.push(`application request: ${request.method()} ${url.pathname}`);
  });
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).hostname !== "127.0.0.1")
      violations.push(`non-loopback websocket: ${socket.url()}`);
  });
  return violations;
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const target = path.join(root, entry.name);
      return entry.isDirectory() ? filesBelow(target) : Promise.resolve([target]);
    }),
  );
  return nested.flat();
}

test.describe("@demo local-only Customer preview", () => {
  test("WP-2226 Continue shopping retains the document and displays exact CAD amounts", async ({
    page,
  }) => {
    const violations = monitorDemoBoundary(page);
    await page.goto("/cart");
    const main = page.getByRole("main");
    await expect(main.getByText("CAD 14.68", { exact: true }).first()).toBeVisible();
    await expect(main).not.toContainText("minor units");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-navigation-probe", "retained"),
    );
    const continueShopping = main.getByRole("link", { name: "Continue shopping", exact: true });
    await continueShopping.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/menu$/u);
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Synthetic all-day menu", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-navigation-probe", "retained");
    await expectNoHorizontalOverflow(page);
    await page.goto("/checkout");
    await expect(
      page.getByRole("main").getByText("CAD 14.68", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("minor units");
    expect(violations).toEqual([]);
  });

  for (const route of routes) {
    test(`${route.heading} stays synthetic, local, and responsive`, async ({ page }) => {
      const violations = monitorDemoBoundary(page);
      await page.goto(route.path);
      await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();
      const main = page.getByRole("main");
      await expect(main).toBeVisible();
      await expect(main.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(violations).toEqual([]);
    });
  }

  test("uses keyboard-reachable visible navigation for an accepted route", async ({ page }) => {
    const violations = monitorDemoBoundary(page);
    await page.goto("/");
    await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();

    const menuLink = page.getByRole("link", { name: "Menu", exact: true });
    for (let tabIndex = 0; tabIndex < 12; tabIndex += 1) {
      if (await menuLink.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(menuLink).toBeFocused();
    await expect(menuLink).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/menu$/u);
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Synthetic all-day menu", exact: true }),
    ).toBeVisible();
    expect(violations).toEqual([]);
  });
});

test.describe("@production production demo exclusion", () => {
  test("excludes demo modules and bounded fixture markers from emitted assets", async () => {
    const dist = path.resolve(import.meta.dirname, "../dist");
    const files = await filesBelow(dist);
    expect(files.some((file) => path.basename(file).includes("customer-demo"))).toBe(false);

    const textAssets = files.filter((file) => /\.(?:html|js|css)$/u.test(file));
    const emittedText = (await Promise.all(textAssets.map((file) => readFile(file, "utf8")))).join(
      "\n",
    );
    for (const marker of [
      "Local synthetic preview",
      "Read-only training data",
      "Synthetic Kitchen",
      "Synthetic mushroom rice bowl",
    ])
      expect(emittedText).not.toContain(marker);
  });

  for (const route of routes) {
    test(`${route.heading} has no production demo authority`, async ({ page }) => {
      await page.route("**/customer/**", async (request) =>
        request.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
      );
      await page.goto(route.path);
      await expect(page.getByRole("status", { name: "Local synthetic preview" })).toHaveCount(0);
      await expect(page.getByText("Read-only training data", { exact: false })).toHaveCount(0);
    });
  }
});
