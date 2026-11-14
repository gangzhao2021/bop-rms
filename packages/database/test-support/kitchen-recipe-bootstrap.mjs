import assert from "node:assert/strict";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import {
  createRecipeService,
  createPostgresBaseRecipeSource,
  createPostgresRecipeModifierSource,
  createPostgresRecipeStore,
  createPostgresRecipePreparationContentStore,
  createPostgresConfiguredRecipePreparationSource,
  createRecipePreparationContentBinding,
  createRecipePreparationModifierContentBinding,
} from "../../rms/recipe/src/index.ts";
import { createRecipeModifierService } from "../../rms/recipe/src/application/recipe-modifier-service.ts";
import { createPostgresRecipeModifierWriteStore } from "../../rms/recipe/src/infrastructure/persistence/recipe-modifier-write-store.ts";
import { preparationRecipeFixture } from "../../rms/recipe/src/tests/recipe-preparation-content.fixture.ts";
import { preparationPublicationFixture } from "../../rms/recipe/src/tests/recipe-preparation-publication.fixture.ts";
import { createKitchenRecipePreparationSource } from "../../../apps/api/src/kitchen-recipe-preparation-source.ts";

/** Actual publication services/storage; all external reviewer/ingredient/Store authority facts are synthetic. */
export async function bootstrapKitchenRecipe({
  admin,
  role,
  runner,
  scope,
  orderRecord,
  at,
  hash,
  references,
  capability,
  reuseInventoryRecipe = false,
}) {
  let counter = 50000;
  const next = () => "0190ee00-0000-7000-8000-" + (counter++).toString(16).padStart(12, "0");
  const actor = next(),
    cost = next(),
    safety = next();
  await admin.query("GRANT USAGE ON SCHEMA rms_recipe TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe,rms_recipe.recipe_scope_binding,rms_recipe.recipe_scope_binding_end,rms_recipe.recipe_modifier_version TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement,rms_recipe.recipe_allergen_evidence,rms_recipe.recipe_preparation_step,rms_recipe.recipe_operation_record,rms_recipe.recipe_review_record,rms_recipe.recipe_preparation_content TO " +
      role,
  );
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
      brandReference: scope.brandReference,
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
  const audit = (actionCode, targetType, targetId, operation, actorReference = actor) => ({
    auditId: next(),
    brandId: scope.brandReference,
    actor: { type: "User", reference: actorReference },
    actionCode,
    targetType,
    targetId,
    correlationId: operation,
    reasonCode: "SYNTHETIC_REVIEW",
    occurredAt: at,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  const reviews = () => [
    {
      reviewReference: next(),
      reviewKind: "Cost",
      reviewerActorReference: cost,
      evidenceDigest: hash("SYNTHETIC_COST_REVIEW"),
      decision: "Approved",
      reviewedAt: at,
    },
    {
      reviewReference: next(),
      reviewKind: "FoodSafety",
      reviewerActorReference: safety,
      evidenceDigest: hash("SYNTHETIC_SAFETY_REVIEW"),
      decision: "Approved",
      reviewedAt: at,
    },
  ];
  const authorization = (publicationEvidence, record) => ({
    tenantContext,
    permission: permission("recipe.manage"),
    costReviewPermission: permission("recipe.cost-review"),
    foodSafetyReviewPermission: permission("recipe.food-safety-review"),
    draftAuthorActorReference: actor,
    costReviewerActorReference: cost,
    foodSafetyReviewerActorReference: safety,
    publicationEvidence,
    audit: record,
  });
  const facts = {
    validate: async () => ({
      referencesValid: true,
      mappingsComplete: true,
      allergenEvidenceVerified: true,
      costEvidenceVerified: true,
      graphSnapshots: [],
    }),
  };
  let readAllowed = true;
  const contentStore = createPostgresRecipePreparationContentStore({
    brandReference: scope.brandReference,
    sha256: hash,
    authorizeRead: async () => readAllowed,
    authorizeWrite: async () => true,
    validatePublication: async () => true,
    audit: async (record) => ({
      ...audit(
        "RECIPE_PREPARATION_PUBLISHED",
        "RecipePreparationContent",
        record.content.contentReference,
        record.operationReference,
        record.actorReference,
      ),
      dataClassification: "Restricted",
      afterSummary: {
        contentKind: record.modifierRuleVersionReference === null ? "Base" : "Modifier",
      },
    }),
  });
  async function publishContent(snapshot, rule = null) {
    const template = preparationPublicationFixture(snapshot, rule).record;
    const content = { ...template.content, contentReference: next() };
    if (rule === null)
      content.steps = content.steps.map((step) => ({ ...step, capabilityReference: capability }));
    else
      content.changes = content.changes.map((change) =>
        change.action === "Remove"
          ? change
          : { ...change, step: { ...change.step, capabilityReference: capability } },
      );
    content.contentDigest = hash(
      rule === null
        ? createRecipePreparationContentBinding(content, snapshot)
        : createRecipePreparationModifierContentBinding(content, rule, snapshot),
    );
    const record = {
      ...template,
      publishedAt: at,
      operationReference: next(),
      content,
      reviewEvidence: {
        ...template.reviewEvidence,
        contentReference: content.contentReference,
        contentDigest: content.contentDigest,
        reviews: template.reviewEvidence.reviews.map((review) => ({
          ...review,
          reviewReference: next(),
        })),
      },
    };
    await runner().run((transaction) => contentStore.commit({ transaction, record }));
  }
  const skus = new Map();
  for (const item of orderRecord.items) {
    const sku = item.catalog.skuReference;
    const options = skus.get(sku) ?? new Map();
    for (const selected of item.catalog.options)
      options.set(selected.optionReference + ":" + selected.quantity, selected);
    skus.set(sku, options);
  }
  for (const [sku, selectedOptions] of skus) {
    if (reuseInventoryRecipe) {
      const existing = await createPostgresBaseRecipeSource(runner(), scope.brandReference).resolve(
        {
          storeReference: scope.storeReference,
          skuReference: sku,
          occurredAt: at,
        },
      );
      const selections = [...selectedOptions.values()].map((selected) => ({
        bindingReference: selected.bindingReference,
        optionReference: selected.optionReference,
        quantity: selected.quantity,
      }));
      const modifiers = await createPostgresRecipeModifierSource(runner()).resolve(
        existing.snapshot,
        selections,
        at,
      );
      await publishContent(existing.snapshot);
      for (const modifier of modifiers) await publishContent(existing.snapshot, modifier);
      continue;
    }
    const draft = {
      ...preparationRecipeFixture(),
      recipeReference: next(),
      versionReference: next(),
      brandReference: scope.brandReference,
      stableCode: "SYNTHETIC_KITCHEN_" + counter,
      createdAt: at,
      snapshotDigest: hash("SYNTHETIC_RECIPE_" + sku),
    };
    const published = {
      ...draft,
      versionReference: next(),
      aggregateVersion: 2,
      versionNumber: 2,
      lifecycle: "Published",
    };
    const proof = {
      recipeReference: published.recipeReference,
      versionReference: published.versionReference,
      brandReference: scope.brandReference,
      snapshotDigest: published.snapshotDigest,
      draftAuthorActorReference: actor,
      reviews: reviews(),
    };
    const service = createRecipeService({
      authorization: {
        authorize: async (input) =>
          authorization(
            input.action === "Publish" ? proof : null,
            audit(
              "RECIPE_" + input.action.toUpperCase(),
              "Recipe",
              input.recipeReference,
              input.operationReference,
            ),
          ),
      },
      references: { hashIntent: hash, equals: (a, b) => a === b },
      facts,
      repository: createPostgresRecipeStore(runner(), scope.brandReference, next),
    });
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
          candidate: published,
          occurredAt: at,
        })
      ).status,
      "Applied",
    );
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding (recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        next(),
        published.versionReference,
        published.recipeReference,
        scope.brandReference,
        sku,
        scope.storeReference,
        at,
      ],
    );
    await publishContent(published);
    for (const selected of selectedOptions.values()) {
      const rule = {
        ruleReference: next(),
        ruleVersionReference: next(),
        ruleDigest: hash("SYNTHETIC_MODIFIER_" + selected.optionReference),
        brandReference: scope.brandReference,
        recipeVersionReference: published.versionReference,
        selection: {
          bindingReference: next(),
          optionReference: selected.optionReference,
          quantity: selected.quantity,
        },
        changes: [],
      };
      const publishedRule = { ...rule, ruleVersionReference: next() };
      const modifierProof = {
        brandReference: scope.brandReference,
        recipeVersionReference: published.versionReference,
        ruleReference: publishedRule.ruleReference,
        ruleVersionReference: publishedRule.ruleVersionReference,
        ruleDigest: publishedRule.ruleDigest,
        draftAuthorActorReference: actor,
        reviews: reviews(),
      };
      const modifier = createRecipeModifierService({
        authorization: {
          authorize: async (input) =>
            authorization(
              input.lifecycle === "Published" ? modifierProof : null,
              audit(
                "RECIPE_MODIFIER_" + input.lifecycle.toUpperCase(),
                "RecipeModifier",
                input.rule.ruleReference,
                input.operationReference,
              ),
            ),
        },
        facts,
        repository: createPostgresRecipeModifierWriteStore(runner(), scope.brandReference),
      });
      for (const [version, lifecycle, value] of [
        [1, "Draft", rule],
        [2, "Published", publishedRule],
      ])
        assert.equal(
          (
            await modifier.execute({
              base: published,
              rule: value,
              version,
              lifecycle,
              operationReference: next(),
              occurredAt: at,
              effectiveFrom: at,
              effectiveUntil: null,
            })
          ).status,
          "Applied",
        );
      await publishContent(published, publishedRule);
    }
  }
  const recipe = createPostgresConfiguredRecipePreparationSource({
    brandReference: scope.brandReference,
    sha256: hash,
    content: contentStore,
    authorize: async () => readAllowed,
  });
  let oversized = false;
  const source = createKitchenRecipePreparationSource({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    recipe: {
      resolve: async (transaction, query) => {
        const result = await recipe.resolve(transaction, query);
        // Explicit malformed owner-response injection tests the adapter bound; no saved content changes.
        return oversized
          ? { ...result, display: { ...result.display, instructions: ["x".repeat(501)] } }
          : result;
      },
    },
    authorize: async () => readAllowed,
    sha256: hash,
    deriveReference: references.derive,
  });
  return {
    source,
    oversize: (value) => {
      oversized = value;
    },
    revoke: () => {
      readAllowed = false;
    },
    allow: () => {
      readAllowed = true;
    },
  };
}
