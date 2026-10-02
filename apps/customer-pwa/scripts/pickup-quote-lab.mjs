import { URL } from "node:url";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

/** Real browser transport only; no route mocks, injected cookies or private browser storage. */
export async function verifyPickupQuoteLab(origin, pickup) {
  const browser = await chromium.launch();
  let journeys = 0;
  try {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({
        viewport,
        ignoreHTTPSErrors: true,
        isMobile: viewport.width === 390,
        hasTouch: viewport.width === 390,
      });
      try {
        assert.equal(
          (await context.request.post(origin + "/__local/customer-entry")).status(),
          404,
        );
        assert.equal(
          (
            await context.request.post(origin + "/__local/customer-entry", {
              headers: { origin: "https://wrong.invalid", "sec-fetch-site": "same-origin" },
            })
          ).status(),
          404,
        );
        const page = await context.newPage();
        const errors = [];
        const responses = [];
        page.on("response", async (response) => {
          const path = new URL(response.url()).pathname;
          if (path.startsWith("/api/") || path.startsWith("/bff/"))
            responses.push({
              kind:
                path.includes("payment-intents") || path.includes("/orders")
                  ? "payment-or-order-write"
                  : path.includes("checkout-sessions")
                    ? "checkout-session"
                    : path.includes("checkout-details")
                      ? "details"
                      : path.includes("binding")
                        ? "binding"
                        : path.includes("cart")
                          ? "cart"
                          : "entry/menu",
              status: response.status(),
              noStore: response.headers()["cache-control"] === "no-store",
              ...(response.status() >= 400
                ? { error: (await response.json().catch(() => null))?.error?.code ?? "unknown" }
                : {}),
            });
        });
        page.on("pageerror", () => errors.push("page_error"));
        await page.goto(origin);
        await expect(
          page.getByRole("heading", { name: "Synthetic Store", exact: true }),
        ).toBeVisible();
        const before = (await context.cookies()).find((c) => c.name === "__Host-bop-guest");
        assert(before?.secure && before.httpOnly && before.sameSite === "Lax");
        await page.getByRole("button", { name: "Continue to menu", exact: true }).click();
        await page.getByRole("link", { name: "View Latte", exact: true }).click();
        await page.getByRole("button", { name: "Add to cart", exact: true }).click();
        await page.getByRole("button", { name: "Add to cart", exact: true }).click();
        await expect(page.getByRole("link", { name: "Review cart", exact: true }))
          .toBeVisible()
          .catch(async () => {
            throw new Error(
              JSON.stringify({
                stage: "add-to-cart",
                responses,
                owner: pickup.diagnostics,
                persisted: await pickup.inspect(),
                alerts: await page.getByRole("alert").allTextContents(),
              }),
            );
          });
        await page.getByRole("link", { name: "Review cart", exact: true }).click();
        await expect(page.getByLabel("Latte quantity", { exact: true })).toHaveText("1");
        const bound = (await context.cookies()).find((c) => c.name === "__Host-bop-guest");
        assert(bound?.secure && bound.httpOnly && bound.sameSite === "Lax");
        assert(bound.value !== before.value);
        await page.getByRole("link", { name: "Review checkout", exact: true }).click();
        await page.getByRole("button", { name: "Get current quote", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Quote summary", exact: true }))
          .toBeVisible()
          .catch(async () => {
            throw new Error(
              JSON.stringify({
                stage: "quote",
                responses,
                owner: pickup.diagnostics,
                persisted: await pickup.inspect(),
                alerts: await page.getByRole("alert").allTextContents(),
              }),
            );
          });
        const quote = page.getByRole("region", { name: "Quote summary", exact: true });
        await expect(quote).toContainText("5.65");
        await expect(quote).not.toContainText("Quote expired");
        await page.getByRole("link", { name: "Back to cart", exact: true }).click();
        await page.getByRole("button", { name: "Increase Latte quantity", exact: true }).click();
        await expect(page.getByLabel("Latte quantity", { exact: true })).toHaveText("2");
        await expect(
          page.getByText("Review checkout to request a current quote before payment.", {
            exact: true,
          }),
        ).toBeVisible();
        await page.getByRole("link", { name: "Review checkout", exact: true }).click();
        await page.getByRole("button", { name: "Get current quote", exact: true }).click();
        await expect(
          page.getByRole("region", { name: "Quote summary", exact: true }),
        ).toContainText("11.30");
        await expect(page.getByRole("heading", { name: "Contact and receipt", exact: true }))
          .toBeVisible()
          .catch(async () => {
            throw new Error(
              JSON.stringify({
                stage: "checkout-details-read",
                responses,
                owner: pickup.diagnostics,
                checkoutFailures: pickup.checkoutSessionFailures,
                checkoutStages: pickup.checkoutStages,
                alerts: await page.getByRole("alert").allTextContents(),
              }),
            );
          });
        await page.getByRole("button", { name: "Reload checkout details", exact: true }).click();
        await expect(page.getByLabel("Pickup name", { exact: true })).toHaveValue("");
        await page.getByLabel("Pickup name", { exact: true }).fill("Synthetic Guest");
        await page.getByLabel("Contact method").selectOption("Email");
        await page.getByLabel("Pickup email", { exact: true }).fill("synthetic@example.invalid");
        await page.getByRole("button", { name: "Save checkout details", exact: true }).click();
        await expect(page.getByText("Checkout details saved.", { exact: true })).toBeVisible();
        const detailsResponses = responses.filter((response) => response.kind === "details");
        assert(detailsResponses.length >= 3);
        assert(
          detailsResponses.every(
            (response) => [200, 201].includes(response.status) && response.noStore,
          ),
        );
        await page.getByLabel("Tip (CAD)", { exact: true }).fill("0");
        let droppedFirstSessionResponse = false;
        await page.route("**/api/v1/carts/*/checkout-sessions", async (route) => {
          const request = route.request();
          const requestHeaders = await request.allHeaders();
          // Chromium's intercepted Fetch omits this browser-controlled metadata in the local lab.
          const headers = { ...requestHeaders, "sec-fetch-site": "same-origin" };
          if (droppedFirstSessionResponse) return route.continue({ headers });
          droppedFirstSessionResponse = true;
          const response = await route.fetch({ headers });
          responses.push({
            kind: "checkout-session-first-response-dropped",
            status: response.status(),
            noStore: response.headers()["cache-control"] === "no-store",
            request: {
              method: request.method(),
              contentType: requestHeaders["content-type"],
              origin: requestHeaders.origin,
              fetchSite: requestHeaders["sec-fetch-site"],
              idempotencyKeyValid:
                /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
                  requestHeaders["idempotency-key"] ?? "",
                ),
              csrfPresent: typeof requestHeaders["x-csrf-token"] === "string",
              guestCookiePresent: (requestHeaders.cookie ?? "").includes("__Host-bop-guest="),
              bodyKeys: Object.keys(request.postDataJSON() ?? {}).sort(),
            },
            ...(response.status() >= 400
              ? { error: (await response.json().catch(() => null))?.error?.code ?? "unknown" }
              : {}),
          });
          await route.abort();
        });
        const continueButton = page.getByRole("button", {
          name: "Continue to payment",
          exact: true,
        });
        await expect(continueButton)
          .toBeEnabled({ timeout: 3_000 })
          .catch(async () => {
            throw new Error(
              JSON.stringify({
                stage: "checkout-session-not-ready",
                disabled: await continueButton.isDisabled(),
                alerts: await page.getByRole("alert").allTextContents(),
                statuses: await page.getByRole("status").allTextContents(),
                checkout: (await page.locator("main").innerText()).slice(-1600),
              }),
            );
          });
        await continueButton.click();
        await expect(
          page.getByText("We could not confirm checkout. Retry to recover the same checkout.", {
            exact: true,
          }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Retry checkout", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Secure payment", exact: true }))
          .toBeVisible()
          .catch(async () => {
            throw new Error(
              JSON.stringify({
                stage: "checkout-session",
                responses,
                owner: pickup.diagnostics,
                checkoutFailures: pickup.checkoutSessionFailures,
                checkoutStages: pickup.checkoutStages,
                alerts: await page.getByRole("alert").allTextContents(),
              }),
            );
          });
        await page.unroute("**/api/v1/carts/*/checkout-sessions");
        await expect(
          page.getByRole("heading", { name: "Online payment is unavailable", exact: true }),
        ).toBeVisible();
        const sessionResponses = responses.filter(
          (response) => response.kind === "checkout-session",
        );
        const droppedSessionResponse = responses.find(
          (response) => response.kind === "checkout-session-first-response-dropped",
        );
        assert(droppedSessionResponse);
        assert([200, 201].includes(droppedSessionResponse.status));
        assert(droppedSessionResponse.noStore);
        assert(sessionResponses.length >= 1);
        assert(
          sessionResponses.every(
            (response) => [200, 201].includes(response.status) && response.noStore,
          ),
        );
        assert.equal(
          responses.filter((response) => response.kind === "payment-or-order-write").length,
          0,
        );
        await pickup.verify(++journeys);
        await pickup.verifyCheckoutDetails(journeys);
        await pickup.verifyCheckoutSessions(journeys);
        assert.equal((await context.request.get(origin + "/ready")).status(), 503);
        assert(new URL(page.url()).hash === "");
        assert(new URL(page.url()).search === "");
        assert.equal(
          await page.evaluate(
            () => globalThis.localStorage.length + globalThis.sessionStorage.length,
          ),
          0,
        );
        assert(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
        );
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
