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
        page.on("response", (response) => {
          const path = new URL(response.url()).pathname;
          if (path.startsWith("/api/") || path.startsWith("/bff/"))
            responses.push({
              kind: path.includes("binding")
                ? "binding"
                : path.includes("cart")
                  ? "cart"
                  : "entry/menu",
              status: response.status(),
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
          page.getByText("No current quote is attached. Requote is required before checkout.", {
            exact: true,
          }),
        ).toBeVisible();
        await page.getByRole("link", { name: "Review checkout", exact: true }).click();
        await page.getByRole("button", { name: "Get current quote", exact: true }).click();
        await expect(
          page.getByRole("region", { name: "Quote summary", exact: true }),
        ).toContainText("11.30");
        await page.getByRole("link", { name: "Back to cart", exact: true }).click();
        await page.getByRole("button", { name: "Remove", exact: true }).click();
        await expect(
          page.getByRole("heading", { name: "Your cart is empty", exact: true }),
        ).toBeVisible();
        await pickup.verify(++journeys);
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
