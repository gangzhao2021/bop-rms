import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import { createPersistentMerchantBffService } from "../../../apps/api/src/persistent-merchant-bff.ts";
import { createMerchantKitchenCommand } from "../../../apps/api/src/merchant-kitchen-command.ts";
import { createMerchantKitchenQuery } from "../../../apps/api/src/merchant-kitchen-query.ts";
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../../../apps/merchant-web/package.json", import.meta.url),
);
const express = apiRequire("express");
const { chromium, expect } = webRequire("@playwright/test");

/** Actual built App / HTTPS / persisted BFF and Kitchen owners. Synthetic staff and policies only. */
export async function createKitchenMerchantBrowser({
  session,
  scope,
  createPorts,
  validateCurrentSource,
  sha256,
}) {
  const directory = await mkdtemp(join(tmpdir(), "bop-kitchen-browser-"));
  let server, browser;
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (server?.listening)
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
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
    const app = express();
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "https://127.0.0.1:" + server.address().port;
    const persistence = {
      ...session.persistence,
      now: () => new Date().toISOString(),
      publication: {
        configurationType: "STORE_CONFIGURATION",
        purposeCode: "STORE_CONFIGURATION",
        requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
      },
      initialScope: async () => scope,
      targetScope: async () => scope,
      workspace: async (_tx, { context }) => {
        const selectedScope = {
          brandLabel: context.brand.displayName,
          storeLabel: context.store.displayName,
          storeReference: context.store.storeReference,
        };
        return {
          screenId: "HOME-OVERVIEW",
          selectedScope,
          authorizedStores: [selectedScope],
          businessDate: "2000-01-01",
          storeStatus: "Unavailable",
          freshness: "Stale",
          dashboardAvailability: "UnavailableUntilWP1905",
          navigation: [
            {
              screenId: "KIT-KITCHEN-QUEUE",
              label: "Kitchen",
              href: "/operations/kitchen",
              permission: "kitchen.operate",
            },
          ],
        };
      },
    };
    const authentication = createPersistentMerchantBffService(persistence);
    app.use(
      "/merchant",
      createMerchantBffRouter({
        exactOrigin: origin,
        acceptedHost: new URL(origin).host,
        service: authentication,
        kitchenQuery: createMerchantKitchenQuery({ persistence, authentication, sha256 }),
        kitchenCommand: (input) =>
          createMerchantKitchenCommand({
            persistence,
            authentication,
            lifecycle: createPorts(input.command, new Date().toISOString()),
            validateCurrentSource,
          })(input),
      }),
    );
    const assets = resolve("apps/merchant-web/dist");
    app.use(express.static(assets));
    app.get("/{*path}", (_req, res) => res.sendFile(join(assets, "index.html")));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    await context.addCookies([
      {
        name: "__Host-bop-merchant",
        value: session.sessionCookie,
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const bootstrap = page.waitForResponse(
      (response) => response.url() === origin + "/merchant/session",
    );
    await page.goto(origin + "/operations/kitchen");
    const boot = await bootstrap;
    assert.equal(boot.status(), 200, "Persisted Merchant bootstrap must succeed");
    const bootBody = await boot.json();
    assert.equal(bootBody.workspace.selectedScope.storeReference, scope.storeReference);
    assert.notEqual(bootBody.workspace.businessDate, "2000-01-01");
    await expect(page.getByRole("heading", { name: "Kitchen Board", exact: true })).toBeVisible();
    const refresh = page.getByRole("button", { name: "Refresh from source", exact: true });
    return {
      async execute(command) {
        const label = {
          AcceptKitchenWorkItem: "Accept",
          StartKitchenWorkItem: "Start",
          CompleteKitchenWorkItem: "Complete remaining quantity",
          MarkKitchenOrderItemReady: "Mark ready",
        }[command.action];
        assert.ok(label);
        const card = page.locator("article").filter({
          has: page.locator(
            'a[href="/operations/kitchen/work-items/' + command.workItemReference + '"]',
          ),
        });
        const button = card.getByRole("button", { name: label, exact: true });
        await expect(async () => {
          await refresh.click();
          await expect(button).toBeEnabled({ timeout: 1000 });
        }).toPass({ timeout: 15000, intervals: [100, 250, 500] });
        const completion = page.waitForResponse(
          (response) =>
            response.url() === origin + "/merchant/kitchen/work" &&
            response.request().method() === "POST",
        );
        await button.click();
        const response = await completion;
        assert.equal(response.status(), 200, "Kitchen browser command must succeed");
        const sent = response.request().postDataJSON();
        assert.equal(sent.authority, "CurrentMerchantSession");
        assert.equal(sent.storeReference, scope.storeReference);
        assert.equal(sent.actorReference, undefined);
        const { authority, ...intent } = sent;
        assert.equal(authority, "CurrentMerchantSession");
        // Retain the exact browser-generated intent for existing persisted replay/proof checks.
        Object.assign(command, intent);
        const result = await response.json();
        await expect(
          page.getByRole("heading", { name: "Waiting for refreshed queue", exact: true }),
        ).toBeVisible();
        await expect(async () => {
          await refresh.click();
          await expect(
            page.getByRole("heading", { name: "Kitchen action confirmed", exact: true }),
          ).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 15000, intervals: [100, 250, 500] });
        assert.equal(
          await page.evaluate(
            () => globalThis.localStorage.length + globalThis.sessionStorage.length,
          ),
          0,
        );
        return result;
      },
      async assertRevoked() {
        await refresh.click();
        await expect(
          page.getByRole("heading", { name: "Permission denied", exact: true }),
        ).toBeVisible();
        await expect(page.locator("article.store-card")).toHaveCount(0);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
