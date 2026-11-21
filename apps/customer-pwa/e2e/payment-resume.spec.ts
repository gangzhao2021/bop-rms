import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { routeStorefrontReads } from "./storefront-reads";

// WP-2423: every page with a Store context reads the Store's identity (and the menu for
// cart lines not yet priced); spec routes registered later still answer first.
test.beforeEach(({ context }) => routeStorefrontReads(context));

// WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT). Synthetic HTTP and Stripe SDK fixtures exercise the built
// UI; they do not prove live Guest authorization or Stripe acceptance.
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

async function fixture(page: Page, initial: "Pending" | "Failed" = "Pending") {
  const calls: { path: string; body: string | null; key: string | undefined }[] = [];
  let result: "Pending" | "Failed" | "Succeeded" = initial;
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
          total: { amountMinor: "1689", currency: "CAD" },
          payBy: initial === "Pending" ? "2099-01-01T12:30:00.000Z" : "2026-01-01T12:30:00.000Z",
          failure: result === "Failed" ? "NotCompleted" : null,
        },
      });
    if (url.pathname === `/api/v1/checkout-sessions/${checkout}/payment-intents`)
      return json({
        schemaVersion: 1,
        payment: {
          checkoutSessionReference: checkout,
          paymentIntentReference: intent,
          orderReference: order,
          creationStatus: "AlreadyCreated",
          total: { amountMinor: "1689", currency: "CAD" },
        },
      });
    if (url.pathname === `/api/v1/checkout-sessions/${checkout}/payment-handoff`)
      return json({ schemaVersion: 1, clientSecret: "pi_SyntheticResume_secret_SyntheticOnly" });
    return route.fulfill({ status: 503, json: { unavailable: true } });
  });
  return {
    calls,
    approveNextRead() {
      result = "Succeeded";
    },
  };
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
] as const) {
  test(`@production a guest who left the payment page finishes the same payment (${viewport.width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const api = await fixture(page);
    await page.goto("/checkout/payment");
    await expect(page.getByRole("heading", { name: "Payment not confirmed yet" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Finish paying" })).toBeVisible();
    await expect(page.getByText("Amount to pay: $16.89", { exact: false })).toBeVisible();
    // Reading the result never starts a payment.
    expect(api.calls.filter((call) => !call.path.endsWith("/payment-reconciliation"))).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      axe.violations
        .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
        .map((violation) => violation.id),
    ).toEqual([]);

    await page.getByRole("button", { name: "Finish paying", exact: true }).click();
    await expect(page.getByText("Synthetic secure card component")).toBeVisible();
    // The same payment: no amount, tip or selection is sent, and no new attempt is asked for.
    expect(
      api.calls
        .filter((call) => !call.path.endsWith("/payment-reconciliation"))
        .map((call) => [call.path.split("/").at(-1), call.body, call.key]),
    ).toEqual([
      ["payment-intents", JSON.stringify({ resume: true }), undefined],
      ["payment-handoff", "{}", undefined],
    ]);
    api.approveNextRead();
    await page.getByRole("button", { name: "Pay securely", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Finish paying" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(intent);
  });
}

test("@production a payment never finished in time says it was cancelled and nothing was charged", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const api = await fixture(page, "Failed");
  await page.goto("/checkout/result");
  await expect(page.getByRole("heading", { name: "Payment not finished" })).toBeVisible();
  await expect(
    page.getByText(
      "This payment wasn’t finished in time, so it was cancelled. Nothing was charged.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try another card" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finish paying" })).toHaveCount(0);
  expect(api.calls.filter((call) => !call.path.endsWith("/payment-reconciliation"))).toEqual([]);
});

// v15 2026-11-01: "Finish paying" opened the payment form (the card form, or the TEST-ONLY
// simulator's Confirm / Decline), and the page's next automatic check (every few seconds while the
// payment is open) removed it again, so a guest who came back could never finish. The form stays
// through the checks; the same payment is paid once. (The simulator's form is only offered on the
// local InternalTest address, so this browser check uses the card form; both are the same panel.)
test("@production a guest who comes back keeps the payment form through the automatic checks", async ({
  page,
}) => {
  const api = await fixture(page);
  await page.goto("/checkout/payment");
  await expect(page.getByRole("heading", { name: "Payment not confirmed yet" })).toBeVisible();
  await page.getByRole("button", { name: "Finish paying", exact: true }).click();
  const form = page.getByText("Synthetic secure card component");
  await expect(form).toBeVisible();
  // The page checks the payment again on its own (after 3 s); the form stays.
  const checks = () =>
    api.calls.filter((call) => call.path.endsWith("/payment-reconciliation")).length;
  const before = checks();
  await expect.poll(checks, { timeout: 10_000 }).toBeGreaterThan(before);
  await expect(form).toBeVisible();
  api.approveNextRead();
  await page.getByRole("button", { name: "Pay securely", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Payment confirmed" })).toBeVisible();
  expect(
    api.calls
      .filter((call) => !call.path.endsWith("/payment-reconciliation"))
      .map((call) => [call.path.split("/").at(-1), call.body]),
  ).toEqual([
    ["payment-intents", JSON.stringify({ resume: true })],
    ["payment-handoff", "{}"],
  ]);
});

// WP-2423 item 2: this page says the guest may have entered a card already, so a form that doesn't
// load proves nothing was charged.
test("@production coming back to a payment whose form won't load never says it wasn't charged", async ({
  page,
}) => {
  await fixture(page);
  await page.route("https://js.stripe.com/**", (route) => route.abort("failed"));
  await page.goto("/checkout/payment");
  await page.getByRole("button", { name: "Finish paying", exact: true }).click();
  const form = page.getByRole("region", { name: "Secure card payment" });
  await expect(form.getByRole("alert")).toContainText(
    "If you already entered your card, ask a staff member to check before paying again.",
  );
  await expect(form).not.toContainText("hasn’t been charged");
  await expect(form.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
});
