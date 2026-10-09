import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
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
    if (path === "/merchant/session") {
      const selected = {
        storeReference: id(3),
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
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
      profile: "StoreSetupSaveV1",
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
            profile: "StoreSetupDraftV1",
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
  // On narrow screens the workspace navigation sits behind the Menu disclosure (WP-2423 M1).
  const compactMenu = page.locator(".workspace-sidebar__compact > summary");
  if (await compactMenu.isVisible()) await compactMenu.click();
  await page
    .getByRole("link", { name: "Store setup", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/organization/stores/${id(3)}/setup$`));
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeEnabled();
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
  await page.getByRole("button", { name: "2. Address and timezone", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Draft timezone", exact: true })
    .selectOption("America/Toronto");
  await page.getByLabel("Business day starts at (local time)", { exact: true }).fill("04:00:00");
}
test("@production Store Setup ordinary entry eight steps partial save refresh and reload", async ({
  page,
}) => {
  const fixture = await install(page);
  await open(page);
  await expect(
    page.getByRole("navigation", { name: "Setup steps" }).getByRole("button"),
  ).toHaveCount(8);
  await timezone(page);
  await page.getByRole("button", { name: "3. Service modes", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Configuration source", exact: true })
    .selectOption("StoreOverride");
  await page.getByLabel("Pickup", { exact: true }).check();
  await page.getByRole("button", { name: "4. Hours", exact: true }).click();
  await page.getByRole("button", { name: "Configure weekly hours", exact: true }).click();
  await page.getByRole("button", { name: "Add Monday interval", exact: true }).click();
  await page.getByLabel("Monday interval 1 start", { exact: true }).fill("09:00:00");
  await page.getByLabel("Monday interval 1 end", { exact: true }).fill("17:00:00");
  await page
    .getByRole("group", { name: "Monday interval 1 service modes", exact: true })
    .getByLabel("Pickup", { exact: true })
    .check();
  await page.getByLabel("Order cutoff seconds", { exact: true }).fill("600");
  await page.getByLabel("Lead time seconds", { exact: true }).fill("900");
  await page.getByRole("button", { name: "Save setup draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.control.writes).toHaveLength(1);
  expect(fixture.control.reads).toBeGreaterThanOrEqual(3);
  expect(fixture.snapshot()?.content.addressReference).toEqual({ state: "Unconfigured" });
  expect(fixture.snapshot()?.content.weeklySchedule.state).toBe("Configured");
  await page.reload();
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "2. Address and timezone", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Draft timezone", exact: true })).toHaveValue(
    "America/Toronto",
  );
  await expect(page.getByLabel("Business day starts at (local time)", { exact: true })).toHaveValue(
    "04:00:00",
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
  await page.getByRole("button", { name: "Save setup draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original save", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeDisabled();
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
  await expect(page.getByRole("alert")).toContainText("does not allow this action");
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeDisabled();
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
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeEnabled();
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
  await page.getByRole("button", { name: "2. Address and timezone", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Address and timezone", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Draft timezone", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await page
      .getByRole("button", { name: "Save setup draft", exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  expect(
    await page
      .getByRole("combobox", { name: "Draft timezone", exact: true })
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: "/tmp/wp2421-store-setup-mobile.png", fullPage: true });
  fixture.control.wrongScope = true;
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "selected Store or signed-in session changed",
  );
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toHaveCount(0);
  expect(fixture.control.writes).toHaveLength(0);
  expect(fixture.control.errors).toEqual([]);
});
