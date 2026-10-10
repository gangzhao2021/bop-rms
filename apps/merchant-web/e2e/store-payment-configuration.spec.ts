import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  createStoreSetupDraft,
  replaceStoreSetupDraftContent,
  type StoreSetupDraft,
  type StoreSetupActualScope,
} from "../../../packages/rms/store/src/contracts/store-setup-draft.js";
import {
  parseStoreSetupSaveCommand,
  parseStoreSetupOperationReceipt,
} from "../../../packages/rms/store/src/contracts/store-setup-operation.js";
import {
  parseStorePaymentConfigurationSave,
  parseStorePaymentConfigurationVersion,
  parseStorePaymentConfigurationReceipt,
  parseStorePaymentConfigurationCurrent,
  type StorePaymentConfigurationVersion,
} from "../../../packages/rms/payment/src/contracts/store-payment-configuration.js";
import { canonicalPublicationValue } from "../src/product-publication-command-client-v2.js";

// Built App, real browser clients and IndexedDB. HTTP identities, persistence and
// business inputs are synthetic; public owning parsers do not confer native IAM.
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const csrf = "A".repeat(43),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
const href = `/app/organization/stores/${id(3)}/setup`;
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalPublicationValue(value)).digest("hex");
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
async function records(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open("bop-store-payment-configuration-pending-v1", 1);
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
async function install(page: Page) {
  const control = {
    losePayment: false,
    denyResolve: false,
    requiredCsrf: csrf,
    paymentWrites: [] as Record<string, unknown>[],
    resolves: [] as Record<string, unknown>[],
    draftWrites: [] as Record<string, unknown>[],
    dispatchCursors: [] as unknown[],
    errors: [] as string[],
  };
  let payment: StorePaymentConfigurationVersion | null = null,
    draft: StoreSetupDraft | null = null;
  const saved = new Map<string, StorePaymentConfigurationVersion>(),
    ledger = new Map<string, ReturnType<typeof parseStorePaymentConfigurationReceipt>>();
  page.on("pageerror", (error) => control.errors.push(error.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      at = new Date().toISOString();
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
    if (path === "/merchant/store-setup" && request.method() === "GET") {
      expect(url.searchParams.get("storeReference")).toBe(scope.storeReference);
      return respond(route, {
        profile: "StoreSetupWorkspaceV1",
        scope,
        store: {
          storeReference: id(3),
          code: "SYNTH_STORE",
          displayName: "Synthetic Store",
          locale: "en-CA",
          currencyCode: "CAD",
          timeZone: "America/Toronto",
          version: 1,
        },
        setup: {
          profile: "StoreSetupCurrentV1",
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          readerActorReference: id(4),
          snapshot: draft,
          observedAt: at,
          validUntil: new Date(Date.parse(at) + 5000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
        },
      });
    }

    if (path === "/merchant/store-setup/references" && request.method() === "GET")
      return respond(route, {
        profile: "StoreSetupReferencesCurrentV1",
        ...scope,
        address: null,
        contact: null,
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
        businessReferenceValidation: "NotEvaluated",
      });
    if (path === "/merchant/store-setup/payment-configuration" && request.method() === "GET")
      return respond(
        route,
        parseStorePaymentConfigurationCurrent({
          profile: "StorePaymentConfigurationCurrentV1",
          ...scope,
          snapshot: payment,
          observedAt: at,
          validUntil: new Date(Date.parse(at) + 5000).toISOString(),
          providerReadiness: "NotEvaluated",
        }),
      );
    if (
      request.method() !== "POST" ||
      !["/merchant/store-setup", "/merchant/store-setup/payment-configuration"].includes(path)
    )
      return respond(route, { error: "fixture_unavailable" }, 503);
    const actualScope = JSON.parse(
      Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString("utf8"),
    );
    expect(actualScope).toEqual(scope);
    const body: Record<string, unknown> = request.postDataJSON();
    if (request.headers()["x-bop-csrf"] !== control.requiredCsrf)
      return respond(route, { error: "request_denied" }, 403);
    if (path === "/merchant/store-setup/payment-configuration") {
      expect(Object.keys(body).sort()).toEqual(
        [
          "command",
          "operationReference",
          "expectedConfigurationReference",
          "expectedRevision",
          body.command === "ResolveOriginal" ? "intentDigest" : "content",
        ].sort(),
      );
      const cursors = await records(page);
      control.dispatchCursors.push(...cursors);
      expect(cursors).toContainEqual({
        profile: "StorePaymentConfigurationPendingOriginalV1",
        scope,
        operationReference: body.operationReference,
        expectedConfigurationReference: body.expectedConfigurationReference,
        expectedRevision: body.expectedRevision,
        intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      if (body.command === "ResolveOriginal") {
        control.resolves.push(body);
        if (control.denyResolve) return respond(route, { error: "request_denied" }, 403);
        const receipt = ledger.get(String(body.operationReference));
        if (!receipt) throw new Error("synthetic original missing");
        expect(body.intentDigest).toBe(receipt.intentDigest);
        return respond(route, receipt);
      }
      expect(body.command).toBe("SaveConfiguration");
      control.paymentWrites.push(body);
      const command = parseStorePaymentConfigurationSave({
        profile: "StorePaymentConfigurationSaveV1",
        ...scope,
        operationReference: body.operationReference,
        expectedConfigurationReference: body.expectedConfigurationReference,
        expectedRevision: body.expectedRevision,
        content: body.content,
        purposeCode: "STORE_PAYMENT_CONFIGURATION",
      });
      expect(command.expectedConfigurationReference).toBe(payment?.configurationReference ?? null);
      expect(command.expectedRevision).toBe(payment?.revision ?? 0);
      payment = parseStorePaymentConfigurationVersion({
        profile: "StorePaymentConfigurationV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        configurationReference: id(50 + control.paymentWrites.length),
        revision: command.expectedRevision + 1,
        authoredByReference: id(4),
        previousConfigurationReference: payment?.configurationReference ?? null,
        content: command.content,
        currencyCode: "CAD",
        createdAt: payment?.createdAt ?? at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      saved.set(payment.configurationReference, payment);
      const receipt = parseStorePaymentConfigurationReceipt({
        profile: "StorePaymentConfigurationReceiptV1",
        ...scope,
        operationReference: command.operationReference,
        intentDigest: hash(command),
        expectedConfigurationReference: command.expectedConfigurationReference,
        expectedRevision: command.expectedRevision,
        outcome: "Committed",
        snapshot: payment,
        auditReference: id(200 + control.paymentWrites.length),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      if (control.losePayment) {
        control.losePayment = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
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
    control.draftWrites.push(body);
    const command = parseStoreSetupSaveCommand({
      profile: Object.hasOwn(body.content, "feeContexts") ? "StoreSetupSaveV2" : "StoreSetupSaveV1",
      ...scope,
      operationReference: body.operationReference,
      expectedSetupReference: body.expectedSetupReference,
      expectedRevision: body.expectedRevision,
      content: body.content,
      purposeCode: "STORE_SETUP_DRAFT",
    });
    const actual: StoreSetupActualScope = {
      ...scope,
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      baseConfigurationReference: null,
    };
    if (command.content.paymentConfigurationReference.state === "Configured")
      expect(saved.has(command.content.paymentConfigurationReference.value)).toBe(true);
    draft = draft
      ? replaceStoreSetupDraftContent(draft, command.content, actual, {
          expectedRevision: command.expectedRevision,
          observedAt: at,
        })
      : createStoreSetupDraft(
          {
            profile:
              command.profile === "StoreSetupSaveV2" ? "StoreSetupDraftV2" : "StoreSetupDraftV1",
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            setupDraftReference: id(6),
            revision: 1,
            authoredByReference: id(4),
            defaultLocale: "en-CA",
            currencyCode: "CAD",
            baseConfigurationReference: null,
            content: command.content,
            createdAt: at,
            updatedAt: at,
            purposeCode: "STORE_SETUP_DRAFT",
            dataClassification: "ConfigurationMetadata",
          },
          actual,
        );
    return respond(
      route,
      parseStoreSetupOperationReceipt({
        profile: "StoreSetupOperationReceiptV1",
        ...scope,
        operationReference: command.operationReference,
        expectedSetupReference: command.expectedSetupReference,
        expectedRevision: command.expectedRevision,
        purposeCode: "STORE_SETUP_DRAFT",
        intentDigest: hash(command),
        outcome: "Committed",
        snapshot: draft,
        auditReference: id(400 + draft.revision),
        occurredAt: at,
      }),
    );
  });
  return {
    control,
    payment: () => payment,
    draft: () => draft,
    newManager: () => {
      if (!payment) throw new Error("synthetic payment missing");
      const at = new Date().toISOString();
      payment = parseStorePaymentConfigurationVersion({
        ...payment,
        configurationReference: id(99),
        revision: payment.revision + 1,
        previousConfigurationReference: payment.configurationReference,
        authoredByReference: id(9),
        content: { ...payment.content, customerOnlineCardEnabled: true },
        updatedAt: at,
      });
      saved.set(payment.configurationReference, payment);
    },
  };
}
async function open(page: Page) {
  await page.goto("/app");
  // On narrow screens the workspace navigation sits behind the Menu disclosure (WP-2423 M1).
  const workspaceNav = page.getByRole("navigation", { name: "Workspace" });
  await workspaceNav.waitFor();
  const compactMenu = workspaceNav.locator(".workspace-sidebar__compact > summary");
  if (await compactMenu.isVisible()) await compactMenu.click();
  await page
    .getByRole("link", { name: "Store setup", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save payment configuration", exact: true }),
  ).toBeEnabled();
}

test("@production Store payment rules save, explicit selection, setup resume retain immutable old selection", async ({
  page,
}) => {
  const f = await install(page);
  await open(page);
  await page.getByRole("checkbox", { name: "Staff terminal card present", exact: true }).check();
  await page.getByRole("checkbox", { name: "Staff terminal Interac", exact: true }).check();
  await page.getByRole("button", { name: "Save payment configuration", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Use saved payment configuration", exact: true }),
  ).toBeVisible();
  expect(f.payment()?.content).toEqual({
    customerOnlineCardEnabled: false,
    staffTerminalCardPresentEnabled: true,
    staffTerminalInteracEnabled: true,
  });
  expect(f.draft()).toBeNull();
  await page.getByRole("button", { name: "Use saved payment configuration", exact: true }).click();
  await page.getByRole("button", { name: "Save setup draft", exact: true }).click();
  await expect.poll(() => f.draft()?.revision).toBe(1);
  const selected = f.payment()?.configurationReference;
  expect(f.draft()?.content.paymentConfigurationReference).toEqual({
    state: "Configured",
    value: selected,
  });
  f.newManager();
  await page
    .getByRole("button", { name: "Refresh saved payment configuration", exact: true })
    .click();
  await expect(
    page.getByText("Saved payment revision 2. Provider readiness has not been evaluated."),
  ).toBeVisible();
  expect(f.draft()?.content.paymentConfigurationReference).toEqual({
    state: "Configured",
    value: selected,
  });
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save payment configuration", exact: true }),
  ).toBeEnabled();
  expect(f.draft()?.content.paymentConfigurationReference).toEqual({
    state: "Configured",
    value: selected,
  });
  expect(await records(page)).toEqual([]);
  expect(f.control.errors).toEqual([]);
});
test("@production payment committed reply loss reload denies recovery then clears same payload-free original", async ({
  page,
}) => {
  const f = await install(page);
  f.control.losePayment = true;
  await open(page);
  await page.getByRole("checkbox", { name: "Customer online card", exact: true }).check();
  await page.getByRole("button", { name: "Save payment configuration", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original payment save", exact: true }),
  ).toBeEnabled();
  const pending = await records(page);
  expect(pending).toHaveLength(1);
  const encoded = JSON.stringify(pending);
  for (const key of [
    "content",
    "csrf",
    "customerOnlineCardEnabled",
    "staffTerminalCardPresentEnabled",
    "staffTerminalInteracEnabled",
    "providerReadiness",
  ])
    expect(encoded).not.toContain(key);
  const op = f.control.paymentWrites[0]?.operationReference;
  await page.reload();
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save payment configuration", exact: true }),
  ).toBeDisabled();
  f.control.denyResolve = true;
  await page.getByRole("button", { name: "Recover original payment save", exact: true }).click();
  await expect(
    page.getByText("You cannot access payment configuration in the current Store."),
  ).toBeVisible();
  expect(await records(page)).toEqual(pending);
  f.control.denyResolve = false;
  await page.getByRole("button", { name: "Recover original payment save", exact: true }).click();
  await expect(
    page.getByText("Earlier payment save confirmed. Choose the saved configuration to use it."),
  ).toBeVisible();
  expect(await records(page)).toEqual([]);
  expect(f.control.paymentWrites).toHaveLength(1);
  expect(f.control.resolves.map((r) => r.operationReference)).toEqual([op, op]);
  expect(f.control.errors).toEqual([]);
});
test("@production mobile payment keyboard controls and CSRF denial preserve original barrier", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await install(page);
  await open(page);
  const toggle = page.getByRole("checkbox", { name: "Customer online card", exact: true });
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  f.control.requiredCsrf = "B".repeat(43);
  await page.getByRole("button", { name: "Save payment configuration", exact: true }).click();
  await expect(
    page.getByText("You cannot access payment configuration in the current Store."),
  ).toBeVisible();
  expect(f.control.paymentWrites).toEqual([]);
  expect(await records(page)).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Save payment configuration", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(f.control.errors).toEqual([]);
});
