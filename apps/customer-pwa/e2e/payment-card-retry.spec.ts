import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY). Synthetic HTTP and Stripe SDK fixtures exercise the built
// UI; they do not prove live Guest authorization, Provider declines or Stripe acceptance.
const checkout = "0190fa21-0000-7000-8000-000000000011";
const intent = "0190fa21-0000-7000-8000-000000000012";
const order = "0190fa21-0000-7000-8000-000000000013";
test.use({ serviceWorkers: "block" });

const syntheticStripe = `window.syntheticCard = { mounts: 0, confirms: 0 };
window.Stripe = function() { return {
  elements: function() { return {
    create: function(type, options) {
      if (type !== "payment" || options.wallets.applePay !== "never" ||
          options.wallets.googlePay !== "never") throw Error("invalid secure options");
      var handlers = {}, host;
      return {
        on: function(event, callback) { handlers[event] = callback; },
        mount: function(target) {
          host = target; host.textContent = "Synthetic secure card component";
          window.syntheticCard.mounts++;
          queueMicrotask(function() { handlers.ready(); });
        },
        destroy: function() { if (host) host.textContent = ""; }
      };
    },
    submit: async function() { return {}; }
  }; },
  confirmPayment: async function() {
    window.syntheticCard.confirms++;
    return { paymentIntent: { status: "succeeded" } };
  }
}; };`;

async function fixture(page: Page, options: { retry?: { status: number; code?: string } } = {}) {
  const calls: { path: string; body: string | null; key: string | undefined }[] = [];
  let result: "Failed" | "Succeeded" = "Failed";
  await page.route("https://js.stripe.com/**", (route) =>
    route.fulfill({ contentType: "application/javascript", body: syntheticStripe }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() !== "GET")
      calls.push({
        path: url.pathname,
        body: request.postData(),
        key: request.headers()["idempotency-key"],
      });
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
          status: result,
          total: { amountMinor: "2260", currency: "CAD" },
          payBy: "2099-01-01T12:30:00.000Z",
          failure: result === "Failed" ? "Declined" : null,
        },
      });
    if (url.pathname === `/api/v1/checkout-sessions/${checkout}/payment-intents`) {
      const retry = options.retry ?? { status: 201 };
      if (retry.code)
        return json(
          { schemaVersion: 1, error: { code: retry.code, messageKey: "customer.payment" } },
          retry.status,
        );
      return json(
        {
          schemaVersion: 1,
          payment: {
            checkoutSessionReference: checkout,
            paymentIntentReference: intent,
            orderReference: order,
            creationStatus: "Created",
            total: { amountMinor: "2260", currency: "CAD" },
          },
        },
        201,
      );
    }
    if (url.pathname === `/api/v1/checkout-sessions/${checkout}/payment-handoff`)
      return json({ schemaVersion: 1, clientSecret: "pi_SyntheticRetry_secret_SyntheticOnly" });
    return route.fulfill({ status: 503, json: { unavailable: true } });
  });
  return {
    calls,
    approveNextRead() {
      result = "Succeeded";
    },
  };
}

async function noOverflowOrBlockingAxe(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => violation.id),
  ).toEqual([]);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const) {
  test(`@production a declined card can be replaced by another card (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const api = await fixture(page);
    await page.goto("/checkout/result");
    await expect(page.getByRole("heading", { name: "Payment declined" })).toBeVisible();
    await expect(
      page.getByText(
        "Your card was declined. Try another card or ask staff to pay at the counter.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByText("Amount to pay: $22.60")).toBeVisible();
    // Reading the result never starts another payment.
    expect(api.calls.filter((call) => !call.path.endsWith("/payment-reconciliation"))).toEqual([]);
    await noOverflowOrBlockingAxe(page);

    await page.getByRole("button", { name: "Try another card", exact: true }).click();
    await expect(page.getByText("Synthetic secure card component")).toBeVisible();
    // The retry names no amount, tip or selection: the server keeps the same payment.
    expect(
      api.calls
        .filter((call) => !call.path.endsWith("/payment-reconciliation"))
        .map((call) => [call.path.split("/").at(-1), call.body, call.key]),
    ).toEqual([
      ["payment-intents", JSON.stringify({ retry: true }), undefined],
      ["payment-handoff", "{}", undefined],
    ]);
    await noOverflowOrBlockingAxe(page);

    api.approveNextRead();
    await page.getByRole("button", { name: "Pay securely", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try another card" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(intent);
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });
  });
}

for (const [code, status, text] of [
  [
    "payment_retry_limit",
    409,
    "This order has reached the limit of card tries. Ask staff to pay at the counter.",
  ],
  [
    "payment_window_ended",
    422,
    "The time to pay for this order has ended, so you haven’t been charged. Ask staff for help.",
  ],
] as const) {
  test(`@production explains when another card cannot be tried: ${code}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const api = await fixture(page, { retry: { status, code } });
    await page.goto("/checkout/result");
    await page.getByRole("button", { name: "Try another card", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: text })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try another card" })).toHaveCount(0);
    expect(
      api.calls
        .map((call) => call.path.split("/").at(-1))
        .filter((path) => path !== "payment-reconciliation"),
    ).toEqual(["payment-intents"]);
    await expect(page.locator("body")).not.toContainText(code);
    await noOverflowOrBlockingAxe(page);
  });
}
