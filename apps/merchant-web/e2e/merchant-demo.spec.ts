import { expect, test, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const STORE_REFERENCE = "018f8100-0000-7000-8000-000000000001";
const MENU_REFERENCE = "018f7600-0000-7000-8000-000000000001";
const ORDER_REFERENCE = "018f7600-0000-7000-8000-000000000001";
const WORK_ITEM_REFERENCE = "018f0f58-767a-7f3b-a1d0-000000000401";

const routes = [
  { path: "/app", identity: "HOME-OVERVIEW" },
  { path: "/app/organization/stores", identity: "STORE-LIST" },
  { path: `/app/organization/stores/${STORE_REFERENCE}`, identity: "STORE-DETAIL" },
  { path: `/app/organization/stores/${STORE_REFERENCE}/setup`, identity: "STORE-SETUP" },
  {
    path: `/app/organization/stores/${STORE_REFERENCE}/service`,
    identity: "STORE-HOURS-SERVICE",
  },
  { path: "/app/commerce/menus", identity: "CAT-MENU-LIST" },
  { path: `/app/commerce/menus/${MENU_REFERENCE}/edit`, identity: "CAT-MENU-BUILDER" },
  { path: "/operations/orders", identity: "OPS-ORDER-QUEUE" },
  { path: `/operations/orders/${ORDER_REFERENCE}`, identity: "OPS-ORDER-DETAIL" },
  { path: "/operations/kitchen", identity: "KIT-KITCHEN-QUEUE" },
  {
    path: `/operations/kitchen/work-items/${WORK_ITEM_REFERENCE}`,
    identity: "KIT-WORK-ITEM",
  },
  { path: "/app/compliance", identity: "CMP-DASHBOARD" },
  { path: "/platform/support-cases", identity: "PLT-SUPPORT-CASE" },
] as const;

function monitorBrowserBoundary(page: Page) {
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

test.describe("@demo local-only Merchant showcase", () => {
  for (const route of routes) {
    test(`${route.identity} stays synthetic, local, and responsive`, async ({ page }) => {
      const violations = monitorBrowserBoundary(page);
      await page.goto(route.path);
      await expect(page.getByText(route.identity, { exact: false }).first()).toBeVisible();
      await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(violations).toEqual([]);
    });
  }

  test("uses an accessible visible link for an accepted workflow", async ({ page }) => {
    const violations = monitorBrowserBoundary(page);
    await page.goto("/app");
    await expect(page.getByRole("status", { name: "Local synthetic preview" })).toBeVisible();

    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    for (let tabIndex = 0; tabIndex < 5; tabIndex += 1) {
      if (await skipLink.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();

    const orderQueue = page.getByRole("link", { name: /Order Queue/ });
    await expect(orderQueue).toBeVisible();
    await orderQueue.click();
    await expect(page).toHaveURL(/\/operations\/orders$/u);
    await expect(page.getByText("OPS-ORDER-QUEUE", { exact: false }).first()).toBeVisible();
    expect(violations).toEqual([]);
  });
});

test.describe("@production production demo exclusion", () => {
  test("excludes demo modules and bounded fixture markers from emitted assets", async () => {
    const dist = path.resolve(import.meta.dirname, "../dist");
    const files = await filesBelow(dist);
    expect(files.some((file) => path.basename(file).includes("merchant-demo"))).toBe(false);

    const textAssets = files.filter((file) => /\.(?:html|js|css)$/u.test(file));
    const emittedText = (await Promise.all(textAssets.map((file) => readFile(file, "utf8")))).join(
      "\n",
    );
    for (const marker of [
      "Local synthetic preview",
      "Synthetic daily summary",
      "Synthetic Training Store",
      "PLATFORM · NONPRODUCTION",
    ])
      expect(emittedText).not.toContain(marker);
  });

  for (const route of routes) {
    test(`${route.identity} fails closed without synthetic authority`, async ({ page }) => {
      const violations = monitorBrowserBoundary(page);
      await page.route("**/merchant/session", async (request) =>
        request.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
      );
      await page.goto(route.path);
      await expect(page.getByRole("status", { name: "Local synthetic preview" })).toHaveCount(0);
      await expect(page.getByText(/Sign in required|unavailable/iu).first()).toBeVisible();
      expect(violations).toHaveLength(2);
      expect(violations).toEqual(
        expect.arrayContaining([
          "application request: GET /merchant/session",
          "console: Failed to load resource: the server responded with a status of 401 (Unauthorized)",
        ]),
      );
    });
  }
});
