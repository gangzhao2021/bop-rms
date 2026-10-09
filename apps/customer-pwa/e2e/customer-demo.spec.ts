import { expect, test, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SELLABLE_REFERENCE = "018f9900-0000-7000-8000-000000000003";
const ORDER_REFERENCE = "018f9900-0000-7000-8000-000000000014";

const routes = [
  { path: "/", heading: "Ready to order" },
  { path: "/menu", heading: "Synthetic all-day menu" },
  { path: "/menu/search", heading: "Search this menu" },
  {
    path: `/menu/items/${SELLABLE_REFERENCE}`,
    heading: "Synthetic mushroom rice bowl",
  },
  { path: "/cart", heading: "Your cart" },
  { path: "/checkout", heading: "Checkout" },
  { path: "/checkout/payment", heading: "Secure payment" },
  { path: "/checkout/result", heading: "Check your payment" },
  { path: `/orders/${ORDER_REFERENCE}`, heading: "Track your order" },
  { path: `/orders/${ORDER_REFERENCE}/delivery`, heading: "Track your delivery" },
  { path: `/orders/${ORDER_REFERENCE}/receipt`, heading: "Receipt" },
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
    await expect(main.getByText("$14.68", { exact: true }).first()).toBeVisible();
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
    await expect(page.getByRole("main").getByText("$14.68", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText("minor units");
    expect(violations).toEqual([]);
  });

  test("CUST-CART keeps the Figma hierarchy responsive with unavailable actions disabled", async ({
    page,
  }) => {
    const violations = monitorDemoBoundary(page);
    await page.goto("/cart");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Your cart", exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: "Order summary", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Clear cart" })).toHaveCount(0);
    await expect(main.locator(".cart-offline")).toBeVisible();
    await expect(main.getByRole("link", { name: "Checkout", exact: true })).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "Customer journey" })
        .getByRole("link", { name: "Menu", exact: true }),
    ).toHaveAttribute("href", "/menu");
    await expect(page.getByRole("heading", { level: 1, name: "Training Store" })).toBeVisible();

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await expectNoHorizontalOverflow(page);
      const layout = await main.locator(".cart-layout").evaluate((element) => {
        const style = getComputedStyle(element);
        const page = element.closest(".cart-page");
        const header = page?.querySelector(".bop-shell__header");
        const item = page?.querySelector(".cart-item");
        const summary = page?.querySelector(".cart-summary");
        return {
          columns: style.gridTemplateColumns.split(" ").length,
          background: page === null ? "missing" : getComputedStyle(page).backgroundColor,
          header:
            header === null || header === undefined
              ? "missing"
              : getComputedStyle(header).backgroundColor,
          item:
            item === null || item === undefined
              ? "missing"
              : getComputedStyle(item).backgroundColor,
          summary:
            summary === null || summary === undefined
              ? "missing"
              : getComputedStyle(summary).backgroundColor,
        };
      });
      expect(layout.background).toBe("rgb(255, 255, 255)");
      expect(layout.header).toBe("rgb(255, 255, 255)");
      expect(layout.item).toBe("rgb(255, 255, 255)");
      expect(layout.summary).toBe("rgb(255, 255, 255)");
      expect(layout.columns).toBe(width >= 768 ? 2 : 1);
      const navigationUsesOneRow = await page.locator(".bop-shell__nav").evaluate((element) => {
        const rows = [...element.children].map((child) => child.getBoundingClientRect().y);
        return rows.every((y) => Math.abs(y - (rows[0] ?? y)) < 1);
      });
      expect(navigationUsesOneRow, `Customer journey should use one row at ${width}px`).toBe(true);
      const quoteWarning = main.locator(".cart-summary .cart-warning").first();
      const quoteExpiry = main.locator(".cart-summary__validity");
      const warningBox = await quoteWarning.boundingBox();
      const expiryBox = await quoteExpiry.boundingBox();
      if (warningBox === null || expiryBox === null) throw new Error("Cart Quote fields missing");
      const verticalGap = warningBox.y - (expiryBox.y + expiryBox.height);
      expect(verticalGap).toBeGreaterThanOrEqual(8);
      await page.screenshot({
        path: `test-results/cust-cart-${width}.png`,
        fullPage: true,
      });
    }
    expect(violations).toEqual([]);
  });

  test("CUST-CHECKOUT keeps the Figma hierarchy responsive and payment gated", async ({ page }) => {
    const violations = monitorDemoBoundary(page);
    await page.goto("/checkout");
    const main = page.getByRole("main");
    await expect(page.getByRole("navigation", { name: "Customer journey" })).toBeVisible();
    await expect(main.getByRole("list", { name: "Checkout progress" })).toBeVisible();
    await expect(main).not.toContainText("Capacity Hold");
    await expect(main).not.toContainText("TRAINING_DATA_ONLY");
    await expect(main.getByRole("group", { name: "Tip amount" })).toBeVisible();
    await expect(main.getByRole("button", { name: /Continue to payment/u })).toBeDisabled();

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await expectNoHorizontalOverflow(page);
      const visual = await main.evaluate((element) => {
        const page = element as HTMLElement;
        const header = page.querySelector(".customer-heading");
        const card = page.querySelector(".checkout-summary");
        const progress = page.querySelector(".checkout-progress");
        return {
          canvas: getComputedStyle(page).backgroundColor,
          header: header === null ? "missing" : getComputedStyle(header).backgroundColor,
          card: card === null ? "missing" : getComputedStyle(card).backgroundColor,
          progress: progress === null ? "missing" : getComputedStyle(progress).display,
        };
      });
      expect(visual.canvas).toBe("rgba(0, 0, 0, 0)");
      expect(visual.header).not.toBe("missing");
      expect(visual.card).toBe("rgb(255, 255, 255)");
      expect(visual.progress).toBe("flex");
      const navRows = await page
        .locator(".bop-shell__nav")
        .evaluate((element) =>
          [...element.children].map((child) => child.getBoundingClientRect().y),
        );
      expect(navRows.every((y) => Math.abs(y - (navRows[0] ?? y)) < 1)).toBe(true);
      await page.screenshot({ path: `test-results/cust-checkout-${width}.png`, fullPage: true });
    }
    expect(violations).toEqual([]);
  });

  for (const route of routes) {
    test(`${route.heading} stays synthetic, local, and responsive`, async ({ page }) => {
      const violations = monitorDemoBoundary(page);
      await page.goto(route.path);
      await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();
      const main = page.getByRole("main");
      await expect(main).toBeVisible();
      const routeHeading = main.getByRole("heading", { name: route.heading, exact: true });
      if (route.path.startsWith("/menu/items/")) {
        await expect(
          main.getByRole("article").getByRole("heading", { name: route.heading }),
        ).toBeVisible();
      } else {
        await expect(routeHeading).toHaveCount(1);
        await expect(routeHeading).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
      expect(violations).toEqual([]);
    });
  }

  test("uses keyboard-reachable visible navigation for an accepted route", async ({ page }) => {
    const violations = monitorDemoBoundary(page);
    await page.goto("/");
    await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();

    const menuLink = page
      .getByRole("navigation", { name: "Customer journey" })
      .getByRole("link", { name: "Menu", exact: true });
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
