import { createEffectivePeriod } from "@bop/effective-period";
import { createBrand, createTenantContext } from "@bop/tenant";
import { expect, it, vi, beforeEach } from "vitest";
import {
  createRecipeMeasurementDraftService,
  digestRecipeMeasurementContentV2 as digest,
  requireRecipeMeasurementContentDigest,
  createPostgresRecipeMeasurementDraftStore,
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  type RecipeOperationRecord,
  type RecipePorts,
  type RecipeSnapshot,
} from "../index.js";
const protocol = vi.hoisted(() => ({ base: vi.fn() }));
vi.mock("../infrastructure/persistence/recipe-store.js", () => ({
  createPostgresRecipeStore: protocol.base,
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
    effectivePeriod: createEffectivePeriod({
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: "2026-08-01T04:00:00.000Z" as never,
        localDateTime: "2026-08-01T00:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    }),
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
function fixture(options: { sameReviewers?: boolean; stale?: boolean } = {}) {
  let aggregate: RecipeSnapshot | null = null;
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
            snapshotDigest: snapshot(true).snapshotDigest,
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
          graphSnapshots: [],
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
    service: createRecipeMeasurementDraftService({
      ...ports,
      repositoryForContent: () => ports.repository,
    }),
    operation: () => operations.get(ids.operation),
    revoke: () => {
      revoked = true;
    },
    reads: () => reads,
  };
}

function content(version = 1) {
  const core = {
    ...snapshot(false),
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
function command(version = 1) {
  return {
    action: version === 1 ? ("CreateDraft" as const) : ("ReplaceDraft" as const),
    operationReference: version === 1 ? ids.operation : id(77),
    expectedAggregateVersion: version === 1 ? null : 1,
    candidate: content(version),
    occurredAt: at,
  };
}
it("native owning service creates/replaces and recovers original full-content digest", async () => {
  const f = fixture(),
    first = command();
  expect(await f.service.execute(first)).toMatchObject({
    status: "Applied",
    content: { profile: "RecipeMeasurementContentV2" },
  });
  expect(await f.service.execute(first)).toMatchObject({ status: "AlreadyApplied" });
  const replacement = command(2);
  expect(await f.service.execute(replacement)).toMatchObject({
    status: "Applied",
    aggregate: { aggregateVersion: 2 },
  });
  expect(await f.service.execute(first)).toMatchObject({
    status: "AlreadyApplied",
    aggregate: { aggregateVersion: 1 },
  });
});
it("changed unit pin cannot recover the original operation even with recomputed complete digest", async () => {
  const f = fixture(),
    first = command();
  await f.service.execute(first);
  const raw = {
    ...first.candidate,
    measurements: [{ ...first.candidate.measurements[0], usageUnitCode: "G", targetUnitCode: "G" }],
  };
  const changed = requireRecipeMeasurementContentDigest({
    ...raw,
    snapshot: { ...raw.snapshot, snapshotDigest: digest(raw) },
  });
  await expect(f.service.execute({ ...first, candidate: changed })).rejects.toMatchObject({
    code: "RECIPE_IDEMPOTENCY_CONFLICT",
  });
});
it("revocation applies before original replay and no syntax result supplies publication admission", async () => {
  const f = fixture(),
    first = command();
  await f.service.execute(first);
  f.revoke();
  await expect(f.service.execute(first)).rejects.toMatchObject({
    code: "RECIPE_PERMISSION_DENIED",
  });
  const fresh = fixture();
  for (const action of ["Publish", "Invalidate", "Archive"])
    await expect(fresh.service.execute({ ...first, action } as never)).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
  expect(fresh.reads()).toBe(0);
});
it("native expected-version check rejects stale replacement", async () => {
  const f = fixture({ stale: true });
  await f.service.execute(command());
  await expect(f.service.execute(command(2))).rejects.toMatchObject({
    code: "RECIPE_VERSION_CONFLICT",
  });
});
it("rejects changed digest and accessors before any repository call", async () => {
  const f = fixture(),
    value = command();
  await expect(
    f.service.execute({
      ...value,
      candidate: {
        ...value.candidate,
        snapshot: {
          ...value.candidate.snapshot,
          snapshotDigest: parseRecipeDigest("sha256:" + "f".repeat(64)),
        },
      },
    }),
  ).rejects.toMatchObject({ code: "RECIPE_INPUT_INVALID" });
  let entered = false;
  Object.defineProperty(value, "action", {
    get() {
      entered = true;
      return "CreateDraft";
    },
    enumerable: true,
  });
  await expect(f.service.execute(value)).rejects.toMatchObject({ code: "RECIPE_INPUT_INVALID" });
  expect(entered).toBe(false);
  expect(f.reads()).toBe(0);
});
let record: RecipeOperationRecord | null = null,
  stored: unknown = null,
  mode = "";
beforeEach(() => {
  record = null;
  stored = null;
  mode = "";
  vi.clearAllMocks();
});
function repository(c = content()) {
  const tx = {
    query: vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
      void values;
      if (sql.startsWith("INSERT INTO rms_recipe.recipe_measurement_content")) {
        if (mode === "insert") throw new Error("unrestricted raw DB error");
        stored = c;
        if (mode === "query") tx.query = vi.fn(async () => ({ rows: [] }));
        return { rowCount: mode === "rowCount" ? 0 : 1, rows: [] };
      }
      if (sql.startsWith("SELECT content_json"))
        return {
          rows: stored ? [{ content_json: stored, content_digest: c.snapshot.snapshotDigest }] : [],
        };
      return { rows: [] };
    }),
  };
  protocol.base.mockImplementation(() => ({
    resolveOperation: async () => record,
    load: async () => null,
    codeAvailable: async () => true,
    create: async (input: { record: RecipeOperationRecord }) => {
      record = input.record;
      return record;
    },
    commit: async (input: { record: RecipeOperationRecord }) => {
      record = input.record;
      return record;
    },
  }));
  const runner = {
    async run<T>(work: (actual: typeof tx) => Promise<T>) {
      const result = await work(tx);
      if (mode === "runner") throw new Error("unrestricted runner error");
      if (mode === "duplicate") await work(tx);
      return mode === "result" ? ({ wrong: true } as T) : result;
    },
  };
  return {
    tx,
    store: createPostgresRecipeMeasurementDraftStore(runner, ids.brand, () => id(88), c),
  };
}
async function nativeRecord() {
  const f = fixture();
  await f.service.execute(command());
  const r = f.operation();
  if (!r) throw new Error("fixture record");
  return r;
}
it("own repository protocol delegates full core and appends exact V2 content", async () => {
  const r = await nativeRecord(),
    h = repository();
  expect(await h.store.create({ record: r, audit: {} as never })).toEqual(r);
  expect(await h.store.resolveMeasurementOperation(ids.operation)).toMatchObject({
    record: r,
    content: content(),
  });
});
it.each(["insert", "query", "rowCount", "duplicate", "result", "runner"])(
  "own repository bounds %s failure and never exposes raw error",
  async (key) => {
    const r = await nativeRecord(),
      h = repository();
    mode = key;
    await expect(h.store.create({ record: r, audit: {} as never })).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
    mode = "";
    await expect(h.store.codeAvailable({} as never)).rejects.toMatchObject({
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("durable replay refuses missing or substituted full content", async () => {
  const r = await nativeRecord(),
    h = repository();
  record = r;
  await expect(h.store.resolveOperation(ids.operation)).rejects.toMatchObject({
    code: "RECIPE_DEPENDENCY_UNAVAILABLE",
  });
  const fresh = repository();
  record = r;
  stored = {
    ...content(),
    snapshot: { ...content().snapshot, snapshotDigest: "sha256:" + "f".repeat(64) },
  };
  await expect(fresh.store.resolveOperation(ids.operation)).rejects.toMatchObject({
    code: "RECIPE_DEPENDENCY_UNAVAILABLE",
  });
});
