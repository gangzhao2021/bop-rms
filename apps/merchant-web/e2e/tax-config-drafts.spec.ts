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
  database = "bop-tax-config-authoring-pending-v1";
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
async function fixture(page: Page) {
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
        ...scope,
        configurationReference,
        state: configurationReference === null ? null : (saved.get(configurationReference) ?? null),
        observedAt: at,
        validUntil: until,
        referenceEligibility: "NotEvaluated",
      });
    const action = path.slice(prefix.length);
    if (action === "candidates/current")
      return respond(route, {
        profile: "TaxConfigCandidateCurrentV1",
        ...scope,
        configurationReference: url.searchParams.get("configurationReference"),
        targetVersionReference: url.searchParams.get("targetVersionReference"),
        record: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });
    if (action === "candidates/roster")
      return respond(route, {
        profile: "TaxConfigCandidateRosterV1",
        ...scope,
        configurationReference: url.searchParams.get("configurationReference"),
        afterCandidate: url.searchParams.get("afterCandidate"),
        entries: [],
        nextAfterCandidate: null,
        observedAt: at,
        validUntil: until,
        qualification: "NotEvaluated",
      });

    // This Draft fixture does not seed an Operating Entity or materials. The
    // sibling panel reads explicit source absence, rather than a dropped request.
    if (action === "tax-registrant") return respond(route, null);
    if (action === "materials/current")
      return respond(route, {
        profile: "TaxConfigMaterialCurrentV1",
        ...scope,
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
        ...scope,
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
          ...scope,
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
        ...scope,
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
        ...scope,
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
        ...scope,
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
  return state;
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
test("@production ordinary Tax Draft saves, replaces and mechanically simulates Basket and Refund", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(href);
  await enterDraft(page);
  await page.getByRole("button", { name: "Save Tax Draft", exact: true }).click();
  await expect(
    page.getByText("Draft saved and refreshed. Professional approval has not been evaluated.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect.poll(async () => (await pending(page)).length).toBe(0);
  await page.getByLabel("Rule 1 rate", { exact: true }).fill("0.1");
  await page.getByRole("button", { name: "Save Tax Draft", exact: true }).click();
  await expect.poll(() => f.posts.length).toBe(2);
  await expect(page.getByRole("button", { name: "Save Tax Draft", exact: true })).toBeDisabled();
  expect(f.posts.map((p) => p.action)).toEqual(["CreateDraft", "ReplaceDraft"]);
  await page.getByRole("button", { name: "Refresh saved Drafts", exact: true }).click();
  await expect(
    page
      .getByLabel("Saved Tax Draft", { exact: true })
      .getByRole("option", { name: /SYNTHETIC_FOOD.*Revision 2/ }),
  ).toHaveCount(1);
  await page.getByLabel("Fixture kind", { exact: true }).selectOption("Basket");
  await page.getByLabel("Evaluation time (UTC)", { exact: true }).fill(new Date().toISOString());
  await page.getByLabel("Line label code", { exact: true }).fill("MEAL");
  await page.getByLabel("Amount in minor units", { exact: true }).fill("100");
  await page.getByLabel("Simulation classification", { exact: true }).selectOption(id(7));
  await page.getByRole("button", { name: "Simulate saved Draft", exact: true }).click();
  await expect(
    page.getByText("Net: 100 · Tax: 10 · Gross: 110 minor units", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Fixture kind", { exact: true }).selectOption("Refund");
  await page.getByLabel("Amount in minor units", { exact: true }).fill("-100");
  await page.getByRole("button", { name: "Simulate saved Draft", exact: true }).click();
  await expect(
    page.getByText("Net: -100 · Tax: -10 · Gross: -110 minor units", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Professional review: Not evaluated. Legal conclusion: Not evaluated.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(f.posts).toHaveLength(2);
  expect(f.simulations).toHaveLength(2);
  expect(f.errors).toEqual([]);
});
test("@production lost reply reload recovers only the durable original without re-sending fields", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto(href);
  await enterDraft(page);
  f.lose = true;
  await page.getByRole("button", { name: "Save Tax Draft", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Recover original Tax save", exact: true }),
  ).toBeEnabled();
  await expect.poll(async () => (await pending(page)).length).toBe(1);
  const original = f.posts[0];
  if (!original) throw new Error("Missing original controlled request");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Recover original Tax save", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: "Save Tax Draft", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Recover original Tax save", exact: true }).click();
  await expect(
    page.getByText("Original save committed. Current Draft refreshed.", { exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await pending(page)).length).toBe(0);
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]).toMatchObject({
    action: original.action,
    operationReference: original.operationReference,
    configurationReference: original.configurationReference,
    expectedAggregateVersion: original.expectedAggregateVersion,
  });
  expect(f.posts[1]).not.toHaveProperty("content");
  expect(f.errors).toEqual([]);
});
test("@production denied and Disabled sources fail closed, then the ordinary mobile form remains keyboard usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  f.deny = true;
  await page.goto(href);
  await expect(page.getByRole("alert")).toContainText("Permission denied");
  expect(
    await page.evaluate(
      async (name) => (await indexedDB.databases()).some((d) => d.name === name),
      database,
    ),
  ).toBe(false);
  expect(f.posts).toHaveLength(0);
  f.deny = false;
  f.disabled = true;
  await page.getByRole("button", { name: "Retry workspace", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("disabled");
  expect(f.posts).toHaveLength(0);
  f.disabled = false;
  await page.getByRole("button", { name: "Retry workspace", exact: true }).click();
  await enterDraft(page);
  await page.getByLabel("Rule 1 rate", { exact: true }).focus();
  await expect(page.getByLabel("Rule 1 rate", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Rule 1 receipt label code", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const box = await page.getByRole("button", { name: "Save Tax Draft", exact: true }).boundingBox();
  if (!box) throw new Error("Missing rendered Save button");
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(f.errors).toEqual([]);
});
