import {
  parseCatalogReference,
  parseProductAggregate,
  deriveCatalogProductPublicationContentIdentity,
} from "@rms/catalog";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import type { CurrentBrandConfigurationContent } from "./current-brand-configuration-content.js";
import { expect, it, vi } from "vitest";
import {
  createCurrentProductContentPolicySource,
  createCurrentProductDraftContentPolicySource,
} from "./current-product-content-policy.js";
const at = "2026-09-30T06:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = () => ({
  aggregate: {},
  binding: {
    tenantReference: id(1),
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 1,
    contentDigest: digest,
    configurationDigest: digest,
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: "2026-09-30T06:00:20.000Z",
  },
  brandRequest: {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purposeCode: "CATALOG_PRODUCT_CONTENT" as const,
    configurationVersionReference: id(4),
    expectedBrandVersion: 1,
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: "2026-09-30T06:00:20.000Z",
  },
  policyRequest: { policyReference: id(7), policyVersion: 1, observedAt: at },
});
const tx = { query: vi.fn() };
function fixture() {
  const brandSource = {
    withCurrentContent: vi.fn(async () => {
      throw new Error("synthetic owner unavailable");
    }),
  };
  const policySource = {
    withCurrentPolicy: vi.fn(async () => {
      throw new Error("synthetic owner unavailable");
    }),
    withHeldScopePolicy: vi.fn(),
    context: Object.freeze({
      tenantReference: parseCatalogReference(id(1)),
      brandReference: parseCatalogReference(id(2)),
      actorReference: parseCatalogReference(id(3)),
      actorKind: "User" as const,
    }),
  };
  const source = createCurrentProductContentPolicySource({
    brandSource,
    policySource,
    clock: { now: () => at },
  });
  return { brandSource, policySource, source };
}
it("does not evaluate or replace missing owning current sources with default policy", async () => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.source.withCurrentAssessment(tx, input(), work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.brandSource.withCurrentContent).toHaveBeenCalledOnce();
  expect(f.policySource.withCurrentPolicy).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it.each(["aggregate", "binding", "brandRequest", "policyRequest"])(
  "never invokes an outer %s getter",
  async (key) => {
    const f = fixture(),
      getter = vi.fn();
    const value = Object.defineProperty(input(), key, { get: getter });
    await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.brandSource.withCurrentContent).not.toHaveBeenCalled();
  },
);

function draftSourceFixture() {
  let now = at,
    foreignTransaction = false,
    duplicate = false;
  const events: string[] = [],
    value = input(),
    shorter = "2026-09-30T06:00:01.000Z",
    aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SOURCE_DRAFT",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(3),
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic" },
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        skus: [],
        optionBindings: [],
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: {},
          localizedDescriptions: {},
          preparationNotes: {},
          tagReferences: [],
          attributeValues: [],
          media: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    });
  value.aggregate = aggregate;
  const { referenceConfiguration, ...identity } =
    deriveCatalogProductPublicationContentIdentity(aggregate);
  void referenceConfiguration;
  Object.assign(value.binding, identity);
  const brand: CurrentBrandConfigurationContent = {
      profile: "CurrentBrandConfigurationContentV1",
      tenantReference: id(1),
      brandReference: id(2),
      brandVersion: 1,
      configurationVersionReference: id(4),
      configurationVersion: 1,
      contentDigest: digest,
      originalPublicationReference: id(9),
      currentPublicationReference: id(10),
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA", "fr-CA"],
      overrideAllowedFieldCodes: [],
      hardRequirementFieldCodes: [],
      catalogSourceReference: id(11),
      platformTemplateReference: id(12),
      effectiveFrom: at,
      effectiveUntil: null,
      originalIntentDigest: digest,
      observedAt: at,
      validUntil: shorter,
      eligibility: "NotEvaluated",
    },
    content = parsePublishingProductPublicationPolicy({
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(13),
      policyReference: id(7),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA", "fr-CA"],
      mediaRequirement: "Required",
      effectiveFrom: at,
      effectiveUntil: null,
    });
  const options: Parameters<typeof createCurrentProductDraftContentPolicySource>[0] = {
    clock: { now: () => now },
    brandSource: {
      async withCurrentContent(_request, work) {
        events.push("Brand");
        const result = await work(brand, foreignTransaction ? { query: vi.fn() } : tx);
        if (duplicate) await work(brand, tx);
        events.push("Brand final");
        return result;
      },
    },
    policySource: {
      context: {
        tenantReference: parseCatalogReference(id(1)),
        brandReference: parseCatalogReference(id(2)),
        actorReference: parseCatalogReference(id(3)),
        actorKind: "User",
      },
      async withHeldScopePolicy() {
        throw new Error("Unused publication scope path");
      },
      async withCurrentPolicy(actual, _request, work) {
        expect(actual).toBe(tx);
        events.push("Policy");
        const result = await work({
          content,
          currentPublicationReference: id(14),
          observedAt: at,
          validUntil: value.binding.validUntil,
        });
        events.push("Policy final");
        return result;
      },
    },
  };
  return {
    value,
    options,
    events,
    shorter,
    now: (instant: string) => {
      now = instant;
    },
    foreign: () => {
      foreignTransaction = true;
    },
    duplicate: () => {
      duplicate = true;
    },
  };
}
it.each(["Draft", "Publication"])(
  "Draft source keeps the exact %s stage while holding the same current sources",
  async (stage) => {
    const f = draftSourceFixture(),
      source =
        stage === "Draft"
          ? createCurrentProductDraftContentPolicySource(f.options)
          : createCurrentProductContentPolicySource(f.options);
    const result = await source.withCurrentAssessment(tx, f.value, async (assessment) => {
      f.events.push("Consumer");
      expect(assessment.validUntil).toBe(f.shorter);
      return assessment;
    });
    expect(result.decision).toBe(stage === "Draft" ? "PassForAssessedDraftRules" : "HardError");
    expect(result.profile).toBe(
      stage === "Draft"
        ? "CatalogProductDraftContentPolicyAssessmentV1"
        : "CatalogProductContentPolicyAssessmentV1",
    );
    expect(f.events).toEqual(["Brand", "Policy", "Consumer", "Policy final", "Brand final"]);
  },
);
it("Draft source retains the original shorter Brand boundary after awaited consumer work", async () => {
  const f = draftSourceFixture();
  await expect(
    createCurrentProductDraftContentPolicySource(f.options).withCurrentAssessment(
      tx,
      f.value,
      async () => {
        f.now(f.shorter);
      },
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it.each(["foreign transaction", "duplicate callback"])(
  "Draft source refuses %s rather than accepting an earlier valid assessment",
  async (kind) => {
    const f = draftSourceFixture();
    if (kind === "foreign transaction") f.foreign();
    else f.duplicate();
    await expect(
      createCurrentProductDraftContentPolicySource(f.options).withCurrentAssessment(
        tx,
        f.value,
        async () => undefined,
      ),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);
it("rejects a binding accessor before source acquisition", async () => {
  const f = fixture(),
    value = input(),
    getter = vi.fn();
  Object.defineProperty(value.binding, "validUntil", { get: getter });
  await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.brandSource.withCurrentContent).not.toHaveBeenCalled();
});

it.each(["tenantReference", "brandReference", "actorReference"] as const)(
  "binds both sources to one current %s",
  async (key) => {
    const f = fixture(),
      value = input();
    value.brandRequest[key] = id(99);
    await expect(f.source.withCurrentAssessment(tx, value, vi.fn())).rejects.toThrow();
    expect(f.brandSource.withCurrentContent).not.toHaveBeenCalled();
  },
);
