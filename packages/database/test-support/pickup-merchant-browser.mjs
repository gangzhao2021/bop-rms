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
import { createMerchantPickupHandoff } from "../../../apps/api/src/merchant-pickup-handoff.ts";
import { createMerchantPickupProof } from "../../../apps/api/src/merchant-pickup-proof.ts";
import { createMerchantPickupQuery } from "../../../apps/api/src/merchant-pickup-query.ts";
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../../../apps/merchant-web/package.json", import.meta.url),
);
const express = apiRequire("express");
const { chromium, expect } = webRequire("@playwright/test");

/** Actual built App / HTTPS / persisted BFF and Pickup owners. Synthetic staff and policies only. */
export async function createPickupMerchantBrowser({ session, scope, handoff, proof, workstation }) {
  const directory = await mkdtemp(join(tmpdir(), "bop-pickup-browser-"));
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
              screenId: "FUL-PICKUP-QUEUE",
              label: "Pickup",
              href: "/operations/pickup",
              permission: "fulfillment.operate",
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
        pickupQuery: createMerchantPickupQuery({
          persistence,
          authentication,
          store: handoff.store,
          installContext: handoff.installContext,
          resolveWorkstation: async () => workstation,
        }),
        pickupProof: createMerchantPickupProof({ persistence, authentication, ...proof }),
        pickupHandoff: createMerchantPickupHandoff({ persistence, authentication, ...handoff }),
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
    await page.goto(origin + "/operations/pickup");
    const boot = await bootstrap;
    assert.equal(boot.status(), 200, "Persisted Merchant bootstrap must succeed");
    const bootBody = await boot.json();
    assert.equal(bootBody.workspace.selectedScope.storeReference, scope.storeReference);
    assert.notEqual(bootBody.workspace.businessDate, "2000-01-01");
    await expect(page.getByRole("heading", { name: "Pickup Queue", exact: true })).toBeVisible();
    const refresh = page.getByRole("button", { name: "Refresh from source", exact: true });
    return {
      async verify(intent) {
        await page.getByRole("button", { name: "Open proof verification", exact: true }).click();
        await page.getByLabel("Pickup credential", { exact: true }).fill(intent.credential);
        const completed = page.waitForResponse(
          (response) =>
            response.url() === origin + "/merchant/pickup/proof" &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Verify pickup proof", exact: true }).click();
        const response = await completed;
        assert.equal(response.status(), 200, "Pickup browser proof must succeed");
        const sent = response.request().postDataJSON();
        assert.equal(sent.storeReference, scope.storeReference);
        assert.equal(sent.actorReference, undefined);
        Object.assign(intent, sent);
        await expect(page.getByText("Proof verified.", { exact: false })).toBeVisible();
        return response.json();
      },
      async handoff(intent) {
        await page.getByRole("button", { name: "Review pickup handoff" }).click();
        const dialog = page.getByRole("dialog", { name: "Confirm pickup handoff" });
        await dialog.getByLabel("Recipient type").selectOption(intent.recipientType);
        await dialog.getByLabel("Masked recipient label").fill(intent.recipientDisplayMask);
        await dialog.getByRole("checkbox").check();
        const completed = page.waitForResponse(
          (response) =>
            response.url() === origin + "/merchant/pickup/handoff" &&
            response.request().method() === "POST",
        );
        await dialog.getByRole("button", { name: "Confirm and record handoff" }).click();
        const response = await completed;
        assert.equal(response.status(), 200, "Pickup browser handoff must succeed");
        const sent = response.request().postDataJSON();
        assert.equal(sent.storeReference, scope.storeReference);
        assert.equal(sent.actorReference, undefined);
        assert.equal(sent.deviceReference, workstation.deviceReference);
        assert.equal(sent.pickupLocationReference, workstation.pickupLocationReference);
        Object.assign(intent, sent);
        await expect(
          dialog.getByText("Handoff recorded. Close and refresh the queue."),
        ).toBeVisible();
        await dialog.getByRole("button", { name: "Close handoff confirmation" }).click();
        await refresh.click();
        await expect(
          page.getByRole("heading", { name: "No matching pickups", exact: true }),
        ).toBeVisible();
        assert.equal(
          await page.evaluate(
            () => globalThis.localStorage.length + globalThis.sessionStorage.length,
          ),
          0,
        );
        return response.json();
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
