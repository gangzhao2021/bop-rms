import { expect, test, type Page } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));
test.use({ serviceWorkers: "block" });

// WP-2423 M03 (v15 orders 13 and 14, one cart version, both paid): after a paid pickup order the
// guest's pages never lead back to a payable checkout of the same dishes. Synthetic HTTP fixtures
// exercise the built UI; the refusal itself is proven by the database acceptance tests.
const id = (n: number) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const checkout = id(11),
  intent = id(12),
  order = id(13);

async function fixture(page: Page, payment: "Succeeded" | "NotCompleted") {
  const calls: { path: string; body: string | null }[] = [];
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  let restored = false;
  const cart = (items: number) => ({
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version: items === 0 ? 3 : 4,
      orderType: "Pickup",
      serviceMode: "Pickup",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Noodle Store" },
      lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
      items: Array.from({ length: items }, () => ({
        cartItemReference: id(2),
        sellableReference: id(3),
        displayName: "Beef noodle soup",
        quantity: 1,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
        warnings: [],
      })),
      quote: null,
      warnings: [],
      ...(items === 0 && payment === "Succeeded"
        ? { placedOrder: { orderReference: order, orderNumber: "13" } }
        : {}),
    },
  });
  await page.route("**/bff/customer/cart**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET") calls.push({ path: url.pathname, body: request.postData() });
    if (url.pathname === "/bff/customer/cart/restore-order") {
      restored = true;
      return route.fulfill({
        json: { ...cart(1), restored: { added: 1, unavailable: 1 } },
        headers: { "cache-control": "no-store" },
      });
    }
    return route.fulfill({
      json: cart(restored ? 1 : 0),
      headers: { "cache-control": "no-store" },
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET") calls.push({ path: url.pathname, body: request.postData() });
    const json = (value: unknown, status = 200) =>
      route.fulfill({ status, json: value, headers: { "cache-control": "no-store" } });
    if (url.pathname === "/api/v1/customer/session/csrf")
      return json({
        schemaVersion: 1,
        csrfToken: "B".repeat(43),
        checkoutSessionReference: checkout,
      });
    if (
      url.pathname === `/api/v1/checkout-sessions/${checkout}/payment-result` ||
      url.pathname === `/api/v1/checkout-sessions/${checkout}/payment-reconciliation`
    )
      return json({
        schemaVersion: 1,
        payment: {
          checkoutSessionReference: checkout,
          paymentIntentReference: intent,
          orderReference: order,
          status: payment === "Succeeded" ? "Succeeded" : "Failed",
          total: { amountMinor: "1413", currency: "CAD" },
          payBy: "2026-01-01T12:30:00.000Z",
          failure: payment === "NotCompleted" ? "NotCompleted" : null,
        },
      });
    return route.fulfill({ status: 503, json: { unavailable: true } });
  });
  return { calls };
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const) {
  test(`@production after paying, Back lands on the order, never on a payable checkout (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const api = await fixture(page, "Succeeded");
    await page.goto("/checkout/result");
    await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible();
    await expect(page.getByRole("link", { name: "View order status" })).toHaveAttribute(
      "href",
      "/orders/" + order,
    );
    await expect(page.getByRole("link", { name: "Back to menu" })).toHaveAttribute("href", "/menu");
    await expect(page.getByRole("link", { name: "Back to checkout" })).toHaveCount(0);
    await page.screenshot({
      path: `../../.local/screenshots/m03-paid-result-${viewport.width}.png`,
      fullPage: true,
    });

    // Browser Back, or an old bookmark of the checkout: the emptied cart names the order.
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: "Already ordered" })).toBeVisible();
    await expect(page.getByText("These dishes are in order 13.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "View order status" })).toHaveAttribute(
      "href",
      "/orders/" + order,
    );
    await expect(page.getByRole("button", { name: /Continue to payment|Pay/u })).toHaveCount(0);
    await expectNoInternalText(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `../../.local/screenshots/m03-checkout-already-ordered-${viewport.width}.png`,
      fullPage: true,
    });
    // Nothing on these pages starts a checkout or a payment.
    expect(api.calls).toEqual([]);
  });
}

test.describe("zh-Hans", () => {
  test.use({ locale: "zh-CN" });
  test("@production 已付款后返回结账：显示已经下单和订单号", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await fixture(page, "Succeeded");
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: "已经下单" })).toBeVisible();
    await expect(page.getByText("这些菜已经在订单 13 里。", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "查看订单状态" })).toBeVisible();
    await expectNoInternalText(page);
    await page.screenshot({
      path: "../../.local/screenshots/m03-checkout-already-ordered-zh-390.png",
    });
  });
});

test("@production a pickup payment that closed unpaid puts the dishes back with one tap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await fixture(page, "NotCompleted");
  await page.goto("/checkout/result");
  await expect(page.getByRole("heading", { name: "Payment not finished" })).toBeVisible();
  await expect(page.getByText("It wasn’t sent to the kitchen.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to checkout" })).toHaveCount(0);
  await page.getByRole("button", { name: "Put these dishes back in my cart" }).click();
  await expect(page.getByText("Your dishes are back in your cart.")).toBeVisible();
  await expect(
    page.getByText("1 dish can’t be ordered right now, so it wasn’t put back."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to your cart" })).toHaveAttribute(
    "href",
    "/cart",
  );
  expect(api.calls).toEqual([
    { path: "/bff/customer/cart/restore-order", body: JSON.stringify({ orderReference: order }) },
  ]);
  await expectNoInternalText(page);
  await page.screenshot({
    path: "../../.local/screenshots/m03-restore-dishes-390.png",
    fullPage: true,
  });
});
