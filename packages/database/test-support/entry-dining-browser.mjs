import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";

const webRequire = createRequire(
  new URL("../../../apps/customer-pwa/package.json", import.meta.url),
);

/** Opt-in HTTPS App -> original API -> actual owner DB. No route interception.
 * Restores an already issued synthetic-provider Guest session in memory.
 */
export async function verifyEntryDiningBrowser({ base, order, orderType = "DineIn" }) {
  const { chromium, expect } = webRequire("@playwright/test");
  const { createServer } = await import(webRequire.resolve("vite"));
  const directory = await mkdtemp(join(tmpdir(), "bop-entry-browser-"));
  let web, browser;
  try {
    const key = join(directory, "key.pem"),
      cert = join(directory, "cert.pem");
    await promisify(execFile)(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-subj",
        "/CN=127.0.0.1",
        "-days",
        "1",
      ],
      { timeout: 10000 },
    );
    web = await createServer({
      root: resolve("apps/customer-pwa"),
      configFile: resolve("apps/customer-pwa/vite.config.ts"),
      mode: "test",
      logLevel: "silent",
      server: {
        host: "127.0.0.1",
        port: 0,
        https: { key: await readFile(key), cert: await readFile(cert) },
        proxy: {
          "/api": { target: base, changeOrigin: false },
          "/bff": { target: base, changeOrigin: false },
        },
      },
    });
    await web.listen();
    const origin = "https://127.0.0.1:" + web.httpServer.address().port;
    browser = await chromium.launch({ headless: true });
    const viewports = orderType === "Pickup" ? [1440, 390, 320] : [390];
    for (const width of viewports) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: "block",
        viewport: { width, height: width === 1440 ? 900 : 844 },
      });
      await context.addCookies([
        {
          name: "__Host-bop-guest",
          value: order.input.sessionCredential,
          url: origin,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await context.newPage();
      const reads = [];
      const writes = [];
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/") && request.method() !== "GET")
          writes.push(request.method());
      });
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (
          (path.startsWith("/api/v1/orders/") && path.endsWith("/receipt")) ||
          path === "/api/v1/customer/session/csrf"
        )
          reads.push({
            kind: path.endsWith("/receipt") ? "receipt" : "bootstrap",
            status: response.status(),
            noStore: response.headers()["cache-control"] === "no-store",
          });
      });
      await page.goto(origin);
      await page.locator("main").waitFor();
      await page.evaluate(
        "import('/src/session/customer-transaction-context.ts').then(module => { globalThis.__bopResumeCsrf = module.setCustomerCsrfCredential; })",
      );
      await page.evaluate(
        ({ csrf, orderReference }) => {
          globalThis.__bopResumeCsrf(csrf);
          delete globalThis.__bopResumeCsrf;
          globalThis.history.pushState(null, "", "/orders/" + orderReference);
          globalThis.dispatchEvent(new globalThis.PopStateEvent("popstate"));
        },
        { csrf: order.input.csrfCredential, orderReference: order.record.order.orderReference },
      );
      assert.equal(order.record.order.orderType, orderType);
      if (orderType === "Pickup") {
        await expect(
          page.getByRole("heading", { name: "Order collected", exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Payment received: CAD 22.60", { exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Items served", exact: true })).toHaveCount(
          0,
        );
      } else {
        await expect(
          page.getByRole("heading", { name: "Items served", exact: true }),
        ).toBeVisible();
        await expect(page.getByText("Payment received: CAD 56.50", { exact: true })).toBeVisible();
        await expect(page.getByText("Served 2 of 2", { exact: true })).toBeVisible();
        await expect(page.getByText("Served 3 of 3", { exact: true })).toBeVisible();
      }
      await page.getByRole("link", { name: "View receipt and support", exact: true }).click();
      for (const name of ["Version 1: Original", "Version 2: Refund", "Version 3: Refund"])
        await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      await expect(page.getByText("RefundPending", { exact: true })).toBeVisible();
      await expect(page.getByText("Refunded", { exact: true })).not.toHaveCount(0);
      if (orderType === "Pickup") {
        const amounts = page.locator(".receipt-page__financial dd");
        await expect(amounts).toHaveText(["CAD 22.60", "CAD 22.60", "CAD 0.00"]);
        const history = async () => {
          for (const name of ["Version 1: Original", "Version 2: Refund", "Version 3: Refund"])
            await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
        };
        const acceptedHistory = await page.locator(".receipt-page__history").innerText();
        const readsBeforeOffline = reads.length;
        await context.setOffline(true);
        await expect(
          page.getByRole("heading", { name: "Offline read-only", exact: true }),
        ).toBeVisible();
        await history();
        await expect(
          page.getByText("Current payment and refund amounts are unavailable while offline.", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Refresh receipt", exact: true }),
        ).toBeDisabled();
        assert.equal(await page.locator(".receipt-page__history").innerText(), acceptedHistory);
        await context.setOffline(false);
        await expect(
          page.getByRole("heading", { name: "Offline read-only", exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("heading", { name: "Live receipt status is unavailable", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("Current payment and refund amounts are unavailable.", { exact: true }),
        ).toBeVisible();
        assert.equal(reads.length, readsBeforeOffline);
        const refreshed = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.endsWith("/receipt") && response.status() === 200,
        );
        await page.getByRole("button", { name: "Refresh receipt", exact: true }).click();
        await refreshed;
        await history();
        await expect(
          page.getByText("Current payment and refund amounts are unavailable.", { exact: true }),
        ).toHaveCount(0);
        await expect(amounts).toHaveText(["CAD 22.60", "CAD 22.60", "CAD 0.00"]);
        assert.equal(await page.locator(".receipt-page__history").innerText(), acceptedHistory);
        const restored = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/v1/customer/session/csrf",
        );
        await page.reload();
        assert.equal((await restored).status(), 200, "foreground Session bootstrap after reload");
        await history();
        await expect(amounts).toHaveText(["CAD 22.60", "CAD 22.60", "CAD 0.00"]);
        assert.equal(await page.locator(".receipt-page__history").innerText(), acceptedHistory);
        // Exercise the native event handler with synthetic persisted events. This does
        // not assert that this headless browser actually admitted the page to bfcache.
        await page.evaluate(() =>
          globalThis.dispatchEvent(
            new globalThis.PageTransitionEvent("pagehide", { persisted: true }),
          ),
        );
        await expect(page.locator("#root")).toBeHidden();
        await expect(page.getByRole("status")).toHaveText("Checking your session. Please wait.");
        await expect(
          page.getByRole("heading", { name: "Version 1: Original", exact: true }),
        ).toBeHidden();
        const historyRestore = page.waitForResponse(
          (response) => new URL(response.url()).pathname === "/api/v1/customer/session/csrf",
        );
        await page.evaluate(() =>
          globalThis.dispatchEvent(
            new globalThis.PageTransitionEvent("pageshow", { persisted: true }),
          ),
        );
        assert.equal(
          (await historyRestore).status(),
          200,
          "foreground Session bootstrap after history restore",
        );
        await history();
        await expect(amounts).toHaveText(["CAD 22.60", "CAD 22.60", "CAD 0.00"]);
        assert.equal(await page.locator(".receipt-page__history").innerText(), acceptedHistory);
        assert.equal(
          await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
          ),
          true,
        );
        const captures = resolve("apps/customer-pwa/test-results");
        await mkdir(captures, { recursive: true });
        await page.screenshot({
          path: join(captures, `owner-pickup-receipt-${width}.png`),
          fullPage: true,
        });
        assert(reads.length >= 4);
        assert(
          reads.every((read) => read.status === 200 && read.noStore),
          JSON.stringify(reads),
        );
        assert.deepEqual(writes, []);
      }
      assert.equal(
        await page.evaluate(
          () => globalThis.localStorage.length + globalThis.sessionStorage.length,
        ),
        0,
      );
      assert.equal(await page.evaluate(async () => (await globalThis.caches.keys()).length), 0);
      await context.addCookies([
        {
          name: "__Host-bop-guest",
          value: "z".repeat(43),
          url: origin,
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await page.getByRole("link", { name: "Back to order status", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "This order cannot be opened", exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(
        page.getByRole("heading", { name: "Receipt not found", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Version 1: Original", exact: true }),
      ).toHaveCount(0);
      await context.close();
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await web?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
