import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
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
      await expect(page.getByRole("heading", { name: "Items served", exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByRole("heading", { name: "Items served", exact: true })).toBeVisible();
      await expect(page.getByText("Payment received: CAD 56.50", { exact: true })).toBeVisible();
      await expect(page.getByText("Served 2 of 2", { exact: true })).toBeVisible();
      await expect(page.getByText("Served 3 of 3", { exact: true })).toBeVisible();
    }
    await page.getByRole("link", { name: "View receipt and support", exact: true }).click();
    for (const name of ["Version 1: Original", "Version 2: Refund", "Version 3: Refund"])
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByText("RefundPending", { exact: true })).toBeVisible();
    await expect(page.getByText("Refunded", { exact: true })).not.toHaveCount(0);
    assert.equal(
      await page.evaluate(() => globalThis.localStorage.length + globalThis.sessionStorage.length),
      0,
    );
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
    await expect(page.getByRole("heading", { name: "Order not found", exact: true })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Receipt not found", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Version 1: Original", exact: true }),
    ).toHaveCount(0);
    await context.close();
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
