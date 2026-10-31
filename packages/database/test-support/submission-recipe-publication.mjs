import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createRecipeService, createPostgresRecipeStore } from "../../rms/recipe/src/index.ts";

/** Synthetic reviewers/facts, actual Draft/Publish commands, history and Audit. */
export async function publishSubmissionRecipe(admin, snapshot, actor, id) {
  const at = snapshot.createdAt;
  let sequence = 20000;
  const next = () => id(++sequence);
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const cost = next(),
    safety = next();
  const tenantContext = createTenantContext(
    {
      actorType: "User",
      actorReference: actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    },
    createBrand({
      brandReference: snapshot.brandReference,
      code: "RECIPE",
      displayName: "Synthetic Recipe Brand",
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
  const permission = (action) => ({
    effect: "Allow",
    reason: "ROLE_PERMISSION",
    source: "RolePermission",
    action,
    scopeKind: "Brand",
    policySnapshotReference: actor,
    policyVersion: 1,
    audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
  });
  const proof = {
    recipeReference: snapshot.recipeReference,
    versionReference: snapshot.versionReference,
    brandReference: snapshot.brandReference,
    snapshotDigest: snapshot.snapshotDigest,
    draftAuthorActorReference: actor,
    reviews: ["Cost", "FoodSafety"].map((reviewKind, index) => ({
      reviewReference: next(),
      reviewKind,
      reviewerActorReference: index === 0 ? cost : safety,
      evidenceDigest: hash("SYNTHETIC_REVIEW_" + reviewKind),
      decision: "Approved",
      reviewedAt: at,
    })),
  };
  const runner = {
    async run(work) {
      await admin.query("BEGIN");
      try {
        const result = await work({ query: (sql, values) => admin.query(sql, [...values]) });
        await admin.query("COMMIT");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    },
  };
  const service = createRecipeService({
    authorization: {
      authorize: async (input) => ({
        tenantContext,
        permission: permission("recipe.manage"),
        costReviewPermission: permission("recipe.cost-review"),
        foodSafetyReviewPermission: permission("recipe.food-safety-review"),
        draftAuthorActorReference: actor,
        costReviewerActorReference: cost,
        foodSafetyReviewerActorReference: safety,
        publicationEvidence: input.action === "Publish" ? proof : null,
        audit: {
          auditId: next(),
          brandId: snapshot.brandReference,
          actor: { type: "User", reference: actor },
          actionCode: "RECIPE_" + input.action.toUpperCase(),
          targetType: "Recipe",
          targetId: input.recipeReference,
          correlationId: input.operationReference,
          reasonCode: "SYNTHETIC_REVIEW",
          occurredAt: at,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
      }),
    },
    references: { hashIntent: hash, equals: (a, b) => a === b },
    facts: {
      validate: async () => ({
        referencesValid: true,
        mappingsComplete: true,
        allergenEvidenceVerified: true,
        costEvidenceVerified: true,
        graphSnapshots: [],
      }),
    },
    repository: createPostgresRecipeStore(runner, snapshot.brandReference, next),
  });
  const draft = {
    ...snapshot,
    versionReference: next(),
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Draft",
  };
  assert.equal(
    (
      await service.execute({
        action: "CreateDraft",
        operationReference: next(),
        expectedAggregateVersion: null,
        candidate: draft,
        occurredAt: at,
      })
    ).status,
    "Applied",
  );
  assert.equal(
    (
      await service.execute({
        action: "Publish",
        operationReference: next(),
        expectedAggregateVersion: 1,
        candidate: snapshot,
        occurredAt: at,
      })
    ).status,
    "Applied",
  );
}
