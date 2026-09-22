import { URL } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
const apiRequire = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const webRequire = createRequire(
  new URL("../../../apps/merchant-web/package.json", import.meta.url),
);
const express = apiRequire("express");
const { chromium, expect } = webRequire("@playwright/test");

/** Opt-in milestone: actual built UI -> HTTPS router -> persisted owner composition.
 * Only TLS certificate validation is relaxed for an ephemeral local test certificate.
 * Authentication cookie is an actual already-issued synthetic-provider session.
 */
export async function verifyMerchantServiceBrowser({
  control,
  configuration,
  assertConfigurationAudit,
  cookie,
  store,
  now,
  advance,
}) {
  const directory = await mkdtemp(join(tmpdir(), "bop-service-browser-"));
  let server, browser;
  try {
    const keyPath = join(directory, "key.pem"),
      certPath = join(directory, "cert.pem");
    await promisify(execFile)(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=127.0.0.1",
        "-days",
        "1",
      ],
      { timeout: 10000 },
    );
    const app = express();
    server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = "https://127.0.0.1:" + server.address().port;
    app.use(
      "/merchant",
      createMerchantBffRouter(configuration.runtime(origin, new URL(origin).host)),
    );
    const assets = resolve("apps/merchant-web/dist");
    app.use(express.static(assets));
    app.get("/{*path}", (_request, response) => response.sendFile(join(assets, "index.html")));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    await context.addCookies([
      {
        name: "__Host-bop-merchant",
        value: cookie,
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(now()));
    const writes = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url() === origin + "/merchant/service-control")
        writes.push(request.postDataJSON());
    });
    await page.goto(origin + "/app/organization/stores/" + store + "/service");
    const panel = page.getByRole("region", { name: "Service controls" });
    await expect(panel.getByText("No active pauses.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Published hours" })).toBeVisible();
    await expect(page.getByText("Business day starts at 04:00:00 local time.")).toBeVisible();
    await expect(
      page.getByText(
        "08:00:00–17:00:00 · Pickup · order cutoff 0 seconds before closing · preparation lead time 600 seconds",
      ),
    ).toBeVisible();

    const original = await control.read(cookie);
    await panel.getByLabel("Pause duration (minutes)").fill("15");
    await panel.getByLabel("Service", { exact: true }).selectOption("Pickup");
    await panel.getByRole("button", { name: "Pause service", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Resume Pickup" })).toBeVisible();
    const paused = await control.read(cookie);
    assert.equal(paused.expectedVersion, original.expectedVersion + 1);
    assert.equal(paused.activePauses.length, 1);
    assert.equal(paused.activePauses[0].closureReference, writes[0].operationReference);
    assert.deepEqual(paused.activePauses[0].serviceModes, ["Pickup"]);
    const replay = await page.evaluate(async (command) => {
      const sessionResponse = await globalThis.fetch("/merchant/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const session = await sessionResponse.json();
      const response = await globalThis.fetch("/merchant/service-control", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-BOP-CSRF": session.csrf },
        body: JSON.stringify(command),
      });
      return { status: response.status, result: await response.json() };
    }, writes[0]);
    assert.deepEqual(replay, {
      status: 200,
      result: { status: "AlreadyApplied", resultingVersion: paused.expectedVersion },
    });
    assert.equal((await control.read(cookie)).activePauses.length, 1);

    advance();
    await page.clock.setFixedTime(new Date(now()));
    await panel.getByRole("button", { name: "Resume Pickup" }).focus();
    await page.keyboard.press("Enter");
    await expect(panel.getByText("No active pauses.")).toBeVisible();
    const resumed = await control.read(cookie);
    assert.equal(resumed.expectedVersion, original.expectedVersion + 2);
    assert.deepEqual(resumed.activePauses, []);
    assert.equal(writes.length, 3);
    assert.equal(writes[2].content.pauseOperationReference, writes[0].operationReference);
    await page.reload();
    await expect(panel.getByText("No active pauses.")).toBeVisible();
    assert.equal(writes.length, 3);

    const beforeConfiguration = await configuration.read(cookie);
    const configurationWrites = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url() === origin + "/merchant/store-configuration")
        configurationWrites.push(request.postDataJSON());
    });
    const editor = page.getByRole("region", { name: "Operating hours draft" });
    await editor.getByRole("button", { name: "Edit operating hours" }).click();
    await editor.getByLabel("Business day starts").fill("05:00");
    await editor.getByRole("button", { name: "Save hours draft" }).click();
    await expect(
      editor.getByText("Draft saved. It takes effect only after approval and publication."),
    ).toBeVisible();
    assert.equal(configurationWrites.length, 1);
    await assertConfigurationAudit(configurationWrites[0]);
    const savedConfiguration = await configuration.read(cookie);
    assert.equal(savedConfiguration.expectedVersion, beforeConfiguration.expectedVersion + 1);
    assert.equal(savedConfiguration.latest.businessDayStartLocalTime, "05:00:00");
    assert.equal(
      savedConfiguration.current.configurationReference,
      beforeConfiguration.current.configurationReference,
    );
    await page.reload();
    await editor.getByRole("button", { name: "Edit operating hours" }).click();
    await expect(editor.getByLabel("Business day starts")).toHaveValue("05:00");
    assert.equal(configurationWrites.length, 1);

    await editor.getByRole("button", { name: "Validate saved draft" }).click();
    await expect(editor.getByText("Saved draft validated.")).toBeVisible();
    await editor.getByRole("button", { name: "Submit saved draft" }).click();
    await expect(editor.getByText("Draft submitted for independent approval.")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Submit saved draft" })).toBeDisabled();
    assert.equal(configurationWrites.length, 3);
    assert.equal(configurationWrites[1].command, "Validate");
    assert.equal(configurationWrites[2].command, "Submit");
    assert.equal(
      configurationWrites[2].configuration.configurationReference,
      configurationWrites[0].configuration.configurationReference,
    );
    for (const request of configurationWrites) await assertConfigurationAudit(request);
    const submittedConfiguration = await configuration.read(cookie);
    assert.equal(submittedConfiguration.latest.lifecycle, "PendingApproval");
    assert.equal(submittedConfiguration.expectedVersion, savedConfiguration.expectedVersion);
    assert.equal(
      submittedConfiguration.current.configurationReference,
      beforeConfiguration.current.configurationReference,
    );
    const ownApprovalResponse = page.waitForResponse(
      (response) =>
        response.url() === origin + "/merchant/store-configuration" &&
        response.request().method() === "POST",
    );
    await editor.getByRole("button", { name: "Approve reviewed configuration" }).click();
    assert.equal((await ownApprovalResponse).status(), 403);
    await expect(editor.getByText(/Permission denied/)).toBeVisible();
    assert.equal((await configuration.read(cookie)).latest.lifecycle, "PendingApproval");

    // Explicit synthetic second-author setup; approving browser/session stays real.
    const reviewPending = await configuration.prepareBrowserApproval();
    await editor.getByRole("button", { name: "Edit operating hours" }).click();
    await editor.getByLabel("Business day starts").fill("06:00");
    await expect(
      editor.getByRole("button", { name: "Approve reviewed configuration" }),
    ).toBeDisabled();
    await editor.getByLabel("Business day starts").fill("05:00");
    await editor.getByRole("button", { name: "Approve reviewed configuration" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      editor.getByText(
        "Configuration approved. Published hours remain unchanged until publication.",
      ),
    ).toBeVisible();
    assert.equal(configurationWrites.length, 5);
    const approvalRequest = configurationWrites[4];
    assert.equal(approvalRequest.command, "Approve");
    assert.equal(approvalRequest.configuration.lifecycle, "PendingApproval");
    assert.equal(approvalRequest.configuration.approvedByReference, null);
    await assertConfigurationAudit(approvalRequest);
    const approvedConfiguration = await configuration.read(cookie);
    assert.equal(approvedConfiguration.latest.lifecycle, "Approved");
    assert.equal(approvedConfiguration.expectedVersion, reviewPending.configurationVersion);
    assert.equal(
      approvedConfiguration.current.configurationReference,
      beforeConfiguration.current.configurationReference,
    );
    await page.reload();
    await editor.getByRole("button", { name: "Edit operating hours" }).click();
    await expect(editor.getByText("Latest state: Approved")).toBeVisible();
    await expect(
      editor.getByRole("button", { name: "Approve reviewed configuration" }),
    ).toHaveCount(0);
    const approvalReplay = await page.evaluate(async (command) => {
      const session = await (
        await globalThis.fetch("/merchant/session", {
          credentials: "same-origin",
          cache: "no-store",
        })
      ).json();
      const response = await globalThis.fetch("/merchant/store-configuration", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "X-BOP-CSRF": session.csrf },
        body: JSON.stringify(command),
      });
      return { status: response.status, result: await response.json() };
    }, approvalRequest);
    assert.deepEqual(approvalReplay, {
      status: 200,
      result: { status: "AlreadyApplied", resultingVersion: reviewPending.configurationVersion },
    });
    await assertConfigurationAudit(approvalRequest);
    await configuration.verifyPublication(async () => {
      advance();
      await page.reload();
      await editor.getByRole("button", { name: "Edit operating hours" }).click();
      await editor.getByLabel("Business day starts").fill("06:00");
      await expect(
        editor.getByRole("button", { name: "Publish approved configuration" }),
      ).toBeDisabled();
      await editor.getByLabel("Business day starts").fill("05:00");
      const previousWrites = configurationWrites.length;
      await editor.getByRole("button", { name: "Publish approved configuration" }).focus();
      await page.keyboard.press("Enter");
      await expect(editor.getByText("Configuration published.")).toBeVisible();
      assert.equal(configurationWrites.length, previousWrites + 1);
      const request = configurationWrites.at(-1);
      assert.equal(request.command, "Publish");
      assert.equal(request.configuration.updatedAt, approvedConfiguration.latest.updatedAt);
      await page.reload();
      await editor.getByRole("button", { name: "Edit operating hours" }).click();
      await expect(editor.getByText("Latest state: Published")).toBeVisible();
      await expect(editor.getByLabel("Business day starts")).toHaveValue("05:00");
      await expect(
        editor.getByRole("button", { name: "Publish approved configuration" }),
      ).toHaveCount(0);
      return request;
    });
    await context.close();
  } finally {
    await browser?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
}
