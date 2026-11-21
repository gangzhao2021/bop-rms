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
        ? { placedOrder: { orderReference: order, orderNumber: "13", notMade: false } }
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
        json: { ...cart(1), restored: { added: 1, alreadyPutBack: 0, unavailable: 1 } },
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

// Review (M03 round 2): a guest whose cart still shows dishes reaches checkout. Synthetic HTTP.
async function fullCart(
  page: Page,
  options: {
    readonly placedOrder?: { orderReference: string; orderNumber: string; notMade: boolean };
    readonly refuse?: boolean;
  },
) {
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const seen = { sessions: 0, payments: [] as string[] };
  await page.route("**/bff/customer/entry", (route) =>
    route.fulfill({
      status: 201,
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 2,
        status: "Established",
        brandDisplayName: "Synthetic Brand",
        storeDisplayName: "Synthetic Noodle Store",
        publicStoreReference: id(4),
        publicTableReference: null,
        channel: "Pickup",
        operatingState: "Open",
        availableServiceModes: ["Pickup"],
        locale: "en-CA",
        contextExpiresAt: expiresAt,
        csrfToken: "d".repeat(43),
      },
    }),
  );
  await page.route("**/bff/customer/cart**", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        schemaVersion: 1,
        cart: {
          cartReference: id(1),
          version: 3,
          orderType: "Pickup",
          serviceMode: "Pickup",
          context: { brandName: "Synthetic Brand", storeName: "Synthetic Noodle Store" },
          lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
          items: [
            {
              cartItemReference: id(2),
              sellableReference: id(3),
              displayName: "Beef noodle soup",
              quantity: 1,
              configuration: [],
              customerNote: null,
              lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
              warnings: [],
            },
          ],
          quote: null,
          warnings: [],
          ...(options.placedOrder ? { placedOrder: options.placedOrder } : {}),
        },
      },
    }),
  );
  await page.route("**/api/v1/carts/*/quote", (route) =>
    route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        quote: {
          quoteReference: id(5),
          quoteVersion: 1,
          cartVersion: 3,
          currency: "CAD",
          subtotal: { amountMinor: "1250", currency: "CAD" },
          discount: { amountMinor: "0", currency: "CAD" },
          tax: { amountMinor: "163", currency: "CAD" },
          fee: { amountMinor: "0", currency: "CAD" },
          total: { amountMinor: "1413", currency: "CAD" },
          expiresAt,
          warnings: [],
          blockingReasons: [],
          priceChange: null,
        },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/current", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        checkout: { cartReference: id(1), cartVersion: 3, orderType: "Pickup", details: null },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details/policy", (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        policy: {
          cartReference: id(1),
          cartVersion: 3,
          orderType: "Pickup",
          checkedAt: new Date(Date.now() - 1000).toISOString(),
          validUntil: expiresAt,
          documents: [],
        },
      },
    }),
  );
  await page.route("**/bff/customer/checkout-details", async (route) => {
    const request = route.request(),
      body = request.postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      json: {
        schemaVersion: 1,
        details: {
          operationReference: request.headers()["idempotency-key"],
          detailsReference: body.detailsReference,
          detailsVersion: 1,
          cartReference: id(1),
          cartVersion: 3,
          quoteReference: id(5),
          quoteVersion: 1,
          orderType: "Pickup",
          receiptChoice: "InSession",
          recordedAt: new Date().toISOString(),
        },
      },
    });
  });
  await page.route("**/api/v1/carts/*/checkout-sessions", (route) => {
    seen.sessions += 1;
    return route.fulfill({
      status: 409,
      json: {
        schemaVersion: 1,
        error: {
          code: "checkout_session_already_ordered",
          messageKey: "customer.checkoutSession.already_ordered",
          order: { orderReference: order, orderNumber: "13" },
        },
      },
    });
  });
  await page.route("**/api/v1/checkout-sessions/**", (route) => {
    seen.payments.push(route.request().url());
    return route.abort();
  });
  await page.goto("/#qr=aaa.bbb.ccc");
  await expect(
    page.getByRole("heading", { name: "Synthetic Noodle Store", exact: true }),
  ).toBeVisible();
  return seen;
}
async function openPath(page: Page, path: string) {
  await page.evaluate((target) => {
    history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const) {
  test(`@production a second tab's checkout of ordered dishes opens the order, never a conflict (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const seen = await fullCart(page, {});
    await openPath(page, "/checkout");
    await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible();
    await page.getByLabel("Pickup name", { exact: true }).fill("Synthetic Guest");
    await page.getByLabel("Mobile number", { exact: true }).fill("416 555 0123");
    await page.getByRole("button", { name: "No tip", exact: true }).click();
    await page.getByRole("button", { name: /Continue to payment/u }).click();
    await expect(page.getByRole("heading", { name: "Already ordered" })).toBeVisible();
    await expect(page.getByText("These dishes are in order 13.", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "View order status" })).toHaveAttribute(
      "href",
      "/orders/" + order,
    );
    // Not the generic conflict that sends the guest back to the same cart.
    await expect(page.getByRole("link", { name: "Change your cart" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Continue to payment/u })).toHaveCount(0);
    expect(seen.sessions).toBe(1);
    expect(seen.payments).toEqual([]);
    await expectNoInternalText(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `../../.local/screenshots/m03-second-tab-already-ordered-${viewport.width}.png`,
      fullPage: true,
    });
  });
}

test("@production a cart filled before the fix says its dishes are already in an order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const seen = await fullCart(page, {
    placedOrder: { orderReference: order, orderNumber: "13", notMade: false },
  });
  await openPath(page, "/cart");
  await expect(page.getByRole("heading", { name: "Already ordered" })).toBeVisible();
  await expect(
    page.getByText("The dishes in your cart are already in order 13", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "View order status" })).toHaveAttribute(
    "href",
    "/orders/" + order,
  );
  await expect(page.getByText("Beef noodle soup", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Checkout", exact: true })).toHaveCount(0);
  await page.screenshot({
    path: "../../.local/screenshots/m03-legacy-cart-page-390.png",
    fullPage: true,
  });
  // A bookmarked checkout says the same and offers no payment.
  await openPath(page, "/checkout");
  await expect(
    page.getByText("The dishes in your cart are already in order 13", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue to payment/u })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Go to your cart" })).toHaveAttribute(
    "href",
    "/cart",
  );
  expect(seen.sessions).toBe(0);
  await expectNoInternalText(page);
  await page.screenshot({
    path: "../../.local/screenshots/m03-legacy-checkout-already-ordered-390.png",
    fullPage: true,
  });
});

test("@production an emptied cart whose order closed unpaid offers its dishes back", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  let presses = 0;
  await page.route("**/bff/customer/cart**", async (route) => {
    const url = new URL(route.request().url());
    const empty = {
      schemaVersion: 1,
      cart: {
        cartReference: id(1),
        version: 3,
        orderType: "Pickup",
        serviceMode: "Pickup",
        context: { brandName: "Synthetic Brand", storeName: "Synthetic Noodle Store" },
        lifecycle: { status: "Active", idleExpiresAt: expiresAt, absoluteExpiresAt: expiresAt },
        items: [],
        quote: null,
        warnings: [],
        placedOrder: { orderReference: order, orderNumber: "13", notMade: true },
      },
    };
    if (url.pathname === "/bff/customer/cart/restore-order") {
      presses += 1;
      // As the server after the dishes were put back, ordered again and the cart emptied: the
      // press adds nothing.
      return route.fulfill({
        json: { ...empty, restored: { added: 0, alreadyPutBack: 1, unavailable: 0 } },
        headers: { "cache-control": "no-store" },
      });
    }
    return route.fulfill({ json: empty, headers: { "cache-control": "no-store" } });
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/customer/session/csrf")
      return route.fulfill({
        json: { schemaVersion: 1, csrfToken: "B".repeat(43) },
        headers: { "cache-control": "no-store" },
      });
    return route.fulfill({ status: 503, json: { unavailable: true } });
  });
  await page.goto("/cart");
  await expect(page.getByRole("heading", { name: "Order closed" })).toBeVisible();
  await expect(
    page.getByText("Order 13 was closed and won’t be made.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Open it to see whether it’s paid", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Put these dishes back in my cart" }).click();
  await expect(
    page.getByText("These dishes were already put back in your cart earlier.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Your dishes are back in your cart.")).toHaveCount(0);
  expect(presses).toBe(1);
  await expectNoInternalText(page);
  await page.screenshot({
    path: "../../.local/screenshots/m03-cart-order-closed-390.png",
    fullPage: true,
  });
});
