import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";

/**
 * merchant-outage-recovery M01: a busy or broken spell while a page is opened or reloaded never
 * leaves staff at "A current merchant session and Store are required."; the page says it is
 * reconnecting, keeps its navigation, and opens by itself once the system answers.
 */
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const headers = { "cache-control": "no-store" };
const scope = {
  brandLabel: "Synthetic Brand",
  storeLabel: "Synthetic Store",
  storeReference: id(99),
  timeZone: "America/Toronto",
};
const session = {
  authenticated: true,
  csrf: "a".repeat(43),
  workspace: {
    screenId: "HOME-OVERVIEW",
    selectedScope: scope,
    authorizedStores: [scope],
    businessDate: "2026-09-14",
    storeStatus: "Open",
    freshness: "Current",
    dashboardAvailability: "UnavailableUntilWP1905",
    navigation: [
      {
        screenId: "OPS-ORDER-QUEUE",
        label: "Orders",
        href: "/operations/orders",
        permission: "ordering.operate",
      },
      {
        screenId: "STORE-HOURS-SERVICE",
        label: "Hours & ordering",
        href: "/app/organization/stores/" + id(99) + "/service",
        permission: "store.service.read",
      },
    ],
  },
};
const order = {
  orderReference: id(100),
  orderNumber: "ORD-100",
  orderType: "Pickup",
  sourceChannel: "Web",
  submittedAt: "2026-09-14T00:00:00.000Z",
  observedAt: "2026-09-14T00:01:00.000Z",
  initialBatchReference: id(90),
  batches: [
    {
      orderBatchReference: id(90),
      sequence: 1,
      acceptanceStatus: "Accepted",
      canRequestAcceptance: false,
      canCancel: false,
      staffCancellation: null,
      canCancelItems: false,
    },
  ],
  canRequestAcceptance: false,
  currentPhase: "Accepted",
  currentVersion: 2,
  unfulfillable: null,
  pickupNotCollected: false,
  acceptBy: null,
  awaitingPayment: false,
  paidOnline: { amountMinor: "1130", currencyCode: "CAD" },
};
/** What the `front` proxy serves while the pilot service is stopped (DEC-PILOT-MAINTENANCE-PAGE). */
const maintenance = (route: Route) =>
  route.fulfill({
    status: 503,
    headers: { ...headers, "content-type": "text/html" },
    body: "<!doctype html><title>Maintenance</title><p>The system is being updated.</p>",
  });

async function routeOrders(page: Page) {
  await page.route("**/merchant/orders*", (route) =>
    route.fulfill({ headers, json: { items: [order], nextAfterOrderReference: null } }),
  );
}

for (const language of ["en", "zh-Hans"] as const) {
  test(`@production a page reloaded while the system is down reconnects by itself (${language})`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const zh = language === "zh-Hans";
    if (zh)
      await page.addInitScript(() => {
        window.localStorage.setItem("bop.merchant.language", "zh-Hans");
      });
    let down = false;
    let busy = 0;
    await page.route("**/merchant/session", (route) => {
      if (down) return maintenance(route);
      // The api's own "busy" answer is waited out inside the one read (no panel needed).
      if (busy > 0) {
        busy -= 1;
        return route.fulfill({ status: 503, headers, json: { error: "retry_later" } });
      }
      return route.fulfill({ headers, json: session });
    });
    await routeOrders(page);
    await page.goto("/operations/orders");
    await expect(page.getByRole("heading", { name: "ORD-100", exact: true })).toBeVisible();

    down = true;
    await page.reload();
    const panel = page.locator(".workspace-reconnect");
    await expect(panel).toContainText(zh ? "暂时连不上" : "Can't connect right now");
    await expect(panel).toContainText(zh ? "可能会被自动退款" : "may be refunded automatically");
    await expect(page.getByText("A current merchant session")).toHaveCount(0);
    await expect(page.getByText("需要当前有效的商户登录和门店")).toHaveCount(0);
    // The navigation this tab last showed stays, without the Store-addressed link.
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: zh ? "订单" : "Orders" }).first()).toBeAttached();
    expect(
      await page.evaluate(() => sessionStorage.getItem("bop.workspace.frame.v1") ?? ""),
    ).not.toContain(id(99));
    await expectNoInternalText(page);

    // Back up: the page opens by itself, with no reload or tap.
    down = false;
    busy = 2;
    await expect(page.getByRole("heading", { name: "ORD-100", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(panel).toHaveCount(0);
  });
}

test("@production an offline device says so and opens again as soon as the network is back", async ({
  page,
  context,
}) => {
  test.setTimeout(60_000);
  let release: (() => void) | null = null;
  let first = true;
  await page.route("**/merchant/session", async (route) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => (release = resolve));
      return route.abort("internetdisconnected");
    }
    return route.fulfill({ headers, json: session });
  });
  await routeOrders(page);
  await page.goto("/operations/orders");
  await expect.poll(() => release !== null).toBe(true);
  await context.setOffline(true);
  (release as unknown as () => void)();
  const panel = page.locator(".workspace-reconnect");
  await expect(panel).toContainText("This device is offline");
  await expect(page.getByText("A current merchant session")).toHaveCount(0);
  await context.setOffline(false);
  // The "online" event retries at once (well before the 5 s timer).
  await expect(page.getByRole("heading", { name: "ORD-100", exact: true })).toBeVisible({
    timeout: 4_000,
  });
});

test("@production a sign-out is still a sign-out, not a reconnect", async ({ page }) => {
  let reads = 0;
  await page.route("**/merchant/session", (route) => {
    reads += 1;
    return route.fulfill({ status: 401, headers, json: { error: "session_ended" } });
  });
  await page.goto("/operations/orders");
  await expect(page.locator(".workspace-reconnect")).toHaveCount(0);
  await page.waitForTimeout(6_000);
  expect(reads).toBe(1);
});

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error("not laid out");
  return found;
}

for (const width of [390, 1024, 1440])
  test(`@production the reconnecting page reads as a page at ${width}: clear of the language switch, with margins and a real Try now button`, async ({
    page,
  }) => {
    // Live v15 2026-11-10: its first line ran under 中文, it sat flush against the sidebar and the
    // top edge (and the phone's left edge), and Try now looked like plain text.
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    let down = false;
    await page.route("**/merchant/session", (route) =>
      down ? maintenance(route) : route.fulfill({ headers, json: session }),
    );
    await routeOrders(page);
    await page.goto("/operations/orders");
    await expect(page.getByRole("heading", { name: "ORD-100", exact: true })).toBeVisible();
    down = true;
    await page.reload();
    const heading = page.getByRole("heading", { name: "Can't connect right now", level: 1 });
    await expect(heading).toBeVisible();
    const language = page.getByRole("button", { name: "切换到中文" });
    await expect(language).toHaveCount(1);
    const h = await box(heading);
    const l = await box(language);
    const overlaps =
      h.x < l.x + l.width && l.x < h.x + h.width && h.y < l.y + l.height && l.y < h.y + h.height;
    expect(overlaps).toBe(false);
    // Margins: off the top edge, and off the sidebar (or the phone's edge) by the page gutter.
    expect(h.y).toBeGreaterThanOrEqual(16);
    const text = await box(page.getByText("Retrying on its own.", { exact: false }));
    if (width === 390) expect(text.x).toBeGreaterThanOrEqual(16);
    else {
      const nav = await box(page.locator(".workspace-sidebar"));
      expect(text.x).toBeGreaterThanOrEqual(nav.x + nav.width + 16);
    }
    // Try now is drawn as a button (a border or a fill), at least 44 px tall.
    const tryNow = page.getByRole("button", { name: "Try now" });
    const look = await tryNow.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        border: style.borderTopStyle !== "none" && parseFloat(style.borderTopWidth) > 0,
        fill:
          style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent",
        height: element.getBoundingClientRect().height,
      };
    });
    expect(look.border || look.fill).toBe(true);
    expect(look.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: `test-results/reconnect-${width}.png` });
    await expectNoInternalText(page);
  });
