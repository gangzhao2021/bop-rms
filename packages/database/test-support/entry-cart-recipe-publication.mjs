import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createRecipeService, createPostgresRecipeStore } from "../../rms/recipe/src/index.ts";

/** Owner publication over the original Cart recipe, with explicitly synthetic review/ingredient authority. */
export async function publishEntryCartRecipe({ admin, role, runner, snapshot, id, at }) {
  let sequence = 40000;
  const next = () => id(++sequence);
  const actor = next(),
    cost = next(),
    safety = next();
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  await admin.query("GRANT USAGE ON SCHEMA rms_recipe,platform_eventing,platform_audit TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement,rms_recipe.recipe_allergen_evidence,rms_recipe.recipe_preparation_step,rms_recipe.recipe_operation_record,rms_recipe.recipe_review_record,platform_audit.audit_record,platform_eventing.outbox_event TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
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
      displayName: "Synthetic Entry Recipe Brand",
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
    reviews: [
      ["Cost", cost],
      ["FoodSafety", safety],
    ].map(([reviewKind, reviewerActorReference]) => ({
      reviewReference: next(),
      reviewKind,
      reviewerActorReference,
      evidenceDigest: hash("SYNTHETIC_ENTRY_" + reviewKind),
      decision: "Approved",
      reviewedAt: at,
    })),
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
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
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
    lifecycle: "Draft",
    aggregateVersion: 1,
    versionNumber: 1,
  };
  const created = await service.execute({
    action: "CreateDraft",
    operationReference: next(),
    expectedAggregateVersion: null,
    candidate: draft,
    occurredAt: at,
  });
  assert.equal(created.status, "Applied");
  const published = await service.execute({
    action: "Publish",
    operationReference: next(),
    expectedAggregateVersion: 1,
    candidate: snapshot,
    occurredAt: at,
  });
  assert.equal(published.status, "Applied");
}
