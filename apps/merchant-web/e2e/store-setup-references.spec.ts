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
  parseStoreSetupReferenceSave,
  parseStoreSetupReferenceVersion,
  parseStoreSetupReferenceReceipt,
  parseStoreSetupReferencesCurrent,
  type StoreSetupReferenceKind,
  type StoreSetupReferenceVersion,
} from "../../../packages/rms/store/src/contracts/store-setup-reference.js";
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
        const open = indexedDB.open("bop-store-setup-reference-pending-v1", 1);
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
    loseContact: false,
    denyResolve: false,
    wrongReferenceScope: false,
    requiredCsrf: csrf,
    referenceWrites: [] as Record<string, unknown>[],
    resolves: [] as Record<string, unknown>[],
    draftWrites: [] as Record<string, unknown>[],
    dispatchCursors: [] as unknown[],
    errors: [] as string[],
  };
  const versions = new Map<StoreSetupReferenceKind, StoreSetupReferenceVersion>(),
    ledger = new Map<string, ReturnType<typeof parseStoreSetupReferenceReceipt>>();
  let draft: StoreSetupDraft | null = null;
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
    if (path === "/merchant/store-setup/references" && request.method() === "GET") {
      expect(url.searchParams.get("storeReference")).toBe(scope.storeReference);
      const actual = control.wrongReferenceScope ? { ...scope, storeReference: id(30) } : scope;
      return respond(
        route,
        parseStoreSetupReferencesCurrent({
          profile: "StoreSetupReferencesCurrentV1",
          ...actual,
          address: versions.get("Address") ?? null,
          contact: versions.get("Contact") ?? null,
          observedAt: at,
          validUntil: new Date(Date.parse(at) + 5000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
        }),
      );
    }
    if (
      request.method() !== "POST" ||
      ![
        "/merchant/store-setup",
        "/merchant/store-setup/references/address",
        "/merchant/store-setup/references/contact",
      ].includes(path)
    )
      return respond(route, { error: "fixture_unavailable" }, 503);
    const actualScope = JSON.parse(
      Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString("utf8"),
    );
    expect(actualScope).toEqual(scope);
    const body: Record<string, unknown> = request.postDataJSON();
    if (request.headers()["x-bop-csrf"] !== control.requiredCsrf)
      return respond(route, { error: "request_denied" }, 403);
    if (path !== "/merchant/store-setup") {
      const kind: StoreSetupReferenceKind = path.endsWith("address") ? "Address" : "Contact";
      expect(Object.keys(body).sort()).toEqual(
        [
          "command",
          "operationReference",
          "expectedReference",
          "expectedRevision",
          body.command === "ResolveOriginal" ? "intentDigest" : "content",
        ].sort(),
      );
      const cursors = await records(page);
      control.dispatchCursors.push(...cursors);
      expect(cursors).toContainEqual({
        profile: "StoreSetupReferencePendingOriginalV1",
        scope,
        kind,
        operationReference: body.operationReference,
        expectedReference: body.expectedReference,
        expectedRevision: body.expectedRevision,
        intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      if (body.command === "ResolveOriginal") {
        control.resolves.push(body);
        expect(body).not.toHaveProperty("content");
        if (control.denyResolve) return respond(route, { error: "request_denied" }, 403);
        const receipt = ledger.get(String(body.operationReference));
        if (!receipt) throw new Error("Synthetic original was not committed");
        expect(body.intentDigest).toBe(receipt.intentDigest);
        expect(body.expectedReference).toBe(receipt.expectedReference);
        expect(body.expectedRevision).toBe(receipt.expectedRevision);
        return respond(route, receipt);
      }
      expect(body.command).toBe("SaveReference");
      control.referenceWrites.push(body);
      const command = parseStoreSetupReferenceSave({
        profile: "StoreSetupReferenceSaveV1",
        ...scope,
        kind,
        operationReference: body.operationReference,
        expectedReference: body.expectedReference,
        expectedRevision: body.expectedRevision,
        content: body.content,
        purposeCode: "STORE_SETUP_REFERENCE",
      });
      const previous = versions.get(kind);
      expect(command.expectedReference).toBe(previous?.reference ?? null);
      expect(command.expectedRevision).toBe(previous?.revision ?? 0);
      const snapshot = parseStoreSetupReferenceVersion({
        profile: "StoreSetupReferenceVersionV1",
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        kind,
        reference: id(50 + control.referenceWrites.length),
        revision: command.expectedRevision + 1,
        authoredByReference: id(4),
        previousReference: previous?.reference ?? null,
        content: command.content,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
        dataClassification: "Internal",
      });
      versions.set(kind, snapshot);
      const receipt = parseStoreSetupReferenceReceipt({
        profile: "StoreSetupReferenceReceiptV1",
        ...scope,
        kind,
        operationReference: command.operationReference,
        intentDigest: hash(command),
        expectedReference: command.expectedReference,
        expectedRevision: command.expectedRevision,
        outcome: "Committed",
        snapshot,
        auditReference: id(200 + control.referenceWrites.length),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      if (kind === "Contact" && control.loseContact) {
        control.loseContact = false;
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
    const actual: StoreSetupActualScope = {
      ...scope,
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      baseConfigurationReference: null,
    };
    if (command.content.addressReference.state === "Configured")
      expect(command.content.addressReference.value).toBe(versions.get("Address")?.reference);
    if (command.content.contactReference.state === "Configured")
      expect(command.content.contactReference.value).toBe(versions.get("Contact")?.reference);
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
  return { control, versions, draft: () => draft };
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
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole("button", { name: "Save setup draft", exact: true })).toBeEnabled();
}
async function addressStep(page: Page) {
  await page.getByRole("button", { name: "2. Address and timezone", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save address configuration", exact: true }),
  ).toBeEnabled();
}
async function fillAddress(page: Page) {
  const region = page.getByRole("region", { name: "Address configuration", exact: true });
  for (const [label, value] of [
    ["Country code", "CA"],
    ["Province or region code", "ON"],
    ["City", "Synthetic locality"],
    ["Postal code", "M1M 1M1"],
    ["Address line 1", "Synthetic fixture address"],
  ] as const)
    await region.getByLabel(label, { exact: true }).fill(value);
}
async function contactStep(page: Page) {
  await page.getByRole("button", { name: "7. Contacts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save contact configuration", exact: true }),
  ).toBeEnabled();
}
async function fillContact(page: Page) {
  const region = page.getByRole("region", { name: "Contact configuration", exact: true });
  await region.getByLabel("Contact name", { exact: true }).fill("Synthetic business contact");
  await region.getByLabel("Business phone with country code", { exact: true }).fill("+14165550123");
  await region.getByLabel("Website (optional)", { exact: true }).fill("https://example.test/");
}

test("@production Store Setup saves Address and Contact references then binds selections in refreshed draft", async ({
  page,
}) => {
  const f = await install(page);
  await open(page);
  await addressStep(page);
  await fillAddress(page);
  await page.getByRole("button", { name: "Save address configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use saved address", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Use saved address", exact: true }).click();
  await contactStep(page);
  await fillContact(page);
  await page.getByRole("button", { name: "Save contact configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Use saved contact", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Use saved contact", exact: true }).click();
  await page.getByRole("button", { name: "Save setup draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.control.referenceWrites).toHaveLength(2);
  expect(f.control.draftWrites).toHaveLength(1);
  expect(f.draft()?.content.addressReference).toEqual({
    state: "Configured",
    value: f.versions.get("Address")?.reference,
  });
  expect(f.draft()?.content.contactReference).toEqual({
    state: "Configured",
    value: f.versions.get("Contact")?.reference,
  });
  expect(await records(page)).toEqual([]);
  await page.reload();
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  await addressStep(page);
  await expect(page.getByLabel("Address line 1", { exact: true })).toHaveValue(
    "Synthetic fixture address",
  );
  await contactStep(page);
  await expect(page.getByLabel("Contact name", { exact: true })).toHaveValue(
    "Synthetic business contact",
  );
  expect(f.control.errors).toEqual([]);
});
test("@production Contact committed response loss retains payload-free original across reload and denied recovery", async ({
  page,
}) => {
  const f = await install(page);
  await open(page);
  await contactStep(page);
  await fillContact(page);
  f.control.loseContact = true;
  await page.getByRole("button", { name: "Save contact configuration", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original contact save", exact: true }),
  ).toBeEnabled();
  const original = await records(page);
  expect(original).toHaveLength(1);
  expect(original[0]).toEqual({
    profile: "StoreSetupReferencePendingOriginalV1",
    scope,
    kind: "Contact",
    operationReference: f.control.referenceWrites[0]?.operationReference,
    expectedReference: null,
    expectedRevision: 0,
    intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
  });
  for (const disallowed of [
    "contactName",
    "businessPhone",
    "website",
    "content",
    "csrf",
    "snapshot",
  ])
    expect(JSON.stringify(original)).not.toContain(disallowed);
  await page.reload();
  await page.getByRole("button", { name: "7. Contacts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original contact save", exact: true }),
  ).toBeEnabled();
  expect(f.control.referenceWrites).toHaveLength(1);
  expect(f.control.resolves).toHaveLength(0);
  f.control.denyResolve = true;
  await page.getByRole("button", { name: "Recover original contact save", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Contact configuration", exact: true }).getByRole("alert"),
  ).toContainText("cannot access this configuration");
  expect(await records(page)).toEqual(original);
  await expect(
    page.getByRole("button", { name: "Save contact configuration", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "7. Contacts", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original contact save", exact: true }),
  ).toBeEnabled();
  f.control.denyResolve = false;
  await page.getByRole("button", { name: "Recover original contact save", exact: true }).click();
  await expect(
    page.getByText(
      "Earlier save confirmed. Choose this saved configuration to use it in the setup draft.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await records(page)).toEqual([]);
  expect(f.control.referenceWrites).toHaveLength(1);
  expect(f.control.resolves).toHaveLength(2);
  expect(f.control.resolves[0]).toEqual(f.control.resolves[1]);
  await page.getByRole("button", { name: "Use saved contact", exact: true }).click();
  await page.getByRole("button", { name: "Save setup draft", exact: true }).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.draft()?.content.contactReference).toEqual({
    state: "Configured",
    value: f.versions.get("Contact")?.reference,
  });
  expect(f.control.errors).toEqual([]);
});
test("@production Reference controls reflow at 390px and scope or CSRF denial cannot create facts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await install(page);
  await open(page);
  await page.getByRole("button", { name: "2. Address and timezone", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Address configuration", exact: true }),
  ).toBeVisible();
  await fillAddress(page);
  const save = page.getByRole("button", { name: "Save address configuration", exact: true });
  await save.focus();
  await expect(save).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  f.control.requiredCsrf = "B".repeat(43);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("region", { name: "Address configuration", exact: true }).getByRole("alert"),
  ).toContainText("cannot access this configuration");
  expect(f.control.referenceWrites).toEqual([]);
  expect(f.versions.size).toBe(0);
  expect(await records(page)).toHaveLength(1);
  f.control.wrongReferenceScope = true;
  await page.reload();
  await page.getByRole("button", { name: "2. Address and timezone", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Address configuration", exact: true }).getByRole("alert"),
  ).toContainText("Configuration unavailable");
  await expect(save).toBeDisabled();
  expect(f.control.referenceWrites).toEqual([]);
  expect(f.control.draftWrites).toEqual([]);
  expect(await records(page)).toHaveLength(1);
  expect(f.control.errors).toEqual([]);
});
