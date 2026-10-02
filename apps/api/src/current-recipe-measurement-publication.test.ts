import { createBrand, createTenantContext } from "@bop/tenant";
import { beforeEach, expect, it, vi } from "vitest";
import {
  digestRecipeMeasurementContentV2 as digest,
  requireRecipeMeasurementContentDigest,
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  type RecipeMeasurementContentV2,
  type RecipeOperationRecord,
  type RecipePorts,
  type RecipeSnapshot,
} from "@rms/recipe";
import {
  buildInventoryConfigurationReferenceSnapshot,
  buildCurrentRecipeIngredientUnitFacts,
} from "@rms/inventory";
import { createCurrentRecipeMeasurementPublicationService as create } from "./current-recipe-measurement-publication.js";
const protocol = vi.hoisted(() => ({ store: vi.fn(), source: vi.fn(), pinned: vi.fn() }));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createPostgresRecipeMeasurementPublicationStore: protocol.store,
  createPinnedPublishedRecipeMeasurementGraphSource: protocol.pinned,
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresInventoryRecipeIngredientUnitSource: protocol.source,
}));
const rawId = (n: number) => `018f9900-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const id = (n: number) => parseRecipeReference(rawId(n));
const ids = {
  brand: id(1),
  actor: id(2),
  author: id(3),
  costReviewer: id(4),
  foodReviewer: id(5),
  recipe: id(6),
  v1: id(7),
  v2: id(8),
  operation: id(9),
  policy: rawId(10),
  audit: rawId(11),
  correlation: rawId(12),
};
const at = "2026-08-13T18:00:00.000Z";
function snapshot(published: boolean): RecipeSnapshot {
  return {
    recipeReference: ids.recipe,
    versionReference: published ? ids.v2 : ids.v1,
    brandReference: ids.brand,
    stableCode: parseRecipeCode("SYNTHETIC_RECIPE"),
    aggregateVersion: published ? 2 : 1,
    versionNumber: published ? 2 : 1,
    snapshotDigest: parseRecipeDigest(`sha256:${(published ? "b" : "a").repeat(64)}`),
    lifecycle: published ? "Published" : "Draft",
    displayNameCode: parseRecipeCode("SYNTHETIC_NAME"),
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: parseRecipeCode("PORTION"),
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(20),
        sourceKind: "InventoryItem",
        sourceReference: id(21),
        sourceVersionReference: id(22),
        quantityMicrounits: "1000000",
        unitDimension: "Mass",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "1",
        unitCostDenominator: "1000000",
        allergens: [{ allergenReference: id(23), evidenceReference: id(24), verified: true }],
      },
    ],
    preparationVersionReference: id(25),
    steps: [
      {
        stepReference: id(26),
        sequenceGroup: 0,
        instructionCode: parseRecipeCode("PREPARE"),
        durationSeconds: 60,
        capabilityCode: parseRecipeCode("PREP"),
      },
    ],
    substitutionPolicyReference: null,
    effectivePeriod: {
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-08-01T04:00:00.000Z" as never,
        localDateTime: "2026-08-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    },
    invalidationReasonCode: null,
    createdAt: at,
  };
}
function tenant() {
  return createTenantContext(
    {
      actorType: "User",
      actorReference: ids.actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    } as never,
    createBrand({
      brandReference: ids.brand,
      code: "RECIPE",
      displayName: "Recipe Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    at,
  );
}
function hash(value: string) {
  let state = 2166136261;
  for (const character of value) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return `sha256:${(state >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
}
function fixture(
  options: {
    sameReviewers?: boolean;
    stale?: boolean;
    candidate?: RecipeMeasurementContentV2;
    children?: readonly RecipeSnapshot[];
  } = {},
) {
  let aggregate: RecipeSnapshot | null = snapshot(false);
  let revoked = false;
  let reads = 0;
  const operations = new Map<string, RecipeOperationRecord>();
  const ports: RecipePorts = {
    authorization: {
      async authorize(input) {
        if (revoked) return null;
        return {
          publicationEvidence: {
            recipeReference: ids.recipe,
            versionReference: ids.v2,
            brandReference: ids.brand,
            snapshotDigest: (options.candidate ?? content(2)).snapshot.snapshotDigest,
            draftAuthorActorReference: ids.author,
            reviews: [
              {
                reviewReference: id(70),
                reviewKind: "Cost",
                reviewerActorReference: ids.costReviewer,
                evidenceDigest: parseRecipeDigest("sha256:" + "c".repeat(64)),
                reviewedAt: at,
                decision: "Approved",
              },
              {
                reviewReference: id(71),
                reviewKind: "FoodSafety",
                reviewerActorReference: ids.foodReviewer,
                evidenceDigest: parseRecipeDigest("sha256:" + "d".repeat(64)),
                reviewedAt: at,
                decision: "Approved",
              },
            ],
          },
          tenantContext: tenant(),
          permission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "recipe.manage",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          costReviewPermission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "recipe.cost-review",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          foodSafetyReviewPermission: {
            effect: "Allow",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            action: "recipe.food-safety-review",
            scopeKind: "Brand",
            policySnapshotReference: ids.policy,
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          },
          draftAuthorActorReference: ids.author,
          costReviewerActorReference: ids.costReviewer,
          foodSafetyReviewerActorReference: options.sameReviewers
            ? ids.costReviewer
            : ids.foodReviewer,
          audit: {
            auditId: ids.audit,
            brandId: ids.brand,
            actor: { type: "User", reference: ids.actor },
            actionCode: `RECIPE_${input.action.toUpperCase()}`,
            targetType: "Recipe",
            targetId: ids.recipe,
            beforeSummary: {},
            afterSummary: {},
            reasonCode: "AUTHORIZED_OPERATION",
            correlationId: ids.correlation,
            occurredAt: input.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        } as never;
      },
    },
    references: { hashIntent: hash, equals: (left, right) => left === right },
    facts: {
      async validate() {
        return {
          referencesValid: true,
          mappingsComplete: true,
          allergenEvidenceVerified: true,
          costEvidenceVerified: true,
          graphSnapshots: options.children ?? [],
        };
      },
    },
    repository: {
      async resolveOperation(reference) {
        reads++;
        return operations.get(reference) ?? null;
      },
      async load(reference) {
        if (options.stale && aggregate !== null) return { ...aggregate, aggregateVersion: 3 };
        return aggregate?.recipeReference === reference ? aggregate : null;
      },
      async codeAvailable() {
        return true;
      },
      async create(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
      async commit(input) {
        aggregate = input.record.aggregate;
        operations.set(input.record.operationReference, input.record);
        return input.record;
      },
    },
  };
  return {
    ports,
    operations,
    revoke: () => {
      revoked = true;
    },
    reads: () => reads,
  };
}
function content(version = 1) {
  const core = {
    ...snapshot(version === 2),
    versionReference: id(version === 1 ? 7 : 8),
    aggregateVersion: version,
    versionNumber: version,
  };
  const value = {
    profile: "RecipeMeasurementContentV2",
    snapshot: core,
    measurements: [
      {
        requirementReference: id(20),
        usageUnitCode: "KG",
        usageDimension: "Mass",
        targetUnitCode: "KG",
        targetDimension: "Mass",
        conversionKind: "InventoryBaseUnitIdentity",
        conversionReference: null,
      },
    ],
  };
  return requireRecipeMeasurementContentDigest({
    ...value,
    snapshot: { ...core, snapshotDigest: digest(value) },
  });
}

const until = "2026-08-13T18:00:05.000Z";
let clock = at,
  sourceCalls = 0,
  badSource = false,
  substituted = false,
  duplicate = false,
  late = false,
  denyFields = false,
  hook: () => void = () => undefined,
  pinnedMissing = false,
  pinnedDenied = false;
beforeEach(() => {
  clock = at;
  sourceCalls = 0;
  badSource = false;
  substituted = false;
  duplicate = false;
  late = false;
  denyFields = false;
  hook = () => undefined;
  pinnedMissing = false;
  pinnedDenied = false;
  vi.clearAllMocks();
});
function setup(
  candidate = content(2),
  children: readonly RecipeMeasurementContentV2[] = [],
  pinned = false,
) {
  const f = fixture({ candidate, children: children.map((c) => c.snapshot) }),
    tx = { query: vi.fn(async () => ({ rows: [] })) },
    saved = new Map<string, ReturnType<typeof content>>();
  const input = {
    action: "Publish",
    operationReference: ids.operation,
    expectedAggregateVersion: 1,
    candidate,
    occurredAt: at,
  };
  const hold = vi.fn(async () => {
    if (late) throw Error("synthetic current Recipe denial");
  });
  const metadataHold = vi.fn(async (_tx: unknown, _input: unknown) => {
      void _tx;
      void _input;
      return undefined;
    }),
    unitHold = vi.fn(async (_tx: unknown, _input: unknown) => {
      void _tx;
      void _input;
      if (denyFields) throw Error("synthetic unit denial");
    });
  const nativeCommit = f.ports.repository.commit.bind(f.ports.repository);
  const repo = {
    ...f.ports.repository,
    commit: async (value: Parameters<typeof nativeCommit>[0]) => {
      const r = await nativeCommit(value);
      saved.set(r.operationReference, input.candidate);
      hook();
      return r;
    },
    resolveMeasurementOperation: async (ref: string) => {
      const r = f.operations.get(ref);
      return r ? { record: r, content: saved.get(ref) } : null;
    },
  };
  protocol.store.mockReturnValue(repo);
  protocol.source.mockImplementation((options) => ({
    withCurrentUnits: async (
      request: Parameters<typeof buildInventoryConfigurationReferenceSnapshot>[1],
      pins: Parameters<typeof buildCurrentRecipeIngredientUnitFacts>[0],
      work: (
        facts: ReturnType<typeof buildCurrentRecipeIngredientUnitFacts> & { validUntil: string },
      ) => Promise<unknown>,
    ) => {
      sourceCalls++;
      if (badSource) throw Error("synthetic missing source");
      return options.transactions.run(async (actual: typeof tx) => {
        await options.authority.holdUntilTransactionCompletes(actual, {});
        await options.unitAuthority.holdUntilTransactionCompletes(actual, {});
        const scope = {
          tenantReference: request.tenantReference,
          brandReference: request.brandReference,
        };
        const metadata = buildInventoryConfigurationReferenceSnapshot(
          {
            generation: "2",
            observedAt: at,
            counts: { items: "1", versions: "2", operations: "2" },
            items: [
              {
                ...scope,
                itemReference: id(21),
                itemType: "RawMaterial",
                createdAt: at,
                precise: true,
              },
            ],
            versions: [1, 2].map((v) => ({
              ...scope,
              itemReference: id(21),
              itemVersion: String(v),
              itemType: "RawMaterial",
              lifecycle: v === 2 ? "Active" : "Inactive",
              recordedAt: at,
              precise: true,
            })),
            operations: [1, 2].map((v) => ({
              ...scope,
              itemReference: id(21),
              itemVersion: String(v),
              operationReference: v === 2 ? id(22) : id(100),
              action: v === 2 ? "Activate" : "Create",
            })),
          },
          request,
          at,
        );
        const facts = {
          ...buildCurrentRecipeIngredientUnitFacts(
            pins,
            [
              {
                itemReference: id(21),
                itemVersion: "2",
                operationReference: id(22),
                recordedAt: at,
                precise: true,
                baseUnit: {
                  unitCode: "KG",
                  dimension: "Mass",
                  ledgerPrecision: 4,
                  displayPrecision: 4,
                  roundingMode: "HalfEven",
                },
                unitConversions: [],
              },
            ],
            metadata,
            request,
            at,
          ),
          validUntil: until,
        };
        const answer = await work(facts);
        if (duplicate) await work(facts);
        await options.unitAuthority.holdUntilTransactionCompletes(actual, {});
        return substituted ? { substituted: true } : answer;
      });
    },
  }));
  protocol.pinned.mockImplementation((options) => ({
    withCurrentGraph: (
      value: unknown,
      work: (graph: {
        validUntil: string;
        contents: { content: RecipeMeasurementContentV2 }[];
      }) => Promise<unknown>,
    ) =>
      options.transactions.run(async (actual: typeof tx) => {
        if (pinnedMissing) throw Error("synthetic missing complete child source");
        await options.authority.holdUntilTransactionCompletes(actual, value);
        await options.measurementAuthority.holdUntilTransactionCompletes(actual, value);
        const answer = await work({
          validUntil: "2026-08-13T18:00:03.000Z",
          contents: children.map((content) => ({ content })),
        });
        await options.measurementAuthority.holdUntilTransactionCompletes(actual, value);
        return answer;
      }),
  }));
  const childHold = vi.fn(async (_tx: unknown, _input: unknown) => {
    void _tx;
    void _input;
    if (pinnedDenied) throw Error("synthetic child permission refusal");
  });
  const service = create({
    tenantReference: rawId(4),
    brandReference: ids.brand,
    actorReference: ids.actor,
    clock: { now: () => clock },
    generateReference: () => rawId(88),
    recipePorts: f.ports,
    ...(pinned
      ? {
          pinnedRecipes: {
            authority: { holdUntilTransactionCompletes: childHold },
            measurementAuthority: { holdUntilTransactionCompletes: childHold },
          },
        }
      : {}),
    recipeAuthority: { holdUntilTransactionCompletes: hold },
    inventory: {
      authority: { holdUntilTransactionCompletes: metadataHold },
      unitAuthority: { holdUntilTransactionCompletes: unitHold },
    },
  });
  return { f, tx, input, service, hold, metadataHold, unitHold, childHold };
}
it("publishes full content only through held owning units and native independent reviews", async () => {
  const h = setup();
  expect(await h.service.execute(h.tx, h.input)).toMatchObject({
    status: "Applied",
    content: h.input.candidate,
  });
  expect(sourceCalls).toBe(1);
  expect(h.hold).toHaveBeenCalledTimes(3);
  expect(h.metadataHold.mock.calls[0]?.[0]).toBe(h.tx);
  expect(h.unitHold.mock.calls[0]?.[0]).toBe(h.tx);
  expect(h.f.operations.get(ids.operation)?.publicationEvidence?.snapshotDigest).toBe(
    h.input.candidate.snapshot.snapshotDigest,
  );
});
it("recovers original operation despite historical Item source becoming unavailable", async () => {
  const h = setup();
  await h.service.execute(h.tx, h.input);
  badSource = true;
  expect(await h.service.execute(h.tx, h.input)).toMatchObject({
    status: "AlreadyApplied",
    aggregate: { aggregateVersion: 2 },
  });
  expect(sourceCalls).toBe(1);
});
it("rejects changed full intent on original replay without reopening current units", async () => {
  const h = setup();
  await h.service.execute(h.tx, h.input);
  const raw = {
    ...h.input.candidate,
    measurements: [
      { ...h.input.candidate.measurements[0], usageUnitCode: "G", targetUnitCode: "G" },
    ],
  };
  const candidate = requireRecipeMeasurementContentDigest({
    ...raw,
    snapshot: { ...raw.snapshot, snapshotDigest: digest(raw) },
  });
  await expect(h.service.execute(h.tx, { ...h.input, candidate })).rejects.toMatchObject({
    code: "RECIPE_IDEMPOTENCY_CONFLICT",
  });
  expect(sourceCalls).toBe(1);
});
it("current native permission still gates historical replay", async () => {
  const h = setup();
  await h.service.execute(h.tx, h.input);
  h.f.revoke();
  await expect(h.service.execute(h.tx, h.input)).rejects.toMatchObject({
    code: "RECIPE_PERMISSION_DENIED",
  });
});
it.each(["source", "recipe", "fields", "expiry", "reverse", "query", "duplicate", "result"])(
  "fails closed and poisons original Tx on %s",
  async (mode) => {
    const h = setup();
    if (mode === "source") badSource = true;
    hook = () => {
      if (mode === "recipe") late = true;
      if (mode === "fields") denyFields = true;
      if (mode === "expiry") clock = until;
      if (mode === "reverse") clock = "2026-08-13T17:59:59.999Z";
      if (mode === "query") h.tx.query = vi.fn(async () => ({ rows: [] }));
    };
    duplicate = mode === "duplicate";
    substituted = mode === "result";
    await expect(h.service.execute(h.tx, h.input)).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
    badSource = false;
    late = false;
    denyFields = false;
    clock = at;
    duplicate = false;
    substituted = false;
    await expect(h.service.execute(h.tx, h.input)).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("rejects wrong Actor evidence and old expected version using native guards", async () => {
  const h = setup();
  await expect(
    h.service.execute(h.tx, { ...h.input, expectedAggregateVersion: 2 }),
  ).rejects.toMatchObject({ code: "RECIPE_VERSION_CONFLICT" });
  const g = setup(),
    authorize = g.f.ports.authorization.authorize.bind(g.f.ports.authorization);
  g.f.ports.authorization.authorize = async (v) => {
    const e = await authorize(v);
    if (!e) throw Error("fixture");
    return {
      ...e,
      tenantContext: {
        ...e.tenantContext,
        actor: { ...e.tenantContext.actor, actorReference: rawId(77) },
      },
    } as never;
  };
  await expect(g.service.execute(g.tx, g.input)).rejects.toMatchObject({
    code: "RECIPE_PERMISSION_DENIED",
  });
});
it.each(["digest", "brand", "lifecycle", "action", "time", "extra", "accessor"])(
  "rejects closed input %s before sources",
  async (mode) => {
    const h = setup();
    let value: unknown = h.input,
      calls = 0;
    if (mode === "digest")
      value = {
        ...h.input,
        candidate: {
          ...h.input.candidate,
          snapshot: { ...h.input.candidate.snapshot, snapshotDigest: "sha256:" + "f".repeat(64) },
        },
      };
    if (mode === "action") value = { ...h.input, action: "CreateDraft" };
    if (mode === "time") value = { ...h.input, occurredAt: "2026-08-13T18:01:00.000Z" };
    if (mode === "extra") value = { ...h.input, extra: true };
    if (mode === "brand" || mode === "lifecycle") {
      const raw = {
        ...h.input.candidate,
        snapshot: {
          ...h.input.candidate.snapshot,
          ...(mode === "brand" ? { brandReference: rawId(77) } : { lifecycle: "Draft" }),
        },
      };
      value = {
        ...h.input,
        candidate: { ...raw, snapshot: { ...raw.snapshot, snapshotDigest: digest(raw) } },
      };
    }
    if (mode === "accessor")
      Object.defineProperty(h.input, "action", {
        enumerable: true,
        get() {
          calls++;
          return "Publish";
        },
      });
    await expect(h.service.execute(h.tx, value)).rejects.toBeDefined();
    expect(sourceCalls).toBe(0);
    expect(calls).toBe(0);
  },
);
it("rejects Subrecipe candidate before any synthetic or owning unit source can substitute child V2", async () => {
  const h = setup(),
    i = h.input.candidate.snapshot.ingredients[0];
  if (!i) throw Error("fixture");
  const raw = {
    ...h.input.candidate,
    snapshot: { ...h.input.candidate.snapshot, ingredients: [{ ...i, sourceKind: "SubRecipe" }] },
    measurements: [
      { ...h.input.candidate.measurements[0], conversionKind: "PinnedSubrecipeYieldIdentity" },
    ],
  };
  const candidate = { ...raw, snapshot: { ...raw.snapshot, snapshotDigest: digest(raw) } };
  await expect(h.service.execute(h.tx, { ...h.input, candidate })).rejects.toMatchObject({
    code: "RECIPE_DEPENDENCY_UNAVAILABLE",
  });
  expect(sourceCalls).toBe(0);
});

function subContents() {
  const leaf = content(2),
    childRaw = {
      ...leaf,
      snapshot: {
        ...leaf.snapshot,
        recipeReference: id(90),
        versionReference: id(91),
        stableCode: parseRecipeCode("SYNTHETIC_CHILD"),
      },
    };
  const child = requireRecipeMeasurementContentDigest({
    ...childRaw,
    snapshot: { ...childRaw.snapshot, snapshotDigest: digest(childRaw) },
  });
  const ingredient = leaf.snapshot.ingredients[0];
  if (!ingredient) throw Error("fixture");
  const parentRaw = {
    ...leaf,
    snapshot: {
      ...leaf.snapshot,
      ingredients: [
        {
          ...ingredient,
          sourceKind: "SubRecipe",
          sourceReference: child.snapshot.recipeReference,
          sourceVersionReference: child.snapshot.versionReference,
          unitDimension: "Count",
          quantityMicrounits: "2000000",
        },
      ],
    },
    measurements: [
      {
        requirementReference: ingredient.requirementReference,
        usageUnitCode: "PORTION",
        usageDimension: "Count",
        targetUnitCode: "PORTION",
        targetDimension: "Count",
        conversionKind: "PinnedSubrecipeYieldIdentity",
        conversionReference: null,
      },
    ],
  };
  const parent = requireRecipeMeasurementContentDigest({
    ...parentRaw,
    snapshot: { ...parentRaw.snapshot, snapshotDigest: digest(parentRaw) },
  });
  return { parent, child };
}
it("publishes SubRecipe with exact held full child, all actual unit selectors and scaled final demand", async () => {
  const { parent, child } = subContents(),
    h = setup(parent, [child], true);
  expect(await h.service.execute(h.tx, h.input)).toMatchObject({
    status: "Applied",
    content: parent,
  });
  expect(protocol.pinned).toHaveBeenCalledTimes(1);
  expect(sourceCalls).toBe(1);
  expect(h.childHold.mock.calls[0]?.[0]).toBe(h.tx);
});
it("original SubRecipe replay bypasses now unavailable child and Item sources while retaining current Recipe authorization", async () => {
  const { parent, child } = subContents(),
    h = setup(parent, [child], true);
  await h.service.execute(h.tx, h.input);
  pinnedMissing = true;
  badSource = true;
  expect(await h.service.execute(h.tx, h.input)).toMatchObject({
    status: "AlreadyApplied",
    content: parent,
  });
  expect(protocol.pinned).toHaveBeenCalledTimes(1);
  expect(sourceCalls).toBe(1);
  h.f.revoke();
  await expect(h.service.execute(h.tx, h.input)).rejects.toMatchObject({
    code: "RECIPE_PERMISSION_DENIED",
  });
});
for (const mode of ["missing", "permission", "shortest", "lateFields", "incomplete"] as const)
  it("refuses SubRecipe " + mode + " without substituting synthetic child defaults", async () => {
    const { parent, child } = subContents(),
      h = setup(parent, mode === "incomplete" ? [] : [child], true);
    if (mode === "missing") pinnedMissing = true;
    if (mode === "permission") pinnedDenied = true;
    if (mode === "shortest")
      hook = () => {
        clock = "2026-08-13T18:00:04.000Z";
      };
    if (mode === "lateFields")
      hook = () => {
        pinnedDenied = true;
      };
    await expect(h.service.execute(h.tx, h.input)).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
    await expect(h.service.execute(h.tx, h.input)).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
  });
