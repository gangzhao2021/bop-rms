import { createEffectivePeriod } from "@bop/effective-period";
import { createBrand, createTenantContext } from "@bop/tenant";
import { describe, expect, it } from "vitest";
import {
  createRecipeService,
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeReference,
  type RecipeOperationRecord,
  type RecipePorts,
  type RecipeSnapshot,
} from "../index.js";

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
  let aggregate: RecipeSnapshot | null = snapshot(false);
  const operations = new Map<string, RecipeOperationRecord>();
  const ports: RecipePorts = {
    authorization: {
      async authorize(input) {
        return {
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
  return { service: createRecipeService(ports), operation: () => operations.get(ids.operation) };
}
describe("Recipe administration service", () => {
  it("publishes with dual review and replays the atomic Event result", async () => {
    const target = fixture();
    const input = {
      action: "Publish" as const,
      operationReference: ids.operation,
      expectedAggregateVersion: 1,
      candidate: snapshot(true),
      occurredAt: at,
    };
    expect(await target.service.execute(input)).toMatchObject({
      status: "Applied",
      aggregate: { lifecycle: "Published" },
    });
    expect(target.operation()?.event).toMatchObject({
      eventType: "RecipePublished",
      aggregateVersion: 2,
    });
    expect(await target.service.execute(input)).toMatchObject({ status: "AlreadyApplied" });
  });
  it("rejects non-independent reviewers and stale Expected Version", async () => {
    const input = {
      action: "Publish" as const,
      operationReference: ids.operation,
      expectedAggregateVersion: 1,
      candidate: snapshot(true),
      occurredAt: at,
    };
    await expect(fixture({ sameReviewers: true }).service.execute(input)).rejects.toMatchObject({
      code: "RECIPE_DUAL_REVIEW_REQUIRED",
    });
    await expect(fixture({ stale: true }).service.execute(input)).rejects.toMatchObject({
      code: "RECIPE_VERSION_CONFLICT",
    });
  });
});
