import { expect, test } from "@playwright/test";
// Synthetic HTTP interception on the production PWA, not live Store/Pricing evidence.
const id = (n: number) => "018f8800-0000-7000-8000-" + n.toString(16).padStart(12, "0");
for (const screen of [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "narrow touch", width: 390, height: 844, touch: true },
]) {
  test.describe("@production Checkout continuity " + screen.name, () => {
    test.use({
      viewport: { width: screen.width, height: screen.height },
      hasTouch: screen.touch,
      isMobile: screen.touch,
      serviceWorkers: "block",
    });
    for (const terminal of ["attached", "expired", "payment", "payment-failed"])
      test(
        "retains one Quote intent across unknown, offline and explicit retry: " + terminal,
        async ({ page, context }) => {
          const failures: string[] = [];
          page.on("pageerror", () => failures.push("page error"));
          page.on("console", (message) => {
            if (
              message.type() === "error" &&
              !(message.location().url.endsWith("/quote") && /503|410/u.test(message.text()))
            )
              failures.push("unexpected console error");
          });
          const expiresAt = new Date(Date.now() + 600_000).toISOString();
          const csrf = "c".repeat(43);
          const quoteCalls: { key: string | undefined; body: unknown }[] = [];
          const view = {
            schemaVersion: 1,
            cart: {
              cartReference: id(1),
              version: 3,
              orderType: "Pickup",
              serviceMode: "Pickup",
              context: { brandName: "Synthetic Brand", storeName: "Synthetic Checkout Store" },
              lifecycle: {
                status: "Active",
                idleExpiresAt: expiresAt,
                absoluteExpiresAt: expiresAt,
              },
              items: [
                {
                  cartItemReference: id(2),
                  sellableReference: id(3),
                  displayName: "Synthetic tea",
                  quantity: 1,
                  configuration: [],
                  customerNote: null,
                  lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
                  warnings: [],
                },
              ],
              quote: null,
              warnings: [],
            },
          };
          await page.route("**/bff/customer/entry", (route) =>
            route.fulfill({
              status: 201,
              headers: { "cache-control": "no-store" },
              json: {
                schemaVersion: 2,
                status: "Established",
                brandDisplayName: "Synthetic Brand",
                storeDisplayName: "Synthetic Checkout Store",
                publicStoreReference: id(4),
                publicTableReference: null,
                channel: "Pickup",
                operatingState: "Open",
                availableServiceModes: ["Pickup"],
                locale: "en-CA",
                contextExpiresAt: expiresAt,
                csrfToken: csrf,
              },
            }),
          );
          await page.route("**/bff/customer/cart", (route) =>
            route.fulfill({ status: 200, json: view }),
          );
          const policyDocument = {
            documentReference: id(8),
            documentVersion: 1,
            documentDigest: "sha256:" + "a".repeat(64),
            purposeCode: "CHECKOUT_TERMS",
          };
          const savedDetails = {
            detailsReference: id(7),
            detailsVersion: 2,
            cartReference: id(1),
            cartVersion: 2,
            quoteReference: id(6),
            quoteVersion: 1,
            pickupContact: { name: "Synthetic Guest", channel: "Phone", value: "+15555550100" },
            receipt: { choice: "InSession", email: null },
            policies: [policyDocument],
            recordedAt: new Date(Date.now() - 60_000).toISOString(),
          };
          await page.route("**/bff/customer/checkout-details/current", (route) =>
            route.fulfill({
              json: {
                schemaVersion: 1,
                checkout: {
                  cartReference: id(1),
                  cartVersion: 3,
                  orderType: "Pickup",
                  details: savedDetails,
                },
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
                  documents: [
                    {
                      ...policyDocument,
                      title: "Synthetic checkout terms",
                      bodyText:
                        "<script>window.policyExecuted=true</script>\nSynthetic display only.",
                    },
                  ],
                },
              },
            }),
          );
          const detailCalls: { key: string | undefined; body: Record<string, unknown> }[] = [];
          await page.route("**/bff/customer/checkout-details", async (route) => {
            const request = route.request(),
              body = request.postDataJSON() as Record<string, unknown>;
            expect(request.headers()["x-csrf-token"]).toBe(csrf);
            detailCalls.push({ key: request.headers()["idempotency-key"], body });
            if (detailCalls.length === 1) {
              await route.fulfill({ status: 200, body: "{" }); // Synthetic lost/invalid response.
              return;
            }
            await route.fulfill({
              status: 200,
              json: {
                schemaVersion: 1,
                details: {
                  operationReference: request.headers()["idempotency-key"],
                  detailsReference: body.detailsReference,
                  detailsVersion: Number(body.expectedVersion) + 1,
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
          await page.route("**/api/v1/carts/*/quote", async (route) => {
            const request = route.request();
            expect(request.method()).toBe("POST");
            expect(request.headers()["x-csrf-token"]).toBe(csrf);
            quoteCalls.push({
              key: request.headers()["idempotency-key"],
              body: request.postDataJSON(),
            });
            if (quoteCalls.length === 1) {
              await route.fulfill({
                status: 503,
                json: {
                  schemaVersion: 1,
                  error: {
                    code: "quote_service_unavailable",
                    messageKey: "customer.quote.service_unavailable",
                  },
                },
              });
              return;
            }
            if (terminal === "expired" && quoteCalls.length === 2) {
              await route.fulfill({
                status: 410,
                json: {
                  schemaVersion: 1,
                  error: {
                    code: "quote_operation_expired",
                    messageKey: "customer.quote.operation_expired",
                  },
                  resolution: {
                    operationReference: request.headers()["idempotency-key"],
                    cartReference: id(1),
                    cartVersion: 3,
                  },
                },
              });
              return;
            }
            await route.fulfill({
              status: 201,
              json: {
                schemaVersion: 1,
                quote: {
                  quoteReference: id(5),
                  quoteVersion: 1,
                  cartVersion: 3,
                  currency: "CAD",
                  subtotal: { amountMinor: "100", currency: "CAD" },
                  discount: { amountMinor: "0", currency: "CAD" },
                  tax: { amountMinor: "13", currency: "CAD" },
                  fee: { amountMinor: "0", currency: "CAD" },
                  total: { amountMinor: "113", currency: "CAD" },
                  expiresAt,
                  warnings: [],
                  blockingReasons: [],
                  priceChange: null,
                },
              },
            });
          });
          await page.clock.install();
          await page.goto("/#qr=aaa.bbb.ccc");
          await expect(
            page.getByRole("heading", { name: "Synthetic Checkout Store", exact: true }),
          ).toBeVisible();
          expect(new URL(page.url()).hash).toBe("");
          // Native same-document route change retains the real Entry client's private CSRF context.
          await page.evaluate(() => {
            history.pushState(null, "", "/checkout");
            window.dispatchEvent(new PopStateEvent("popstate"));
          });
          await expect(page.getByRole("heading", { name: "Checkout", exact: true })).toBeVisible();
          // U1: the page prices the cart itself; the lost first response leaves one retryable intent.
          const retry = page.getByRole("button", { name: "Retry pricing", exact: true });
          await expect(retry).toBeEnabled();
          await expect(page.getByRole("button", { name: "Refresh prices" })).toHaveCount(0);
          expect(quoteCalls).toHaveLength(1);
          await context.setOffline(true);
          await expect(retry).toBeDisabled();
          expect(quoteCalls).toHaveLength(1);
          await context.setOffline(false);
          await expect(retry).toBeEnabled();
          expect(quoteCalls).toHaveLength(1);
          if (screen.touch) await retry.tap();
          else await retry.click();
          if (terminal === "expired") {
            await expect(
              page.getByText("Your previous prices expired. Refresh to price your order again.", {
                exact: true,
              }),
            ).toBeVisible();
            await expect(retry).toHaveCount(0);
            expect(quoteCalls).toHaveLength(2);
            expect(quoteCalls[1]).toEqual(quoteCalls[0]);
            const renew = page.getByRole("button", { name: "Refresh prices", exact: true });
            if (screen.touch) await renew.tap();
            else {
              await expect(renew).toBeFocused();
              await page.keyboard.press("Enter");
            }
          }
          await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible();
          await expect(page.getByText("$1.13", { exact: true }).first()).toBeVisible();
          await expect(retry).toHaveCount(0);
          expect(quoteCalls).toHaveLength(terminal === "expired" ? 3 : 2);
          if (terminal === "expired") expect(quoteCalls[2]?.key).not.toBe(quoteCalls[0]?.key);
          expect(quoteCalls[0]?.key).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          );
          expect(quoteCalls[1]).toEqual(quoteCalls[0]);
          expect(quoteCalls[0]?.body).toEqual({ cartVersion: 3 });
          // Policies not yet accepted: the single continue action stays disabled.
          await expect(page.getByRole("button", { name: /Continue to payment/u })).toBeDisabled();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          ).toBe(true);
          const name = page.getByLabel("Pickup name", { exact: true });
          const confirm = page.getByRole("checkbox", {
            name: "I have read and agree to the policies above",
          });
          const save = page.getByRole("button", { name: "Save details", exact: true });
          await expect(name).toHaveValue("Synthetic Guest");
          await expect(confirm).not.toBeChecked();
          await expect(save).toBeDisabled();
          await page.getByText("Synthetic checkout terms", { exact: true }).click();
          await expect(
            page.getByText("<script>window.policyExecuted=true</script>", { exact: false }),
          ).toBeVisible();
          expect(await page.evaluate(() => Object.hasOwn(window, "policyExecuted"))).toBe(false);
          await confirm.focus();
          await page.keyboard.press("Space");
          await expect(save).toBeEnabled();
          await save.click();
          const retryDetails = page.getByRole("button", {
            name: "Retry saving details",
            exact: true,
          });
          await expect(retryDetails).toBeEnabled();
          await expect(name).toBeDisabled();
          expect(detailCalls).toHaveLength(1);
          await context.setOffline(true);
          await expect(retryDetails).toBeDisabled();
          await context.setOffline(false);
          await expect(retryDetails).toBeEnabled();
          await expect(name).toHaveValue("Synthetic Guest");
          expect(detailCalls).toHaveLength(1);
          if (screen.touch) await retryDetails.tap();
          else await retryDetails.click();
          await expect(page.getByText("Checkout details saved.", { exact: true })).toBeVisible();
          expect(detailCalls).toHaveLength(2);
          expect(detailCalls[1]).toEqual(detailCalls[0]);
          expect(detailCalls[0]?.body).toMatchObject({
            detailsReference: id(7),
            expectedVersion: 2,
            cartVersion: 3,
            quoteReference: id(5),
            policies: [policyDocument],
          });
          expect(detailCalls[0]?.body).not.toHaveProperty("orderType");
          await expect(save).toBeDisabled();
          if (terminal.startsWith("payment")) {
            // Reconnection re-priced the cart automatically; the saved details still apply.
            await expect(page.getByRole("heading", { name: "Total", exact: true })).toBeVisible();
            await expect(page.getByText("Checkout details saved.", { exact: true })).toBeVisible();
            const sessionView = {
              schemaVersion: 1,
              session: {
                checkoutSessionReference: id(10),
                cartReference: id(1),
                cartVersion: 3,
                quoteReference: id(5),
                quoteVersion: 1,
                createdAt: new Date().toISOString(),
              },
            };
            const sessionCalls: { key: string | undefined; body: unknown }[] = [];
            await page.route("**/api/v1/carts/*/checkout-sessions", async (route) => {
              const request = route.request();
              expect(request.headers()["x-csrf-token"]).toBe(csrf);
              sessionCalls.push({
                key: request.headers()["idempotency-key"],
                body: request.postDataJSON(),
              });
              await route.fulfill(
                sessionCalls.length === 1
                  ? { status: 200, body: "{" }
                  : { status: 200, json: sessionView },
              );
            });
            await page.route("**/api/v1/checkout-sessions/" + id(10), (route) =>
              route.fulfill({ json: sessionView }),
            );
            const paymentCalls: { key: string | undefined; body: unknown }[] = [];
            await page.route("**/api/v1/checkout-sessions/*/payment-intents", async (route) => {
              const request = route.request();
              expect(request.headers()["x-csrf-token"]).toBe(csrf);
              paymentCalls.push({
                key: request.headers()["idempotency-key"],
                body: request.postDataJSON(),
              });
              await route.fulfill(
                paymentCalls.length === 1
                  ? { status: 200, body: "{" }
                  : {
                      status: paymentCalls.length === 2 ? 202 : 200,
                      json: {
                        schemaVersion: 1,
                        payment: {
                          checkoutSessionReference: id(10),
                          paymentIntentReference: id(11),
                          orderReference: id(12),
                          creationStatus:
                            paymentCalls.length === 2 ? "Processing" : "AlreadyCreated",
                          total: { amountMinor: "238", currency: "CAD" },
                        },
                      },
                    },
              );
            });
            let resultCalls = 0;
            await page.route(
              /\/api\/v1\/checkout-sessions\/[^/]+\/payment-(?:result|reconciliation)$/u,
              (route) => {
                const reconciliation = route.request().url().endsWith("/payment-reconciliation");
                expect(route.request().method()).toBe(reconciliation ? "POST" : "GET");
                expect(reconciliation).toBe(resultCalls > 0);
                if (reconciliation) expect(route.request().postDataJSON()).toEqual({});
                expect(route.request().headers()["x-csrf-token"]).toBe(csrf);
                resultCalls++;
                return route.fulfill({
                  headers: { "cache-control": "no-store" },
                  json: {
                    schemaVersion: 1,
                    payment: {
                      checkoutSessionReference: id(10),
                      paymentIntentReference: id(11),
                      orderReference: id(12),
                      status:
                        resultCalls === 1
                          ? "Pending"
                          : terminal === "payment-failed"
                            ? "Failed"
                            : "Succeeded",
                      total: { amountMinor: "238", currency: "CAD" },
                    },
                  },
                });
              },
            );
            let handoffCalls = 0;
            await page.route("**/api/v1/checkout-sessions/*/payment-handoff", (route) => {
              handoffCalls += 1;
              return route.fulfill({
                headers: { "cache-control": "no-store" },
                json: {
                  schemaVersion: 1,
                  clientSecret: "pi_SyntheticBrowser_secret_SyntheticOnly",
                },
              });
            });
            // Synthetic SDK boundary, not Stripe network/3DS/iframe acceptance.
            await page.route("https://js.stripe.com/**", (route) =>
              route.fulfill({
                contentType: "application/javascript",
                body: `window.syntheticCard = { mounts: 0, destroys: 0, confirms: 0 };
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
                        destroy: function() { if (host) host.textContent = ""; window.syntheticCard.destroys++; }
                      };
                    },
                    submit: async function() {
                      if (window.syntheticHoldSubmit)
                        return new Promise(function(resolve) { window.syntheticResolveSubmit = resolve; });
                      return {};
                    }
                  }; },
                  confirmPayment: async function(options) {
                    if (options.redirect !== "if_required" ||
                        options.confirmParams.return_url !== "https://synthetic-return.invalid/return")
                      throw Error("invalid confirmation options");
                    window.syntheticCard.confirms++;
                    return { paymentIntent: { status: "succeeded" } };
                  }
                }; };`,
              }),
            );
            const proceed = page.getByRole("button", { name: /Continue to payment/u });
            await expect(proceed).toBeEnabled();
            await page.getByRole("button", { name: "Other", exact: true }).click();
            const tip = page.getByLabel("Tip (CAD)", { exact: true });
            await tip.fill("1.251");
            await expect(tip).toHaveAttribute("aria-invalid", "true");
            await expect(proceed).toBeDisabled();
            await tip.fill("1.25");
            await expect(proceed).toBeEnabled();
            await expect(proceed).toContainText("$2.38");
            await proceed.click();
            const retrySession = page.getByRole("button", { name: "Retry checkout", exact: true });
            await expect(retrySession).toBeEnabled();
            await expect(tip).toBeDisabled();
            await context.setOffline(true);
            await expect(retrySession).toBeDisabled();
            await context.setOffline(false);
            await expect(retrySession).toBeEnabled();
            expect(sessionCalls).toHaveLength(1);
            await retrySession.click();
            await expect(page).toHaveURL(/\/checkout\/payment$/u);
            expect(sessionCalls).toHaveLength(2);
            expect(sessionCalls[1]).toEqual(sessionCalls[0]);
            await expect(page.getByText("$1.25", { exact: true })).toBeVisible();
            await expect(page.getByLabel("Tip (CAD)", { exact: true })).toHaveCount(0);
            // U1: the page prepares the payment itself; the lost response leaves one retry.
            const retryPayment = page.getByRole("button", {
              name: "Check payment readiness",
              exact: true,
            });
            await expect(retryPayment).toBeEnabled();
            await context.setOffline(true);
            await expect(retryPayment).toBeDisabled();
            await context.setOffline(false);
            await expect(retryPayment).toBeEnabled();
            expect(paymentCalls).toHaveLength(1);
            await retryPayment.click();
            await expect(page.getByText("$2.38", { exact: true })).toBeVisible();
            expect(paymentCalls).toHaveLength(2);
            expect(paymentCalls[1]).toEqual(paymentCalls[0]);
            expect(paymentCalls[0]?.body).toEqual({ tip: { amountMinor: "125", currency: "CAD" } });
            // SPA remount must preserve payment identity; synthetic Processing is never Paid.
            await page.evaluate(() => {
              history.pushState(null, "", "/cart");
              window.dispatchEvent(new PopStateEvent("popstate"));
            });
            await expect(
              page.getByRole("heading", { name: "Secure payment", exact: true }),
            ).toHaveCount(0);
            await page.evaluate(() => {
              history.pushState(null, "", "/checkout/payment");
              window.dispatchEvent(new PopStateEvent("popstate"));
            });
            const pay = page.getByRole("button", { name: "Pay securely", exact: true });
            await expect(pay).toBeEnabled();
            expect(paymentCalls).toHaveLength(3);
            expect(paymentCalls[2]).toEqual(paymentCalls[0]);
            expect(handoffCalls).toBe(1);
            await page.evaluate(() => Reflect.set(window, "syntheticHoldSubmit", true));
            await pay.click();
            await expect(
              page.getByRole("button", { name: "Submitting payment…", exact: true }),
            ).toBeDisabled();
            await context.setOffline(true);
            await expect(pay).toHaveCount(0);
            await context.setOffline(false);
            await expect(retryPayment).toBeEnabled();
            expect(paymentCalls).toHaveLength(3);
            await page.evaluate(async () => {
              Reflect.set(window, "syntheticHoldSubmit", false);
              const resolve = Reflect.get(window, "syntheticResolveSubmit") as (
                value: object,
              ) => void;
              resolve({});
              await Promise.resolve();
            });
            expect(await page.evaluate(() => Reflect.get(window, "syntheticCard"))).toEqual({
              mounts: 1,
              destroys: 1,
              confirms: 0,
            });
            await retryPayment.click();
            await expect(pay).toBeEnabled();
            expect(paymentCalls[3]).toEqual(paymentCalls[0]);
            expect(handoffCalls).toBe(2);
            await pay.click();
            await expect(page).toHaveURL(/\/checkout\/result$/u);
            await expect(
              page.getByText("Payment confirmation is pending. Do not submit another payment.", {
                exact: true,
              }),
            ).toBeVisible();
            expect(resultCalls).toBe(1);
            await expect(
              page.getByRole("heading", { name: "Payment confirmed", exact: true }),
            ).toHaveCount(0);
            // U2: a pending result is re-checked automatically with the same operation.
            await expect(page.getByText("Checking again automatically…")).toBeVisible();
            if (terminal === "payment-failed") {
              await expect(
                page.getByRole("heading", { name: "Payment failed", exact: true }),
              ).toBeVisible({ timeout: 15_000 });
              await expect(
                page.getByRole("link", { name: "View order status", exact: true }),
              ).toHaveCount(0);
              await expect(
                page.getByRole("heading", { name: "Payment confirmed", exact: true }),
              ).toHaveCount(0);
            } else {
              await expect(
                page.getByRole("heading", { name: "Payment confirmed", exact: true }),
              ).toBeVisible({ timeout: 15_000 });
              await expect(
                page.getByRole("link", { name: "View order status", exact: true }),
              ).toHaveAttribute("href", "/orders/" + id(12));
            }
            expect(resultCalls).toBe(2);
            expect(paymentCalls).toHaveLength(4);
            await expect(pay).toHaveCount(0);
            expect(await page.evaluate(() => Reflect.get(window, "syntheticCard"))).toEqual({
              mounts: 2,
              destroys: 2,
              confirms: 1,
            });
            expect(await page.content()).not.toContain("pi_SyntheticBrowser_secret_SyntheticOnly");
            expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
            if (terminal === "payment-failed") {
              await page.goto("/checkout/result?paid=true");
              await expect(
                page.getByText("This payment cannot be identified in this window.", {
                  exact: false,
                }),
              ).toBeVisible();
              await expect(
                page.getByRole("heading", { name: "Payment confirmed", exact: true }),
              ).toHaveCount(0);
              expect(resultCalls).toBe(2);
              expect(paymentCalls).toHaveLength(4);
            }
            expect(failures).toEqual([]);
            return;
          }
          await page.getByRole("button", { name: "Reload checkout details", exact: true }).click();
          await expect(confirm).not.toBeChecked();
          await expect(save).toBeDisabled();
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
          ).toBe(true);
          await page.clock.fastForward(600_001);
          await expect(
            page.getByText("Checkout information expired.", { exact: false }),
          ).toBeVisible();
          await expect(name).toBeDisabled();
          expect(detailCalls).toHaveLength(2);
          expect(failures).toEqual([]);
        },
      );
  });
}
