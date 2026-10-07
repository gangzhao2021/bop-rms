import {
  compareTaxConfigCandidateFixtureSuite,
  simulateTaxConfigCandidateFixture,
} from "../../../packages/rms/pricing/src/contracts/tax-config-candidate-fixture-comparison.js";
import { createTaxConfigurationSnapshot } from "../../../packages/rms/pricing/src/domain/tax-configuration.js";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
} from "../../../packages/rms/pricing/src/domain/money-tax-contract.js";
import { createTaxPublicationCandidate } from "../../../packages/rms/pricing/src/contracts/tax-config-publication-candidate.js";
import {
  createTaxConfigCandidateRecord,
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateRoster,
  parseTaxConfigCandidateSummary,
} from "../../../packages/rms/pricing/src/contracts/tax-config-candidate-authoring.js";
import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  parseTaxConfigAuthoringScope,
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringState,
  parseTaxConfigAuthoringCurrent,
  parseTaxConfigAuthoringRoster,
} from "../../../packages/rms/pricing/src/contracts/tax-config-authoring.js";
import {
  parseTaxConfigMaterialCommand,
  parseTaxConfigMaterialResolve,
  parseTaxConfigMaterialVersion,
  parseTaxConfigMaterialOperation,
  parseTaxConfigMaterialCurrent,
  parseTaxConfigMaterialRoster,
  parseTaxConfigMaterialSummary,
  taxConfigMaterialIntentDigest,
  taxConfigMaterialContentDigest,
  type TaxConfigMaterialVersion,
  type TaxConfigMaterialOperation,
} from "../../../packages/rms/pricing/src/contracts/tax-config-material.js";
import { canonicalPublicationValue as canonical } from "../src/product-publication-command-client-v2.js";
// Production-built App, real browser clients and IndexedDB. Every HTTP source,
// permission and material below is controlled synthetic evidence; no native
// Session/IAM/PostgreSQL, professional qualification or legal conclusion claim.
const id = (n: number) => `01902425-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  }),
  csrf = "A".repeat(43),
  href = "/app/commerce/tax",
  database = "bop-tax-config-material-pending-v1";
const hash = (value: unknown) =>
  "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");
const respond = (route: Route, value: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(value),
  });
async function originals(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onerror = () => reject(Error("Journal read failed"));
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
          tx.onabort = () => reject(Error("Journal read failed"));
        };
      }),
    database,
  );
}
function sources() {
  const at = new Date(Date.now() - 2000).toISOString();
  const command = parseTaxConfigAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(10),
    configurationReference: null,
    expectedAggregateVersion: null,
    content: {
      stableCode: "SYNTHETIC_FOOD",
      effectivePeriod: {
        timeZone: "America/Toronto",
        effectiveFrom: {
          instant: "2026-10-01T04:00:00.000Z",
          localDateTime: "2026-10-01T00:00:00.000",
          utcOffsetMinutes: -240,
        },
        effectiveUntil: null,
      },
      rules: [
        {
          taxClassificationReference: id(7),
          orderType: "Pickup",
          chargeType: "Sellable",
          taxComponentCode: "HST",
          treatment: "Taxable",
          rate: "0.13",
          priceInclusion: "Exclusive",
          roundingMode: "HalfUp",
          calculationOrder: 1,
          compoundOnPriorTax: false,
          exceptionEvidenceReference: null,
          receiptPresentationCode: "HST",
        },
      ],
    },
  });
  const currencyMetadata = createCurrencyMetadataSnapshot({
    currencyCode: parseCurrencyCode("CAD"),
    minorUnitExponent: 2,
    metadataVersion: 1,
    metadataVersionReference: parsePricingReference(id(8)),
    metadataDigest: parsePricingDigest(hash("synthetic Currency Metadata")),
  });
  const body = {
    configurationReference: parsePricingReference(id(11)),
    versionReference: parsePricingReference(id(12)),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    stableCode: command.content.stableCode,
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Draft" as const,
    jurisdictionCode: "CA-ON" as const,
    currencyMetadata,
    effectivePeriod: command.content.effectivePeriod,
    registrationEvidence: null,
    professionalEvidence: null,
    rules: command.content.rules.map((rule) => ({
      ...rule,
      ruleReference: parsePricingReference(id(13)),
    })),
    createdAt: at,
  };
  const snapshot = createTaxConfigurationSnapshot({
    ...body,
    jurisdictionCode: parsePricingCode("CA-ON"),
    snapshotDigest: parsePricingDigest(hash(body)),
  });
  const draft = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    draftAuthorActorReference: scope.actorReference,
    snapshot,
  });
  const content = {
    operatingEntityProfileVersionReference: id(103),
    operatingEntityTaxReference: null,
    jurisdictionCode: "CA-ON",
    applicability: "NotApplicable",
    sourceIssuedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
    declaredSourceDigest: null,
  };
  const registration = parseTaxConfigMaterialVersion({
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    materialReference: id(20),
    versionReference: id(21),
    revision: 1,
    previousVersionReference: null,
    materialKind: "RegistrationApplicability",
    content,
    contentDigest: taxConfigMaterialContentDigest(content, "RegistrationApplicability"),
    recordedByActorReference: scope.actorReference,
    createdAt: at,
    recordedAt: at,
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  });
  const registrationMaterial = {
    materialReference: registration.materialReference,
    versionReference: registration.versionReference,
    contentDigest: registration.contentDigest,
  };
  const sourceRule = snapshot.rules[0];
  if (!sourceRule) throw Error("Missing seeded Draft rule");
  const candidate = createTaxPublicationCandidate({
    draft,
    targetVersionReference: id(30),
    sourceRuleBindings: [
      { sourceRuleReference: sourceRule.ruleReference, targetRuleReference: id(31) },
    ],
    registrationMaterial,
  });
  const prepare = parseTaxConfigCandidateCommand({
    action: "PrepareCandidate",
    operationReference: id(32),
    configurationReference: snapshot.configurationReference,
    expectedDraft: candidate.content.baseDraft,
    registrationMaterial,
  });
  const record = createTaxConfigCandidateRecord({
    scope,
    command: prepare,
    candidate,
    draft,
    registrationMaterial: registration,
    preparedAt: at,
    auditReference: id(33),
    eventReference: id(34),
  });
  const suite = {
    targetPublicationCandidate: {
      versionReference: candidate.content.targetVersionReference,
      contentDigest: candidate.contentDigest,
    },
    currencyMetadata,
    cases: [
      {
        fixture: {
          profile: "TaxDraftFixtureV1",
          fixtureReference: id(40),
          kind: "Basket",
          evaluatedAt: at,
          lines: [
            {
              lineReference: id(41),
              calculationReferences: [id(42)],
              labelCode: "SYNTHETIC",
              taxClassificationReference: id(7),
              orderType: "Pickup",
              chargeType: "Sellable",
              amountMinor: "1000",
            },
          ],
        },
        expected: {
          fixtureReference: id(40),
          kind: "Basket",
          configurationReference: snapshot.configurationReference,
          versionReference: candidate.content.targetVersionReference,
          snapshotDigest: candidate.contentDigest,
          netAmountMinor: "1000",
          taxAmountMinor: "130",
          grossAmountMinor: "1130",
          receiptPreview: [
            {
              lineReference: id(41),
              labelCode: "SYNTHETIC",
              componentCode: "HST",
              treatment: "Taxable",
              rate: "0.13",
              taxAmountMinor: "130",
            },
          ],
        },
      },
    ],
    sourceIssuedAt: at,
    declaredSourceDigest: null,
  };
  return { draft, registration, record, suite };
}
async function install(page: Page) {
  let serial = 200;
  const seeded = sources();
  const versions = new Map<string, TaxConfigMaterialVersion>(),
    heads = new Map<string, TaxConfigMaterialVersion>(),
    ledger = new Map<string, TaxConfigMaterialOperation>();
  const state = {
    lose: false,
    denyResolve: false,
    denySource: false,
    failRefresh: false,
    failAfterWrite: false,
    actor: scope.actorReference,
    posts: [] as Record<string, unknown>[],
    resolves: [] as Record<string, unknown>[],
    reads: [] as string[],
    errors: [] as string[],
    driftCandidate: false,
    denyComparison: false,
    comparisonFault: "" as "" | "Scope" | "Lease" | "Pin",
    comparisons: [] as Record<string, unknown>[],
    delayComparison: false,
    comparisonResponded: false,
    releaseComparison: null as (() => void) | null,
  };
  versions.set(seeded.registration.versionReference, seeded.registration);
  heads.set(seeded.registration.materialReference, seeded.registration);
  page.on("pageerror", (error) => state.errors.push(error.message));
  await page.route("**/merchant/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      at = new Date().toISOString(),
      until = new Date(Date.parse(at) + 5000).toISOString(),
      selected = parseTaxConfigAuthoringScope({ ...scope, actorReference: state.actor });
    if (path === "/merchant/session") {
      const store = {
        storeReference: scope.storeReference,
        storeLabel: "Synthetic Store",
        brandLabel: "Synthetic Brand",
      };
      return respond(route, {
        authenticated: true,
        csrf,
        workspace: {
          screenId: "HOME-OVERVIEW",
          selectedScope: store,
          authorizedStores: [store],
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
    const action = path.slice(prefix.length);
    if (action === "candidates/current") {
      if (state.driftCandidate) {
        // Controlled transport corruption: the actual declared candidate body no
        // longer matches its stored checksum. The browser must stop before IDB/POST.
        const drift = JSON.parse(JSON.stringify(seeded.record));
        drift.candidate.content.rules[0].rate = "0.14";
        return respond(route, {
          profile: "TaxConfigCandidateCurrentV1",
          ...selected,
          configurationReference: seeded.draft.snapshot.configurationReference,
          targetVersionReference: seeded.record.candidate.content.targetVersionReference,
          record: drift,
          observedAt: at,
          validUntil: until,
          qualification: "NotEvaluated",
        });
      }
      return respond(
        route,
        parseTaxConfigCandidateCurrent({
          profile: "TaxConfigCandidateCurrentV1",
          ...selected,
          configurationReference: seeded.draft.snapshot.configurationReference,
          targetVersionReference: seeded.record.candidate.content.targetVersionReference,
          record: seeded.record,
          observedAt: at,
          validUntil: until,
          qualification: "NotEvaluated",
        }),
      );
    }
    if (action === "candidates/roster") {
      const r = seeded.record,
        c = r.candidate.content;
      return respond(
        route,
        parseTaxConfigCandidateRoster({
          profile: "TaxConfigCandidateRosterV1",
          ...selected,
          configurationReference: c.configurationReference,
          afterCandidate: null,
          entries: [
            parseTaxConfigCandidateSummary({
              tenantReference: r.tenantReference,
              brandReference: r.brandReference,
              storeReference: r.storeReference,
              configurationReference: c.configurationReference,
              targetVersionReference: c.targetVersionReference,
              targetAggregateVersion: c.targetAggregateVersion,
              targetVersionNumber: c.targetVersionNumber,
              contentDigest: r.candidate.contentDigest,
              baseDraft: c.baseDraft,
              registrationMaterial: c.registrationMaterial,
              preparedByActorReference: r.preparedByActorReference,
              operationReference: r.operationReference,
              preparedAt: r.preparedAt,
              status: "Recorded",
              qualification: "NotEvaluated",
            }),
          ],
          nextAfterCandidate: null,
          observedAt: at,
          validUntil: until,
          qualification: "NotEvaluated",
        }),
      );
    }
    if (action === "scope" || action === "current") {
      const configured =
        action === "current" ? url.searchParams.get("configurationReference") : null;
      return respond(
        route,
        parseTaxConfigAuthoringCurrent({
          profile: "TaxConfigAuthoringCurrentV1",
          ...selected,
          configurationReference: configured,
          state: configured ? seeded.draft : null,
          observedAt: at,
          validUntil: until,
          referenceEligibility: "NotEvaluated",
        }),
      );
    }
    if (action === "roster")
      return respond(
        route,
        parseTaxConfigAuthoringRoster({
          profile: "TaxConfigAuthoringRosterV1",
          ...selected,
          afterConfiguration: null,
          entries: [seeded.draft],
          nextAfterConfiguration: null,
          observedAt: at,
          validUntil: until,
          referenceEligibility: "NotEvaluated",
        }),
      );
    if (action === "classifications")
      return respond(route, {
        profile: "TaxConfigClassificationChoicesV1",
        ...selected,
        registryReference: id(5),
        versionReference: id(6),
        registryVersion: 1,
        snapshotDigest: hash("synthetic classifications"),
        defaultLocale: "en-CA",
        choices: [
          {
            classificationReference: id(7),
            code: "SYNTHETIC",
            localizedNames: { "en-CA": "Synthetic classification" },
            lifecycle: "Active",
          },
        ],
        observedAt: at,
        validUntil: until,
        sourceQualification: "NotEvaluated",
      });
    if (!action.startsWith("materials/") && action !== "tax-registrant") return route.abort();
    const header = request.headers()["x-bop-store-setup-scope"];
    expect(header).toBeTruthy();
    const expected = parseTaxConfigAuthoringScope(
      JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")),
    );
    if (canonical(expected) !== canonical(selected))
      return respond(route, { error: "request_denied" }, 403);
    state.reads.push(action);
    if (action === "tax-registrant") {
      if (state.denySource) return respond(route, { error: "request_denied" }, 403);
      return respond(route, {
        profile: "TaxRegistrantCurrentSourceV1",
        ...selected,
        businessFunction: "TaxRegistrant",
        effectiveAt: at,
        assignmentReference: id(101),
        assignmentVersion: 1,
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        effectiveUntil: null,
        operatingEntityReference: id(102),
        entityVersion: 3,
        operatingEntityProfileVersionReference: id(103),
        profileVersion: 2,
        legalName: "Synthetic material registrant",
        jurisdictionCode: "CA-ON",
        registrationReference: id(104),
        taxRegistrationReference: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    }
    const materialKind = url.searchParams.get("materialKind") ?? "RegistrationApplicability";
    const current = (reference: string | null, version?: TaxConfigMaterialVersion | null) =>
      parseTaxConfigMaterialCurrent({
        profile: "TaxConfigMaterialCurrentV1",
        ...selected,
        materialReference: reference,
        materialKind,
        version:
          version === undefined
            ? reference === null
              ? null
              : (heads.get(reference) ?? null)
            : version,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    if (action === "materials/current") {
      if (state.failRefresh) return route.abort();
      return respond(route, current(url.searchParams.get("materialReference")));
    }
    if (action === "materials/version") {
      const v = versions.get(url.searchParams.get("versionReference") ?? "");
      if (!v) return respond(route, { error: "tax_config_authoring_conflict" }, 409);
      return respond(route, current(String(v.materialReference), v));
    }
    if (action === "materials/roster")
      return respond(
        route,
        parseTaxConfigMaterialRoster({
          profile: "TaxConfigMaterialRosterV1",
          ...selected,
          materialKind,
          afterMaterial: url.searchParams.get("afterMaterial"),
          entries: [...heads.values()]
            .filter((v) => v.materialKind === materialKind)
            .sort((a, b) => String(a.materialReference).localeCompare(String(b.materialReference)))
            .map((v) =>
              parseTaxConfigMaterialSummary({
                tenantReference: v.tenantReference,
                brandReference: v.brandReference,
                storeReference: v.storeReference,
                materialReference: v.materialReference,
                versionReference: v.versionReference,
                revision: v.revision,
                materialKind: v.materialKind,
                contentDigest: v.contentDigest,
                recordedAt: v.recordedAt,
                status: "Recorded",
                qualification: "NotEvaluated",
              }),
            ),
          nextAfterMaterial: null,
          observedAt: at,
          validUntil: until,
          qualification: "NotEvaluated",
        }),
      );
    if (request.headers()["x-bop-csrf"] !== csrf)
      return respond(route, { error: "request_denied" }, 403);
    if (action === "materials/compare") {
      const raw = request.postDataJSON() as Record<string, unknown>;
      state.comparisons.push(raw);
      expect(Object.keys(raw).sort()).toEqual(
        ["configurationReference", "targetPublicationCandidate", "fixtureSuiteMaterial"].sort(),
      );
      if (state.denyComparison) return respond(route, { error: "request_denied" }, 403);
      const target = raw.targetPublicationCandidate as Record<string, unknown>,
        pin = raw.fixtureSuiteMaterial as Record<string, unknown>;
      expect(Object.keys(target).sort()).toEqual(["versionReference", "contentDigest"].sort());
      expect(Object.keys(pin).sort()).toEqual(
        ["materialReference", "versionReference", "contentDigest"].sort(),
      );
      const suite = versions.get(String(pin.versionReference));
      if (
        !suite ||
        suite.materialKind !== "FixtureSuite" ||
        suite.materialReference !== pin.materialReference ||
        suite.contentDigest !== pin.contentDigest ||
        raw.configurationReference !== seeded.draft.snapshot.configurationReference ||
        canonical(target) !== canonical(seeded.suite.targetPublicationCandidate)
      )
        return respond(route, { error: "tax_config_authoring_conflict" }, 409);
      // Real owning mathematics on the actual selected stored immutable suite;
      // the HTTP authority/material source is still controlled synthetic input.
      const comparison = compareTaxConfigCandidateFixtureSuite(seeded.record, suite);
      const output = {
        profile: "TaxConfigMaterialComparisonV1",
        ...selected,
        comparison,
        observedAt: at,
        validUntil: until,
        referenceEligibility: "NotEvaluated",
      };
      if (state.comparisonFault === "Scope")
        return respond(route, { ...output, actorReference: id(999) });
      if (state.comparisonFault === "Lease")
        return respond(route, {
          ...output,
          observedAt: new Date(Date.parse(at) - 10000).toISOString(),
          validUntil: new Date(Date.parse(at) - 5000).toISOString(),
        });
      if (state.comparisonFault === "Pin")
        return respond(route, {
          ...output,
          comparison: { ...comparison, suite: { ...comparison.suite, versionReference: id(998) } },
        });
      if (state.delayComparison) {
        await new Promise<void>((resolve) => {
          state.releaseComparison = resolve;
        });
        state.releaseComparison = null;
        state.comparisonResponded = true;
      }
      return respond(route, output);
    }
    if (action === "materials/resolve-original") {
      if (state.denyResolve) return respond(route, { error: "request_denied" }, 403);
      const raw = request.postDataJSON(),
        c = parseTaxConfigMaterialResolve(raw);
      state.resolves.push(raw);
      expect(Object.keys(raw).sort()).toEqual(
        [
          "action",
          "operationReference",
          "materialReference",
          "expectedRevision",
          "materialKind",
          "intentDigest",
        ].sort(),
      );
      const prior = ledger.get(c.operationReference);
      if (prior) {
        if (
          prior.actorReference !== selected.actorReference ||
          prior.intentDigest !== c.intentDigest
        )
          return respond(route, { error: "request_denied" }, 403);
        return respond(route, prior);
      }
      const receipt = parseTaxConfigMaterialOperation({
        profile: "TaxConfigMaterialOperationV1",
        ...selected,
        action: c.action,
        operationReference: c.operationReference,
        materialReference: c.materialReference,
        expectedRevision: c.expectedRevision,
        materialKind: c.materialKind,
        command: null,
        intentDigest: c.intentDigest,
        outcome: "Abandoned",
        version: null,
        auditReference: id(++serial),
        eventReference: null,
        occurredAt: at,
      });
      ledger.set(c.operationReference, receipt);
      return respond(route, receipt);
    }
    if (action !== "materials/commands") return route.abort();
    const raw = request.postDataJSON(),
      command = parseTaxConfigMaterialCommand(raw);
    state.posts.push(raw);
    await expect(
      panel(page).getByRole("button", { name: "Compare saved fixture expectations", exact: true }),
    ).toBeDisabled();
    const stored = await originals(page);
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0] as Record<string, unknown>).sort()).toEqual(
      [
        "profile",
        "scope",
        "action",
        "operationReference",
        "materialReference",
        "expectedRevision",
        "materialKind",
        "intentDigest",
      ].sort(),
    );
    const encoded = JSON.stringify(stored);
    expect(encoded).not.toContain("content");
    expect(encoded).not.toContain("Synthetic material registrant");
    expect(encoded).not.toContain("sourceIssuedAt");
    expect(encoded).not.toContain(csrf);
    const prior = ledger.get(command.operationReference);
    if (prior) return respond(route, prior);
    const old = command.materialReference === null ? null : heads.get(command.materialReference);
    if (command.action === "ReplaceMaterial" && old?.revision !== command.expectedRevision)
      return respond(route, { error: "tax_config_authoring_conflict" }, 409);
    const version = parseTaxConfigMaterialVersion({
      profile: "TaxConfigMaterialVersionV1",
      tenantReference: scope.tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      materialReference: old?.materialReference ?? id(++serial),
      versionReference: id(++serial),
      revision: (old?.revision ?? 0) + 1,
      previousVersionReference: old?.versionReference ?? null,
      materialKind: command.materialKind,
      content: command.content,
      contentDigest: taxConfigMaterialContentDigest(command.content, command.materialKind),
      recordedByActorReference: selected.actorReference,
      createdAt: old?.createdAt ?? at,
      recordedAt: at,
      dataClassification: "Confidential",
      status: "Recorded",
      qualification: "NotEvaluated",
    });
    const receipt = parseTaxConfigMaterialOperation({
      profile: "TaxConfigMaterialOperationV1",
      ...selected,
      action: command.action,
      operationReference: command.operationReference,
      materialReference: command.materialReference,
      expectedRevision: command.expectedRevision,
      materialKind: command.materialKind,
      command,
      intentDigest: taxConfigMaterialIntentDigest(selected, command),
      outcome: "Committed",
      version,
      auditReference: id(++serial),
      eventReference: id(++serial),
      occurredAt: at,
    });
    versions.set(version.versionReference, version);
    heads.set(version.materialReference, version);
    ledger.set(command.operationReference, receipt);
    if (state.failAfterWrite) state.failRefresh = true;
    if (state.lose) {
      state.lose = false;
      return route.abort();
    }
    return respond(route, receipt);
  });
  return { state, versions, heads, ledger, seeded };
}

const panel = (page: Page) =>
  page.getByRole("region", { name: "Tax evidence materials", exact: true });
async function enter(page: Page, f: Awaited<ReturnType<typeof install>>) {
  await page.goto(href);
  const selector = page.getByRole("combobox", { name: "Saved Tax Draft", exact: true });
  await expect(selector).toBeEnabled();
  await selector.selectOption(String(f.seeded.draft.snapshot.configurationReference));
  await expect(page.getByLabel("Stable code", { exact: true })).toHaveValue("SYNTHETIC_FOOD");
  await page
    .getByRole("combobox", { name: "Material workspace", exact: true })
    .selectOption("Evidence");
  await chooseCandidate(page, f);
}
async function chooseCandidate(page: Page, f: Awaited<ReturnType<typeof install>>) {
  const selector = panel(page).getByRole("combobox", {
    name: "Evidence publication candidate",
    exact: true,
  });
  await expect(selector).toBeEnabled();
  await expect(selector.locator("option")).toHaveCount(2);
  await selector.selectOption(String(f.seeded.record.candidate.content.targetVersionReference));
  await expect
    .poll(async () => {
      const value = await panel(page)
        .getByRole("textbox", { name: "Selected candidate source JSON", exact: true })
        .inputValue();
      try {
        return canonical(JSON.parse(value));
      } catch {
        return null;
      }
    })
    .toBe(canonical(f.seeded.record.candidate));
  await expect(selector).toBeEnabled();
}
async function fillSuite(
  page: Page,
  f: Awaited<ReturnType<typeof install>>,
  value: unknown = f.seeded.suite,
) {
  await expect(
    panel(page).getByRole("textbox", { name: "Structured fixture suite JSON", exact: true }),
  ).toBeEnabled();
  await panel(page)
    .getByRole("textbox", { name: "Structured fixture suite JSON", exact: true })
    .fill(JSON.stringify(value));
}
async function save(page: Page) {
  await panel(page).getByRole("button", { name: "Save evidence material", exact: true }).click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Material recorded and refreshed. Qualification remains not evaluated.",
  );
  await expect.poll(() => originals(page)).toEqual([]);
}

test("@production stored Candidate Suite and Report declarations preserve exact pins, hashes and immutable history", async ({
  page,
}) => {
  const f = await install(page);
  await enter(page, f);
  await fillSuite(page, f);
  await save(page);
  const first = [...f.versions.values()].find((v) => v.materialKind === "FixtureSuite");
  if (!first) throw Error("Missing recorded suite");
  expect(first.contentDigest).toBe(taxConfigMaterialContentDigest(f.seeded.suite, "FixtureSuite"));
  expect(first.qualification).toBe("NotEvaluated");
  const replacement = {
    ...f.seeded.suite,
    sourceIssuedAt: new Date().toISOString(),
    declaredSourceDigest: hash("declared external checksum, not acquired bytes"),
  };
  await fillSuite(page, f, replacement);
  await save(page);
  const head = f.heads.get(first.materialReference);
  if (!head) throw Error("Missing current suite");
  expect(head.revision).toBe(2);
  expect(head.previousVersionReference).toBe(first.versionReference);
  await panel(page).getByRole("button", { name: "Previous evidence version", exact: true }).click();
  await expect(
    panel(page).getByRole("heading", { name: "Historical saved material revision 1", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const value = await panel(page)
        .getByRole("textbox", { name: "Recorded evidence JSON", exact: true })
        .inputValue();
      try {
        return canonical(JSON.parse(value));
      } catch {
        return null;
      }
    })
    .toBe(canonical(first.content));
  await expect(
    panel(page).getByRole("button", { name: "Save evidence material", exact: true }),
  ).toBeDisabled();
  expect(f.versions.get(first.versionReference)).toEqual(first);
  await panel(page)
    .getByRole("button", { name: "Return to current evidence", exact: true })
    .click();
  await panel(page)
    .getByRole("combobox", { name: "Evidence material kind", exact: true })
    .selectOption("ProfessionalReport");
  await chooseCandidate(page, f);
  const suite = panel(page).getByRole("combobox", { name: "Report fixture suite", exact: true });
  await expect(suite).toBeEnabled();
  await expect(suite.locator("option")).toHaveCount(2);
  await suite.selectOption(String(first.materialReference));
  await expect(
    panel(page).getByRole("button", { name: "Save evidence material", exact: true }),
  ).toBeEnabled();
  const reviewedAt = new Date().toISOString(),
    validUntil = new Date(Date.now() + 86400000).toISOString();
  await panel(page)
    .getByRole("textbox", { name: "Declared issuer name", exact: true })
    .fill("Synthetic external declaration");
  await panel(page)
    .getByRole("textbox", { name: "Issuer organization (optional)", exact: true })
    .fill("Controlled fixture only");
  await panel(page)
    .getByRole("textbox", { name: "Report reviewed at (UTC)", exact: true })
    .fill(reviewedAt);
  await panel(page)
    .getByRole("textbox", { name: "Report valid until (UTC)", exact: true })
    .fill(validUntil);
  await panel(page)
    .getByRole("combobox", { name: "Declared report conclusion", exact: true })
    .selectOption("Pass");
  await save(page);
  const report = [...f.versions.values()].find((v) => v.materialKind === "ProfessionalReport");
  if (!report || !("fixtureSuiteMaterial" in report.content))
    throw Error("Missing declared report");
  expect(report.content.fixtureSuiteMaterial).toEqual({
    versionReference: head.versionReference,
    contentDigest: head.contentDigest,
  });
  expect(report.content.registrationMaterial).toEqual({
    versionReference: f.seeded.registration.versionReference,
    contentDigest: f.seeded.registration.contentDigest,
  });
  expect(report.content.targetPublicationCandidate).toEqual(
    f.seeded.suite.targetPublicationCandidate,
  );
  expect(report.content.declaredConclusion).toBe("Pass");
  expect(report.qualification).toBe("NotEvaluated");
  expect(report.contentDigest).toBe(
    taxConfigMaterialContentDigest(report.content, "ProfessionalReport"),
  );
  await expect(
    panel(page).getByText(
      "Independent review and publishing remain unavailable until qualified sources and approved coverage are connected.",
      { exact: true },
    ),
  ).toBeVisible();
  await enter(page, f);
  await panel(page)
    .getByRole("combobox", { name: "Evidence material kind", exact: true })
    .selectOption("ProfessionalReport");
  const saved = panel(page).getByRole("combobox", { name: "Saved evidence material", exact: true });
  await expect(saved).toBeEnabled();
  await expect(saved.locator("option")).toHaveCount(2);
  await saved.selectOption(String(report.materialReference));
  await expect
    .poll(async () => {
      const value = await panel(page)
        .getByRole("textbox", { name: "Recorded evidence JSON", exact: true })
        .inputValue();
      try {
        return canonical(JSON.parse(value));
      } catch {
        return null;
      }
    })
    .toBe(canonical(report.content));
  expect(f.state.posts).toHaveLength(3);
  expect(f.state.errors).toEqual([]);
});

test("@production lost Suite reply shares a payload-free barrier across material entries and resolves the original after reload", async ({
  page,
}) => {
  const f = await install(page);
  await enter(page, f);
  await fillSuite(page, f);
  f.state.lose = true;
  await panel(page).getByRole("button", { name: "Save evidence material", exact: true }).click();
  await expect(
    panel(page).getByRole("button", { name: "Recover original material request", exact: true }),
  ).toBeEnabled();
  await expect(
    panel(page).getByRole("button", { name: "Compare saved fixture expectations", exact: true }),
  ).toBeDisabled();
  const stored = await originals(page);
  expect(stored).toHaveLength(1);
  const encoded = JSON.stringify(stored);
  for (const secret of [
    "content",
    "cases",
    "declaredIssuer",
    "currencyMetadata",
    "Synthetic external declaration",
    csrf,
  ])
    expect(encoded).not.toContain(secret);
  const original = f.state.posts[0];
  if (!original) throw Error("Missing original dispatched command");
  await page
    .getByRole("combobox", { name: "Material workspace", exact: true })
    .selectOption("Registration");
  const registration = page.getByRole("region", {
    name: "Tax registration materials",
    exact: true,
  });
  await expect(
    registration.getByRole("button", { name: "Save registration material", exact: true }),
  ).toBeDisabled();
  expect(f.state.posts).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Material workspace", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Material workspace", exact: true })
    .selectOption("Evidence");
  const recovery = panel(page).getByRole("button", {
    name: "Recover original material request",
    exact: true,
  });
  await expect(recovery).toBeEnabled();
  f.state.denyResolve = true;
  await recovery.click();
  await expect(panel(page).getByRole("alert")).toContainText("Current permission refused");
  expect(await originals(page)).toEqual(stored);
  expect(f.state.posts).toHaveLength(1);
  f.state.denyResolve = false;
  await recovery.click();
  await expect(panel(page).getByRole("status")).toHaveText(
    "Original material recorded and refreshed. Refresh the workspace to continue.",
  );
  await expect.poll(() => originals(page)).toEqual([]);
  const resolved = f.state.resolves.at(-1);
  expect(resolved).toEqual({
    ...Object.fromEntries(Object.entries(original).filter(([key]) => key !== "content")),
    intentDigest: taxConfigMaterialIntentDigest(scope, parseTaxConfigMaterialCommand(original)),
  });
  expect([...f.versions.values()].filter((v) => v.materialKind === "FixtureSuite")).toHaveLength(1);
  expect(f.state.posts).toHaveLength(1);
  await expect(
    panel(page).getByRole("button", { name: "Refresh evidence workspace", exact: true }),
  ).toBeEnabled();
  expect(f.state.errors).toEqual([]);
});

test("@production source drift refuses reserve and POST while evidence controls reflow at 320px and 200 percent text", async ({
  page,
}) => {
  const f = await install(page);
  await enter(page, f);
  await fillSuite(page, f);
  f.state.driftCandidate = true;
  await panel(page).getByRole("button", { name: "Save evidence material", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText("saved source checksums");
  expect(f.state.posts).toEqual([]);
  expect(await originals(page)).toEqual([]);
  await expect(panel(page).getByRole("alert")).toBeFocused();
  f.state.driftCandidate = false;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect(
    panel(page).getByRole("textbox", { name: "Structured fixture suite JSON", exact: true }),
  ).toBeVisible();
  const bounds = await panel(page).evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    scroll: element.scrollWidth,
  }));
  expect(bounds.scroll).toBeLessThanOrEqual(Math.ceil(bounds.width));
  const documentBounds = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(documentBounds.scroll).toBeLessThanOrEqual(documentBounds.width);
  const touch = await panel(page)
    .getByRole("button", { name: "Save evidence material", exact: true })
    .boundingBox();
  expect(touch?.height).toBeGreaterThanOrEqual(44);
  const keyboardKind = panel(page).getByRole("combobox", {
    name: "Evidence material kind",
    exact: true,
  });
  await expect(keyboardKind).toBeEnabled();
  await keyboardKind.focus();
  await expect(keyboardKind).toBeFocused();
  await page.keyboard.press("p");
  await page.keyboard.press("Enter");
  await expect(
    panel(page).getByRole("combobox", { name: "Evidence material kind", exact: true }),
  ).toHaveValue("ProfessionalReport");
  await page.screenshot({
    path: "/private/tmp/wp2421-tax-evidence-material-mobile.png",
    fullPage: true,
  });
  expect(f.state.errors).toEqual([]);
});

const compareButton = (page: Page) =>
  panel(page).getByRole("button", {
    name: "Compare saved fixture expectations",
    exact: true,
  });
const comparisonView = (page: Page) =>
  panel(page).getByRole("region", {
    name: "Mechanical fixture comparison",
    exact: true,
  });

test("@production compares recorded Basket and Refund expectations with actual candidate mathematics, including selected Report suite", async ({
  page,
}) => {
  const f = await install(page);
  await enter(page, f);
  const basket = f.seeded.suite.cases[0];
  if (!basket) throw Error("Missing controlled Basket case");
  const refund = {
    profile: "TaxDraftFixtureV1",
    fixtureReference: id(50),
    kind: "Refund",
    evaluatedAt: basket.fixture.evaluatedAt,
    lines: [
      {
        lineReference: id(51),
        calculationReferences: [id(52)],
        labelCode: "SYNTHETIC_REFUND",
        taxClassificationReference: id(7),
        orderType: "Pickup",
        chargeType: "Sellable",
        amountMinor: "-1000",
      },
    ],
  };
  const content = {
    ...f.seeded.suite,
    cases: [
      {
        fixture: basket.fixture,
        expected: simulateTaxConfigCandidateFixture(f.seeded.record, basket.fixture),
      },
      { fixture: refund, expected: simulateTaxConfigCandidateFixture(f.seeded.record, refund) },
    ],
  };
  await fillSuite(page, f, content);
  await save(page);
  const suite = [...f.versions.values()].find((v) => v.materialKind === "FixtureSuite");
  if (!suite) throw Error("Missing actual recorded suite");
  const actual = compareTaxConfigCandidateFixtureSuite(f.seeded.record, suite);
  expect(actual.allCasesMatched).toBe(true);
  expect(actual.cases).toHaveLength(2);
  const before = { versions: f.versions.size, ledger: f.ledger.size, posts: f.state.posts.length };
  await expect(compareButton(page)).toBeEnabled();
  await compareButton(page).click();
  await expect(
    comparisonView(page).getByText("All declared cases match the mechanical calculation.", {
      exact: true,
    }),
  ).toBeVisible();
  for (const [index, result] of actual.cases.entries()) {
    const item = comparisonView(page).getByRole("listitem").nth(index);
    await expect(item).toContainText(`Case ${index + 1}: Match`);
    await expect(item).toContainText(`Actual checksum: ${result.actualDigest}`);
    await expect(item).toContainText(`Declared expected checksum: ${result.expectedDigest}`);
  }
  await expect(
    comparisonView(page).getByText(
      "Professional review: Not evaluated. Legal conclusion: Not evaluated. Reference eligibility: Not evaluated.",
      { exact: true },
    ),
  ).toBeVisible();
  const command = {
    configurationReference: f.seeded.draft.snapshot.configurationReference,
    targetPublicationCandidate: f.seeded.suite.targetPublicationCandidate,
    fixtureSuiteMaterial: {
      materialReference: suite.materialReference,
      versionReference: suite.versionReference,
      contentDigest: suite.contentDigest,
    },
  };
  expect(f.state.comparisons).toEqual([command]);
  expect(JSON.stringify(f.state.comparisons)).not.toContain("cases");
  expect(JSON.stringify(f.state.comparisons)).not.toContain("operationReference");
  expect(await originals(page)).toEqual([]);
  expect({ versions: f.versions.size, ledger: f.ledger.size, posts: f.state.posts.length }).toEqual(
    before,
  );
  await panel(page)
    .getByRole("combobox", { name: "Evidence material kind", exact: true })
    .selectOption("ProfessionalReport");
  await chooseCandidate(page, f);
  const selected = panel(page).getByRole("combobox", { name: "Report fixture suite", exact: true });
  await expect(selected).toBeEnabled();
  await selected.selectOption(String(suite.materialReference));
  await expect(compareButton(page)).toBeEnabled();
  await compareButton(page).click();
  await expect(
    comparisonView(page).getByText("All declared cases match the mechanical calculation.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.state.comparisons).toEqual([command, command]);
  expect({ versions: f.versions.size, ledger: f.ledger.size, posts: f.state.posts.length }).toEqual(
    before,
  );
  expect(await originals(page)).toEqual([]);
  expect(f.state.errors).toEqual([]);
});

test("@production compares exact historical mismatching expectations and refuses denied, expired, foreign-scope or substituted comparison replies", async ({
  page,
}) => {
  const f = await install(page);
  await enter(page, f);
  const first = f.seeded.suite.cases[0];
  if (!first) throw Error("Missing controlled Basket case");
  const content = {
    ...f.seeded.suite,
    cases: [
      {
        fixture: first.fixture,
        expected: {
          ...first.expected,
          taxAmountMinor: "140",
          grossAmountMinor: "1140",
          receiptPreview: first.expected.receiptPreview.map((item) => ({
            ...item,
            taxAmountMinor: "140",
          })),
        },
      },
    ],
  };
  await fillSuite(page, f, content);
  await save(page);
  const original = [...f.versions.values()].find((v) => v.materialKind === "FixtureSuite");
  if (!original) throw Error("Missing stored declared mismatching suite");
  const expected = compareTaxConfigCandidateFixtureSuite(f.seeded.record, original);
  expect(expected.allCasesMatched).toBe(false);
  expect(expected.cases[0]?.mismatchedFields).toEqual([
    "taxAmountMinor",
    "grossAmountMinor",
    "receiptPreview",
  ]);
  await compareButton(page).click();
  await expect(
    comparisonView(page).getByText("Some declared cases differ from the mechanical calculation.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(comparisonView(page).getByRole("listitem")).toContainText(
    "Different fields: taxAmountMinor, grossAmountMinor, receiptPreview",
  );
  const row = expected.cases[0];
  if (!row) throw Error("Missing owning comparison case");
  await expect(comparisonView(page).getByRole("listitem")).toContainText(
    `Actual checksum: ${row.actualDigest}`,
  );
  await expect(comparisonView(page).getByRole("listitem")).toContainText(
    `Declared expected checksum: ${row.expectedDigest}`,
  );
  await fillSuite(page, f, {
    ...f.seeded.suite,
    cases: [
      {
        fixture: first.fixture,
        expected: simulateTaxConfigCandidateFixture(f.seeded.record, first.fixture),
      },
    ],
  });
  await save(page);
  const successor = f.heads.get(original.materialReference);
  if (!successor) throw Error("Missing corrected suite successor");
  expect(successor.revision).toBe(2);
  expect(compareTaxConfigCandidateFixtureSuite(f.seeded.record, successor).allCasesMatched).toBe(
    true,
  );
  await panel(page).getByRole("button", { name: "Previous evidence version", exact: true }).click();
  await expect(
    panel(page).getByRole("heading", { name: "Historical saved material revision 1", exact: true }),
  ).toBeVisible();
  await expect(compareButton(page)).toBeEnabled();
  await compareButton(page).click();
  await expect(
    comparisonView(page).getByText("Some declared cases differ from the mechanical calculation.", {
      exact: true,
    }),
  ).toBeVisible();
  const oldCommand = {
    configurationReference: f.seeded.draft.snapshot.configurationReference,
    targetPublicationCandidate: f.seeded.suite.targetPublicationCandidate,
    fixtureSuiteMaterial: {
      materialReference: original.materialReference,
      versionReference: original.versionReference,
      contentDigest: original.contentDigest,
    },
  };
  expect(f.state.comparisons.at(-1)).toEqual(oldCommand);
  const unchanged = {
    versions: f.versions.size,
    ledger: f.ledger.size,
    posts: f.state.posts.length,
  };
  f.state.denyComparison = true;
  await compareButton(page).click();
  await expect(panel(page).getByRole("alert")).toContainText("Current permission refused");
  await expect(comparisonView(page)).toHaveCount(0);
  f.state.denyComparison = false;
  await compareButton(page).click();
  await expect(
    comparisonView(page).getByText("Some declared cases differ from the mechanical calculation.", {
      exact: true,
    }),
  ).toBeVisible();
  for (const fault of ["Pin", "Lease", "Scope"] as const) {
    f.state.comparisonFault = fault;
    await expect(compareButton(page)).toBeEnabled();
    await compareButton(page).click();
    await expect(panel(page).getByRole("alert")).toBeVisible();
    await expect(comparisonView(page)).toHaveCount(0);
    expect(f.state.comparisons.at(-1)).toEqual(oldCommand);
    expect(await originals(page)).toEqual([]);
    expect({
      versions: f.versions.size,
      ledger: f.ledger.size,
      posts: f.state.posts.length,
    }).toEqual(unchanged);
  }
  f.state.comparisonFault = "";
  await compareButton(page).click();
  await expect(
    comparisonView(page).getByText("Some declared cases differ from the mechanical calculation.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.versions.get(original.versionReference)).toEqual(original);
  expect(f.state.errors).toEqual([]);
});

test("@production discards a late read comparison after parent Draft editing disables the evidence workspace", async ({
  page,
}) => {
  const f = await install(page);
  await enter(page, f);
  await fillSuite(page, f);
  await save(page);
  const posts = f.state.posts.length,
    versions = f.versions.size,
    ledger = f.ledger.size;
  f.state.delayComparison = true;
  await expect(compareButton(page)).toBeEnabled();
  await compareButton(page).click();
  await expect.poll(() => f.state.releaseComparison !== null).toBe(true);
  await page.getByLabel("Rule 1 rate", { exact: true }).fill("0.14");
  await expect(compareButton(page)).toBeDisabled();
  const release = f.state.releaseComparison;
  if (!release) throw Error("No retained comparison response");
  release();
  await expect.poll(() => f.state.comparisonResponded).toBe(true);
  await expect(
    panel(page).getByRole("status").filter({ hasText: "Loading saved material sources" }),
  ).toHaveCount(0);
  await expect(comparisonView(page)).toHaveCount(0);
  expect(f.state.posts).toHaveLength(posts);
  expect(f.versions.size).toBe(versions);
  expect(f.ledger.size).toBe(ledger);
  expect(await originals(page)).toEqual([]);
  f.state.delayComparison = false;
  await page.getByRole("button", { name: "Refresh current Draft", exact: true }).click();
  await expect(page.getByLabel("Stable code", { exact: true })).toHaveValue("SYNTHETIC_FOOD");
  await expect(compareButton(page)).toBeEnabled();
  await compareButton(page).click();
  await expect(comparisonView(page)).toContainText(
    "All declared cases match the mechanical calculation.",
  );
  expect(f.state.posts).toHaveLength(posts);
  expect(await originals(page)).toEqual([]);
  expect(f.state.errors).toEqual([]);
});
