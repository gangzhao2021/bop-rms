import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  deriveCatalogProductPublicationContentIdentity,
  bindCatalogProductPublicationValidationContextV2,
  bindCatalogProductPublicationQualificationContext,
  buildCatalogProductPublicationReferenceRequestV2,
  buildCatalogProductPublicationReferenceProvenance,
  buildCatalogProductRetirementCoverage,
  buildProductPublicationReferenceHistorySnapshotV2,
  buildProductPublicationMenuReferenceSourceSnapshotV2,
  buildProductPublicationBundleReferenceSourceSnapshotV2,
  buildProductPublicationAvailabilityReferenceSourceSnapshotV2,
} from "@rms/catalog";
import {
  buildRecipeProductPublicationReferenceSnapshotV2,
  buildRecipeInventoryProductPublicationReferenceSnapshotV2,
} from "@rms/recipe";
import {
  buildInventoryProductPublicationConfigurationReferenceSnapshotV2,
  buildInventoryProductPublicationSkuMappingReferenceSnapshotV2,
} from "@rms/inventory";
import {
  buildProductPublicationPriceBookReferenceSourceSnapshotV2,
  buildProductPublicationOptionPriceReferenceSourceSnapshotV2,
  buildProductPublicationPromotionReferenceSourceSnapshotV2,
  buildProductPublicationConfigurationReferenceSourceSnapshotV2,
} from "@rms/pricing";
import {
  bindMerchantProductPublicationReferenceRequestsV2,
  composeMerchantProductPublicationImpactReferencesV2,
} from "./merchant-product-publication-reference-source-v2.js";
import {
  buildMerchantProductPublicationBusinessConfiguration,
  createMerchantProductPublicationBusinessPolicy,
  type MerchantProductPublicationBusinessConfiguration,
  type MerchantProductPublicationBusinessPolicyOptions,
} from "./merchant-product-publication-business-policy.js";

type Policy = ReturnType<typeof createMerchantProductPublicationBusinessPolicy>;
type Input = Parameters<Policy["withAssessment"]>[1];
type Tx = Parameters<Policy["withAssessment"]>[0];
type Mutable<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : { -readonly [K in keyof T]: Mutable<T[K]> };
const id = (n: number) => `019024b0-0042-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-03T12:00:00.000Z",
  plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString(),
  until = plus(5000),
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));

// Real closed Catalog contexts and pure eight-owner composite builders. Leaf
// rows/authority below are controlled unit inputs, not native or sale proof.
function fixture(start = at, active = true, lifecycle: "Active" | "Discontinued" = "Active") {
  const aggregate = parseProductAggregate({
      productReference: id(1),
      brandReference: id(2),
      internalCode: "BUSINESS_RULES",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(3),
      draft: {
        versionReference: id(4),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Business rules fixture" },
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        skus: active
          ? [
              {
                skuReference: id(5),
                productReference: id(1),
                brandReference: id(2),
                skuCode: "ONE",
                lifecycle,
                localizedNames: { "en-CA": "One" },
                variantSelections: [],
                unitOfSale: "EA",
                unitQuantity: "1",
                createdAt: at,
                createdByActorReference: id(3),
              },
            ]
          : [],
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
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(11),
      productReference: id(1),
      versionReference: id(4),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(12), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: start, localDateTime: start.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "CONTROLLED_BUSINESS_RULES",
      replacementIntent: { ...body, digest: hash(body) },
      replacementIntentDigest: hash(body),
    }),
    original = { command, aggregate, current: null, content: null, observedAt: at },
    context = bindCatalogProductPublicationQualificationContext(original, until),
    referenceContext = bindCatalogProductPublicationValidationContextV2(original),
    request = buildCatalogProductPublicationReferenceRequestV2(referenceContext, until),
    bound = bindMerchantProductPublicationReferenceRequestsV2({
      context: referenceContext,
      request,
    }),
    empty = (families: string[]) => ({
      generation: null,
      observedAt: at,
      counts: Object.fromEntries(families.map((k) => [k, "0"])),
      ...Object.fromEntries(families.map((k) => [k, []])),
    }),
    inventory = buildInventoryProductPublicationConfigurationReferenceSnapshotV2(
      empty(["items", "versions", "operations"]),
      bound.inventory,
      at,
    ),
    leaf = { observedAt: at, references: [] },
    graph = identity.referenceConfiguration,
    { categoryCoverage, ...rawGraph } = graph;
  const references = composeMerchantProductPublicationImpactReferencesV2({
    request,
    context: referenceContext,
    now: at,
    referenceProvenance: buildCatalogProductPublicationReferenceProvenance(
      {
        aggregateVersion: 1,
        observedAt: at,
        history: [
          {
            aggregate,
            operationReference: id(15),
            snapshotDigest: hash(aggregate),
            coherent: true,
          },
        ],
      },
      request,
      at,
    ),
    publicationCoverage: buildCatalogProductRetirementCoverage({
      tenantReference: id(10),
      brandReference: id(2),
      productReference: id(1),
      aggregateVersion: 1,
      sourceRevision: "1",
      observedAt: at,
      history: [],
      headers: [],
    }),
    history: buildProductPublicationReferenceHistorySnapshotV2(
      {
        observedAt: at,
        targetExists: true,
        recordCoverage: true,
        recordedAggregateVersion: 1,
        configurations: [
          { ...rawGraph, categoryClassificationKnown: categoryCoverage === "Known" },
        ],
      },
      request,
      at,
    ),
    menu: buildProductPublicationMenuReferenceSourceSnapshotV2(
      empty(["reviews", "placements", "revisions", "releases", "periods"]),
      request,
      at,
    ),
    bundle: buildProductPublicationBundleReferenceSourceSnapshotV2(
      empty(["bundles", "versions", "groups", "members"]),
      request,
      at,
    ),
    availability: buildProductPublicationAvailabilityReferenceSourceSnapshotV2(
      { generation: null, observedAt: at, rootCount: "0", rules: [] },
      request,
      at,
    ),
    recipe: buildRecipeProductPublicationReferenceSnapshotV2(
      { ...empty(["recipes", "versions", "bindings", "modifiers"]), bindingCount: null },
      bound.recipe,
      at,
    ),
    recipeInventory: buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      empty(["recipes", "versions", "ingredients", "modifiers", "changes"]),
      bound.recipeInventory,
      at,
    ),
    inventory: buildInventoryProductPublicationSkuMappingReferenceSnapshotV2(
      { generation: null, observedAt: at, count: "0", mappings: [] },
      inventory,
      bound.inventory,
      at,
    ),
    pricing: buildProductPublicationConfigurationReferenceSourceSnapshotV2(
      {
        generation: "0",
        priceBooks: buildProductPublicationPriceBookReferenceSourceSnapshotV2(
          leaf,
          bound.pricing,
          at,
        ),
        optionPrices: buildProductPublicationOptionPriceReferenceSourceSnapshotV2(
          leaf,
          bound.pricing,
          at,
        ),
        promotions: buildProductPublicationPromotionReferenceSourceSnapshotV2(
          leaf,
          bound.pricing,
          at,
        ),
      },
      bound.pricing,
      at,
    ),
  });
  const policy = {
    content: parsePublishingProductPublicationPolicy({
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(10),
      brandReference: id(2),
      familyReference: id(20),
      policyReference: id(21),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Channel", "OrderType", "Brand"],
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: plus(-86400000),
      effectiveUntil: null,
    }),
    currentPublicationReference: id(22),
    observedAt: at,
    validUntil: until,
  };
  return { context, policy, references: structuredClone(references) as Mutable<typeof references> };
}
function harness(f = fixture()) {
  let time = at,
    allowed = true,
    holderCalls = 0;
  const tx: Tx = { query: vi.fn(async () => ({ rows: [] })) };
  const guards: { guard: () => Promise<void>; finalAssert: () => void }[] = [];
  let config: MerchantProductPublicationBusinessConfiguration =
    buildMerchantProductPublicationBusinessConfiguration({
      context: f.context,
      policy: f.policy,
      configurationReference: id(30),
      configurationRevision: 1,
    });
  let onHold: (() => Promise<void>) | undefined;
  let beforeCallback: (() => Promise<void>) | undefined;
  const options: MerchantProductPublicationBusinessPolicyOptions = {
    clock: { now: () => time },
    configurations: {
      async withCurrentConfiguration(actual, input, work) {
        holderCalls++;
        expect(actual).toBe(tx);
        expect(input.context.originalIntentDigest).toBe(f.context.originalIntentDigest);
        const held = config,
          digest = hash(held);
        const check = () => {
          if (!allowed || hash(config) !== digest)
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
        };
        await input.registerBeforeCommit(
          tx,
          async () => {
            check();
            await onHold?.();
            check();
          },
          () => {
            check();
          },
        );
        await beforeCallback?.();
        check();
        return work(held, tx);
      },
    },
  };
  const source = createMerchantProductPublicationBusinessPolicy(options),
    registerBeforeCommit: Input["registerBeforeCommit"] = async (actual, guard, finalAssert) => {
      expect(actual).toBe(tx);
      guards.push({
        guard,
        finalAssert:
          finalAssert ??
          (() => {
            throw new Error("missing final");
          }),
      });
    };
  const input: Input = { ...f, registerBeforeCommit };
  type Assessment = Parameters<Parameters<Policy["withAssessment"]>[2]>[0];
  function read(): Promise<Assessment>;
  function read<T>(work: (assessment: Assessment) => Promise<T>): Promise<T>;
  function read(work: (assessment: Assessment) => Promise<unknown> = async (value) => value) {
    return source.withAssessment(tx, input, work);
  }
  return {
    f,
    tx,
    input,
    source,
    options,
    read,
    guards,
    get config() {
      return config;
    },
    set config(v: MerchantProductPublicationBusinessConfiguration) {
      config = v;
    },
    get calls() {
      return holderCalls;
    },
    setTime(v: string) {
      time = v;
    },
    deny() {
      allowed = false;
    },
    onHold(fn: () => Promise<void>) {
      onHold = fn;
    },
    beforeCallback(fn: () => Promise<void>) {
      beforeCallback = fn;
    },
    async commit() {
      for (const g of guards) await g.guard();
      for (const g of guards) g.finalAssert();
    },
  };
}
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
function presence(f: ReturnType<typeof fixture>) {
  const current = f.references.current;
  current.pricing.priceEntries.push({
    priceBookReference: id(40),
    brandReference: id(2),
    aggregateVersion: 2,
    currentVersionReference: id(41),
    updatedAt: at,
    versionReference: id(41),
    versionNumber: 2,
    snapshotDigest: hash("price"),
    lifecycle: "Draft",
    createdAt: at,
    entryReference: id(42),
    sellableReference: id(5),
    scopeKind: "Brand",
    scopeReference: null,
    channelCode: null,
    orderType: null,
    timeZone: "UTC",
    effectiveFrom: plus(100000),
    effectiveUntil: null,
    isCurrentVersion: true,
    temporalStatus: "Future",
  });
  current.recipe.references.push({
    recipe: {
      recipeReference: id(50),
      brandReference: id(2),
      aggregateVersion: 1,
      currentVersionReference: id(51),
      updatedAt: at,
    },
    version: {
      recipeVersionReference: id(51),
      recipeReference: id(50),
      brandReference: id(2),
      versionNumber: 1,
      lifecycle: "Draft",
      snapshotDigest: hash("recipe"),
      effectiveFrom: plus(100000),
      effectiveUntil: null,
      timeZone: "UTC",
      createdAt: at,
    },
    isCurrentRecipeVersion: true,
    bindings: [
      {
        bindingReference: id(52),
        recipeVersionReference: id(51),
        recipeReference: id(50),
        brandReference: id(2),
        skuReference: id(5),
        storeReference: null,
        optionBindingReference: null,
        effectiveFrom: plus(100000),
        effectiveUntil: null,
      },
    ],
    modifiers: [],
  });
  current.inventory.references.push({
    mapping: {
      tenantReference: id(10),
      brandReference: id(2),
      mappingReference: id(60),
      itemReference: id(61),
      mappingVersion: 1,
      sourceItemVersion: 1,
      sourceConfigurationOperationReference: id(62),
      action: "Set",
      target: {
        productReference: id(1),
        productVersionReference: id(4),
        skuReference: id(5),
        catalogConfigurationDigest: current.referenceConfigurationDigest,
      },
      operationReference: id(63),
      mappingIntentDigest: hash("mapping"),
      occurredAt: at,
      current: true,
      sourceConfigurationState: "Current",
    },
    configurationMatch: "Matched",
    gaps: [],
  });
  current.menuReferences.push({
    review: {
      reviewReference: parseCatalogReference(id(70)),
      brandReference: parseCatalogReference(id(2)),
      menuReference: parseCatalogReference(id(71)),
      menuVersionReference: parseCatalogReference(id(72)),
      snapshotDigest: hash("menu"),
      createdAt: parseCatalogInstant(at),
    },
    placements: [
      {
        reviewReference: id(70),
        sectionReference: id(73),
        placementReference: id(74),
        productVersionReference: id(4),
        skuReference: id(5),
      },
    ],
    revisions: [],
    releases: [],
    periods: [],
    lifecycle: null,
  });
}

it("ordinary selected configuration yields four concrete missing-reference warnings, no implicit Pass", async () => {
  const h = harness(),
    result = await h.read();
  expect(result).toMatchObject({
    checks: [
      { code: "EffectivePeriod", outcome: "Pass" },
      { code: "ChangeImpact", outcome: "Warning" },
    ],
  });
  expect(result).toHaveProperty(
    "findings",
    expect.arrayContaining(
      ["PRICING", "RECIPE", "INVENTORY", "MENU"].map((domain) =>
        expect.objectContaining({
          checkCode: "ChangeImpact",
          outcome: "Warning",
          reasonCode: `REQUIRED_${domain}_REFERENCE_MISSING`,
          subjectReference: id(5),
        }),
      ),
    ),
  );
  await h.commit();
  expect(h.calls).toBe(1);
});
it.each([
  [604800000, "Pass"],
  [604800001, "HardError"],
] as const)(
  "uses server observation and inclusive seven-day boundary: %i",
  async (backdate, outcome) => {
    const h = harness(fixture(plus(-backdate)));
    const result = await h.read();
    expect(result.checks[0]).toEqual({ code: "EffectivePeriod", outcome });
    await h.commit();
  },
);
it("recognizes actual stored base rows without demanding Published or currently effective sale configuration", async () => {
  const f = fixture();
  presence(f);
  const h = harness(f);
  expect(await h.read()).toMatchObject({
    checks: [{ outcome: "Pass" }, { outcome: "Pass" }],
    findings: [],
  });
  await h.commit();
});
it.each(["Pricing", "Recipe", "Inventory", "Menu"] as const)(
  "does not count a removed %s relationship",
  async (domain) => {
    const f = fixture();
    presence(f);
    const c = f.references.current;
    if (domain === "Pricing") {
      const row = c.pricing.priceEntries[0];
      if (!row) throw new Error("fixture");
      row.isCurrentVersion = false;
    }
    if (domain === "Recipe") {
      const row = c.recipe.references[0];
      if (!row) throw new Error("fixture");
      row.version.lifecycle = "Archived";
    }
    if (domain === "Inventory") {
      const row = c.inventory.references[0];
      if (!row) throw new Error("fixture");
      row.mapping.current = false;
      c.inventory.clears.push({
        ...row.mapping,
        action: "Clear",
        current: true,
        target: null,
        operationReference: id(64),
        mappingVersion: 2,
      });
    }
    if (domain === "Menu")
      c.menuReferences[0] = {
        ...(c.menuReferences[0] ??
          (() => {
            throw new Error("fixture");
          })()),
        lifecycle: { state: "Archived", version: 1, changedAt: parseCatalogInstant(at) },
      };
    const h = harness(f);
    expect(await h.read()).toHaveProperty("findings", [
      expect.objectContaining({
        reasonCode: `REQUIRED_${domain.toUpperCase()}_REFERENCE_MISSING`,
        outcome: "Warning",
      }),
    ]);
  },
);
it("does not infer Product-level price inheritance or an Option recipe as a base SKU configuration", async () => {
  const f = fixture();
  presence(f);
  const price = f.references.current.pricing.priceEntries[0],
    recipe = f.references.current.recipe.references[0]?.bindings[0];
  if (!price || !recipe) throw new Error("fixture");
  price.sellableReference = id(1);
  recipe.optionBindingReference = id(90);
  const result = await harness(f).read();
  expect(result).toHaveProperty("findings", [
    expect.objectContaining({ reasonCode: "REQUIRED_PRICING_REFERENCE_MISSING" }),
    expect.objectContaining({ reasonCode: "REQUIRED_RECIPE_REFERENCE_MISSING" }),
  ]);
});
it("keeps explicit configurable errors and skips instead of treating them as ordinary defaults", async () => {
  const h = harness();
  h.config = {
    ...h.config,
    requirements: [
      {
        skuReference: id(5),
        Pricing: "RequiredError",
        Recipe: "NotRequired",
        Inventory: "NotRequired",
        Menu: "NotRequired",
      },
    ],
  };
  expect(await h.read()).toMatchObject({
    checks: [{ outcome: "Pass" }, { outcome: "HardError" }],
    findings: [
      expect.objectContaining({
        reasonCode: "REQUIRED_PRICING_REFERENCE_MISSING",
        outcome: "HardError",
      }),
    ],
  });
});
it("empty Active SKU set has empty requirements; PublishableSku remains another check", async () => {
  const h = harness(fixture(at, false));
  expect(h.config.requirements).toEqual([]);
  expect(await h.read()).toMatchObject({ findings: [] });
});
it.each(["missing", "extra", "duplicate", "scope", "policy", "basis", "backdate"])(
  "rejects malformed/incomplete configuration: %s",
  async (kind) => {
    const h = harness(),
      config = structuredClone(h.config) as Mutable<typeof h.config>;
    if (kind === "missing") config.requirements = [];
    if (kind === "extra")
      config.requirements.push({
        skuReference: id(98),
        Pricing: "NotRequired",
        Recipe: "NotRequired",
        Inventory: "NotRequired",
        Menu: "NotRequired",
      });
    if (kind === "duplicate") {
      const row = config.requirements[0];
      if (!row) throw new Error("fixture");
      config.requirements.push(row);
    }
    if (kind === "scope") config.brandReference = id(99);
    if (kind === "policy") config.policyVersion = 2;
    if (kind === "basis") Object.assign(config, { matchingBasis: "CurrentSaleEligibility" });
    if (kind === "backdate") Object.assign(config, { backdateMaximumMilliseconds: 7 });
    h.config = config;
    const work = vi.fn();
    await expect(h.read(work)).rejects.toMatchObject(unavailable);
    expect(work).not.toHaveBeenCalled();
    await expect(h.commit()).rejects.toMatchObject(unavailable);
  },
);
it("unknown unrelated Inventory items do not turn into missing Product facts", async () => {
  const f = fixture();
  f.references.current.inventory.unresolvedItemCoverage.push({
    itemReference: id(88),
    currentMappingReference: null,
    currentMappingVersion: null,
    coverage: "NotRecorded",
    currentLink: "Unknown",
  });
  expect(await harness(f).read()).toMatchObject({
    checks: [{ outcome: "Pass" }, { outcome: "Warning" }],
  });
});
it("an unresolved related mapping cannot become an empty warning report", async () => {
  const f = fixture();
  presence(f);
  const row = f.references.current.inventory.references[0];
  if (!row) throw new Error("fixture");
  row.configurationMatch = "Unresolved";
  row.gaps = ["ConfigurationDigestChanged"];
  await expect(harness(f).read()).rejects.toMatchObject(unavailable);
});
it("a relation matching a recorded exact configuration is not an unknown historical relation", async () => {
  const f = fixture();
  presence(f);
  const row = f.references.current.inventory.references[0],
    old = f.references.recorded[0];
  if (!row || !old) throw new Error("fixture");
  old.inventory.references.push(structuredClone(row));
  row.configurationMatch = "Unresolved";
  row.gaps = ["ConfigurationDigestChanged"];
  expect(await harness(f).read()).toHaveProperty("findings", [
    expect.objectContaining({ reasonCode: "REQUIRED_INVENTORY_REFERENCE_MISSING" }),
  ]);
});
it("checks current authority and immutable configuration again in the commit phase", async () => {
  const h = harness();
  await h.read();
  h.deny();
  await expect(h.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("later async guard expiry is caught by the global synchronous final phase", async () => {
  const h = harness();
  await h.read();
  for (const g of h.guards) await g.guard();
  h.setTime(until);
  expect(() => h.guards[0]?.finalAssert()).toThrowError();
});
it("cannot renew the configuration lease or swallow a reentry failure", async () => {
  const h = harness();
  h.config = { ...h.config, validUntil: plus(6000) };
  await expect(h.read()).rejects.toMatchObject(unavailable);
  const other = harness();
  await expect(
    other.read(async () => {
      await other.read().catch(() => undefined);
      return true;
    }),
  ).rejects.toMatchObject(unavailable);
  await expect(other.commit()).rejects.toMatchObject(unavailable);
});
it("captures ports before awaiting and preserves the actual consumer conflict", async () => {
  const h = harness();
  h.options.configurations.withCurrentConfiguration = async () => {
    throw new Error("replacement");
  };
  const conflict = new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  await expect(
    h.read(async () => {
      throw conflict;
    }),
  ).rejects.toBe(conflict);
});
it("pins query identity and poisons clock failure even if the holder catches it", async () => {
  const h = harness();
  h.beforeCallback(async () => {
    h.tx.query = vi.fn(async () => ({ rows: [] }));
  });
  await expect(h.read()).rejects.toMatchObject(unavailable);
  const bad = harness();
  bad.setTime(plus(-1));
  await expect(bad.read()).rejects.toMatchObject(unavailable);
  bad.setTime(at);
  await expect(bad.commit()).rejects.toMatchObject(unavailable);
});
it("does not run consumer before the configuration holder registers its commit obligation", async () => {
  const h = harness(),
    source = createMerchantProductPublicationBusinessPolicy({
      clock: { now: () => at },
      configurations: {
        withCurrentConfiguration: (tx, input, work) => {
          void input;
          return work(h.config, tx);
        },
      },
    });
  const work = vi.fn();
  await expect(source.withAssessment(h.tx, h.input, work)).rejects.toMatchObject(unavailable);
  expect(work).not.toHaveBeenCalled();
});
it("server-relative semantics do not hash each observation's moving lower bound", async () => {
  const h = harness(),
    first = await h.read();
  const later = harness();
  later.config = { ...later.config, configurationRevision: 2, observedAt: plus(1) };
  later.setTime(plus(1));
  const second = await later.read();
  expect(first.sources[0]?.relevantReferenceDigest).toBe(
    second.sources[0]?.relevantReferenceDigest,
  );
  expect(first.sources[0]?.sourceDigest).not.toBe(second.sources[0]?.sourceDigest);
});
it("keeps a current Set that pins a historical Item configuration", async () => {
  const f = fixture();
  presence(f);
  const row = f.references.current.inventory.references[0];
  if (!row) throw new Error("fixture");
  row.mapping.sourceConfigurationState = "Historical";
  expect(await harness(f).read()).toMatchObject({ findings: [] });
});
it("does not classify recorded configurations for a Discontinued SKU as an Active SKU requirement", async () => {
  const f = fixture(at, true, "Discontinued");
  presence(f);
  const h = harness(f);
  expect(h.config.requirements).toEqual([]);
  expect(await h.read()).toMatchObject({ findings: [] });
});
it("current configuration denial takes precedence over an earlier consumer conflict", async () => {
  const h = harness(),
    denied = new CatalogError("CATALOG_PERMISSION_DENIED"),
    conflict = new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  const source = createMerchantProductPublicationBusinessPolicy({
    clock: { now: () => at },
    configurations: {
      async withCurrentConfiguration(tx, input, work) {
        await input.registerBeforeCommit(
          tx,
          async () => {
            throw denied;
          },
          () => {
            throw denied;
          },
        );
        try {
          return await work(h.config, tx);
        } catch {
          throw denied;
        }
      },
    },
  });
  await expect(
    source.withAssessment(h.tx, h.input, async () => {
      throw conflict;
    }),
  ).rejects.toBe(denied);
});
