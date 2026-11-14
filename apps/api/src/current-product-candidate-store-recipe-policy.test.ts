import { it, expect, vi, beforeEach } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  bindCatalogProductValidationCandidate,
  deriveCatalogProductPublicationContentIdentity,
  parseProductAggregate,
  productValidationCandidateFields,
  CatalogError,
  type ProductPublicationCommand,
} from "@rms/catalog";
import { buildRecipeReferenceSourceSnapshot, recipeReferenceSourceFields } from "@rms/recipe";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRaw as raw,
} from "../../../packages/rms/recipe/src/tests/recipe-catalog-reference-matches.fixture.js";
import { createCurrentProductCandidateStoreRecipePolicySource as create } from "./current-product-candidate-store-recipe-policy.js";
const protocol = vi.hoisted(() => ({
  catalog: vi.fn(),
  recipe: vi.fn(),
  stores: vi.fn(),
  brand: vi.fn(),
  publishing: vi.fn(),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductValidationCandidateSource: protocol.catalog,
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createPostgresRecipeReferenceSourceStore: protocol.recipe,
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresTenantStoreReferenceSource: protocol.stores,
  createPostgresTenantBrandConfigurationContentSource: protocol.brand,
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: protocol.publishing,
}));
import {
  tenantBrandConfigurationContentDigest,
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationRequiredFields,
} from "@bop/tenant";
type Options = Parameters<typeof create>[0];
type Tx = Parameters<ReturnType<typeof create>["withCurrentResolution"]>[0];
function aggregate() {
  return parseProductAggregate({
    productReference: id(3),
    brandReference: id(1),
    internalCode: "SYNTHETIC_CANDIDATE81",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 2,
    createdAt: at,
    createdByActorReference: id(2),
    updatedAt: at,
    draft: {
      versionReference: id(5),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": changed ? "Changed" : "Synthetic candidate" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      skus: [
        {
          skuReference: id(6),
          productReference: id(3),
          brandReference: id(1),
          skuCode: "SYNTHETIC_ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(2),
        },
      ],
      optionBindings: [
        {
          bindingReference: id(20),
          optionSetReference: id(70),
          optionSetVersionReference: id(71),
          purpose: "CUSTOMIZATION",
          sortOrder: 0,
          enabledOptionReferences: [id(80)],
          defaultSelections: [],
          minimumSelectionOverride: null,
          maximumSelectionOverride: null,
          includedSkuReferences: [],
          excludedSkuReferences: [],
          channelCodes: [],
          storeOverrideAllowed: false,
        },
      ],
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
        optionRules: [
          {
            bindingReference: id(20),
            versionResolution: "Pinned",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          },
        ],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
}
function command(): ProductPublicationCommand {
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate());
  return {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(9),
    brandReference: id(1),
    actorReference: id(2),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(3),
    versionReference: id(5),
    expectedProductAggregateVersion: 2,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: "2026-09-30T00:00:00.000Z",
        localDateTime: "2026-09-30T00:00:00.000",
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    reasonCode: "SYNTHETIC",
    occurredAt: at,
  };
}
const input = () => ({
  command: command(),
  storeReference: id(99),
  configurationVersionReference: id(100),
  expectedBrandVersion: 1,
});
let admittedCommand: ProductPublicationCommand;
let topologyMode = "Active",
  recipeMode = "StoreOverride";
let clock: string,
  changed: boolean,
  denied: boolean,
  duplicate: boolean,
  wrongResult: boolean,
  holds: number,
  storeDenied: boolean,
  storeChanged: boolean,
  storeDuplicate: boolean,
  storeWrongResult: boolean;
let brandDenied = false,
  brandChanged = false,
  publicationChanged = false,
  publicationUnavailable = false,
  brandDuplicate = false,
  brandWrongResult = false,
  allowOverride = true,
  hardRequirement = false;
function configuration() {
  return {
    configurationVersionReference: id(100),
    brandReference: id(1),
    configurationVersion: 1,
    lifecycle: "Published",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    mediaThemeReference: null,
    catalogSourceReference: id(101),
    platformTemplateReference: id(102),
    overrideAllowedFieldCodes: allowOverride && !hardRequirement ? ["RECIPE.VERSION"] : [],
    hardRequirementFieldCodes: hardRequirement ? ["RECIPE.VERSION"] : [],
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: "2026-10-01T00:00:00.000Z",
    supersedesVersionReference: null,
    reasonCode: brandChanged ? "SYNTHETIC_CHANGED" : "SYNTHETIC",
    authoredByReference: id(2),
    approvedByReference: id(103),
    approvalEvidenceReference: id(104),
    publicationReference: id(105),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
}
const tx: Tx = { query: vi.fn(async () => ({ rows: [] })) };
function options(): Options {
  return {
    tenantReference: id(9),
    brandReference: id(1),
    actorReference: id(2),
    clock: { now: () => clock },
    brandAuthority: {
      async withCurrentContentRead(r, fields, work) {
        expect(r.originalIntentDigest).toBe(
          "sha256:" + sha256Hex(canonicalizeRfc8785(admittedCommand)),
        );
        expect(fields).toBe(tenantBrandConfigurationRequiredFields);
        if (brandDenied) throw new Error("synthetic Brand denial");
        return work();
      },
      async isCurrent(actual) {
        expect(actual).toBe(tx);
        return !brandDenied;
      },
    },
    storeAuthority: {
      async withCurrentBrandReferenceRead(r, work) {
        expect(r.purposeCode).toBe("CATALOG_PRODUCT_RECIPE_STORE_RESOLUTION");
        expect(r.originalIntentDigest).toBe(
          "sha256:" + sha256Hex(canonicalizeRfc8785(admittedCommand)),
        );
        if (storeDenied) throw new Error("synthetic Store denial");
        return work();
      },
      async isCurrent(actual) {
        expect(actual).toBe(tx);
        return !storeDenied;
      },
    },
    candidateAuthority: {
      async holdUntilTransactionCompletes(actual) {
        expect(actual).toBe(tx);
        holds++;
        if (denied) throw new Error("synthetic fields revoked");
      },
    },
    recipeAuthority: {
      async holdUntilTransactionCompletes(actual) {
        expect(actual).toBe(tx);
        holds++;
        if (denied) throw new Error("synthetic recipe revoked");
      },
    },
  };
}
beforeEach(() => {
  clock = at;
  topologyMode = "Active";
  recipeMode = "StoreOverride";
  brandDenied =
    brandChanged =
    publicationChanged =
    publicationUnavailable =
    brandDuplicate =
    brandWrongResult =
    hardRequirement =
      false;
  allowOverride = true;
  protocol.brand.mockImplementation(
    (
      o: Parameters<
        typeof import("@bop/tenant").createPostgresTenantBrandConfigurationContentSource
      >[0],
    ) => ({
      async withRecordedConfiguration(
        r: import("@bop/tenant").TenantBrandConfigurationContentRequest,
        work: (
          v: import("@bop/tenant").TenantRecordedBrandConfiguration,
          t: import("@bop/tenant").TenantBrandConfigurationTransaction,
        ) => Promise<unknown>,
      ) {
        return o.authority.withCurrentContentRead(r, tenantBrandConfigurationRequiredFields, () =>
          o.transactions.run(async (actual) => {
            if (
              !(await o.authority.isCurrent(actual, r, tenantBrandConfigurationRequiredFields)) ||
              r.expectedBrandVersion !== 1 ||
              r.configurationVersionReference !== id(100)
            )
              throw new Error("synthetic Brand unavailable");
            const c = configuration();
            const value = {
              profile: "TenantRecordedBrandConfigurationV1" as const,
              configuration: parseTenantRecordedBrandConfiguration(c),
              brandVersion: 1,
              contentDigest: tenantBrandConfigurationContentDigest(c),
              observedAt: r.observedAt,
              validUntil: r.validUntil,
              currentPublication: "NotEvaluated" as const,
            };
            const answer = await work(value, actual);
            if (brandDuplicate) await work(value, actual);
            if (!(await o.authority.isCurrent(actual, r, tenantBrandConfigurationRequiredFields)))
              throw new Error("synthetic Brand revoked");
            return brandWrongResult ? {} : answer;
          }),
        );
      },
    }),
  );
  protocol.publishing.mockImplementation(() => ({
    async resolveCurrentReleaseForReference() {
      if (publicationUnavailable) throw new Error("synthetic archived release");
      const c = configuration();
      return {
        recorded: {
          release: {
            snapshotReference: c.configurationVersionReference,
            snapshotDigest: tenantBrandConfigurationContentDigest(c),
            createdAt: at,
          },
          validationEvidence: { checkedAt: at },
          approvalEvidence: {
            approvedAt: at,
            evidenceReference: c.approvalEvidenceReference,
            approvedActorReference: c.approvedByReference,
          },
        },
        current: { release: { releaseId: id(publicationChanged ? 106 : 105) } },
      };
    },
  }));
  changed = denied = duplicate = wrongResult = false;
  admittedCommand = command();
  holds = 0;
  storeDenied = storeChanged = storeDuplicate = storeWrongResult = false;
  tx.query = vi.fn(async () => ({ rows: [] }));
  protocol.stores.mockImplementation(
    (o: Parameters<typeof import("@bop/tenant").createPostgresTenantStoreReferenceSource>[0]) => ({
      async withCurrentSnapshot(
        r: import("@bop/tenant").TenantStoreReferenceRequest,
        work: (v: import("@bop/tenant").TenantStoreReferenceSnapshot) => Promise<unknown>,
      ) {
        return o.authority.withCurrentBrandReferenceRead(r, () =>
          o.transactions.run(async (actual) => {
            if (!(await o.authority.isCurrent(actual, r)))
              throw new Error("synthetic Store current denial");
            const value: import("@bop/tenant").TenantStoreReferenceSnapshot = {
              profile: "TenantStoreReferenceV1",
              brandReference: id(1),
              brandLifecycle: topologyMode === "InactiveBrand" ? "Suspended" : "Active",
              brandVersion: "1",
              generation: "7",
              referenceCount: "1",
              originalIntentDigest: r.originalIntentDigest,
              observedAt: r.observedAt,
              references: [
                {
                  storeReference: id(topologyMode === "UnknownStore" ? 98 : 99),
                  lifecycle: topologyMode === "InactiveStore" ? "Suspended" : "Active",
                  version: "1",
                  createdAt: at,
                  updatedAt: at,
                },
              ],
            };
            const result = await work(value);
            if (storeDuplicate) await work(value);
            if (!(await o.authority.isCurrent(actual, r)) || storeChanged)
              throw new Error("synthetic Store source changed");
            return storeWrongResult ? {} : result;
          }),
        );
      },
    }),
  );
  protocol.catalog.mockImplementation(
    (
      o: Parameters<
        typeof import("@rms/catalog").createPostgresProductValidationCandidateSource
      >[0],
    ) => ({
      async withCurrentCandidate(
        r: unknown,
        work: (v: ReturnType<typeof syntheticCurrentCandidate>, actual: Tx) => Promise<unknown>,
      ) {
        return o.transactions.run(async (actual) => {
          const hold = () =>
            o.authority.holdUntilTransactionCompletes(actual, {
              tenantReference: id(9),
              brandReference: id(1),
              actorReference: id(2),
              actorKind: "User",
              productReference: id(3),
              purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
              owningAction: "catalog.product.validate",
              permission: "catalog.manage",
              requiredFields: productValidationCandidateFields,
              observedAt: o.clock.now(),
            });
          await hold();
          const result = await work(
            syntheticCurrentCandidate(r, aggregate(), o.clock.now()),
            actual,
          );
          if (duplicate)
            await work(syntheticCurrentCandidate(r, aggregate(), o.clock.now()), actual);
          await hold();
          return wrongResult ? {} : result;
        });
      },
    }),
  );
  protocol.recipe.mockImplementation(
    (o: Parameters<typeof import("@rms/recipe").createPostgresRecipeReferenceSourceStore>[0]) => ({
      async withCurrentSnapshot(
        r: Parameters<typeof buildRecipeReferenceSourceSnapshot>[1],
        work: (v: ReturnType<typeof buildRecipeReferenceSourceSnapshot>) => Promise<unknown>,
      ) {
        return o.transactions.run(async (actual) => {
          const hold = () =>
            o.authority.holdUntilTransactionCompletes(actual, {
              tenantReference: id(9),
              request: r,
              observedAt: o.clock.now(),
              requiredFields: recipeReferenceSourceFields,
              permission: "recipe.manage",
              requiredScope: "FullBrandScope",
            });
          await hold();
          const v = raw();
          v.bindings = v.bindings.slice(0, 1);
          const binding = v.bindings[0];
          if (!binding) throw new Error("missing synthetic binding");
          binding.storeReference = recipeMode === "BrandDefault" ? null : id(99);
          if (recipeMode === "Stale") {
            const root = v.recipes[0];
            if (!root) throw new Error("missing root");
            root.currentVersionReference = id(12);
          }
          binding.effectiveFrom = "2026-08-01T00:00:00.000Z";
          if (recipeMode === "Ambiguous") {
            v.bindings.push({ ...binding, bindingReference: id(63) });
          }
          for (const version of v.versions) {
            version.lifecycle = "Published";
            version.effectiveFrom = "2026-08-01T00:00:00.000Z";
          }
          v.modifiers = [];
          v.bindingCount = String(v.bindings.length);
          v.counts.bindings = String(v.bindings.length);
          v.counts.modifiers = "0";
          const result = await work(buildRecipeReferenceSourceSnapshot(v, r, at));
          await hold();
          return result;
        });
      },
    }),
  );
});
const deniedError = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("directly constructs all owning public readers including actual-format current Brand/Publishing proof on the original transaction with original intent, deadline and final current read", async () => {
  const r = await create(options()).withCurrentResolution(tx, input(), async (a) => a);
  expect(r.profile).toBe("CurrentProductCandidateStoreRecipePolicyV1");
  expect(r.recipe.eligibility).toBe("NotEvaluated");
  expect(r.recipe.decision).toBe("PassForDirectBrandAndStoreBindings");
  expect(r.recipe.resolutions[0]?.recipeVersionReference).toBe(id(11));
  expect(r.publishValidation).toBe("Incomplete");
  expect(r.validUntil).toBe("2026-09-29T12:00:05.000Z");
  expect(holds).toBe(6);
  expect(r.recipe.resolutions[0]?.source).toBe("StoreOverride");
  expect(r.recipe.overridePolicy?.currentPublicationReference).toBe(id(105));
  expect(protocol.publishing).toHaveBeenCalledTimes(2);
  const { digest, ...body } = r;
  expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
});
it.each(["fields", "query", "expiry", "backward", "graph", "duplicate", "result"])(
  "refuses late %s after callback",
  async (kind) => {
    const provider = create(options());
    let reached = false;
    await expect(
      provider.withCurrentResolution(tx, input(), async () => {
        reached = true;
        if (kind === "fields") denied = true;
        if (kind === "query") tx.query = vi.fn(async () => ({ rows: [] }));
        if (kind === "expiry") clock = "2026-09-29T12:00:05.000Z";
        if (kind === "backward") clock = "2026-09-29T11:59:59.999Z";
        if (kind === "graph") changed = true;
        if (kind === "duplicate") duplicate = true;
        if (kind === "result") wrongResult = true;
        return "answer";
      }),
    ).rejects.toThrow(deniedError);
    expect(reached).toBe(true);
  },
);
it("caught recursive admission poisons the outer transaction", async () => {
  const p = create(options());
  await expect(
    p.withCurrentResolution(tx, input(), async () => {
      await expect(p.withCurrentResolution(tx, input(), async () => "nested")).rejects.toThrow(
        deniedError,
      );
      return "outer";
    }),
  ).rejects.toThrow(deniedError);
});
it.each([
  "target",
  "Ready",
  "tenant",
  "wrongActor",
  "wrongBrand",
  "past",
  "long",
  "futureObservation",
])("rejects %s before work", async (kind) => {
  let v: unknown = input();
  if (kind === "target") v = { ...input(), target: {} };
  if (kind === "Ready") v = { ...input(), Ready: true };
  if (kind === "tenant") v = { ...input(), tenantReference: id(10) };
  if (kind === "wrongActor") v = { ...input(), command: { ...command(), actorReference: id(10) } };
  if (kind === "wrongBrand") v = { ...input(), command: { ...command(), brandReference: id(10) } };
  if (kind === "past") v = { ...input(), validUntil: at };
  if (kind === "long") v = { ...input(), validUntil: "2026-09-29T12:00:30.001Z" };
  if (kind === "futureObservation") v = { ...input(), observedAt: "2026-09-29T12:00:00.001Z" };
  const work = vi.fn(async () => true);
  await expect(create(options()).withCurrentResolution(tx, v, work)).rejects.toThrow(deniedError);
  expect(work).not.toHaveBeenCalled();
});
it("captures clock/holders and keeps the shortest owning deadline", async () => {
  const o = options(),
    p = create(o);
  o.clock.now = () => {
    throw new Error("replaced");
  };
  o.candidateAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replaced");
  };
  const r = await p.withCurrentResolution(tx, input(), async (r) => r);
  expect(r.validUntil).toBe("2026-09-29T12:00:05.000Z");
});

it.each(["Store fields", "Store generation", "Store duplicate", "Store result"])(
  "refuses late %s on the original UoW",
  async (kind) => {
    let reached = false;
    await expect(
      create(options()).withCurrentResolution(tx, input(), async () => {
        reached = true;
        if (kind === "Store fields") storeDenied = true;
        if (kind === "Store generation") storeChanged = true;
        if (kind === "Store duplicate") storeDuplicate = true;
        if (kind === "Store result") storeWrongResult = true;
        return "tentative";
      }),
    ).rejects.toThrow(deniedError);
    expect(reached).toBe(true);
  },
);
it("does not accept a caller-provided Store override policy", async () => {
  await expect(
    create(options()).withCurrentResolution(
      tx,
      { ...input(), overridePolicy: { Ready: true } },
      async () => "bad",
    ),
  ).rejects.toThrow(deniedError);
});

it.each([
  "Brand fields",
  "Brand content",
  "current publication",
  "Archive",
  "Brand duplicate",
  "Brand result",
])("refuses late %s after independently reached callback", async (kind) => {
  let reached = false;
  await expect(
    create(options()).withCurrentResolution(tx, input(), async () => {
      reached = true;
      if (kind === "Brand fields") brandDenied = true;
      if (kind === "Brand content") brandChanged = true;
      if (kind === "current publication") publicationChanged = true;
      if (kind === "Archive") publicationUnavailable = true;
      if (kind === "Brand duplicate") brandDuplicate = true;
      if (kind === "Brand result") brandWrongResult = true;
      return "tentative";
    }),
  ).rejects.toThrow(deniedError);
  expect(reached).toBe(true);
});
it.each(["not allowed", "hard requirement"])(
  "returns no selected override when current policy is %s",
  async (kind) => {
    allowOverride = false;
    hardRequirement = kind === "hard requirement";
    const result = await create(options()).withCurrentResolution(tx, input(), async (v) => v);
    expect(result.recipe.resolutions[0]?.status).toBe("StoreOverrideDenied");
    expect(result.recipe.resolutions[0]?.recipeVersionReference).toBeNull();
  },
);
it.each(["expected Brand revision", "unknown configuration", "unpublished current source"])(
  "refuses %s before work",
  async (kind) => {
    const value = input();
    if (kind === "expected Brand revision") value.expectedBrandVersion = 2;
    if (kind === "unknown configuration") value.configurationVersionReference = id(110);
    if (kind === "unpublished current source") publicationUnavailable = true;
    const work = vi.fn(async () => true);
    await expect(create(options()).withCurrentResolution(tx, value, work)).rejects.toThrow(
      deniedError,
    );
    expect(work).not.toHaveBeenCalled();
  },
);
it("captures Brand authority methods and never accepts their later substitution", async () => {
  const o = options(),
    p = create(o);
  o.brandAuthority.withCurrentContentRead = async () => {
    throw new Error("replaced");
  };
  o.brandAuthority.isCurrent = async () => false;
  const result = await p.withCurrentResolution(tx, input(), async (v) => v);
  expect(result.recipe.decision).toBe("PassForDirectBrandAndStoreBindings");
});

it.each([
  "wrong Tenant",
  "non Validate",
  "System Actor",
  "out of Store scope",
  "filtered Brand",
  "Store Group",
  "supplied SKU",
  "supplied current policy",
])("refuses unsupported or forged context %s before sources", async (kind) => {
  const v = input();
  let value: unknown = v;
  if (kind === "wrong Tenant") value = { ...v, command: { ...v.command, tenantReference: id(98) } };
  if (kind === "non Validate") value = { ...v, command: { ...v.command, action: "SubmitReview" } };
  if (kind === "System Actor") value = { ...v, command: { ...v.command, actorKind: "System" } };
  if (kind === "out of Store scope")
    value = {
      ...v,
      command: {
        ...v.command,
        scopeSet: [{ level: "Store", reference: id(98), channelCodes: [], orderTypeCodes: [] }],
      },
    };
  if (kind === "filtered Brand")
    value = {
      ...v,
      command: {
        ...v.command,
        scopeSet: [
          { level: "Brand", reference: null, channelCodes: ["ONLINE"], orderTypeCodes: [] },
        ],
      },
    };
  if (kind === "Store Group")
    value = {
      ...v,
      command: {
        ...v.command,
        scopeSet: [
          { level: "StoreGroup", reference: id(98), channelCodes: [], orderTypeCodes: [] },
        ],
      },
    };
  if (kind === "supplied SKU") value = { ...v, skuReference: id(6) };
  if (kind === "supplied current policy") value = { ...v, overridePolicy: { Ready: true } };
  const work = vi.fn();
  await expect(create(options()).withCurrentResolution(tx, value, work)).rejects.toThrow(
    deniedError,
  );
  expect(work).not.toHaveBeenCalled();
  expect(protocol.catalog).not.toHaveBeenCalled();
});
it("binds the full original Validate command and exact Store scope, without fabricated lifecycle request or client timestamps", async () => {
  const initial = input();
  const v = {
    ...initial,
    command: {
      ...initial.command,
      scopeSet: [
        { level: "Store" as const, reference: id(99), channelCodes: [], orderTypeCodes: [] },
      ],
    },
  };
  admittedCommand = v.command;
  const r = await create(options()).withCurrentResolution(tx, v, async (a) => a);
  expect(r.productReference).toBe(id(3));
  expect(r.versionReference).toBe(id(5));
  expect(r.aggregateVersion).toBe(2);
  expect(r.originalIntentDigest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(v.command)));
  expect(r.configurationDigest).toBe(v.command.configurationDigest);
  expect(r.recipe.activationAt).toBe(v.command.effectivePeriod.effectiveFrom.instant);
  expect(r.candidateValidUntil).toBe("2026-09-29T12:00:30.000Z");
  expect(r).not.toHaveProperty("aggregate");
});
it("preserves current trusted Candidate permission denial and poisons the failed transaction", async () => {
  const o = options();
  let revoke = false;
  o.candidateAuthority.holdUntilTransactionCompletes = async (actual) => {
    expect(actual).toBe(tx);
    if (revoke) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  };
  const p = create(o);
  await expect(
    p.withCurrentResolution(tx, input(), async () => {
      revoke = true;
      return {};
    }),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  await expect(p.withCurrentResolution(tx, input(), vi.fn())).rejects.toThrow(deniedError);
});

it("uses a current Brand default when no exact Store override exists, even when overrides are forbidden", async () => {
  recipeMode = "BrandDefault";
  allowOverride = false;
  const r = await create(options()).withCurrentResolution(tx, input(), async (a) => a);
  expect(r.recipe.resolutions[0]?.status).toBe("ResolvedStoredVersion");
  expect(r.recipe.resolutions[0]?.source).toBe("BrandDefault");
  expect(r.recipe.resolutions[0]?.recipeVersionReference).toBe(id(11));
});
it.each([
  "UnknownStore",
  "InactiveStore",
  "InactiveBrand",
  "AmbiguousRecipeBinding",
  "StaleRecipeVersion",
])("does not select a Recipe for current %s", async (status) => {
  if (status === "AmbiguousRecipeBinding") recipeMode = "Ambiguous";
  else if (status === "StaleRecipeVersion") recipeMode = "Stale";
  else topologyMode = status;
  const r = await create(options()).withCurrentResolution(tx, input(), async (a) => a);
  expect(r.recipe.resolutions[0]?.status).toBe(status);
  expect(r.recipe.resolutions[0]?.recipeVersionReference).toBeNull();
  expect(r.eligibility).toBe("NotEvaluated");
  expect(r.publishValidation).toBe("Incomplete");
});

// Explicit synthetic owner-source fixture; pure content binding proves no code uniqueness.
function syntheticCurrentCandidate(
  ...args: Parameters<typeof bindCatalogProductValidationCandidate>
) {
  return Object.freeze({
    ...bindCatalogProductValidationCandidate(...args),
    internalCodeCheck: Object.freeze({ code: "InternalCode" as const, outcome: "Pass" as const }),
  });
}

it.each(["missing", "warning", "extra"])(
  "refuses malformed actual-current code member %s before Store Recipe consumer work",
  async (kind) => {
    protocol.catalog.mockImplementation(
      (
        o: Parameters<
          typeof import("@rms/catalog").createPostgresProductValidationCandidateSource
        >[0],
      ) => ({
        async withCurrentCandidate(
          value: unknown,
          work: (v: ReturnType<typeof syntheticCurrentCandidate>, actual: Tx) => Promise<unknown>,
        ) {
          return o.transactions.run((actual) => {
            const candidate = { ...syntheticCurrentCandidate(value, aggregate(), o.clock.now()) };
            if (kind === "missing") Reflect.deleteProperty(candidate, "internalCodeCheck");
            else
              Object.assign(candidate, {
                internalCodeCheck: {
                  code: "InternalCode",
                  outcome: kind === "warning" ? "Warning" : "Pass",
                  ...(kind === "extra" ? { extra: true } : {}),
                },
              });
            return work(candidate, actual);
          });
        },
      }),
    );
    const work = vi.fn(async () => true);
    await expect(create(options()).withCurrentResolution(tx, input(), work)).rejects.toThrow(
      deniedError,
    );
    expect(work).not.toHaveBeenCalled();
  },
);
