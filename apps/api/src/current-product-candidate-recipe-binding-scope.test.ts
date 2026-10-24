import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  bindCatalogProductValidationCandidate,
  deriveCatalogProductPublicationContentIdentity,
  productValidationCandidateFields,
  CatalogError,
} from "@rms/catalog";
import {
  buildRecipeReferenceSourceSnapshot,
  recipeReferenceSourceFields,
  RecipeWorkflowError,
} from "@rms/recipe";
import { createCurrentProductCandidateRecipeBindingScopeSource as create } from "./current-product-candidate-recipe-binding-scope.js";
const protocol = vi.hoisted(() => ({ candidate: vi.fn(), recipe: vi.fn() }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductValidationCandidateSource: protocol.candidate,
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createPostgresRecipeReferenceSourceStore: protocol.recipe,
}));
const at = "2026-09-30T06:00:00.000Z";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const aggregate = {
    productReference: id(1),
    brandReference: id(2),
    internalCode: "CONTENT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic SKU" },
          variantSelections: [] as { dimensionReference: string; valueReference: string }[],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
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
  };

  const first = aggregate.draft.skus[0];
  if (!first) throw new Error("missing synthetic SKU");
  aggregate.draft.skus.push({
    ...first,
    skuReference: id(6),
    skuCode: "TWO",
    variantSelections: [{ dimensionReference: id(70), valueReference: id(71) }],
  } as typeof first);
  const binding = {
    bindingReference: id(20),
    optionSetReference: id(21),
    optionSetVersionReference: id(22),
    purpose: "CUSTOMIZATION",
    sortOrder: 0,
    enabledOptionReferences: [id(81), id(80)],
    defaultSelections: [],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [id(6)],
    excludedSkuReferences: [id(5)],
    channelCodes: [],
    storeOverrideAllowed: false,
  };
  const full = {
    ...aggregate,
    draft: {
      ...aggregate.draft,
      optionBindings: [binding],
      editorContent: {
        ...aggregate.draft.editorContent,
        variantDimensions: [
          {
            dimensionReference: id(70),
            code: "SIZE",
            localizedNames: { "en-CA": "Size" },
            sortOrder: 0,
            selectionRequirement: "Optional",
            values: [
              {
                valueReference: id(71),
                code: "LARGE",
                localizedNames: { "en-CA": "Large" },
                sortOrder: 0,
                attributeReference: null,
                mediaReference: null,
              },
            ],
          },
        ],
        variantCombinations: [
          { selections: [], disposition: "Valid", skuReference: id(5) },
          {
            selections: [{ dimensionReference: id(70), valueReference: id(71) }],
            disposition: "Valid",
            skuReference: id(6),
          },
        ],
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
      },
    },
  };
  const identity = deriveCatalogProductPublicationContentIdentity(full);
  const command = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(9),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(40),
    productReference: id(1),
    versionReference: id(4),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: "2026-10-01T06:00:00.000Z",
        localDateTime: "2026-10-01T06:00:00.000",
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_VALIDATE",
  };
  return { aggregate: full, command };
}

type Options = Parameters<typeof create>[0];
type Tx = Parameters<ReturnType<typeof create>["withCurrentAssessment"]>[0];
type CandidateOptions = Parameters<
  typeof import("@rms/catalog").createPostgresProductValidationCandidateSource
>[0];
type RecipeOptions = Parameters<
  typeof import("@rms/recipe").createPostgresRecipeReferenceSourceStore
>[0];
const plus = (n: number) => new Date(Date.parse(at) + n).toISOString();
function setup() {
  const f = fixture(),
    state = {
      now: at,
      denyCandidate: false,
      denyRecipe: false,
      changed: false,
      queryDuring: false,
      expireDuring: false,
      remapRecipeErrors: false,
    };
  const tx: Tx = { query: vi.fn(async () => ({ rows: [], rowCount: 7 })) },
    order: string[] = [];
  const candidateHold = vi.fn(
    async (
      actual: Tx,
      input: Parameters<CandidateOptions["authority"]["holdUntilTransactionCompletes"]>[1],
    ) => {
      expect(actual).toBe(tx);
      expect(input.owningAction).toBe("catalog.product.validate");
      expect(input.requiredFields).toBe(productValidationCandidateFields);
      if (state.denyCandidate) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  );
  const recipeHold = vi.fn(
    async (
      actual: Parameters<RecipeOptions["authority"]["holdUntilTransactionCompletes"]>[0],
      input: Parameters<RecipeOptions["authority"]["holdUntilTransactionCompletes"]>[1],
    ) => {
      expect(actual).toBe(tx);
      expect(input.permission).toBe("recipe.manage");
      expect(input.requiredScope).toBe("FullBrandScope");
      expect(input.requiredFields).toBe(recipeReferenceSourceFields);
      expect(input.request.catalogIntentDigest).toBe(
        bindCatalogProductValidationCandidate(f.command, f.aggregate, at).originalIntentDigest,
      );
      if (state.denyRecipe) throw new Error("synthetic revoked Recipe fields");
    },
  );
  let catalogCalls = 0;
  protocol.candidate.mockImplementation((o: CandidateOptions) => ({
    withCurrentCandidate: async (
      value: unknown,
      cb: Parameters<
        ReturnType<
          typeof import("@rms/catalog").createPostgresProductValidationCandidateSource
        >["withCurrentCandidate"]
      >[1],
    ) =>
      o.transactions.run(async (actual) => {
        order.push("candidate enter");
        catalogCalls++;
        await o.authority.holdUntilTransactionCompletes(actual, {
          tenantReference: id(9),
          brandReference: id(2),
          actorReference: id(3),
          actorKind: "User",
          productReference: id(1),
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          permission: "catalog.manage",
          owningAction: "catalog.product.validate",
          requiredFields: productValidationCandidateFields,
          observedAt: o.clock.now(),
        });
        const aggregate = state.changed
          ? {
              ...f.aggregate,
              draft: { ...f.aggregate.draft, localizedNames: { "en-CA": "Changed" } },
            }
          : f.aggregate;
        const r = await cb(
          Object.freeze({
            ...bindCatalogProductValidationCandidate(value, aggregate, o.clock.now()),
            // Synthetic owner-source fixture only; the pure binder cannot prove uniqueness.
            internalCodeCheck: Object.freeze({
              code: "InternalCode" as const,
              outcome: "Pass" as const,
            }),
          }),
          actual,
        );
        await o.authority.holdUntilTransactionCompletes(actual, {
          tenantReference: id(9),
          brandReference: id(2),
          actorReference: id(3),
          actorKind: "User",
          productReference: id(1),
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          permission: "catalog.manage",
          owningAction: "catalog.product.validate",
          requiredFields: productValidationCandidateFields,
          observedAt: o.clock.now(),
        });
        order.push("candidate exit");
        return r;
      }),
  }));
  const raw = () => ({
    generation: "1",
    bindingCount: "1",
    observedAt: at,
    counts: { recipes: "1", versions: "1", bindings: "1", modifiers: "0" },
    recipes: [
      {
        recipeReference: id(10),
        brandReference: id(2),
        aggregateVersion: 2,
        currentVersionReference: id(11),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [
      {
        recipeVersionReference: id(11),
        recipeReference: id(10),
        brandReference: id(2),
        versionNumber: 1,
        lifecycle: "Published",
        snapshotDigest: "sha256:" + "a".repeat(64),
        effectiveFrom: at,
        effectiveUntil: null,
        timeZone: "UTC",
        createdAt: at,
        precise: true,
      },
    ],
    bindings: [
      {
        bindingReference: id(60),
        recipeVersionReference: id(11),
        recipeReference: id(10),
        brandReference: id(2),
        skuReference: id(5),
        storeReference: id(99),
        optionBindingReference: null as string | null,
        effectiveFrom: at,
        effectiveUntil: null,
        precise: true,
      },
    ],
    modifiers: [],
  });
  protocol.recipe.mockImplementation((o: RecipeOptions) => ({
    withCurrentSnapshot: async (
      request: Parameters<typeof buildRecipeReferenceSourceSnapshot>[1],
      cb: (source: ReturnType<typeof buildRecipeReferenceSourceSnapshot>) => Promise<unknown>,
    ) =>
      o.transactions.run(async (actual) => {
        order.push("recipe enter");
        const hold = () =>
          o.authority.holdUntilTransactionCompletes(actual, {
            tenantReference: id(9),
            request,
            permission: "recipe.manage",
            requiredScope: "FullBrandScope",
            requiredFields: recipeReferenceSourceFields,
            observedAt: o.clock.now(),
          });
        await hold();
        const transport = await actual.query("synthetic guarded transport", []);
        expect(transport).toHaveProperty("rowCount", 7);
        let result;
        try {
          result = await cb(buildRecipeReferenceSourceSnapshot(raw(), request, o.clock.now()));
        } catch (error) {
          if (state.remapRecipeErrors)
            throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
          throw error;
        }
        await hold();
        order.push("recipe exit");
        return result;
      }),
  }));
  const options: Options = {
    tenantReference: id(9),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => state.now },
    candidateAuthority: { holdUntilTransactionCompletes: candidateHold },
    recipeAuthority: { holdUntilTransactionCompletes: recipeHold },
  };
  return {
    ...f,
    state,
    tx,
    order,
    raw,
    options,
    source: create(options),
    candidateHold,
    recipeHold,
    catalogCalls: () => catalogCalls,
  };
}
beforeEach(() => {
  protocol.candidate.mockReset();
  protocol.recipe.mockReset();
});
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
it("uses actual Validate identity, full candidate target and held public owners with explicit final candidate reread", async () => {
  const f = setup(),
    token = {};
  const r = await f.source.withCurrentAssessment(f.tx, f.command, async (a) => {
    f.order.push("consumer");
    expect(a.recipe.bindingChecks).toHaveLength(1);
    expect(a.recipe.decision).toBe("PassForStoredMembershipAndPeriods");
    expect(a.recipe.catalogConfigurationDigest).toBe(f.command.configurationDigest);
    expect(a.recipe.activationAt).toBe(f.command.effectivePeriod.effectiveFrom.instant);
    expect(a.recipe.storeTopology).toBe("NotEvaluated");
    expect(a.recipe.uniqueRecipeResolution).toBe("NotEvaluated");
    expect(a.publishValidation).toBe("Incomplete");
    expect(a.validUntil).toBe(plus(5000));
    expect(a).not.toHaveProperty("aggregate");
    const { digest, ...body } = a;
    expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
    return token;
  });
  expect(r).toBe(token);
  expect(f.catalogCalls()).toBe(2);
  expect(f.candidateHold).toHaveBeenCalledTimes(4);
  expect(f.recipeHold).toHaveBeenCalledTimes(2);
  expect(f.order).toEqual([
    "candidate enter",
    "recipe enter",
    "consumer",
    "candidate enter",
    "candidate exit",
    "recipe exit",
    "candidate exit",
  ]);
});
it.each(["candidate fields", "recipe fields", "query", "expiry", "backward", "graph"])(
  "refuses late %s after work and poisons subsequent admission",
  async (mode) => {
    const f = setup(),
      work = vi.fn(async () => {
        if (mode === "candidate fields") f.state.denyCandidate = true;
        if (mode === "recipe fields") f.state.denyRecipe = true;
        if (mode === "query") f.tx.query = async () => ({ rows: [] });
        if (mode === "expiry") f.state.now = plus(5000);
        if (mode === "backward") f.state.now = plus(-1);
        if (mode === "graph") f.state.changed = true;
        return {};
      });
    await expect(f.source.withCurrentAssessment(f.tx, f.command, work)).rejects.toHaveProperty(
      "code",
      mode === "candidate fields" ? "CATALOG_PERMISSION_DENIED" : unavailable.code,
    );
    expect(work).toHaveBeenCalledOnce();
    await expect(f.source.withCurrentAssessment(f.tx, f.command, vi.fn())).rejects.toMatchObject(
      unavailable,
    );
  },
);
it.each([
  { action: "SubmitReview" },
  { actorKind: "System" },
  { tenantReference: id(98) },
  { brandReference: id(98) },
  { actorReference: id(98) },
  { target: {} },
  { Ready: true },
  { skuReference: id(5) },
])("refuses command drift before acquiring source %j", async (patch) => {
  const f = setup(),
    work = vi.fn();
  await expect(
    f.source.withCurrentAssessment(f.tx, { ...f.command, ...patch }, work),
  ).rejects.toMatchObject(unavailable);
  expect(protocol.candidate).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it("caught recursive admission poisons the outer UoW", async () => {
  const f = setup();
  await expect(
    f.source.withCurrentAssessment(f.tx, f.command, async () => {
      await expect(
        f.source.withCurrentAssessment(f.tx, f.command, async () => null),
      ).rejects.toMatchObject(unavailable);
      return {};
    }),
  ).rejects.toMatchObject(unavailable);
});
it.each([
  "candidate duplicates",
  "recipe duplicates",
  "candidate result",
  "recipe result",
  "final candidate result",
  "foreign transaction",
  "candidate extra",
  "candidate code missing",
  "candidate code warning",
  "candidate code extra",
  "candidate intent",
  "candidate future",
  "recipe scope",
  "recipe accessor",
])("refuses protocol substitution %s", async (mode) => {
  const f = setup(),
    work = vi.fn(async () => ({}));
  if (mode.startsWith("recipe"))
    protocol.recipe.mockImplementation((o: RecipeOptions) => ({
      withCurrentSnapshot: async (
        r: Parameters<typeof buildRecipeReferenceSourceSnapshot>[1],
        cb: (v: unknown) => Promise<unknown>,
      ) => {
        let source: unknown = buildRecipeReferenceSourceSnapshot(f.raw(), r, at);
        if (mode === "recipe scope")
          source = { ...(source as object), request: { ...r, brandReference: id(99) } };
        if (mode === "recipe accessor") {
          const copy = { ...(source as object) };
          Object.defineProperty(copy, "observedAt", {
            get: () => {
              throw new Error("must not execute");
            },
          });
          source = copy;
        }
        const result = await cb(source);
        if (mode === "recipe duplicates") await cb(source);
        void o;
        return mode === "recipe result" ? {} : result;
      },
    }));
  else {
    let calls = 0;
    protocol.candidate.mockImplementation((o: CandidateOptions) => ({
      withCurrentCandidate: async (c: unknown, cb: (v: unknown, t: Tx) => Promise<unknown>) =>
        o.transactions.run(async (actual) => {
          calls++;
          let candidate: unknown = syntheticCurrentCandidate(c, f.aggregate, at);
          if (mode === "candidate extra") candidate = { ...(candidate as object), Ready: true };
          if (mode === "candidate code missing") {
            const copy = { ...(candidate as object) };
            Reflect.deleteProperty(copy, "internalCodeCheck");
            candidate = copy;
          }
          if (mode === "candidate code warning")
            candidate = {
              ...(candidate as object),
              internalCodeCheck: { code: "InternalCode", outcome: "Warning" },
            };
          if (mode === "candidate code extra")
            candidate = {
              ...(candidate as object),
              internalCodeCheck: { code: "InternalCode", outcome: "Pass", extra: true },
            };
          if (mode === "candidate intent")
            candidate = {
              ...(candidate as object),
              originalIntentDigest: "sha256:" + "f".repeat(64),
            };
          if (mode === "candidate future")
            candidate = syntheticCurrentCandidate(c, f.aggregate, plus(1));
          const result = await cb(candidate, mode === "foreign transaction" ? f.tx : actual);
          if (mode === "candidate duplicates") await cb(candidate, actual);
          return mode === "candidate result" || (mode === "final candidate result" && calls === 2)
            ? {}
            : result;
        }),
    }));
  }
  await expect(f.source.withCurrentAssessment(f.tx, f.command, work)).rejects.toMatchObject(
    unavailable,
  );
  expect(work.mock.calls.length).toBeLessThanOrEqual(1);
});
it("refuses the command's original past activation instead of replacing it with now", async () => {
  const f = setup();
  const command = {
    ...f.command,
    effectivePeriod: {
      ...f.command.effectivePeriod,
      effectiveFrom: {
        instant: plus(-1),
        localDateTime: plus(-1).slice(0, 23),
        utcOffsetMinutes: 0,
      },
    },
  };
  await expect(f.source.withCurrentAssessment(f.tx, command, vi.fn())).rejects.toMatchObject(
    unavailable,
  );
});
it.each(["replacement", "expiry"])(
  "checks captured query after an in-flight response %s",
  async (mode) => {
    const f = setup();
    f.tx.query = vi.fn(async () => {
      if (mode === "replacement") f.tx.query = async () => ({ rows: [] });
      else f.state.now = plus(30000);
      return { rows: [], rowCount: 7 };
    });
    const work = vi.fn();
    await expect(f.source.withCurrentAssessment(f.tx, f.command, work)).rejects.toMatchObject(
      unavailable,
    );
    expect(work).not.toHaveBeenCalled();
  },
);
it("keeps original Recipe deadline through advancing final candidate observations", async () => {
  const f = setup();
  const a = await f.source.withCurrentAssessment(f.tx, f.command, async (a) => {
    f.state.now = plus(4000);
    return a;
  });
  expect(a.validUntil).toBe(plus(5000));
});
it("retains current permissions and authority method capture", async () => {
  const f = setup();
  f.options.candidateAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replaced method");
  };
  f.options.recipeAuthority.holdUntilTransactionCompletes = async () => {
    throw new Error("replaced method");
  };
  await f.source.withCurrentAssessment(f.tx, f.command, async () => null);
  expect(f.candidateHold).toHaveBeenCalledTimes(4);
  expect(f.recipeHold).toHaveBeenCalledTimes(2);
});

it("refuses a correctly bound legacy candidate before Recipe acquisition", async () => {
  const f = setup(),
    { editorContent, ...draft } = f.aggregate.draft;
  void editorContent;
  const aggregate = { ...f.aggregate, draft },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const command = {
    ...f.command,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
  };
  protocol.candidate.mockImplementation((o: CandidateOptions) => ({
    withCurrentCandidate: async (c: unknown, cb: (v: unknown, tx: Tx) => Promise<unknown>) =>
      o.transactions.run((actual) => cb(syntheticCurrentCandidate(c, aggregate, at), actual)),
  }));
  const work = vi.fn();
  await expect(f.source.withCurrentAssessment(f.tx, command, work)).rejects.toMatchObject(
    unavailable,
  );
  expect(f.recipeHold).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it.each(["empty", "excluded", "included"])(
  "returns only truthful subset evidence for %s Recipe membership",
  async (mode) => {
    const f = setup();
    protocol.recipe.mockImplementation(() => ({
      withCurrentSnapshot: async (
        r: Parameters<typeof buildRecipeReferenceSourceSnapshot>[1],
        cb: (v: unknown) => Promise<unknown>,
      ) => {
        const source = f.raw();
        if (mode === "empty") {
          source.bindings = [];
          source.bindingCount = "0";
          source.counts.bindings = "0";
        } else {
          const b = source.bindings[0];
          if (!b) throw new Error("missing fixture Binding");
          b.optionBindingReference = id(20);
          if (mode === "included") b.skuReference = id(6);
        }
        return cb(buildRecipeReferenceSourceSnapshot(source, r, at));
      },
    }));
    const a = await f.source.withCurrentAssessment(f.tx, f.command, async (a) => a);
    expect(a.recipe.decision).toBe(
      mode === "excluded" ? "HardError" : "PassForStoredMembershipAndPeriods",
    );
    if (mode === "excluded") expect(a.recipe.gaps[0]?.reason).toBe("SkuOutsideBindingScope");
    if (mode === "empty") expect(a.recipe.bindingChecks).toEqual([]);
    expect(a.recipe.uniqueRecipeResolution).toBe("NotEvaluated");
    expect(a.publishValidation).toBe("Incomplete");
  },
);

it("preserves only trusted current Candidate permission denial across the Recipe owner's foreign error mapping", async () => {
  const f = setup();
  f.state.remapRecipeErrors = true;
  const work = vi.fn(async () => {
    f.state.denyCandidate = true;
    return {};
  });
  await expect(f.source.withCurrentAssessment(f.tx, f.command, work)).rejects.toHaveProperty(
    "code",
    "CATALOG_PERMISSION_DENIED",
  );
  expect(work).toHaveBeenCalledOnce();
  await expect(f.source.withCurrentAssessment(f.tx, f.command, vi.fn())).rejects.toMatchObject(
    unavailable,
  );
});
it("does not recover a consumer-manufactured permission denial from a sanitized Recipe error", async () => {
  const f = setup();
  f.state.remapRecipeErrors = true;
  const work = vi.fn(async () => {
    throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(f.source.withCurrentAssessment(f.tx, f.command, work)).rejects.toMatchObject(
    unavailable,
  );
  expect(work).toHaveBeenCalledOnce();
  expect(f.candidateHold).toHaveBeenCalledOnce();
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
