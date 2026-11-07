import { it, expect, vi, beforeEach } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildProductPricingBindingSourceSnapshot,
  productPricingBindingCurrentSourceFields,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import { buildRecipeReferenceSourceSnapshot } from "@rms/recipe";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRaw as raw,
} from "../../../packages/rms/recipe/src/tests/recipe-catalog-reference-matches.fixture.js";
import { createCurrentProductStoreRecipePolicySource as create } from "./current-product-store-recipe-policy.js";
const protocol = vi.hoisted(() => ({
  catalog: vi.fn(),
  recipe: vi.fn(),
  stores: vi.fn(),
  brand: vi.fn(),
  publishing: vi.fn(),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductPricingBindingSourceStore: protocol.catalog,
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
} from "@bop/tenant";
type Options = Parameters<typeof create>[0];
type Tx = Parameters<ReturnType<typeof create>["withCurrentResolution"]>[0];
const request: ProductLifecycleReviewRequest = {
  purposeCode: "CATALOG_LIFECYCLE_REVIEW",
  brandReference: id(1),
  actorReference: id(2),
  productReference: id(3),
  skuReference: null,
  operationReference: id(4),
  expectedAggregateVersion: 2,
  originalProductVersionReference: id(5),
  beforeLifecycle: "Draft",
  targetLifecycle: "Archived",
  reasonCode: "SYNTHETIC",
  activeSkuCount: 0,
};
const input = () => ({
  request,
  observedAt: at,
  validUntil: "2026-09-29T12:00:20.000Z",
  activationAt: "2026-09-30T00:00:00.000Z",
  storeReference: id(99),
  configurationVersionReference: id(100),
  expectedBrandVersion: 1,
});
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
function catalogSource() {
  return buildProductPricingBindingSourceSnapshot(
    {
      observedAt: at,
      targetExists: true,
      precise: true,
      versionReference: id(5),
      categoryClassificationKnown: false,
      categoryReferences: null,
      primaryCategoryReference: null,
      taxClassificationReference: null,
      skuReferences: [id(6)],
      bindings: [
        {
          bindingReference: id(20),
          optionSetReference: id(70),
          optionSetVersionReference: id(71),
          enabledOptionReferences: [id(changed ? 81 : 80)],
          includedSkuReferences: [],
          excludedSkuReferences: [],
          channelCodes: [],
        },
      ],
    },
    request,
    at,
  );
}
function options(): Options {
  return {
    tenantReference: id(9),
    brandReference: id(1),
    actorReference: id(2),
    clock: { now: () => clock },
    brandAuthority: {
      async withCurrentContentRead(_r, _fields, work) {
        if (brandDenied) throw new Error("synthetic Brand denial");
        return work();
      },
      async isCurrent(actual) {
        expect(actual).toBe(tx);
        return !brandDenied;
      },
    },
    storeAuthority: {
      async withCurrentBrandReferenceRead(_r, work) {
        if (storeDenied) throw new Error("synthetic Store denial");
        return work();
      },
      async isCurrent(actual) {
        expect(actual).toBe(tx);
        return !storeDenied;
      },
    },
    catalogAuthority: {
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
        return o.authority.withCurrentContentRead(r, [], () =>
          o.transactions.run(async (actual) => {
            if (
              !(await o.authority.isCurrent(actual, r, [])) ||
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
            if (!(await o.authority.isCurrent(actual, r, [])))
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
              brandLifecycle: "Active",
              brandVersion: "1",
              generation: "7",
              referenceCount: "1",
              originalIntentDigest: r.originalIntentDigest,
              observedAt: r.observedAt,
              references: [
                {
                  storeReference: id(99),
                  lifecycle: "Active",
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
        typeof import("@rms/catalog").createPostgresProductPricingBindingSourceStore
      >[0],
    ) => ({
      async withCurrentSnapshot(
        r: ProductLifecycleReviewRequest,
        work: (v: ReturnType<typeof catalogSource>) => Promise<unknown>,
      ) {
        return o.transactions.run(async (actual) => {
          await o.authority.holdUntilTransactionCompletes(actual, {
            tenantReference: id(9),
            actorReference: id(2),
            request: r,
            purposeCode: "CATALOG_LIFECYCLE_PRICING_BINDING_SOURCE_READ",
            permission: "catalog.manage",
            requiredFields: productPricingBindingCurrentSourceFields,
            observedAt: o.clock.now(),
          });
          const result = await work(catalogSource());
          if (duplicate) await work(catalogSource());
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
              requiredFields: [],
              permission: "recipe.manage",
              requiredScope: "FullBrandScope",
            });
          await hold();
          const v = raw();
          v.bindings = v.bindings.slice(0, 1);
          const binding = v.bindings[0];
          if (!binding) throw new Error("missing synthetic binding");
          binding.storeReference = id(99);
          binding.effectiveFrom = "2026-08-01T00:00:00.000Z";
          for (const version of v.versions) {
            version.lifecycle = "Published";
            version.effectiveFrom = "2026-08-01T00:00:00.000Z";
          }
          v.modifiers = [];
          v.bindingCount = "1";
          v.counts.bindings = "1";
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
  expect(r.profile).toBe("CurrentProductStoreRecipePolicyV1");
  expect(r.recipe.eligibility).toBe("NotEvaluated");
  expect(r.recipe.decision).toBe("PassForDirectBrandAndStoreBindings");
  expect(r.recipe.resolutions[0]?.recipeVersionReference).toBe(id(11));
  expect(r.publishValidation).toBe("Incomplete");
  expect(r.validUntil).toBe("2026-09-29T12:00:05.000Z");
  expect(holds).toBe(4);
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
  if (kind === "wrongActor") v = { ...input(), request: { ...request, actorReference: id(10) } };
  if (kind === "wrongBrand") v = { ...input(), request: { ...request, brandReference: id(10) } };
  if (kind === "past") v = { ...input(), validUntil: at };
  if (kind === "long") v = { ...input(), validUntil: "2026-09-29T12:00:30.001Z" };
  if (kind === "futureObservation") v = { ...input(), observedAt: "2026-09-29T12:00:00.001Z" };
  const work = vi.fn(async () => true);
  await expect(create(options()).withCurrentResolution(tx, v, work)).rejects.toThrow(deniedError);
  expect(work).not.toHaveBeenCalled();
});
it("captures clock/holders and keeps the earliest original deadline", async () => {
  const o = options(),
    p = create(o);
  o.clock.now = () => {
    throw new Error("replaced");
  };
  o.catalogAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replaced");
  };
  const r = await p.withCurrentResolution(
    tx,
    { ...input(), validUntil: "2026-09-29T12:00:01.000Z" },
    async (r) => r,
  );
  expect(r.validUntil).toBe("2026-09-29T12:00:01.000Z");
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
