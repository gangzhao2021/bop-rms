import { createHash } from "node:crypto";
import { establishedOpeningList, serveStoreSetupPanels } from "./store-setup-panels";
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoInternalText } from "./internal-text-guard";
import {
  createStoreSetupDraft,
  replaceStoreSetupDraftContent,
  type StoreSetupDraft,
} from "../../../packages/rms/store/src/contracts/store-setup-draft.js";
import {
  parseStoreSetupSaveCommand,
  parseStoreSetupOperationReceipt,
} from "../../../packages/rms/store/src/contracts/store-setup-operation.js";
import { canonicalPublicationValue } from "../src/product-publication-command-client-v2.js";
import { followWorkspaceLink, openStoreSetupPlace } from "./workspace-navigation";
// Production-built React, actual browser client/IndexedDB and public owning
// parsers. Session, IAM and HTTP persistence below are controlled synthetic
// fixtures; these cases do not prove PostgreSQL or actual permission authority.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const href = `/app/organization/stores/${id(3)}/setup`;
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
async function install(page: Page) {
  await serveStoreSetupPanels(page);
  const control = {
    loseNext: false,
    denyResolve: false,
    wrongScope: false,
    reads: 0,
    writes: [] as Record<string, unknown>[],
    resolves: [] as Record<string, unknown>[],
    errors: [] as string[],
  };
  let saved: StoreSetupDraft | null = null;
  const ledger = new Map<string, ReturnType<typeof parseStoreSetupOperationReceipt>>();
  page.on("pageerror", (error) => control.errors.push(error.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/merchant/store/opening-list") return respond(route, establishedOpeningList);
    if (path === "/merchant/session") {
      const selected = {
        storeReference: id(3),
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
        timeZone: "America/Toronto",
      };
      return respond(route, {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: selected,
          authorizedStores: [selected],
          navigation: [
            {
              screenId: "STORE-SETUP",
              href,
              label: "Store setup",
              permission: "organization.manage",
            },
          ],
          businessDate: "2026-10-05",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    if (path !== "/merchant/store-setup")
      return respond(route, { error: "fixture_unavailable" }, 503);
    const observedAt = new Date().toISOString();
    if (request.method() === "GET") {
      control.reads++;
      expect(new URL(request.url()).searchParams.get("storeReference")).toBe(id(3));
      const actual = control.wrongScope ? { ...scope, storeReference: id(30) } : scope;
      return respond(route, {
        profile: "StoreSetupWorkspaceV1",
        scope: actual,
        store: {
          storeReference: actual.storeReference,
          code: "SYNTH_STORE",
          displayName: "Synthetic Store",
          locale: "en-CA",
          currencyCode: "CAD",
          timeZone: "America/Toronto",
          version: 1,
        },
        setup: {
          profile: "StoreSetupCurrentV1",
          tenantReference: actual.tenantReference,
          brandReference: actual.brandReference,
          storeReference: actual.storeReference,
          readerActorReference: actual.actorReference,
          snapshot: saved,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
        },
      });
    }
    expect(request.headers()["x-bop-csrf"]).toBe(csrf);
    expect(
      JSON.parse(
        Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(
          "utf8",
        ),
      ),
    ).toEqual(scope);
    const body: Record<string, unknown> = request.postDataJSON();
    if (body.command === "ResolveOriginal") {
      control.resolves.push(body);
      expect(Object.keys(body).sort()).toEqual(
        [
          "command",
          "operationReference",
          "expectedSetupReference",
          "expectedRevision",
          "intentDigest",
        ].sort(),
      );
      expect(body).not.toHaveProperty("content");
      if (control.denyResolve) return respond(route, { error: "request_denied" }, 403);
      const original = ledger.get(String(body.operationReference));
      if (!original) throw new Error("Synthetic original was not committed");
      expect(body.intentDigest).toBe(original.intentDigest);
      expect(body.expectedRevision).toBe(original.expectedRevision);
      expect(body.expectedSetupReference).toBe(original.expectedSetupReference);
      return respond(route, original);
    }
    expect(body.command).toBe("SaveDraft");
    expect(Object.keys(body).sort()).toEqual(
      [
        "command",
        "operationReference",
        "expectedSetupReference",
        "expectedRevision",
        "content",
      ].sort(),
    );
    control.writes.push(body);
    const command = parseStoreSetupSaveCommand({
      profile: Object.hasOwn(body.content as object, "feeContexts")
        ? "StoreSetupSaveV2"
        : "StoreSetupSaveV1",
      ...scope,
      operationReference: body.operationReference,
      expectedSetupReference: body.expectedSetupReference,
      expectedRevision: body.expectedRevision,
      content: body.content,
      purposeCode: "STORE_SETUP_DRAFT",
    });
    expect(command.expectedRevision).toBe(saved?.revision ?? 0);
    expect(command.expectedSetupReference).toBe(saved?.setupDraftReference ?? null);
    const actual = {
      ...scope,
      defaultLocale: "en-CA",
      currencyCode: "CAD" as const,
      baseConfigurationReference: null,
    };
    saved = saved
      ? replaceStoreSetupDraftContent(saved, command.content, actual, {
          expectedRevision: command.expectedRevision,
          observedAt,
        })
      : createStoreSetupDraft(
          {
            profile:
              command.profile === "StoreSetupSaveV2" ? "StoreSetupDraftV2" : "StoreSetupDraftV1",
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            setupDraftReference: id(6),
            revision: 1,
            authoredByReference: scope.actorReference,
            defaultLocale: "en-CA",
            currencyCode: "CAD",
            baseConfigurationReference: null,
            content: command.content,
            createdAt: observedAt,
            updatedAt: observedAt,
            purposeCode: "STORE_SETUP_DRAFT",
            dataClassification: "ConfigurationMetadata",
          },
          actual,
        );
    const receipt = parseStoreSetupOperationReceipt({
      profile: "StoreSetupOperationReceiptV1",
      ...scope,
      operationReference: command.operationReference,
      expectedSetupReference: command.expectedSetupReference,
      expectedRevision: command.expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
      intentDigest:
        "sha256:" + createHash("sha256").update(canonicalPublicationValue(command)).digest("hex"),
      outcome: "Committed",
      snapshot: saved,
      auditReference: id(100 + saved.revision),
      occurredAt: observedAt,
    });
    ledger.set(command.operationReference, receipt);
    if (control.loseNext) {
      control.loseNext = false;
      return route.abort("failed");
    }
    return respond(route, receipt);
  });
  return { control, snapshot: () => saved };
}
async function open(page: Page) {
  await page.goto("/app");
  // The Menu drawer on phones, the closed navigation group on wider screens (UI refresh 2026-10-21).
  await followWorkspaceLink(page, "Store setup");
  await expect(page).toHaveURL(new RegExp(`/app/organization/stores/${id(3)}/setup$`));
  await openStoreSetupPlace(page, "Settings that need approval");
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeEnabled();
}
async function journalRecords(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-store-setup-pending-v1", 1);
        open.onerror = () => reject(new Error("Synthetic journal inspection failed"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          let values: unknown[] = [];
          request.onsuccess = () => {
            values = request.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(values);
          };
          tx.onabort = tx.onerror = () => {
            db.close();
            reject(new Error("Synthetic journal inspection failed"));
          };
        };
      }),
  );
}
async function timezone(page: Page) {
  await page.getByRole("button", { name: "1. Time zone and business day", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Time zone", exact: true })
    .selectOption("America/Toronto");
  await page.getByLabel("Business day starts at (local time)", { exact: true }).fill("04:00");
}
test("@production Store Setup ordinary entry approval steps partial save refresh and reload", async ({
  page,
}) => {
  const fixture = await install(page);
  await open(page);
  await expect(
    page.getByRole("navigation", { name: "Setup steps" }).getByRole("button"),
  ).toHaveCount(4);
  // b18 review: an open Store's approval place has no opening steps; hours live in Hours & ordering.
  await expect(
    page.getByRole("navigation", { name: "Setup steps" }).getByRole("button"),
  ).toHaveText([
    "1. Time zone and business day",
    "2. Services",
    "3. Fees, tax and payment",
    "4. Review and publish",
  ]);
  // WP-2423: every step reads in staff language (no store codes, enum names, UTC or stubs).
  for (const step of await page
    .getByRole("navigation", { name: "Setup steps" })
    .getByRole("button")
    .all()) {
    await step.click();
    // Time zones are listed by name and place; no identifier allowlist is needed.
    await expectNoInternalText(page);
  }
  await timezone(page);
  await page.getByRole("button", { name: "2. Services", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Use service settings from", exact: true })
    .selectOption("StoreOverride");
  await page.getByLabel("Pickup", { exact: true }).check();
  await page.getByLabel("Order limits").selectOption("none");
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.control.writes).toHaveLength(1);
  expect(fixture.control.reads).toBeGreaterThanOrEqual(3);
  expect(fixture.snapshot()?.content.addressReference).toEqual({ state: "Unconfigured" });
  expect(fixture.snapshot()?.content.capacityConfigurationReference).toEqual({
    state: "Configured",
    value: null,
  });
  // Weekly hours (minutes typed, seconds saved) are covered where they are edited: a Store being
  // opened (store-first-opening.spec.ts) and Hours & ordering (StoreConfigurationEditor tests).
  await page.reload();
  await page.getByRole("button", { name: "1. Time zone and business day", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toHaveValue(
    "America/Toronto",
  );
  await expect(
    page.getByRole("combobox", { name: "Time zone", exact: true }).locator("option:checked"),
  ).toHaveText("Eastern time (Toronto, Ottawa, Montréal)");
  // b21: the Canadian zones by plain name, not every world zone.
  const zoneField = page.getByRole("combobox", { name: "Time zone", exact: true });
  await expect(zoneField.locator("optgroup")).toHaveCount(0);
  await expect(zoneField.locator("option[value='America/Vancouver']")).toHaveText(
    "Pacific time (Vancouver)",
  );
  await expect(zoneField.locator("option[value='Pacific/Bougainville']")).toHaveCount(0);
  await expect(page.getByLabel("Business day starts at (local time)", { exact: true })).toHaveValue(
    // b19: the field shows hours and minutes; the draft still saves 04:00:00.
    "04:00",
  );
  expect(fixture.control.errors).toEqual([]);
});
test("@production Store Setup lost committed reply survives reload and denied recovery until exact original confirmed", async ({
  page,
}) => {
  const fixture = await install(page);
  await open(page);
  await timezone(page);
  fixture.control.loseNext = true;
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original save", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Recover original save", exact: true }),
  ).toBeEnabled();
  const retained = await journalRecords(page);
  expect(retained).toHaveLength(1);
  expect(retained[0]).toEqual({
    profile: "StoreSetupPendingOriginalV1",
    scope,
    operationReference: fixture.control.writes[0]?.operationReference,
    expectedSetupReference: null,
    expectedRevision: 0,
    intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
  });
  fixture.control.denyResolve = true;
  await page.getByRole("button", { name: "Recover original save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Your role can't change store setup");
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeDisabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Recover original save", exact: true }),
  ).toBeEnabled();
  fixture.control.denyResolve = false;
  await page.getByRole("button", { name: "Recover original save", exact: true }).click();
  await expect(
    page.getByText("The original save was committed. Current saved settings are shown.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.control.writes).toHaveLength(1);
  expect(fixture.control.resolves).toHaveLength(2);
  expect(await journalRecords(page)).toEqual([]);
  for (const resolved of fixture.control.resolves)
    expect(resolved.operationReference).toBe(fixture.control.writes[0]?.operationReference);
  await page.reload();
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Recover original save", exact: true }),
  ).toHaveCount(0);
  expect(fixture.control.errors).toEqual([]);
});
test("@production Store Setup mismatched selected scope refuses editing and narrow keyboard view reflows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await install(page);
  await open(page);
  await page.getByRole("button", { name: "1. Time zone and business day", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Time zone and business day", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await page
      .getByRole("button", { name: "Save as draft", exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await page
      .getByRole("combobox", { name: "Time zone", exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "/tmp/wp2421-store-setup-mobile.png", fullPage: true });
  // WP-2423: tapping a step moves to its heading; the skip link never covers the page.
  await page.getByRole("button", { name: "2. Services", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Services", exact: true })).toBeFocused();
  for (const skip of await page.locator(".bop-skip-link").all())
    expect(await skip.evaluate((link) => link.getBoundingClientRect().bottom)).toBeLessThanOrEqual(
      0,
    );
  fixture.control.wrongScope = true;
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "selected Store or signed-in session changed",
  );
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toHaveCount(0);
  expect(fixture.control.writes).toHaveLength(0);
  expect(fixture.control.errors).toEqual([]);
});
test("@production b20: an edit not saved yet comes back after switching the language", async ({
  page,
}) => {
  const fixture = await install(page);
  await open(page);
  await timezone(page);
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.control.writes).toHaveLength(1);
  // Changed, not saved: the language switch reloads the page and brings the edit back.
  await page.getByLabel("Business day starts at (local time)", { exact: true }).fill("04:30");
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect(page.getByLabel("营业日开始于（当地时间）", { exact: true })).toHaveValue("04:30");
  await expect(
    page.getByText("切换语言后，还没保存的修改仍在这里。存为草稿后才会保留。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "放弃未保存的修改" })).toBeEnabled();
  expect(fixture.control.writes).toHaveLength(1);
  // Back to English: still there (kept again), and saving keeps it for good.
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.getByLabel("Business day starts at (local time)", { exact: true })).toHaveValue(
    "04:30",
  );
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.snapshot()?.content.businessDayStartLocalTime).toEqual({
    state: "Configured",
    value: "04:30:00",
  });
  // Nothing unsaved: a switch brings nothing back and says nothing about it.
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect(page.getByLabel("营业日开始于（当地时间）", { exact: true })).toHaveValue("04:30");
  await expect(
    page.getByText("切换语言后，还没保存的修改仍在这里。", { exact: false }),
  ).toHaveCount(0);
  expect(fixture.control.errors).toEqual([]);
});
test("@production b21: with tab storage refusing writes, switching the language asks before losing an unsaved edit", async ({
  page,
}) => {
  const fixture = await install(page);
  // Private browsing or a full store: this tab cannot keep anything through the reload.
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException("Full", "QuotaExceededError");
      write.call(this, key, value);
    };
  });
  await open(page);
  await timezone(page);
  await page.getByLabel("Business day starts at (local time)", { exact: true }).fill("04:30");
  const dialogs: string[] = [];
  page.once("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "切换到中文" }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain("Switching the language reloads the page and loses it");
  // Cancelled: still English, and the edit is still on the page.
  await expect(page.getByLabel("Business day starts at (local time)", { exact: true })).toHaveValue(
    "04:30",
  );
  await expect(page.getByRole("combobox", { name: "Time zone", exact: true })).toHaveValue(
    "America/Toronto",
  );
  expect(fixture.control.writes).toHaveLength(0);
  expect(fixture.control.errors).toEqual([]);
});
// b23 (v15 live check of b22, store-setup-reconnect): losing the connection says the page is
// offline, not that the settings could not be loaded; once it is back the page reads the current
// settings again by itself and keeps what was typed.
const notLoaded =
  "The current Store settings could not be loaded. Connect and refresh to try again.";
const offlineLine =
  "Offline. What you typed here is kept. The current Store settings are read again when the connection is back.";
test("@production b23: back online, Store setup reads again by itself and keeps an unsaved edit", async ({
  page,
  context,
}) => {
  const fixture = await install(page);
  await open(page);
  await timezone(page);
  await page.getByLabel("Business day starts at (local time)", { exact: true }).fill("04:30");
  const before = fixture.control.reads;
  await context.setOffline(true);
  // Soft: a failure here still goes on to show what happens once the connection is back.
  await expect.soft(page.getByText(offlineLine, { exact: true })).toBeVisible();
  await expect.soft(page.getByText(notLoaded, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeDisabled();
  await context.setOffline(false);
  await expect.poll(() => fixture.control.reads).toBeGreaterThan(before);
  await expect(page.getByText(offlineLine, { exact: true })).toHaveCount(0);
  await expect(page.getByText(notLoaded, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Business day starts at (local time)", { exact: true })).toHaveValue(
    "04:30",
  );
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeEnabled();
  // Still gone a while later and on another step.
  await page.getByRole("button", { name: "2. Services", exact: true }).click();
  await expect(page.getByText(notLoaded, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save as draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.snapshot()?.content.businessDayStartLocalTime).toEqual({
    state: "Configured",
    value: "04:30:00",
  });
  expect(fixture.control.errors).toEqual([]);
});
test("@production b23: the connection dropping during the first read loads Store setup once it is back", async ({
  page,
  context,
}) => {
  const fixture = await install(page);
  // The first read of the setup does not answer before the connection goes.
  let held = true;
  await page.route("**/merchant/store-setup?**", async (route) => {
    if (held && route.request().method() === "GET") {
      held = false;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });
  await page.goto("/app");
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await context.setOffline(true);
  // Soft: a failure here still goes on to show what happens once the connection is back.
  await expect.soft(page.getByText(offlineLine, { exact: true })).toBeVisible();
  await expect.soft(page.getByText(notLoaded, { exact: true })).toHaveCount(0);
  await page.waitForTimeout(1_800);
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "Save as draft", exact: true })).toBeEnabled();
  await expect(page.getByText(offlineLine, { exact: true })).toHaveCount(0);
  await expect(page.getByText(notLoaded, { exact: true })).toHaveCount(0);
  expect(fixture.control.errors).toEqual([]);
});
test("@production b23: a setup read that fails while online still says it could not be loaded", async ({
  page,
}) => {
  const fixture = await install(page);
  await page.route("**/merchant/store-setup?**", (route) =>
    route.request().method() === "GET"
      ? respond(route, { error: "fixture_unavailable" }, 503)
      : route.fallback(),
  );
  await page.goto("/app");
  await followWorkspaceLink(page, "Store setup");
  await openStoreSetupPlace(page, "Settings that need approval");
  await expect(page.getByText(notLoaded, { exact: true })).toBeVisible();
  await expect(page.getByText(offlineLine, { exact: true })).toHaveCount(0);
  expect(fixture.control.errors).toEqual([]);
});
