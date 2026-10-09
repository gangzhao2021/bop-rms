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
  parseStoreSetupCurrent,
} from "../../../packages/rms/store/src/contracts/store-setup-operation.js";
import { parseTaxConfigClassificationChoices } from "../../api/src/merchant-tax-config-workbench-values.js";
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
    choiceMode: "Active" as "Active" | "Retired" | "Missing" | "Denied" | "Foreign",
    delayChoices: false,
    releaseChoices: (() => undefined) as () => void,
    choicesStarted: 0,
    actorReference: scope.actorReference,
    chronology: [] as string[],
  };
  let saved: StoreSetupDraft | null = null;
  const history: StoreSetupDraft[] = [];
  const currentScope = () => ({ ...scope, actorReference: control.actorReference });
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
    if (path === "/merchant/store-setup/fee-context-classifications") {
      control.choicesStarted++;
      const captured = currentScope(),
        mode = control.choiceMode;
      expect(request.method()).toBe("GET");
      expect(new URL(request.url()).searchParams.get("storeReference")).toBe(scope.storeReference);
      expect(
        JSON.parse(
          Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(
            "utf8",
          ),
        ),
      ).toEqual(captured);
      expect(request.postData()).toBeNull();
      if (control.delayChoices) {
        control.delayChoices = false;
        await new Promise<void>((resolve) => {
          control.releaseChoices = resolve;
        });
      }
      if (mode === "Denied") return respond(route, { error: "request_denied" }, 403);
      const observedAt = new Date().toISOString();
      const value = parseTaxConfigClassificationChoices({
        profile: "TaxConfigClassificationChoicesV1",
        ...captured,
        actorReference: mode === "Foreign" ? id(40) : captured.actorReference,
        registryReference: id(20),
        versionReference: id(21),
        registryVersion: 1,
        snapshotDigest: "sha256:" + "a".repeat(64),
        defaultLocale: "en-CA",
        choices:
          mode === "Missing"
            ? []
            : [
                {
                  classificationReference: id(22),
                  code: "SYNTH_FEE_CLASS",
                  localizedNames: { "en-CA": "Synthetic fee classification" },
                  lifecycle: mode === "Retired" ? "Retired" : "Active",
                },
              ],
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        sourceQualification: "NotEvaluated",
      });
      return respond(route, value);
    }
    if (path !== "/merchant/store-setup")
      return respond(route, { error: "fixture_unavailable" }, 503);
    const observedAt = new Date().toISOString();
    if (request.method() === "GET") {
      control.reads++;
      expect(new URL(request.url()).searchParams.get("storeReference")).toBe(id(3));
      const actual = control.wrongScope
        ? { ...currentScope(), storeReference: id(30) }
        : currentScope();
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
        setup: parseStoreSetupCurrent({
          profile: "StoreSetupCurrentV1",
          tenantReference: actual.tenantReference,
          brandReference: actual.brandReference,
          storeReference: actual.storeReference,
          readerActorReference: actual.actorReference,
          snapshot: saved,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
          businessReferenceValidation: "NotEvaluated",
        }),
      });
    }
    expect(request.headers()["x-bop-csrf"]).toBe(csrf);
    expect(
      JSON.parse(
        Buffer.from(request.headers()["x-bop-store-setup-scope"] ?? "", "base64url").toString(
          "utf8",
        ),
      ),
    ).toEqual(currentScope());
    const body: Record<string, unknown> = request.postDataJSON();
    if (body.command === "ResolveOriginal") {
      control.resolves.push(body);
      control.chronology.push("ResolveOriginal");
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
    control.chronology.push("SaveDraft");
    const command = parseStoreSetupSaveCommand({
      profile: "StoreSetupSaveV2",
      ...currentScope(),
      operationReference: body.operationReference,
      expectedSetupReference: body.expectedSetupReference,
      expectedRevision: body.expectedRevision,
      content: body.content,
      purposeCode: "STORE_SETUP_DRAFT",
    });
    expect(command.expectedRevision).toBe(saved?.revision ?? 0);
    expect(command.expectedSetupReference).toBe(saved?.setupDraftReference ?? null);
    const actual = {
      ...currentScope(),
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
            profile: "StoreSetupDraftV2",
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            setupDraftReference: id(6),
            revision: 1,
            authoredByReference: control.actorReference,
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
      ...currentScope(),
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
    history.push(saved);
    ledger.set(command.operationReference, receipt);
    if (control.loseNext) {
      control.loseNext = false;
      return route.abort("failed");
    }
    return respond(route, receipt);
  });
  return {
    control,
    history,
    snapshot: () => saved,
    managerSuccessor() {
      if (!saved) throw new Error("Synthetic saved original required");
      const observedAt = new Date().toISOString();
      const manager = { ...scope, actorReference: id(41) },
        command = parseStoreSetupSaveCommand({
          profile: "StoreSetupSaveV2",
          ...manager,
          operationReference: id(500),
          expectedSetupReference: saved.setupDraftReference,
          expectedRevision: saved.revision,
          content: {
            ...saved.content,
            feeContexts: {
              state: "Configured",
              value: [
                { chargeType: "ServiceCharge", state: "Disabled" },
                { chargeType: "DeliveryFee", state: "Disabled" },
                { chargeType: "Tip", state: "Disabled" },
              ],
            },
          },
          purposeCode: "STORE_SETUP_DRAFT",
        });
      saved = replaceStoreSetupDraftContent(
        saved,
        command.content,
        {
          ...manager,
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          baseConfigurationReference: null,
        },
        { expectedRevision: command.expectedRevision, observedAt },
      );
      ledger.set(
        command.operationReference,
        parseStoreSetupOperationReceipt({
          profile: "StoreSetupOperationReceiptV1",
          ...manager,
          operationReference: command.operationReference,
          expectedSetupReference: command.expectedSetupReference,
          expectedRevision: command.expectedRevision,
          purposeCode: "STORE_SETUP_DRAFT",
          intentDigest:
            "sha256:" +
            createHash("sha256").update(canonicalPublicationValue(command)).digest("hex"),
          outcome: "Committed",
          snapshot: saved,
          auditReference: id(501),
          occurredAt: observedAt,
        }),
      );
      history.push(saved);
    },
  };
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

async function feeStep(page: Page) {
  await page.getByRole("button", { name: "5. Tax and payment", exact: true }).click();
  return page.getByRole("region", { name: "Fee contexts", exact: true });
}
async function enabledFee(page: Page) {
  const panel = await feeStep(page);
  await panel
    .getByRole("combobox", { name: "ServiceCharge configuration", exact: true })
    .selectOption("Enabled");
  const classification = panel.getByRole("combobox", {
    name: "ServiceCharge tax classification",
    exact: true,
  });
  await expect(classification).toBeEnabled();
  await classification.selectOption({
    label: "SYNTH_FEE_CLASS — Synthetic fee classification (Active)",
  });
  await panel
    .getByRole("group", { name: "ServiceCharge order types", exact: true })
    .getByLabel("Pickup", { exact: true })
    .check();
  await panel
    .getByRole("combobox", { name: "DeliveryFee configuration", exact: true })
    .selectOption("Disabled");
  await panel
    .getByRole("combobox", { name: "Tip configuration", exact: true })
    .selectOption("Disabled");
  return panel;
}
const save = (page: Page) => page.getByRole("button", { name: "Save setup draft", exact: true });
const recover = (page: Page) =>
  page.getByRole("button", { name: "Recover original save", exact: true });
test("@production Store fee contexts ordinary entry explicit selections V2 current immutable revision and reload", async ({
  page,
}) => {
  const f = await install(page);
  await open(page);
  const panel = await feeStep(page);
  for (const charge of ["ServiceCharge", "DeliveryFee", "Tip"])
    await expect(
      panel.getByRole("combobox", { name: `${charge} configuration`, exact: true }),
    ).toHaveValue("Unconfigured");
  await enabledFee(page);
  await save(page).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.snapshot()?.profile).toBe("StoreSetupDraftV2");
  expect(f.snapshot()?.content.feeContexts).toEqual({
    state: "Configured",
    value: [
      {
        chargeType: "ServiceCharge",
        state: "Enabled",
        taxClassificationReference: id(22),
        orderTypes: ["Pickup"],
      },
      { chargeType: "DeliveryFee", state: "Disabled" },
      { chargeType: "Tip", state: "Disabled" },
    ],
  });
  const first = f.history[0];
  if (!first) throw new Error("Actual saved fixture revision missing");
  await page.reload();
  await expect(page.getByText("Revision 1", { exact: true })).toBeVisible();
  const restored = await feeStep(page);
  await expect(
    restored.getByRole("combobox", { name: "ServiceCharge configuration", exact: true }),
  ).toHaveValue("Enabled");
  await expect(
    restored.getByRole("combobox", { name: "ServiceCharge tax classification", exact: true }),
  ).toHaveValue(id(22));
  await restored
    .getByRole("combobox", { name: "Tip configuration", exact: true })
    .selectOption("Unconfigured");
  await save(page).click();
  await expect(
    page.getByText("Setup draft saved. These settings have not been validated or published.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(() => f.snapshot()?.revision).toBe(2);
  await page.getByRole("button", { name: "1. Identity", exact: true }).click();
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  expect(f.history[0]).toEqual(first);
  expect(f.history[0]?.content.feeContexts).toEqual(first.content.feeContexts);
  expect(f.control.errors).toEqual([]);
});
test("@production Store fee context lost reply old original recovery retains newer Manager fee intent", async ({
  page,
}) => {
  const f = await install(page);
  await open(page);
  await enabledFee(page);
  f.control.loseNext = true;
  await save(page).click();
  await expect(recover(page)).toBeVisible();
  const original = await journalRecords(page);
  expect(original).toHaveLength(1);
  expect(JSON.stringify(original)).not.toContain("feeContexts");
  expect(JSON.stringify(original)).not.toContain("taxClassificationReference");
  f.managerSuccessor();
  await page.reload();
  await expect(recover(page)).toBeEnabled();
  f.control.denyResolve = true;
  await recover(page).click();
  await expect(page.getByRole("alert")).toContainText("does not allow this action");
  expect(await journalRecords(page)).toEqual(original);
  f.control.denyResolve = false;
  await recover(page).click();
  await expect(
    page.getByText("The original save was committed. Current saved settings are shown.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Revision 2", { exact: true })).toBeVisible();
  const panel = await feeStep(page);
  await expect(
    panel.getByRole("combobox", { name: "ServiceCharge configuration", exact: true }),
  ).toHaveValue("Disabled");
  expect(f.control.writes).toHaveLength(1);
  expect(f.control.resolves).toHaveLength(2);
  expect(await journalRecords(page)).toEqual([]);
  expect(f.history[0]?.content.feeContexts?.state).toBe("Configured");
  expect(f.control.chronology).toEqual(["SaveDraft", "ResolveOriginal", "ResolveOriginal"]);
  expect(f.control.errors).toEqual([]);
});
test("@production Store fee contexts reject unavailable retired or foreign classifications before original reserve", async ({
  page,
}) => {
  const f = await install(page);
  f.control.choiceMode = "Missing";
  await open(page);
  const panel = await feeStep(page);
  await panel
    .getByRole("combobox", { name: "ServiceCharge configuration", exact: true })
    .selectOption("Enabled");
  await save(page).click();
  await expect(page.locator("#setup-validation-error")).toContainText("Check the edited settings");
  expect(f.control.writes).toHaveLength(0);
  expect(await journalRecords(page)).toEqual([]);
  await feeStep(page);
  f.control.choiceMode = "Retired";
  await panel
    .getByRole("button", { name: "Refresh fee classification choices", exact: true })
    .click();
  await expect(
    panel
      .getByRole("combobox", { name: "ServiceCharge tax classification", exact: true })
      .getByRole("option", {
        name: "SYNTH_FEE_CLASS — Synthetic fee classification (Retired)",
        exact: true,
      }),
  ).toHaveJSProperty("disabled", true);
  const retiredPicker = panel.getByRole("combobox", {
    name: "ServiceCharge tax classification",
    exact: true,
  });
  await retiredPicker.focus();
  await page.keyboard.press("s");
  await page.keyboard.press("Enter");
  await expect(retiredPicker).toHaveValue("");
  expect(f.control.writes).toHaveLength(0);
  expect(await journalRecords(page)).toEqual([]);
  f.control.choiceMode = "Foreign";
  await panel
    .getByRole("button", { name: "Refresh fee classification choices", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText("Classification choices unavailable");
  f.control.choiceMode = "Active";
  await panel
    .getByRole("button", { name: "Refresh fee classification choices", exact: true })
    .click();
  await expect(
    panel.getByRole("combobox", { name: "ServiceCharge tax classification", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("combobox", { name: "ServiceCharge tax classification", exact: true })
    .selectOption(id(22));
  await panel
    .getByRole("group", { name: "ServiceCharge order types", exact: true })
    .getByLabel("Pickup", { exact: true })
    .check();
  f.control.choiceMode = "Retired";
  await save(page).click();
  await expect(page.locator("#setup-validation-error")).toContainText("Check the edited settings");
  expect(f.control.writes).toHaveLength(0);
  expect(await journalRecords(page)).toEqual([]);
  expect(f.control.errors).toEqual([]);
});
test("@production Store fee contexts late Actor choices cannot replace new scope and narrow keyboard controls reflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const f = await install(page);
  f.control.delayChoices = true;
  await open(page);
  await feeStep(page);
  await expect.poll(() => f.control.choicesStarted).toBe(1);
  f.control.actorReference = id(40);
  await page.reload();
  await expect(save(page)).toBeEnabled();
  const panel = await feeStep(page);
  f.control.releaseChoices();
  const config = panel.getByRole("combobox", { name: "ServiceCharge configuration", exact: true });
  await config.focus();
  await expect(config).toBeFocused();
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(config).toHaveValue("Disabled");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  const overflow = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        "main, section, fieldset, legend, label, select, input, button, nav, ol, li",
      ),
    )
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
      })
      .slice(0, 20)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: element.className,
          role: element.getAttribute("role"),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
        };
      }),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    JSON.stringify(overflow),
  ).toBe(true);
  expect(await config.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await expect(
    panel.getByText(
      "Draft configuration only. These selections do not set fees, rates or effective policy.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(f.control.writes).toHaveLength(0);
  expect(await journalRecords(page)).toEqual([]);
  expect(f.control.errors).toEqual([]);
  await page.screenshot({
    path: "/private/tmp/wp2421-store-setup-fee-contexts-mobile.png",
    fullPage: true,
  });
});
