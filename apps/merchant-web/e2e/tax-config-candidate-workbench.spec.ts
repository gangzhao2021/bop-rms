import { readFile } from "node:fs/promises";
import { createTaxPublicationCandidate } from "../../../packages/rms/pricing/src/contracts/tax-config-publication-candidate.js";
import {
  createTaxConfigCandidateRecord,
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateResolve,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  parseTaxConfigCandidateSummary,
  taxConfigCandidateIntentDigest,
  type TaxConfigCandidateRecord,
  type TaxConfigCandidateOperation,
} from "../../../packages/rms/pricing/src/contracts/tax-config-candidate-authoring.js";
import {
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxConfigMaterialSummary,
  taxConfigMaterialContentDigest,
} from "../../../packages/rms/pricing/src/contracts/tax-config-material.js";
import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringResolve,
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringOperation,
  parseTaxConfigAuthoringState,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
  taxConfigAuthoringIntentDigest,
  type TaxConfigAuthoringState,
} from "../../../packages/rms/pricing/src/contracts/tax-config-authoring.js";
import { createTaxConfigurationSnapshot } from "../../../packages/rms/pricing/src/domain/tax-configuration.js";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
} from "../../../packages/rms/pricing/src/domain/money-tax-contract.js";
import { simulateDraftTaxFixture } from "../../../packages/rms/pricing/src/domain/tax-fixture-simulation.js";
import { canonicalPublicationValue } from "../src/product-publication-command-client-v2.js";
// Production App and public browser clients with real IndexedDB. All HTTP,
// permission, registry and currency facts below are controlled synthetic inputs;
// this does not prove native IAM/PG or professional/legal approval.
const id = (n: number) => `01902422-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const csrf = "A".repeat(43),
  scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  });
const href = "/app/commerce/tax",
  database = "bop-tax-config-candidate-pending-v1";
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonicalPublicationValue(value)).digest("hex");
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
async function pending(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(new Error("Journal read failed"));
        open.onsuccess = () => {
          const db = open.result,
            tx = db.transaction("originals", "readonly"),
            request = tx.objectStore("originals").getAll();
          let result: unknown[] = [];
          request.onsuccess = () => {
            result = request.result;
          };
          tx.oncomplete = () => {
            db.close();
            resolve(result);
          };
          tx.onabort = () => reject(new Error("Journal read failed"));
        };
      }),
    database,
  );
}
async function fixture(page: Page, reader = () => scope) {
  let serial = 100;
  const saved = new Map<string, TaxConfigAuthoringState>(),
    ledger = new Map<string, ReturnType<typeof parseTaxConfigAuthoringOperation>>();
  const state = {
    deny: false,
    disabled: false,
    lose: false,
    posts: [] as Record<string, unknown>[],
    errors: [] as string[],
    simulations: [] as Record<string, unknown>[],
  };
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      at = new Date().toISOString(),
      until = new Date(Date.parse(at) + 5000).toISOString();
    if (path === "/merchant/session") {
      const selected = {
        storeReference: scope.storeReference,
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
              screenId: "TAX-CONFIG",
              href,
              label: "Tax Configuration",
              permission: "pricing.tax-config.manage",
            },
          ],
          businessDate: "2026-10-06",
          storeStatus: "Unavailable",
          freshness: "Current",
          dashboardAvailability: "UnavailableUntilWP1905",
        },
      });
    }
    const prefix = "/merchant/tax-config/authoring/";
    if (!path.startsWith(prefix)) return route.abort();
    if (state.deny) return respond(route, { error: "request_denied" }, 403);
    if (state.disabled)
      return respond(route, { error: "tax_config_authoring_feature_disabled" }, 503);
    const current = (configurationReference: string | null) =>
      parseTaxConfigAuthoringCurrent({
        profile: "TaxConfigAuthoringCurrentV1",
        ...reader(),
        configurationReference,
        state: configurationReference === null ? null : (saved.get(configurationReference) ?? null),
        observedAt: at,
        validUntil: until,
        referenceEligibility: "NotEvaluated",
      });
    const action = path.slice(prefix.length);
    // This Draft fixture does not seed an Operating Entity or materials. The
    // sibling panel reads explicit source absence, rather than a dropped request.
    if (action === "tax-registrant") return respond(route, null);
    if (action === "materials/current")
      return respond(route, {
        profile: "TaxConfigMaterialCurrentV1",
        ...reader(),
        materialReference: url.searchParams.get("materialReference"),
        materialKind: "RegistrationApplicability",
        version: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    if (action === "materials/roster")
      return respond(route, {
        profile: "TaxConfigMaterialRosterV1",
        ...reader(),
        materialKind: "RegistrationApplicability",
        afterMaterial: null,
        entries: [],
        nextAfterMaterial: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });

    if (action === "scope") return respond(route, current(null));
    if (action === "current")
      return respond(route, current(url.searchParams.get("configurationReference")));
    if (action === "roster")
      return respond(
        route,
        parseTaxConfigAuthoringRoster({
          profile: "TaxConfigAuthoringRosterV1",
          ...reader(),
          afterConfiguration: url.searchParams.get("afterConfiguration"),
          entries: [...saved.values()].sort((a, b) =>
            a.snapshot.configurationReference.localeCompare(b.snapshot.configurationReference),
          ),
          nextAfterConfiguration: null,
          observedAt: at,
          validUntil: until,
          referenceEligibility: "NotEvaluated",
        }),
      );
    if (action === "classifications")
      return respond(route, {
        profile: "TaxConfigClassificationChoicesV1",
        ...reader(),
        registryReference: id(5),
        versionReference: id(6),
        registryVersion: 1,
        snapshotDigest: "sha256:" + "a".repeat(64),
        defaultLocale: "en-CA",
        choices: [
          {
            classificationReference: id(7),
            code: "FOOD",
            localizedNames: { "en-CA": "Food classification" },
            lifecycle: "Active",
          },
        ],
        observedAt: at,
        validUntil: until,
        sourceQualification: "NotEvaluated",
      });
    if (action === "simulate") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.simulations.push(body);
      const configuration = parsePricingReference(body.configurationReference),
        value = saved.get(configuration);
      if (
        !value ||
        value.snapshot.versionReference !== body.expectedVersionReference ||
        value.snapshot.snapshotDigest !== body.expectedSnapshotDigest
      )
        return respond(route, { error: "tax_config_authoring_conflict" }, 409);
      const simulation = simulateDraftTaxFixture(value.snapshot, body.fixture);
      return respond(route, {
        profile: "TaxConfigAuthoringSimulationV1",
        ...reader(),
        configurationReference: configuration,
        versionReference: value.snapshot.versionReference,
        snapshotDigest: value.snapshot.snapshotDigest,
        simulation,
        observedAt: at,
        validUntil: until,
        referenceEligibility: "NotEvaluated",
      });
    }
    if (action === "commands" || action === "resolve-original") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.posts.push(body);
      if (action === "resolve-original") {
        const command = parseTaxConfigAuthoringResolve(body),
          receipt = ledger.get(command.operationReference);
        if (!receipt || receipt.intentDigest !== command.intentDigest)
          return respond(route, { error: "tax_config_authoring_unavailable" }, 503);
        return respond(route, receipt);
      }
      const command = parseTaxConfigAuthoringCommand(body),
        known = ledger.get(command.operationReference);
      expect(command.content.effectivePeriod.timeZone).toBe("America/Toronto");
      if (known) return respond(route, known);
      const prior =
        command.configurationReference === null ? null : saved.get(command.configurationReference);
      if (
        (command.action === "CreateDraft" && prior) ||
        (command.action === "ReplaceDraft" &&
          (!prior || prior.snapshot.aggregateVersion !== command.expectedAggregateVersion))
      )
        return respond(route, { error: "tax_config_authoring_conflict" }, 409);
      const currencyMetadata = createCurrencyMetadataSnapshot({
        currencyCode: parseCurrencyCode("CAD"),
        minorUnitExponent: 2,
        metadataVersion: 1,
        metadataVersionReference: parsePricingReference(id(8)),
        metadataDigest: parsePricingDigest("sha256:" + "b".repeat(64)),
      });
      const base = {
        configurationReference:
          command.configurationReference ?? parsePricingReference(id(++serial)),
        versionReference: parsePricingReference(id(++serial)),
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        stableCode: command.content.stableCode,
        aggregateVersion: (prior?.snapshot.aggregateVersion ?? 0) + 1,
        versionNumber: (prior?.snapshot.versionNumber ?? 0) + 1,
        lifecycle: "Draft" as const,
        jurisdictionCode: parsePricingCode("CA-ON"),
        currencyMetadata,
        effectivePeriod: command.content.effectivePeriod,
        registrationEvidence: null,
        professionalEvidence: null,
        rules: command.content.rules.map((rule) => ({
          ruleReference: parsePricingReference(id(++serial)),
          ...rule,
        })),
        createdAt: at,
      };
      const snapshot = createTaxConfigurationSnapshot({
        ...base,
        snapshotDigest: parsePricingDigest(hash(base)),
      });
      const authored = parseTaxConfigAuthoringState({
        profile: "TaxConfigAuthoringStateV1",
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        draftAuthorActorReference: scope.actorReference,
        snapshot,
      });
      saved.set(snapshot.configurationReference, authored);
      const receipt = parseTaxConfigAuthoringOperation({
        profile: "TaxConfigAuthoringOperationV1",
        ...reader(),
        action: command.action,
        operationReference: command.operationReference,
        configurationReference: command.configurationReference,
        expectedAggregateVersion: command.expectedAggregateVersion,
        command,
        intentDigest: taxConfigAuthoringIntentDigest(scope, command),
        serviceIntentDigest: hash(snapshot),
        outcome: "Committed",
        snapshot,
        auditReference: id(++serial),
        eventReference: id(++serial),
        occurredAt: at,
      });
      ledger.set(command.operationReference, receipt);
      if (state.lose) {
        state.lose = false;
        return route.abort("failed");
      }
      return respond(route, receipt);
    }
    return route.abort();
  });
  return { ...state, saved };
}
async function enterDraft(page: Page) {
  await expect(page.getByRole("button", { name: "Add Tax rule", exact: true })).toBeEnabled();
  await page.getByLabel("Stable code", { exact: true }).fill("SYNTHETIC_FOOD");
  await page.getByLabel("Effective time zone", { exact: true }).selectOption("America/Toronto");
  await page
    .getByRole("group", { name: "Draft settings", exact: true })
    .getByLabel("Effective from (UTC)", { exact: true })
    .fill("2026-10-01T04:00:00.000Z");
  await page.getByRole("button", { name: "Add Tax rule", exact: true }).click();
  await page.getByLabel("Rule 1 classification", { exact: true }).selectOption(id(7));
  await page.getByLabel("Rule 1 component code", { exact: true }).fill("HST");
  await page.getByLabel("Rule 1 rate", { exact: true }).fill("0.13");
  await page.getByLabel("Rule 1 receipt label code", { exact: true }).fill("HST");
}
async function candidateFixture(page: Page) {
  const reader = { actor: scope.actorReference };
  const draft = await fixture(page, () =>
      parseTaxConfigAuthoringScope({ ...scope, actorReference: reader.actor }),
    ),
    records = new Map<string, TaxConfigCandidateRecord>(),
    ledger = new Map<string, TaxConfigCandidateOperation>();
  let serial = 500;
  const issued = new Date(Date.now() - 1000).toISOString(),
    content = {
      operatingEntityProfileVersionReference: id(450),
      operatingEntityTaxReference: null,
      jurisdictionCode: "CA-ON",
      applicability: "NotApplicable",
      sourceIssuedAt: issued,
      effectiveFrom: issued,
      effectiveUntil: null,
      declaredSourceDigest: null,
    };
  const material = parseTaxConfigMaterialVersion({
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    materialReference: id(451),
    versionReference: id(452),
    revision: 1,
    previousVersionReference: null,
    materialKind: "RegistrationApplicability",
    content,
    contentDigest: taxConfigMaterialContentDigest(content, "RegistrationApplicability"),
    recordedByActorReference: id(453),
    createdAt: issued,
    recordedAt: issued,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  });
  const state = {
    get actor() {
      return reader.actor;
    },
    set actor(value: typeof scope.actorReference) {
      reader.actor = value;
    },
    lose: false,
    denyResolve: false,
    failCurrent: false,
    changedDraft: false,
    changedMaterial: false,
    posts: [] as unknown[],
    reads: [] as string[],
    resolves: [] as unknown[],
  };
  await page.route("**/merchant/tax-config/authoring/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      action = url.pathname.split("/authoring/")[1],
      at = new Date().toISOString(),
      validUntil = new Date(Date.parse(at) + 5000).toISOString();
    if (action === "scope" && state.actor !== scope.actorReference)
      return respond(
        route,
        parseTaxConfigAuthoringCurrent({
          profile: "TaxConfigAuthoringCurrentV1",
          ...scope,
          actorReference: state.actor,
          configurationReference: null,
          state: null,
          observedAt: at,
          validUntil,
          referenceEligibility: "NotEvaluated",
        }),
      );
    if (action === "current" && state.changedDraft)
      return respond(
        route,
        parseTaxConfigAuthoringCurrent({
          profile: "TaxConfigAuthoringCurrentV1",
          ...scope,
          configurationReference: url.searchParams.get("configurationReference"),
          state: null,
          observedAt: at,
          validUntil,
          referenceEligibility: "NotEvaluated",
        }),
      );
    if (action === "materials/current") {
      state.reads.push(action);
      return respond(
        route,
        parseTaxConfigMaterialCurrent({
          profile: "TaxConfigMaterialCurrentV1",
          ...scope,
          materialReference: material.materialReference,
          materialKind: material.materialKind,
          version: state.changedMaterial ? null : material,
          observedAt: at,
          validUntil,
          qualification: "NotEvaluated",
        }),
      );
    }
    if (action === "materials/roster")
      return respond(
        route,
        parseTaxConfigMaterialRoster({
          profile: "TaxConfigMaterialRosterV1",
          ...scope,
          materialKind: material.materialKind,
          afterMaterial: null,
          entries: [
            parseTaxConfigMaterialSummary({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              materialReference: material.materialReference,
              versionReference: material.versionReference,
              revision: 1,
              materialKind: material.materialKind,
              contentDigest: material.contentDigest,
              recordedAt: issued,
              status: "Recorded",
              qualification: "NotEvaluated",
            }),
          ],
          nextAfterMaterial: null,
          observedAt: at,
          validUntil,
          qualification: "NotEvaluated",
        }),
      );
    if (!action?.startsWith("candidates/")) return route.fallback();
    const header = request.headers()["x-bop-store-setup-scope"];
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual(scope);
    state.reads.push(action);
    const config = url.searchParams.get("configurationReference");
    if (action === "candidates/current") {
      if (state.failCurrent)
        return respond(route, { error: "tax_config_authoring_unavailable" }, 503);
      const target = url.searchParams.get("targetVersionReference"),
        value = target
          ? records.get(target)
          : [...records.values()]
              .filter((r) => r.candidate.content.configurationReference === config)
              .at(-1);
      return respond(
        route,
        parseTaxConfigCandidateCurrent({
          profile: "TaxConfigCandidateCurrentV1",
          ...scope,
          configurationReference: config,
          targetVersionReference: value?.candidate.content.targetVersionReference ?? target,
          record: value ?? null,
          observedAt: at,
          validUntil,
          qualification: "NotEvaluated",
        }),
      );
    }
    if (action === "candidates/roster")
      return respond(
        route,
        parseTaxConfigCandidateRoster({
          profile: "TaxConfigCandidateRosterV1",
          ...scope,
          configurationReference: config,
          afterCandidate: null,
          entries: [...records.values()]
            .filter((r) => r.candidate.content.configurationReference === config)
            .sort((a, b) =>
              a.candidate.content.targetVersionReference.localeCompare(
                b.candidate.content.targetVersionReference,
              ),
            )
            .map((r) =>
              parseTaxConfigCandidateSummary({
                tenantReference: r.tenantReference,
                brandReference: r.brandReference,
                storeReference: r.storeReference,
                configurationReference: r.candidate.content.configurationReference,
                targetVersionReference: r.candidate.content.targetVersionReference,
                targetAggregateVersion: r.candidate.content.targetAggregateVersion,
                targetVersionNumber: r.candidate.content.targetVersionNumber,
                contentDigest: r.candidate.contentDigest,
                baseDraft: r.candidate.content.baseDraft,
                registrationMaterial: r.candidate.content.registrationMaterial,
                preparedByActorReference: r.preparedByActorReference,
                operationReference: r.operationReference,
                preparedAt: r.preparedAt,
                status: r.status,
                qualification: r.qualification,
              }),
            ),
          nextAfterCandidate: null,
          observedAt: at,
          validUntil,
          qualification: "NotEvaluated",
        }),
      );
    expect(request.headers()["x-bop-csrf"]).toBe(csrf);
    const raw = request.postDataJSON();
    if (action === "candidates/resolve-original") {
      const command = parseTaxConfigCandidateResolve(raw);
      state.resolves.push(raw);
      if (state.denyResolve) return respond(route, { error: "request_denied" }, 403);
      const receipt = ledger.get(command.operationReference);
      expect(receipt?.intentDigest).toBe(command.intentDigest);
      return respond(route, receipt);
    }
    const command = parseTaxConfigCandidateCommand(raw);
    state.posts.push(raw);
    const cursors = await pending(page);
    expect(cursors).toHaveLength(1);
    expect(cursors[0]).toMatchObject({
      operationReference: command.operationReference,
      expectedDraft: command.expectedDraft,
      registrationMaterial: command.registrationMaterial,
    });
    expect(JSON.stringify(cursors)).not.toMatch(
      /rules|currency|effectivePeriod|sourceIssuedAt|csrf|sessionCookie/,
    );
    const actual = draft.saved.get(command.configurationReference);
    expect(actual).toBeDefined();
    if (!actual) throw Error("Missing controlled saved Draft");
    const candidate = createTaxPublicationCandidate({
      draft: actual,
      targetVersionReference: id(++serial),
      sourceRuleBindings: actual.snapshot.rules.map((r) => ({
        sourceRuleReference: r.ruleReference,
        targetRuleReference: id(++serial),
      })),
      registrationMaterial: command.registrationMaterial,
    });
    const result = createTaxConfigCandidateRecord({
      scope,
      command,
      candidate,
      draft: actual,
      registrationMaterial: material,
      preparedAt: at,
      auditReference: id(++serial),
      eventReference: id(++serial),
    });
    const receipt = parseTaxConfigCandidateOperation({
      profile: "TaxConfigCandidateOperationV1",
      ...scope,
      ...command,
      command,
      intentDigest: taxConfigCandidateIntentDigest(scope, command),
      outcome: "Committed",
      result,
      auditReference: result.auditReference,
      eventReference: result.eventReference,
      occurredAt: at,
    });
    records.set(candidate.content.targetVersionReference, result);
    ledger.set(command.operationReference, receipt);
    if (state.lose) {
      state.lose = false;
      return route.abort("failed");
    }
    return respond(route, receipt);
  });
  return { state, records, material };
}
function firstCandidate(records: Map<string, TaxConfigCandidateRecord>) {
  const value = records.values().next().value;
  if (!value) throw Error("Missing controlled committed candidate");
  return value;
}
async function saveAndSelect(page: Page) {
  await page.goto(href);
  await enterDraft(page);
  await page.getByRole("button", { name: "Save Tax Draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved and refreshed. Professional approval has not been evaluated.", {
      exact: true,
    }),
  ).toBeVisible();
  const panel = page.getByRole("region", { name: "Tax publication candidates", exact: true });
  await expect(panel.getByLabel("Saved registration declaration", { exact: true })).toBeEnabled();
  await panel.getByLabel("Saved registration declaration", { exact: true }).selectOption(id(451));
  await expect(
    panel.getByRole("button", { name: "Prepare publication candidate", exact: true }),
  ).toBeEnabled();
  return panel;
}
test("@production saved Tax Draft and Registration prepare immutable candidate and download truthful review packet", async ({
  page,
}) => {
  const f = await candidateFixture(page),
    panel = await saveAndSelect(page);
  await panel.getByRole("button", { name: "Prepare publication candidate", exact: true }).click();
  await expect(
    panel.getByText(
      "Candidate prepared. Professional and legal qualification remain not evaluated.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect.poll(async () => (await pending(page)).length).toBe(0);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel.getByRole("button", { name: "Download external review packet", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("tax-publication-candidate.json");
  const downloaded = await download.path();
  expect(downloaded).not.toBeNull();
  if (!downloaded) throw Error("Missing downloaded review packet");
  const packet = JSON.parse(await readFile(downloaded, "utf8"));
  expect(packet).toEqual(
    JSON.parse(await panel.getByLabel("External review packet", { exact: true }).inputValue()),
  );
  expect(packet.candidate).toEqual([...f.records.values()][0]?.candidate);
  expect(packet.qualification).toBe("NotEvaluated");
  expect(hash(packet.candidate.content)).toBe(packet.candidate.contentDigest);
  await panel.screenshot({ path: test.info().outputPath("candidate-packet-desktop.png") });
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page
      .locator(".bop-skip-link")
      .evaluate((element) => element.getBoundingClientRect().bottom),
  ).toBeLessThanOrEqual(0);
  await expect.poll(() => page.locator(".bop-skip-link").evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThanOrEqual(0);
  await panel.screenshot({ path: test.info().outputPath("candidate-packet-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await panel.getByRole("button", { name: "Refresh candidate workspace", exact: true }).click();
  await expect(
    panel
      .getByLabel("Saved publication candidate", { exact: true })
      .getByRole("option", { name: /Candidate version 2/ }),
  ).toHaveCount(1);
  await panel.getByLabel("Saved registration declaration", { exact: true }).selectOption(id(451));
  await expect(
    panel.getByRole("button", { name: "Prepare publication candidate", exact: true }),
  ).toBeEnabled();
  await panel.getByRole("button", { name: "Prepare publication candidate", exact: true }).click();
  await expect.poll(() => f.records.size).toBe(2);
  await panel.getByRole("button", { name: "Refresh candidate workspace", exact: true }).click();
  await expect(panel.getByLabel("Saved publication candidate", { exact: true })).toBeEnabled();
  await expect(
    panel
      .getByLabel("Saved publication candidate", { exact: true })
      .getByRole("option", { name: /Candidate version 2/ }),
  ).toHaveCount(2);
  await panel
    .getByLabel("Saved publication candidate", { exact: true })
    .selectOption(firstCandidate(f.records).candidate.content.targetVersionReference);
  await expect
    .poll(
      async () =>
        JSON.parse(await panel.getByLabel("External review packet", { exact: true }).inputValue())
          .candidate.content.targetVersionReference,
    )
    .toBe([...f.records.keys()][0]);
  await page.reload();
  await page
    .getByLabel("Saved Tax Draft", { exact: true })
    .selectOption(firstCandidate(f.records).candidate.content.configurationReference);
  await expect(
    page.getByRole("region", { name: "Recorded publication candidate", exact: true }),
  ).toBeVisible();
});
test("@production lost candidate reply resolves original before materials and retains cursor after denied or failed refresh", async ({
  page,
}) => {
  const f = await candidateFixture(page),
    panel = await saveAndSelect(page);
  f.state.lose = true;
  await panel.getByRole("button", { name: "Prepare publication candidate", exact: true }).click();
  await expect.poll(async () => (await pending(page)).length).toBe(1);
  const original = (await pending(page))[0];
  f.state.actor = parsePricingReference(id(480));
  await page.reload();
  await expect(page.getByRole("button", { name: "Add Tax rule", exact: true })).toBeEnabled();
  expect(await pending(page)).toEqual([original]);
  await expect(
    page.getByRole("button", { name: "Recover original candidate preparation", exact: true }),
  ).toHaveCount(0);
  f.state.actor = scope.actorReference;
  f.state.denyResolve = true;
  await page.reload();
  await page
    .getByLabel("Saved Tax Draft", { exact: true })
    .selectOption(firstCandidate(f.records).candidate.content.configurationReference);
  const recovery = page.getByRole("button", {
    name: "Recover original candidate preparation",
    exact: true,
  });
  await expect(recovery).toBeEnabled();
  f.state.reads.length = 0;
  await recovery.click();
  await expect.poll(() => f.state.resolves.length).toBe(1);
  expect(await pending(page)).toEqual([original]);
  expect(f.state.reads).toEqual(["candidates/resolve-original"]);
  f.state.denyResolve = false;
  f.state.failCurrent = true;
  await recovery.click();
  await expect.poll(() => f.state.resolves.length).toBe(2);
  expect(await pending(page)).toEqual([original]);
  f.state.failCurrent = false;
  await recovery.click();
  await expect.poll(async () => (await pending(page)).length).toBe(0);
  expect(f.state.posts).toHaveLength(1);
  expect(f.state.reads.at(-1)).toBe("candidates/current");
  expect(f.state.resolves.every((r) => !JSON.stringify(r).includes("rules"))).toBe(true);
});
test("@production stale source blocks preparation and candidate workbench reflows at 320px and 200 percent text", async ({
  page,
}) => {
  const f = await candidateFixture(page),
    panel = await saveAndSelect(page);
  f.state.changedMaterial = true;
  await panel.getByRole("button", { name: "Prepare publication candidate", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  expect(f.state.posts).toEqual([]);
  expect(await pending(page)).toEqual([]);
  f.state.changedMaterial = false;
  f.state.changedDraft = true;
  await panel.getByRole("button", { name: "Prepare publication candidate", exact: true }).click();
  expect(f.state.posts).toEqual([]);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addStyleTag({ content: "html {font-size:200%}" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await panel.screenshot({ path: test.info().outputPath("candidate-workbench-text-zoom.png") });
  const refresh = panel.getByRole("button", { name: "Refresh candidate workspace", exact: true });
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await expect
    .poll(() => refresh.evaluate((e) => e.getBoundingClientRect().height))
    .toBeGreaterThanOrEqual(44);
  expect(
    await panel.getByRole("button", { name: /Submit|Approve|Publish/, exact: false }).count(),
  ).toBe(0);
});
