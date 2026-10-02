import { exerciseCurrentProductRecipeMeasurements } from "../test-support/current-product-recipe-measurements.mjs";
import { exerciseRecipeMeasurementSubrecipePublication } from "../test-support/recipe-measurement-subrecipe-publication.mjs";
import { exerciseCurrentPublishedRecipeMeasurementGraph } from "../test-support/current-published-recipe-measurement-graph.mjs";
import { exerciseRecipeMeasurementPublication } from "../test-support/recipe-measurement-publication.mjs";
import { exerciseRecipeIngredientUnitSource } from "../test-support/recipe-ingredient-unit-source.mjs";
import { exerciseRecipeMeasurementDrafts } from "../test-support/recipe-measurement-drafts.mjs";
import { exerciseCurrentPublishedRecipeDependencyGraph } from "../test-support/current-published-recipe-dependency-graph.mjs";
import { exerciseCurrentProductRecipeIngredientReferences } from "../test-support/current-product-recipe-ingredient-references.mjs";
import { exerciseCurrentPublishedRecipeContent } from "../test-support/current-published-recipe-content.mjs";
import { exerciseRecipeAdminQuery } from "../test-support/recipe-admin-query.mjs";
import { exerciseRecipeInventoryObservation } from "../test-support/recipe-inventory-observation.mjs";
import { createPostgresSaleRecipeDemandSource } from "../../rms/recipe/src/index.ts";
import { createMerchantMenuPublicationCommand } from "../../../apps/api/src/merchant-menu-publication-command.ts";
import { withMenuPublicationHttp } from "../../../apps/api/test-support/menu-publication-http.mjs";
const menuAuthority = vi.hoisted(() => ({ resolve: null }));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope:
    () =>
    (...args) =>
      menuAuthority.resolve(...args),
}));
import { createMenuReviewCreationSource } from "../../../apps/api/src/menu-review-creation-source.ts";
import {
  createMenuReviewPreparationSource,
  createMenuReviewDependencyBindingSource,
} from "../../../apps/api/src/menu-review-preparation-source.ts";
import { createPostgresMenuReviewContentStore } from "../../rms/catalog/src/index.ts";
import { seedPriceMenuOwnerFacts } from "../test-support/price-menu-owner-facts.mjs";
import {
  createMenuRecipeAllergenSource,
  createCompleteMenuRecipeAllergenSource,
} from "../../../apps/api/src/menu-recipe-allergen-source.ts";
import { createPostgresRecipeReviewSource } from "../../rms/recipe/src/index.ts";
import { exerciseRecipePreparationContent } from "../test-support/recipe-preparation-content.mjs";
import { finalValidationFixture } from "../../rms/inventory/src/tests/submission-final-validation.fixture.ts";
import {
  createCustomerSubmissionInventorySource,
  createCustomerSubmissionFinalInventoryRecipeSource,
} from "../../../apps/api/src/customer-submission-inventory-source.ts";
import { createPostgresSubmissionRecipeDemandSource } from "../../rms/recipe/src/index.ts";
import { createRecipeModifierService } from "../../rms/recipe/src/application/recipe-modifier-service.ts";
import { createPostgresRecipeModifierWriteStore } from "../../rms/recipe/src/infrastructure/persistence/recipe-modifier-write-store.ts";
import { createPostgresConfiguredRecipeDemandSource } from "../../rms/recipe/src/index.ts";
import { createPostgresRecipeModifierSource } from "../../rms/recipe/src/index.ts";
import { createPostgresBaseRecipeDemandSource } from "../../rms/recipe/src/index.ts";
import { createHash } from "node:crypto";
import { createPostgresBaseRecipeSource } from "../../rms/recipe/src/index.ts";
import { createRecipeService } from "../../rms/recipe/src/index.ts";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createPostgresRecipeStore } from "../../rms/recipe/src/infrastructure/persistence/recipe-store.ts";
import { insertRecipeVersion } from "../../rms/recipe/src/infrastructure/persistence/recipe-version-write.ts";
import { createPostgresRecipeQueryStore } from "../../rms/recipe/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (c) => `sha256:${c.repeat(64)}`;
const at = "2026-08-13T18:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2105_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_RECIPE',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    const snapshot = {
      recipeReference: id(1),
      versionReference: id(4),
      brandReference: id(2),
      stableCode: "SYNTHETIC_RECIPE",
      aggregateVersion: 2,
      versionNumber: 1,
      snapshotDigest: digest("a"),
      lifecycle: "Published",
      displayNameCode: "SYNTHETIC_NAME",
      yieldQuantityMicrounits: "1000000",
      yieldUnitCode: "PORTION",
      yieldDimension: "Count",
      ingredients: [
        {
          requirementReference: id(6),
          sourceKind: "InventoryItem",
          sourceReference: id(7),
          sourceVersionReference: id(8),
          quantityMicrounits: "1000000",
          unitDimension: "Mass",
          conversionNumerator: "1",
          conversionDenominator: "1",
          lossBasisPoints: 500,
          unitCostMinorNumerator: "3",
          unitCostDenominator: "1000000",
          allergens: [{ allergenReference: id(10), evidenceReference: id(11), verified: true }],
        },
      ],
      preparationVersionReference: id(5),
      steps: [
        {
          stepReference: id(22),
          sequenceGroup: 0,
          instructionCode: "PREPARE",
          durationSeconds: 60,
          capabilityCode: "PREP",
        },
      ],
      substitutionPolicyReference: null,
      effectivePeriod: {
        timeZone: "America/Toronto",
        effectiveFrom: {
          instant: at,
          localDateTime: "2026-08-13T14:00:00.000",
          utcOffsetMinutes: -240,
        },
        effectiveUntil: null,
      },
      invalidationReasonCode: null,
      createdAt: at,
    };
    await admin.query("BEGIN");
    try {
      await insertRecipeVersion(
        { query: (sql, values) => admin.query(sql, [...values]) },
        snapshot,
        () => id(9),
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    await admin.query(
      `UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2,updated_at=$2 WHERE recipe_id=$3`,
      [id(4), at, id(1)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_recipe.recipe_allergen_evidence(recipe_allergen_evidence_id,requirement_id,brand_id,allergen_id,evidence_id,verified,recipe_version_id) VALUES($1,$2,$3,$4,$5,true,$6)`,
        [id(19), id(6), id(99), id(20), id(21), id(4)],
      ),
      /recipe_allergen_requirement_fk/u,
    );
    await admin.query(
      `INSERT INTO rms_recipe.recipe_review_record(review_id,recipe_version_id,recipe_id,brand_id,review_kind,reviewer_actor_id,evidence_digest,decision,reviewed_at) VALUES($1,$2,$3,$4,'Cost',$5,$6,'Approved',$7),($8,$2,$3,$4,'FoodSafety',$9,$10,'Approved',$7)`,
      [id(12), id(4), id(1), id(2), id(13), digest("b"), at, id(14), id(15), digest("c")],
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_recipe.recipe_version SET yield_quantity_microunits=1 WHERE recipe_version_id=$1`,
          [id(4)],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_recipe.recipe_ingredient_requirement(requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id,quantity_microunits,unit_dimension,conversion_numerator,conversion_denominator,loss_basis_points,unit_cost_minor_numerator,unit_cost_denominator) VALUES($1,$2,$3,$4,'InventoryItem',$5,$6,1.5,'Mass',1,1,0,0,1)`,
        [id(16), id(4), id(1), id(2), id(17), id(18)],
      ),
      /recipe_ingredient_requirement_quantity_microunits_check/u,
    );
    const next = { ...snapshot, versionReference: id(40), versionNumber: 2, aggregateVersion: 3 };
    await admin.query("BEGIN");
    try {
      await insertRecipeVersion(
        { query: (sql, values) => admin.query(sql, [...values]) },
        next,
        () => id(41),
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    const retained = await admin.query(
      "SELECT count(*)::int AS count FROM rms_recipe.recipe_ingredient_requirement WHERE requirement_id=$1",
      [id(6)],
    );
    assert.equal(retained.rows[0].count, 2);
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_recipe,platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO ${role}`);
    await admin.query(
      `GRANT SELECT ON rms_recipe.recipe,rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement TO ${role}`,
    );
    await admin.query("GRANT USAGE ON SCHEMA platform_audit,platform_eventing TO " + role);
    await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_store_id() TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT ON rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement,rms_recipe.recipe_allergen_evidence,rms_recipe.recipe_preparation_step,rms_recipe.recipe_operation_record,rms_recipe.recipe_review_record,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    await admin.query("GRANT INSERT ON platform_eventing.outbox_event TO " + role);
    let generated = 100;
    function writer(failAudit = false) {
      return createPostgresRecipeStore(
        {
          async run(work) {
            const client = new Client(context.clientConfig);
            await client.connect();
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            try {
              const result = await work({
                async query(sql, values) {
                  if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                    throw new Error("synthetic Audit failure");
                  return client.query(sql, [...values]);
                },
              });
              await client.query("COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
            }
          },
        },
        id(2),
        () => id(generated++),
      );
    }
    const draft = {
      ...snapshot,
      recipeReference: id(60),
      versionReference: id(61),
      stableCode: "SYNTHETIC_ATOMIC",
      aggregateVersion: 1,
      versionNumber: 1,
      lifecycle: "Draft",
    };
    const record = {
      action: "CreateDraft",
      operationReference: id(62),
      operationIntentHash: digest("d"),
      actorReference: id(3),
      publicationEvidence: null,
      aggregate: draft,
      event: {
        eventType: "RecipeDraftCreated",
        recipeReference: draft.recipeReference,
        versionReference: draft.versionReference,
        brandReference: draft.brandReference,
        aggregateVersion: 1,
        lifecycle: "Draft",
        snapshotDigest: draft.snapshotDigest,
        occurredAt: at,
      },
    };
    const audit = {
      auditId: id(63),
      brandId: id(2),
      actor: { type: "User", reference: id(3) },
      actionCode: "RECIPE_CREATEDRAFT",
      targetType: "Recipe",
      targetId: id(60),
      reasonCode: "SYNTHETIC_TEST",
      correlationId: id(62),
      occurredAt: at,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "SYNTHETIC_AUDIT",
      retentionPolicyVersion: 1,
    };
    await assert.rejects(writer(true).create({ record, audit }), {
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe WHERE recipe_id=$1",
          [id(60)],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int AS count FROM platform_eventing.outbox_event"))
        .rows[0].count,
      0,
    );
    await writer().create({ record, audit });
    const recovered = await writer().create({ record, audit: { ...audit, auditId: id(64) } });
    assert.deepEqual(recovered, record);
    assert.deepEqual(await writer().resolveOperation(id(62)), record);
    await assert.rejects(
      writer().create({
        record: { ...record, actorReference: id(99) },
        audit: { ...audit, actor: { type: "User", reference: id(99) }, auditId: id(65) },
      }),
      { code: "RECIPE_IDEMPOTENCY_CONFLICT" },
    );
    const atomicCounts = await admin.query(
      "SELECT (SELECT count(*)::int FROM platform_audit.audit_record) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) AS events,(SELECT count(*)::int FROM rms_recipe.recipe_operation_record) AS operations",
    );
    assert.deepEqual(atomicCounts.rows, [{ audits: 1, events: 1, operations: 1 }]);
    const replacements = [70, 80].map((n) => {
      const aggregate = {
        ...draft,
        versionReference: id(n),
        versionNumber: 2,
        aggregateVersion: 2,
      };
      return {
        record: {
          ...record,
          action: "ReplaceDraft",
          operationReference: id(n + 1),
          operationIntentHash: digest(n === 70 ? "e" : "f"),
          aggregate,
          event: {
            ...record.event,
            eventType: "RecipeDraftReplaced",
            versionReference: id(n),
            aggregateVersion: 2,
          },
        },
        expectedAggregateVersion: 1,
        audit: {
          ...audit,
          auditId: id(n + 2),
          actionCode: "RECIPE_REPLACEDRAFT",
          correlationId: id(n + 1),
        },
      };
    });
    const outcomes = await Promise.allSettled(replacements.map((input) => writer().commit(input)));
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = outcomes.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "RECIPE_VERSION_CONFLICT");
    const savedVersions = await admin.query(
      "SELECT count(*)::int AS count FROM rms_recipe.recipe_version WHERE recipe_id=$1",
      [id(60)],
    );
    assert.equal(savedVersions.rows[0].count, 2);
    const committedCounts = await admin.query(
      "SELECT (SELECT count(*)::int FROM platform_audit.audit_record) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) AS events,(SELECT count(*)::int FROM rms_recipe.recipe_operation_record) AS operations",
    );
    assert.deepEqual(committedCounts.rows, [{ audits: 2, events: 2, operations: 2 }]);
    const published = {
      ...draft,
      versionReference: id(90),
      versionNumber: 3,
      aggregateVersion: 3,
      lifecycle: "Published",
    };
    const publicationEvidence = {
      recipeReference: id(60),
      versionReference: id(90),
      brandReference: id(2),
      snapshotDigest: published.snapshotDigest,
      draftAuthorActorReference: id(3),
      reviews: [
        {
          reviewReference: id(91),
          reviewKind: "Cost",
          reviewerActorReference: id(13),
          evidenceDigest: digest("b"),
          decision: "Approved",
          reviewedAt: at,
        },
        {
          reviewReference: id(92),
          reviewKind: "FoodSafety",
          reviewerActorReference: id(15),
          evidenceDigest: digest("c"),
          decision: "Approved",
          reviewedAt: at,
        },
      ],
    };
    const publishInput = {
      record: {
        ...record,
        action: "Publish",
        operationReference: id(93),
        operationIntentHash: digest("a"),
        aggregate: published,
        publicationEvidence,
        event: {
          ...record.event,
          eventType: "RecipePublished",
          versionReference: id(90),
          aggregateVersion: 3,
          lifecycle: "Published",
        },
      },
      expectedAggregateVersion: 2,
      audit: { ...audit, auditId: id(94), actionCode: "RECIPE_PUBLISH", correlationId: id(93) },
    };
    await assert.rejects(writer(true).commit(publishInput), {
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_review_record WHERE recipe_id=$1",
          [id(60)],
        )
      ).rows[0].count,
      0,
    );
    const tenantContext = createTenantContext(
      {
        actorType: "User",
        actorReference: id(3),
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      },
      createBrand({
        brandReference: id(2),
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
      policySnapshotReference: id(95),
      policyVersion: 1,
      audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
    });
    let revoked = false;
    const service = createRecipeService({
      authorization: {
        async authorize() {
          if (revoked) return null;
          return {
            tenantContext,
            permission: permission("recipe.manage"),
            costReviewPermission: permission("recipe.cost-review"),
            foodSafetyReviewPermission: permission("recipe.food-safety-review"),
            draftAuthorActorReference: id(3),
            costReviewerActorReference: id(13),
            foodSafetyReviewerActorReference: id(15),
            publicationEvidence,
            audit: publishInput.audit,
          };
        },
      },
      references: {
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      },
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
      repository: writer(),
    });
    const serviceInput = {
      action: "Publish",
      operationReference: id(93),
      expectedAggregateVersion: 2,
      candidate: published,
      occurredAt: at,
    };
    assert.equal((await service.execute(serviceInput)).status, "Applied");
    assert.equal((await service.execute(serviceInput)).status, "AlreadyApplied");
    revoked = true;
    await assert.rejects(service.execute(serviceInput), { code: "RECIPE_PERMISSION_DENIED" });
    await exerciseCurrentPublishedRecipeContent({
      admin,
      context,
      role,
      published,
      publicationEvidence,
      id,
      at,
    });
    await exerciseCurrentProductRecipeIngredientReferences({
      admin,
      context,
      role,
      published,
      id,
      at,
    });

    assert.deepEqual(
      (await writer().resolveOperation(id(93))).publicationEvidence,
      publicationEvidence,
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_review_record WHERE recipe_id=$1",
          [id(60)],
        )
      ).rows[0].count,
      2,
    );
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding (recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES ($1,$2,$3,$4,$5,NULL,$6)",
      [id(200), id(90), id(60), id(2), id(201), at],
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_recipe.recipe`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_recipe.recipe`)).rowCount, 2);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_recipe.recipe_ingredient_requirement`)).rowCount,
      5,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_recipe.recipe`)).rowCount, 0);
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
    const query = createPostgresRecipeQueryStore(runner, id(2));
    assert.deepEqual(await query.load(id(1)), snapshot);
    assert.equal(await createPostgresRecipeQueryStore(runner, id(99)).load(id(1)), null);
    assert.equal(
      await query.codeAvailable({
        brandReference: id(2),
        stableCode: "SYNTHETIC_RECIPE",
        excludingRecipeReference: null,
      }),
      false,
    );
    const baseSource = createPostgresBaseRecipeSource(runner, id(2));
    const baseInput = { storeReference: id(202), skuReference: id(201), occurredAt: at };
    assert.equal((await baseSource.resolve(baseInput)).snapshot.versionReference, id(90));
    const theoretical = await createPostgresBaseRecipeDemandSource(runner, id(2)).resolve({
      ...baseInput,
      requestedYieldMicrounits: "1000000",
    });
    assert.equal(theoretical.snapshot.versionReference, id(90));
    assert.equal(theoretical.requirements[0].quantityNumerator, "1050000");
    assert.equal(theoretical.requirements[0].quantityDenominator, "1");
    assert.equal(theoretical.requirements[0].sourcePath[0].versionReference, id(90));
    await assert.rejects(baseSource.resolve({ ...baseInput, skuReference: id(999) }), {
      code: "RECIPE_EVIDENCE_INCOMPLETE",
    });
    await admin.query(
      "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
      [id(2), id(202)],
    );
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding (recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id(203), id(90), id(60), id(2), id(201), id(202), at],
    );
    assert.equal((await baseSource.resolve(baseInput)).bindingReference, id(203));
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding (recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id(204), id(90), id(60), id(2), id(201), id(202), "2026-08-13T17:59:59.999Z"],
    );
    await assert.rejects(baseSource.resolve(baseInput), { code: "RECIPE_EVIDENCE_INCOMPLETE" });
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding (recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from,effective_until) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7)",
      [id(205), id(90), id(60), id(2), id(206), at, "2026-08-13T18:01:00.000Z"],
    );
    assert.equal(
      (await baseSource.resolve({ ...baseInput, skuReference: id(206) })).bindingReference,
      id(205),
    );
    await assert.rejects(
      baseSource.resolve({
        ...baseInput,
        skuReference: id(206),
        occurredAt: "2026-08-13T18:01:00.000Z",
      }),
      { code: "RECIPE_EVIDENCE_INCOMPLETE" },
    );
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding (recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id(207), id(4), id(1), id(2), id(206), id(202), at],
    );
    await admin.query("UPDATE rms_recipe.recipe SET current_version_id=NULL WHERE recipe_id=$1", [
      id(1),
    ]);
    await assert.rejects(baseSource.resolve({ ...baseInput, skuReference: id(206) }), {
      code: "RECIPE_EVIDENCE_INCOMPLETE",
    });
    // Explicit synthetic three-level published Recipe graph.
    const grand = {
      ...snapshot,
      recipeReference: id(330),
      versionReference: id(331),
      stableCode: "SYNTHETIC_GRAND",
      aggregateVersion: 1,
      versionNumber: 1,
      yieldDimension: "Mass",
      yieldUnitCode: "KG",
    };
    const child = {
      ...grand,
      recipeReference: id(310),
      versionReference: id(311),
      stableCode: "SYNTHETIC_CHILD",
      ingredients: [
        {
          ...snapshot.ingredients[0],
          sourceKind: "SubRecipe",
          sourceReference: id(330),
          sourceVersionReference: id(331),
        },
      ],
    };
    const parent = {
      ...snapshot,
      recipeReference: id(300),
      versionReference: id(301),
      stableCode: "SYNTHETIC_PARENT",
      aggregateVersion: 1,
      versionNumber: 1,
      ingredients: [
        {
          ...snapshot.ingredients[0],
          sourceKind: "SubRecipe",
          sourceReference: id(310),
          sourceVersionReference: id(311),
        },
      ],
    };
    let graphReference = 1000;
    for (const node of [grand, child, parent]) {
      await admin.query(
        "INSERT INTO rms_recipe.recipe (recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,$3,1,$4,$5,$4)",
        [node.recipeReference, id(2), node.stableCode, at, id(3)],
      );
      await insertRecipeVersion(
        { query: (sql, values) => admin.query(sql, [...values]) },
        node,
        () => id(graphReference++),
      );
      await admin.query("UPDATE rms_recipe.recipe SET current_version_id=$1 WHERE recipe_id=$2", [
        node.versionReference,
        node.recipeReference,
      ]);
    }
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding (recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,effective_from) VALUES ($1,$2,$3,$4,$5,$6)",
      [id(340), id(301), id(300), id(2), id(341), at],
    );
    const nestedInput = {
      ...baseInput,
      skuReference: id(341),
      requestedYieldMicrounits: "1000000",
    };
    const nested = await createPostgresBaseRecipeDemandSource(runner, id(2)).resolve(nestedInput);
    assert.equal(nested.graph.length, 2);
    assert.equal(nested.requirements[0].quantityNumerator, "1157625");
    assert.equal(nested.requirements[0].quantityDenominator, "1");
    assert.deepEqual(
      nested.requirements[0].sourcePath.map((part) => part.versionReference),
      [id(301), id(311), id(331)],
    );
    await admin.query("UPDATE rms_recipe.recipe SET current_version_id=NULL WHERE recipe_id=$1", [
      id(330),
    ]);
    await assert.rejects(createPostgresBaseRecipeDemandSource(runner, id(2)).resolve(nestedInput), {
      code: "RECIPE_EVIDENCE_INCOMPLETE",
    });
    const modifier = {
      ruleReference: id(400),
      ruleVersionReference: id(401),
      ruleDigest: digest("a"),
      brandReference: id(2),
      recipeVersionReference: id(90),
      selection: { bindingReference: id(402), optionReference: id(403), quantity: 1 },
      changes: [],
    };
    async function seedModifier(
      rule,
      version,
      operation,
      lifecycle = "Draft",
      evidence = null,
      effectiveFrom = at,
    ) {
      return admin.query(
        "INSERT INTO rms_recipe.recipe_modifier_version (rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,operation_id,actor_id,audit_id,occurred_at,review_evidence_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$15,$9,$10,$17,$12,$13,$14,$11,$16)",
        [
          rule.ruleVersionReference,
          rule.ruleReference,
          id(2),
          version,
          id(60),
          id(90),
          id(402),
          id(403),
          rule.ruleDigest,
          rule,
          at,
          operation,
          id(3),
          id(404),
          lifecycle,
          evidence,
          effectiveFrom,
        ],
      );
    }
    await seedModifier(modifier, 1, id(405));
    await assert.rejects(
      seedModifier({ ...modifier, ruleVersionReference: id(406) }, 3, id(407)),
      /Recipe modifier version conflict/u,
    );
    await seedModifier({ ...modifier, ruleVersionReference: id(408) }, 2, id(409));
    assert.equal(
      (await admin.query("SELECT count(*)::int AS count FROM rms_recipe.recipe_modifier_version"))
        .rows[0].count,
      2,
    );
    const activeModifier = {
      ...modifier,
      ruleVersionReference: id(410),
      changes: [
        {
          action: "Add",
          ingredient: {
            ...published.ingredients[0],
            requirementReference: id(420),
            sourceKind: "SubRecipe",
            sourceReference: grand.recipeReference,
            sourceVersionReference: grand.versionReference,
            allergens: [],
          },
        },
      ],
    };
    const modifierProof = {
      ruleReference: id(400),
      ruleVersionReference: id(410),
      brandReference: id(2),
      recipeVersionReference: id(90),
      ruleDigest: activeModifier.ruleDigest,
      draftAuthorActorReference: id(3),
      reviews: publicationEvidence.reviews,
    };
    await seedModifier(activeModifier, 3, id(411), "Published", modifierProof);
    const modifierSource = createPostgresRecipeModifierSource(runner);
    assert.deepEqual(await modifierSource.resolve(published, [modifier.selection], at), [
      activeModifier,
    ]);
    await assert.rejects(
      modifierSource.resolve(published, [{ ...modifier.selection, quantity: 2 }], at),
      { code: "RECIPE_EVIDENCE_INCOMPLETE" },
    );
    const configuredInput = {
      ...baseInput,
      storeReference: id(500),
      skuReference: id(206),
      requestedYieldMicrounits: "1000000",
      selections: [modifier.selection],
    };
    const configuredSource = createPostgresConfiguredRecipeDemandSource(runner, id(2));
    await assert.rejects(configuredSource.resolve(configuredInput), {
      code: "RECIPE_EVIDENCE_INCOMPLETE",
    });
    await admin.query("UPDATE rms_recipe.recipe SET current_version_id=$1 WHERE recipe_id=$2", [
      grand.versionReference,
      grand.recipeReference,
    ]);
    const configuredDemand = await configuredSource.resolve(configuredInput);
    assert.equal(configuredDemand.snapshot.versionReference, published.versionReference);
    assert.deepEqual(configuredDemand.snapshot.ingredients, published.ingredients);
    assert.equal(configuredDemand.graph.length, 1);
    assert.equal(configuredDemand.graph[0].versionReference, grand.versionReference);
    assert.equal(
      configuredDemand.appliedRules[0].ruleVersionReference,
      activeModifier.ruleVersionReference,
    );
    assert.equal(configuredDemand.requirements.length, 2);
    assert.equal(configuredDemand.requirements[1].quantityNumerator, "1102500");
    assert.equal(configuredDemand.requirements[1].quantityDenominator, "1");
    assert.deepEqual(
      configuredDemand.requirements[1].sourcePath.map((part) => part.versionReference),
      [id(90), grand.versionReference],
    );
    await admin.query("RESET ROLE");
    await admin.query(
      "GRANT UPDATE ON rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version TO " +
        role,
    );
    await admin.query("SET ROLE " + role);
    const reviewInput = {
      actorType: "User",
      actorReference: id(3),
      action: "ResolveMenuRecipeFacts",
      purpose: "ReviewMenu",
      brandReference: id(2),
      storeReference: id(500),
      skuReference: id(206),
      observedAt: at,
      selections: [modifier.selection],
    };
    let reviewAllowed = true;
    const reviewSource = createPostgresRecipeReviewSource({
      brandReference: id(2),
      authorize: async () => reviewAllowed,
    });
    const review = await runner.run((tx) => reviewSource.resolve(tx, reviewInput));
    assert.deepEqual(review.snapshot, published);
    assert.deepEqual(review.modifierRules, [activeModifier]);
    assert.equal(review.graph[0].versionReference, grand.versionReference);
    assert.equal(
      review.configuredIngredients.some(
        (item) => item.sourceVersionReference === grand.versionReference,
      ),
      true,
    );
    assert.match(review.sourceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      (
        await runner.run((tx) =>
          reviewSource.resolve(tx, {
            ...reviewInput,
            observedAt: "2026-08-13T18:00:01.000Z",
          }),
        )
      ).sourceDigest,
      review.sourceDigest,
    );
    for (const patch of [
      { brandReference: id(99) },
      { skuReference: id(999) },
      { selections: [modifier.selection, modifier.selection] },
      { selections: [{ ...modifier.selection, quantity: 2 }] },
    ])
      await assert.rejects(
        runner.run((tx) => reviewSource.resolve(tx, { ...reviewInput, ...patch })),
        { code: "RECIPE_EVIDENCE_INCOMPLETE" },
      );
    reviewAllowed = false;
    await assert.rejects(
      runner.run((tx) => reviewSource.resolve(tx, reviewInput)),
      { code: "RECIPE_PERMISSION_DENIED" },
    );
    let reviewChecks = 0;
    await assert.rejects(
      runner.run((tx) =>
        createPostgresRecipeReviewSource({
          brandReference: id(2),
          authorize: async () => ++reviewChecks === 1,
        }).resolve(tx, reviewInput),
      ),
      { code: "RECIPE_PERMISSION_DENIED" },
    );
    // Actual cross-owner rows; source document/approval content remains synthetic.
    await admin.query("RESET ROLE");
    await admin.query("GRANT USAGE ON SCHEMA rms_catalog TO " + role);
    await admin.query(
      "GRANT SELECT,UPDATE ON rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion TO " +
        role,
    );
    await admin.query(
      "INSERT INTO rms_catalog.allergen_registry_version VALUES($1,$2,'CA',$3,$4,$5,'Approved')",
      [id(9900), id(2), digest("a"), at, id(3)],
    );
    await admin.query(
      "INSERT INTO rms_catalog.allergen_registry_entry VALUES($1,$2,$3,'MILK',$4)",
      [id(9900), id(2), id(10), JSON.stringify({ "en-CA": "Milk" })],
    );
    await admin.query(
      "INSERT INTO rms_catalog.allergen_source_evidence VALUES($1,$2,$3,'Ingredient',$4,NULL,$5,$6,$7,'Approved')",
      [id(11), id(2), id(7), id(8), digest("b"), at, "2026-08-14T18:00:00.000Z"],
    );
    await admin.query(
      "INSERT INTO rms_catalog.allergen_source_assertion VALUES($1,$2,$3,$4,'Contains')",
      [id(11), id(2), id(9900), id(10)],
    );
    await admin.query("SET ROLE " + role);
    let catalogReviewAllowed = true;
    const linkedSource = createMenuRecipeAllergenSource({
      brandReference: id(2),
      authorize: async (_tx, _input, owner) => owner !== "Catalog" || catalogReviewAllowed,
    });
    const linkedInput = {
      recipe: reviewInput,
      registryVersionReference: id(9900),
      defaultLocale: "en-CA",
    };
    const linked = await runner.run((tx) => linkedSource.resolve(tx, linkedInput));
    assert.deepEqual(linked.evidenceReferences, [id(11)]);
    assert.equal(linked.allergens.evidence[0].subjectReference, id(7));
    assert.equal(linked.allergens.evidence[0].sourceVersionReference, id(8));
    assert.equal(linked.recipe.graph[0].versionReference, grand.versionReference);
    assert.equal(linked.allergens.evidence[0].assertions[0].classification, "Contains");
    const completeSource = createCompleteMenuRecipeAllergenSource({
      brandReference: id(2),
      authorize: async () => true,
    });
    // Catalog rules are fixture input here; both Recipe variants and Catalog evidence are real rows.
    const completeInput = {
      recipe: reviewInput,
      registryVersionReference: id(9900),
      defaultLocale: "en-CA",
      budget: { maximumConfigurations: 10, maximumSearchSteps: 1000 },
      rules: [
        {
          bindingReference: modifier.selection.bindingReference,
          optionSetVersionReference: id(9910),
          activationOptionReferences: [],
          minimumQuantity: 0,
          maximumQuantity: 1,
          options: [
            {
              optionReference: modifier.selection.optionReference,
              maximumQuantity: 1,
              conflictOptionReferences: [],
            },
          ],
        },
      ],
    };
    const completeEvidence = await runner.run((tx) => completeSource.resolve(tx, completeInput));
    assert.equal(completeEvidence.configurations.length, 2);
    assert.equal(completeEvidence.configurations[0].recipe.modifierRules.length, 0);
    assert.deepEqual(completeEvidence.configurations[1].recipe.modifierRules, [activeModifier]);
    assert.equal(completeEvidence.allergens.evidence.length, 1);
    const laterComplete = await runner.run((tx) =>
      completeSource.resolve(tx, {
        ...completeInput,
        recipe: { ...reviewInput, observedAt: "2026-08-13T18:00:01.000Z" },
      }),
    );
    assert.equal(laterComplete.sourceDigest, completeEvidence.sourceDigest);
    await assert.rejects(
      runner.run((tx) =>
        completeSource.resolve(tx, {
          ...completeInput,
          rules: [
            {
              ...completeInput.rules[0],
              maximumQuantity: 2,
              options: [{ ...completeInput.rules[0].options[0], maximumQuantity: 2 }],
            },
          ],
        }),
      ),
      { code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" },
    );
    await admin.query("RESET ROLE");
    const menuScope = await seedPriceMenuOwnerFacts(
      admin,
      role,
      {
        brandReference: id(2),
        entries: [{ sellableReference: id(206) }],
        unitOfSale: "PORTION",
        unitQuantity: "2.5",
      },
      id,
      at,
    );
    await admin.query(
      "UPDATE rms_catalog.sellable_placement SET localized_name_overrides_json=$2 WHERE placement_id=$1",
      [id(805), JSON.stringify({ "en-CA": "Menu-fixed" })],
    );
    await admin.query("GRANT SELECT ON rms_catalog.menu_section_category TO " + role);
    await admin.query(
      "GRANT SELECT,UPDATE ON rms_catalog.sku,rms_catalog.product_version,rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON rms_catalog.menu_review_content,platform_audit.audit_record TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    await admin.query("SET ROLE " + role);
    let menuAllowed = true;
    const menuSource = createMenuReviewPreparationSource({
      brandReference: id(2),
      authorize: async () => menuAllowed,
    });
    const menuInput = {
      actorReference: id(3),
      menuReference: menuScope.menuReference,
      lifecycleReference: id(9920),
      validationEvidenceReference: id(9921),
      registryVersionReference: id(9900),
      observedAt: at,
      budget: { maximumConfigurations: 10, maximumSearchSteps: 1000 },
    };
    const menuStore = createPostgresMenuReviewContentStore({
      brandReference: id(2),
      menuReference: menuScope.menuReference,
      authorize: async () => true,
    });
    const prepared = await runner.run(async (tx) => {
      const result = await menuSource.prepare(tx, menuInput);
      await menuStore.save(tx, result.record, {
        auditId: id(9922),
        brandId: id(2),
        actor: { type: "User", reference: id(3) },
        actionCode: "CATALOG_MENU_SNAPSHOT_CREATED",
        targetType: "CatalogMenuVersion",
        targetId: id(801),
        correlationId: id(9923),
        occurredAt: at,
        reasonCode: "SYNTHETIC_TEST",
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      return result;
    });
    assert.equal(prepared.resolvedConfigurations, 2);
    assert.match(prepared.record.dependencyDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(prepared.validation.snapshotDigest, prepared.record.snapshotDigest);
    assert.equal(
      prepared.record.content.sections[0].sellables[0].localizedNames["en-CA"],
      "Menu-fixed",
    );
    const stored = await runner.run((tx) =>
      menuStore.read(tx, id(801), prepared.record.snapshotDigest, at),
    );
    assert.deepEqual(stored, prepared.record);
    const dependencyBinding = createMenuReviewDependencyBindingSource({
      brandReference: id(2),
      authorize: async () => menuAllowed,
      budget: menuInput.budget,
    });
    const dependencyRequest = {
      actorReference: id(3),
      menuReference: menuScope.menuReference,
      menuVersionReference: id(801),
      snapshotDigest: prepared.record.snapshotDigest,
      observedAt: "2026-08-13T18:00:01.000Z",
      validationEvidenceReference: id(9921),
    };
    assert.deepEqual(
      await runner.run((tx) => dependencyBinding.resolve(tx, dependencyRequest)),
      prepared.record,
    );
    const laterMenu = await runner.run((tx) =>
      menuSource.prepare(tx, {
        ...menuInput,
        observedAt: "2026-08-13T18:00:01.000Z",
      }),
    );
    assert.equal(laterMenu.record.snapshotDigest, prepared.record.snapshotDigest);
    await assert.rejects(
      runner.run((tx) =>
        menuSource.prepare(tx, {
          ...menuInput,
          budget: { ...menuInput.budget, maximumConfigurations: 1 },
        }),
      ),
      { code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" },
    );
    menuAllowed = false;
    await assert.rejects(
      runner.run((tx) => menuSource.prepare(tx, menuInput)),
      { code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" },
    );
    menuAllowed = true;
    await admin.query("RESET ROLE");
    await admin.query("UPDATE rms_catalog.sku SET localized_names_json=$2 WHERE sku_id=$1", [
      id(206),
      JSON.stringify({ "en-CA": "Changed source" }),
    ]);
    await admin.query("SET ROLE " + role);
    const changedMenu = await runner.run((tx) => menuSource.prepare(tx, menuInput));
    assert.deepEqual(changedMenu.record.content, prepared.record.content);
    assert.notEqual(changedMenu.record.dependencyDigest, prepared.record.dependencyDigest);
    assert.notEqual(changedMenu.record.snapshotDigest, prepared.record.snapshotDigest);
    await assert.rejects(
      runner.run((tx) => dependencyBinding.resolve(tx, dependencyRequest)),
      { code: "MENU_REVIEW_DEPENDENCY_CHANGED" },
    );
    assert.deepEqual(
      await runner.run((tx) => menuStore.read(tx, id(801), prepared.record.snapshotDigest, at)),
      prepared.record,
    );
    await admin.query("RESET ROLE");
    await admin.query("GRANT USAGE ON SCHEMA bop_publishing TO " + role);
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON bop_publishing.publishing_mutation_record TO " + role,
    );
    await admin.query("SET ROLE " + role);
    let creationAllowed = true;
    const creation = createMenuReviewCreationSource({
      tenantReference: id(9960),
      brandReference: id(2),
      budget: menuInput.budget,
      authorize: async () => creationAllowed,
      reference: (purpose, operation) => {
        const offset = {
          Lifecycle: 1,
          Validation: 2,
          ReviewOperation: 3,
          ContentAudit: 4,
          DraftAudit: 5,
          ReviewAudit: 6,
        }[purpose];
        return id(Number.parseInt(operation.slice(-12), 16) + offset);
      },
    });
    const creationInput = {
      actorReference: id(3),
      menuReference: menuScope.menuReference,
      menuVersionReference: id(801),
      configurationDigest: changedMenu.record.configurationDigest,
      registryVersionReference: id(9900),
      operationReference: id(9950),
      observedAt: at,
    };
    const creationCounts = async () => {
      await admin.query("RESET ROLE");
      const row = (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_catalog.menu_review_content) content,(SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) mutations,(SELECT count(*)::int FROM platform_audit.audit_record) audits",
        )
      ).rows[0];
      await admin.query("SET ROLE " + role);
      return row;
    };
    const beforeCreation = await creationCounts();
    const createdReview = await runner.run((tx) => creation.create(tx, creationInput));
    assert.equal(createdReview.status, "Created");
    const afterCreation = await creationCounts();
    assert.deepEqual(afterCreation, {
      content: beforeCreation.content + 1,
      mutations: beforeCreation.mutations + 2,
      audits: beforeCreation.audits + 3,
    });
    assert.equal(createdReview.record.dependencyDigest, changedMenu.record.dependencyDigest);
    const recoveredReview = await runner.run((tx) =>
      creation.create(tx, {
        ...creationInput,
        observedAt: "2026-08-13T18:00:01.000Z",
      }),
    );
    assert.equal(recoveredReview.status, "AlreadyCreated");
    assert.deepEqual(recoveredReview.record, createdReview.record);
    assert.deepEqual(await creationCounts(), afterCreation);
    for (const patch of [
      { configurationDigest: digest("f") },
      { actorReference: id(9989) },
      { registryVersionReference: id(9988) },
    ])
      await assert.rejects(
        runner.run((tx) => creation.create(tx, { ...creationInput, ...patch })),
        { code: "CATALOG_IDEMPOTENCY_CONFLICT" },
      );
    creationAllowed = false;
    await assert.rejects(
      runner.run((tx) => creation.create(tx, creationInput)),
      { code: "CATALOG_PERMISSION_DENIED" },
    );
    creationAllowed = true;
    await admin.query("RESET ROLE");
    await admin.query("UPDATE rms_catalog.sku SET localized_names_json=$2 WHERE sku_id=$1", [
      id(206),
      JSON.stringify({ "en-CA": "Changed again" }),
    ]);
    await admin.query("SET ROLE " + role);
    assert.deepEqual(
      (await runner.run((tx) => creation.create(tx, creationInput))).record,
      createdReview.record,
    );
    let publishingInserts = 0;
    await runner.run(async (tx) => {
      const faulty = {
        query: (sql, values) => {
          if (
            sql.includes("INSERT INTO bop_publishing.publishing_mutation_record") &&
            ++publishingInserts === 2
          )
            throw new Error("synthetic last Publishing insert failure");
          return tx.query(sql, values);
        },
      };
      await assert.rejects(
        creation.create(faulty, { ...creationInput, operationReference: id(9980) }),
      );
    });
    assert.equal(publishingInserts, 2);
    assert.deepEqual(await creationCounts(), afterCreation);
    await admin.query("RESET ROLE");
    await admin.query(
      "GRANT SELECT,INSERT ON rms_catalog.menu_publication_revision,rms_catalog.menu_publication_release,rms_catalog.menu_release_effective_period,rms_catalog.menu_publication_operation_record,rms_catalog.menu_publication_operation_snapshot TO " +
        role,
    );
    await admin.query("SET ROLE " + role);
    let menuActor = id(3),
      activeReviewDigest = null;
    let invalidApprovalExpiry = false;
    let menuFaultHits = 0;
    let menuNow = at,
      menuFault = false,
      publishingPermission = true;
    menuAuthority.resolve = async () => ({
      tenantReference: id(9960),
      actorReference: menuActor,
      context: createTenantContext(
        { ...tenantContext.actor, actorReference: menuActor },
        tenantContext.brand,
        null,
        menuNow,
      ),
      authorizeAction: async (action) => ({
        ...permission(action),
        effect: action.startsWith("publishing.") && !publishingPermission ? "Deny" : "Allow",
      }),
    });
    const reviewCommand = createMerchantMenuPublicationCommand({
      merchant: {
        now: () => menuNow,
        transactions: {
          run: (work) =>
            runner.run((tx) =>
              work({
                query: (sql, values) => {
                  if (
                    menuFault &&
                    sql.includes("INSERT INTO rms_catalog.menu_publication_revision")
                  ) {
                    menuFaultHits++;
                    throw new Error("synthetic Catalog transition failure");
                  }
                  return tx.query(sql, values);
                },
              }),
            ),
        },
      },
      authentication: { authorize: async () => ({ sessionReference: id(14000) }) },
      binding: async (tx, input) => {
        assert.notEqual(activeReviewDigest, null);
        return menuStore.read(tx, input.menuVersionReference, activeReviewDigest, menuNow);
      },
      reviewApproval: {
        reference: (purpose, operation) =>
          id(Number.parseInt(operation.slice(-12), 16) + (purpose === "Approval" ? 1 : 2)),
        validUntil: ({ validationValidUntil }) =>
          invalidApprovalExpiry ? menuNow : validationValidUntil,
      },
      reference: (purpose, operation) =>
        id(
          Number.parseInt(operation.slice(-12), 16) +
            { Audit: 100, Lifecycle: 101, Release: 102, Event: 103, Timing: 104 }[purpose],
        ),
      reviewCreation: {
        budget: menuInput.budget,
        reference: (purpose, operation) =>
          id(
            Number.parseInt(operation.slice(-12), 16) +
              {
                Lifecycle: 1,
                Validation: 2,
                ReviewOperation: 3,
                ContentAudit: 4,
                DraftAudit: 5,
                ReviewAudit: 6,
              }[purpose],
          ),
      },
    });
    const reviewBody = {
      action: "CreateReview",
      operationReference: id(15000),
      menuReference: menuScope.menuReference,
      menuVersionReference: id(801),
      configurationDigest: changedMenu.record.configurationDigest,
      registryVersionReference: id(9900),
      expectedVersion: 1,
    };
    const beforeHttp = await creationCounts();
    await withMenuPublicationHttp(reviewCommand, async (post) => {
      publishingPermission = false;
      assert.equal((await post(reviewBody)).status, 403);
      publishingPermission = true;
      menuFault = true;
      assert.equal((await post(reviewBody)).status, 503);
      assert.equal(menuFaultHits, 1);
      assert.deepEqual(await creationCounts(), beforeHttp);
      menuFault = false;
      const result = await post(reviewBody);
      assert.equal(result.status, 200);
      assert.equal(result.body.state, "InReview");
      assert.equal(result.body.status, "Applied");
      activeReviewDigest = result.body.snapshotDigest;
      const afterHttp = await creationCounts();
      assert.deepEqual(afterHttp, {
        content: beforeHttp.content + 1,
        mutations: beforeHttp.mutations + 2,
        audits: beforeHttp.audits + 4,
      });
      await admin.query("RESET ROLE");
      await admin.query("UPDATE rms_catalog.sku SET localized_names_json=$2 WHERE sku_id=$1", [
        id(206),
        JSON.stringify({ "en-CA": "Changed after HTTP review" }),
      ]);
      await admin.query("SET ROLE " + role);
      menuNow = "2026-08-13T18:00:01.000Z";
      const replay = await post(reviewBody);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.status, "AlreadyApplied");
      assert.equal(replay.body.snapshotDigest, result.body.snapshotDigest);
      assert.deepEqual(await creationCounts(), afterHttp);
      assert.equal((await post({ ...reviewBody, registryVersionReference: id(9999) })).status, 409);
      assert.equal((await post({ ...reviewBody, actorReference: id(9999) })).status, 400);
      publishingPermission = false;
      assert.equal((await post(reviewBody)).status, 403);
      publishingPermission = true;
      menuActor = id(14001);
      const approvalBody = {
        action: "Approve",
        operationReference: id(16000),
        menuReference: menuScope.menuReference,
        menuVersionReference: id(801),
        expectedVersion: 2,
        snapshotDigest: activeReviewDigest,
        effectivePeriod: null,
      };
      assert.equal((await post(approvalBody)).status, 409);
      assert.deepEqual(await creationCounts(), afterHttp);
      await admin.query("RESET ROLE");
      await admin.query("UPDATE rms_catalog.sku SET localized_names_json=$2 WHERE sku_id=$1", [
        id(206),
        JSON.stringify({ "en-CA": "Changed again" }),
      ]);
      await admin.query("SET ROLE " + role);
      publishingPermission = false;
      assert.equal((await post(approvalBody)).status, 403);
      publishingPermission = true;
      invalidApprovalExpiry = true;
      assert.equal((await post(approvalBody)).status, 503);
      assert.deepEqual(await creationCounts(), afterHttp);
      invalidApprovalExpiry = false;
      menuFault = true;
      assert.equal((await post(approvalBody)).status, 503);
      assert.equal(menuFaultHits, 2);
      assert.deepEqual(await creationCounts(), afterHttp);
      menuFault = false;
      const approved = await post(approvalBody);
      assert.equal(approved.status, 200);
      assert.equal(approved.body.state, "Approved");
      assert.equal((await post(approvalBody)).body.status, "AlreadyApplied");
      publishingPermission = false;
      assert.equal((await post(approvalBody)).status, 403);
      publishingPermission = true;
      assert.deepEqual(await creationCounts(), {
        ...afterHttp,
        mutations: afterHttp.mutations + 1,
        audits: afterHttp.audits + 2,
      });
      const publicationBody = {
        ...approvalBody,
        action: "Publish",
        operationReference: id(17000),
        expectedVersion: 3,
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: {
            instant: menuNow,
            localDateTime: menuNow.slice(0, -1),
            utcOffsetMinutes: 0,
          },
          effectiveUntil: null,
        },
      };
      const published = await post(publicationBody);
      assert.equal(published.status, 200);
      assert.equal(published.body.state, "Published");
      const snapshot = await runner.run((tx) =>
        menuStore.loadExact(tx, {
          brandReference: id(2),
          menuReference: menuScope.menuReference,
          menuVersionReference: id(801),
          snapshotDigest: activeReviewDigest,
          releaseReference: published.body.releaseReference,
        }),
      );
      assert.equal(snapshot.snapshotDigest, activeReviewDigest);
      assert.equal(snapshot.sections.length, createdReview.record.content.sections.length);
      const afterPublication = await creationCounts();
      assert.equal((await post(publicationBody)).body.status, "AlreadyApplied");
      assert.deepEqual(await creationCounts(), afterPublication);
    });
    await admin.query("RESET ROLE");
    const immutableSource = await admin.query(
      "UPDATE rms_catalog.allergen_source_evidence SET source_version_id=$2 WHERE evidence_id=$1",
      [id(11), id(9990)],
    );
    assert.equal(immutableSource.rowCount, 0);
    await admin.query("SET ROLE " + role);
    const retainedSource = await runner.run((tx) => linkedSource.resolve(tx, linkedInput));
    assert.equal(retainedSource.sourceDigest, linked.sourceDigest);
    await assert.rejects(
      runner.run((tx) =>
        linkedSource.resolve(tx, {
          ...linkedInput,
          registryVersionReference: id(9991),
        }),
      ),
      { code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" },
    );
    catalogReviewAllowed = false;
    await assert.rejects(
      runner.run((tx) => linkedSource.resolve(tx, linkedInput)),
      { code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" },
    );
    const saleInput = {
      storeReference: configuredInput.storeReference,
      skuReference: configuredInput.skuReference,
      occurredAt: at,
      saleUnitCode: "PORTION",
      unitQuantity: "1",
      saleQuantity: 2,
      selections: configuredInput.selections,
    };
    const observer = new Client(context.clientConfig);
    await observer.connect();
    try {
      const saleDemand = await runner.run(async (tx) => {
        const result = await createPostgresSubmissionRecipeDemandSource(
          { run: async (work) => work(tx) },
          id(2),
        ).resolve(saleInput);
        for (const table of ["recipe", "recipe_scope_binding", "recipe_modifier_version"]) {
          await observer.query("BEGIN");
          try {
            await assert.rejects(
              observer.query("LOCK TABLE rms_recipe." + table + " IN ROW EXCLUSIVE MODE NOWAIT"),
              { code: "55P03" },
            );
          } finally {
            await observer.query("ROLLBACK");
          }
        }
        return result;
      });
      assert.equal(saleDemand.saleQuantity, 2);
      assert.equal(saleDemand.requestedYieldMicrounits, "2000000");
      assert.equal(saleDemand.requirements[1].quantityNumerator, "2205000");
      assert.equal(
        saleDemand.appliedRules[0].ruleVersionReference,
        activeModifier.ruleVersionReference,
      );
      await observer.query("BEGIN");
      try {
        await observer.query(
          "LOCK TABLE rms_recipe.recipe,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version IN ROW EXCLUSIVE MODE NOWAIT",
        );
      } finally {
        await observer.query("ROLLBACK");
      }
      const saleSource = createPostgresSubmissionRecipeDemandSource(runner, id(2));
      const packedDemand = await saleSource.resolve({ ...saleInput, unitQuantity: "2.5" });
      const observedDemand = await createPostgresSaleRecipeDemandSource(runner, id(2)).resolve({
        ...saleInput,
        unitQuantity: "2.5",
      });
      assert.deepEqual(observedDemand, packedDemand);
      await exerciseRecipeInventoryObservation({
        admin,
        role,
        runner,
        id,
        at,
        saleInput,
        requirements: observedDemand.requirements,
      });

      assert.equal(packedDemand.requestedYieldMicrounits, "5000000");
      assert.equal(packedDemand.requirements[1].quantityNumerator, "5512500");
      await assert.rejects(saleSource.resolve({ ...saleInput, saleUnitCode: "KG" }), {
        code: "RECIPE_EVIDENCE_INCOMPLETE",
      });
      await assert.rejects(saleSource.resolve({ ...saleInput, saleQuantity: 0 }), {
        code: "RECIPE_EVIDENCE_INCOMPLETE",
      });
    } finally {
      await observer.end();
    }
    const apiCatalog = {
      snapshotReference: id(9001),
      snapshotDigest: digest("a"),
      brandReference: id(2),
      storeReference: configuredInput.storeReference,
      sellableReference: configuredInput.skuReference,
      sellableType: "Sku",
      productReference: id(9002),
      productVersionReference: id(9003),
      skuReference: configuredInput.skuReference,
      menuVersionReference: id(9004),
      localizedNames: { en: "Synthetic" },
      unitOfSale: "PORTION",
      unitQuantity: "2.5",
      taxClassificationReference: id(9005),
      capturedAt: at,
      options: [
        {
          ...modifier.selection,
          optionSetVersionReference: id(9006),
          localizedNames: { en: "Synthetic option" },
        },
      ],
    };
    const apiCart = {
      cartReference: id(9007),
      brandReference: id(2),
      storeReference: configuredInput.storeReference,
      orderType: "Pickup",
      sourceChannel: "Qr",
      diningSessionReference: null,
      createdByActorReference: id(9008),
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      lifecycle: {
        status: "Active",
        policyVersionReference: id(9009),
        policyDigest: digest("b"),
        idleTimeoutSeconds: 3600,
        absoluteTimeoutSeconds: 86400,
        idleExpiresAt: new Date(Date.parse(at) + 3600000).toISOString(),
        absoluteExpiresAt: new Date(Date.parse(at) + 86400000).toISOString(),
        terminalAt: null,
        terminalReason: null,
      },
      items: [
        {
          cartItemReference: id(9010),
          cartReference: id(9007),
          sellableReference: configuredInput.skuReference,
          quantity: 2,
          optionSelections: [
            {
              optionReference: modifier.selection.optionReference,
              quantity: modifier.selection.quantity,
            },
          ],
          customerNote: null,
          catalogSelectionEvidence: {
            menuVersionReference: id(9004),
            productVersionReference: id(9003),
            catalogChannelCode: "PILOT_CHANNEL",
            catalogOrderTypeCode: "PILOT_ORDER_TYPE",
            ruleEvidence: [
              {
                bindingReference: modifier.selection.bindingReference,
                optionSetVersionReference: id(9006),
              },
            ],
            validatedAt: at,
          },
          addedByActorReference: id(9008),
          addedByParticipantReference: null,
          addedAt: at,
        },
      ],
    };
    const apiInput = {
      cart: apiCart,
      observedAt: at,
      lines: [{ cartItemReference: id(9010), catalog: apiCatalog, pricing: null }],
    };
    await runner.run(async (tx) => {
      const source = createCustomerSubmissionInventorySource(tx, {
        brandReference: id(2),
        storeReference: configuredInput.storeReference,
      });
      const result = await source.resolve(apiInput);
      assert.equal(result.cartReference, apiCart.cartReference);
      assert.equal(result.cartVersion, 1);
      assert.equal(result.contributions[1].quantityNumerator, "5512500");
      assert.equal(
        result.contributions[1].configurationOperationReference,
        configuredDemand.requirements[1].itemVersionReference,
      );
      assert.equal(result.lines[0].recipeVersionReference, published.versionReference);
      assert.match(result.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
      assert.equal((await source.resolve(apiInput)).sourceDigest, result.sourceDigest);
      const finalSource = createCustomerSubmissionFinalInventoryRecipeSource(
        tx,
        {
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: configuredInput.storeReference,
        },
        apiInput,
      );
      const proposal = {
        ...finalValidationFixture(),
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: configuredInput.storeReference,
        cartReference: apiCart.cartReference,
        cartVersion: apiCart.aggregateVersion,
        observedAt: at,
        items: [],
        reservationSet: null,
      };
      // Actual Recipe contributions; empty proposed items are not final writer acceptance.
      const finalDemand = await finalSource.resolve(proposal);
      assert.deepEqual(finalDemand.contributions, result.contributions);
      await assert.rejects(finalSource.resolve({ ...proposal, cartVersion: 2 }), {
        code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
      });
      await assert.rejects(finalSource.resolve({ ...proposal, tenantReference: id(9099) }), {
        code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
      });
      await assert.rejects(source.resolve({ ...apiInput, lines: [] }), {
        code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE",
      });
      await assert.rejects(
        source.resolve({
          ...apiInput,
          lines: [
            {
              ...apiInput.lines[0],
              catalog: {
                ...apiCatalog,
                options: [
                  {
                    ...apiCatalog.options[0],
                    bindingReference: id(9099),
                  },
                ],
              },
            },
          ],
        }),
        { code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE" },
      );
    });
    await seedModifier({ ...modifier, ruleVersionReference: id(430) }, 4, id(431));
    assert.deepEqual(await modifierSource.resolve(published, [modifier.selection], at), [
      activeModifier,
    ]);
    const scheduled = { ...activeModifier, ruleVersionReference: id(432) };
    const starts = "2026-08-13T18:01:00.000Z";
    await seedModifier(
      scheduled,
      5,
      id(433),
      "Published",
      { ...modifierProof, ruleVersionReference: scheduled.ruleVersionReference },
      starts,
    );
    assert.deepEqual(await modifierSource.resolve(published, [modifier.selection], at), [
      activeModifier,
    ]);
    assert.deepEqual(await modifierSource.resolve(published, [modifier.selection], starts), [
      scheduled,
    ]);
    await seedModifier({ ...modifier, ruleVersionReference: id(412) }, 6, id(413), "Invalidated");
    await assert.rejects(modifierSource.resolve(published, [modifier.selection], starts), {
      code: "RECIPE_EVIDENCE_INCOMPLETE",
    });
    await assert.rejects(modifierSource.resolve(published, [modifier.selection], at), {
      code: "RECIPE_EVIDENCE_INCOMPLETE",
    });
    const modifierWriter = createPostgresRecipeModifierWriteStore(runner, id(2));
    const writeRule = { ...modifier, ruleReference: id(600), ruleVersionReference: id(601) };
    const modifierAudit = {
      ...audit,
      auditId: id(603),
      targetType: "RecipeModifier",
      targetId: id(600),
      actionCode: "RECIPE_MODIFIER_DRAFT",
    };
    const writeInput = {
      base: published,
      rule: writeRule,
      version: 1,
      lifecycle: "Draft",
      operationReference: id(604),
      actorReference: id(3),
      occurredAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
      publicationEvidence: null,
      audit: modifierAudit,
    };
    await assert.rejects(
      modifierWriter.append({ ...writeInput, base: { ...published, snapshotDigest: digest("e") } }),
      { code: "RECIPE_EVIDENCE_INCOMPLETE" },
    );
    await admin.query("UPDATE rms_recipe.recipe SET current_version_id=NULL WHERE recipe_id=$1", [
      published.recipeReference,
    ]);
    await assert.rejects(modifierWriter.append(writeInput), { code: "RECIPE_EVIDENCE_INCOMPLETE" });
    await admin.query("UPDATE rms_recipe.recipe SET current_version_id=$1 WHERE recipe_id=$2", [
      published.versionReference,
      published.recipeReference,
    ]);
    let modifierAuditFailureReached = false;
    const failingModifierWriter = createPostgresRecipeModifierWriteStore(
      {
        run: (work) =>
          runner.run((tx) =>
            work({
              query: (sql, values) => {
                if (sql.startsWith("UPDATE platform_audit.audit_chain_head")) {
                  modifierAuditFailureReached = true;
                  throw new Error("synthetic modifier Audit failure");
                }
                return tx.query(sql, values);
              },
            }),
          ),
      },
      id(2),
    );
    await assert.rejects(failingModifierWriter.append(writeInput), {
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_modifier_version WHERE rule_id=$1",
          [id(600)],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(modifierAuditFailureReached, true);
    const written = await modifierWriter.append(writeInput, async () => {
      const contender = new Client(context.clientConfig);
      await contender.connect();
      try {
        await contender.query("BEGIN");
        await contender.query("SET LOCAL ROLE " + role);
        await contender.query("SELECT set_config('bop.brand_id',$1,true)", [id(2)]);
        await assert.rejects(
          contender.query(
            "SELECT recipe_id FROM rms_recipe.recipe WHERE brand_id=$1 AND recipe_id=$2 FOR UPDATE NOWAIT",
            [id(2), published.recipeReference],
          ),
          { code: "55P03" },
        );
      } finally {
        await contender.query("ROLLBACK");
        await contender.end();
      }
    });
    assert.equal(written.status, "Applied");
    const replayed = await modifierWriter.append({
      ...writeInput,
      audit: { ...modifierAudit, auditId: id(605) },
    });
    assert.equal(replayed.status, "AlreadyApplied");
    assert.equal(replayed.auditReference, id(603));
    await assert.rejects(
      modifierWriter.append({
        ...writeInput,
        actorReference: id(99),
        audit: { ...modifierAudit, actor: { type: "User", reference: id(99) } },
      }),
      { code: "RECIPE_IDEMPOTENCY_CONFLICT" },
    );
    await assert.rejects(
      modifierWriter.append({
        ...writeInput,
        operationReference: id(606),
        rule: { ...writeRule, ruleVersionReference: id(607) },
      }),
      { code: "RECIPE_VERSION_CONFLICT" },
    );
    const publishRule = { ...writeRule, ruleVersionReference: id(608) };
    const modifierPublishInput = {
      ...writeInput,
      rule: publishRule,
      version: 2,
      lifecycle: "Published",
      operationReference: id(609),
      publicationEvidence: {
        ...modifierProof,
        ruleReference: id(600),
        ruleVersionReference: id(608),
      },
      audit: { ...modifierAudit, auditId: id(610), actionCode: "RECIPE_MODIFIER_PUBLISHED" },
    };
    await assert.rejects(
      modifierWriter.append({
        ...modifierPublishInput,
        publicationEvidence: {
          ...modifierPublishInput.publicationEvidence,
          draftAuthorActorReference: id(99),
        },
      }),
      { code: "RECIPE_LIFECYCLE_CONFLICT" },
    );
    let modifierPermissionRevoked = false;
    let modifierFactsValid = false;
    let modifierFactCalls = 0;
    const modifierService = createRecipeModifierService({
      authorization: {
        async authorize() {
          if (modifierPermissionRevoked) return null;
          return {
            tenantContext,
            permission: permission("recipe.manage"),
            costReviewPermission: permission("recipe.cost-review"),
            foodSafetyReviewPermission: permission("recipe.food-safety-review"),
            draftAuthorActorReference: id(3),
            costReviewerActorReference: id(13),
            foodSafetyReviewerActorReference: id(15),
            publicationEvidence: modifierPublishInput.publicationEvidence,
            audit: modifierPublishInput.audit,
          };
        },
      },
      facts: {
        async validate() {
          modifierFactCalls++;
          return {
            referencesValid: modifierFactsValid,
            mappingsComplete: true,
            allergenEvidenceVerified: true,
            costEvidenceVerified: true,
            graphSnapshots: [],
          };
        },
      },
      repository: modifierWriter,
    });
    const modifierCommand = {
      base: published,
      rule: publishRule,
      version: 2,
      lifecycle: "Published",
      operationReference: id(609),
      occurredAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
    };
    await assert.rejects(modifierService.execute(modifierCommand), {
      code: "RECIPE_EVIDENCE_INCOMPLETE",
    });
    modifierFactsValid = true;
    assert.equal((await modifierService.execute(modifierCommand)).status, "Applied");
    assert.equal(modifierFactCalls, 2);
    modifierFactsValid = false;
    assert.equal((await modifierService.execute(modifierCommand)).status, "AlreadyApplied");
    assert.equal(modifierFactCalls, 2);
    modifierPermissionRevoked = true;
    await assert.rejects(modifierService.execute(modifierCommand), {
      code: "RECIPE_PERMISSION_DENIED",
    });
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_recipe.recipe_modifier_version WHERE rule_id=$1",
          [id(600)],
        )
      ).rows[0].count,
      2,
    );
    await admin.query("SELECT set_config('bop.store_id','',false)");
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM platform_audit.audit_record WHERE target_id=$1",
          [id(600)],
        )
      ).rows[0].count,
      2,
    );
    await admin.query("RESET ROLE");
    await assert.rejects(
      admin.query("UPDATE rms_recipe.recipe_modifier_version SET lifecycle='Archived'"),
      /Recipe modifier history is immutable/u,
    );
    await assert.rejects(
      admin.query("DELETE FROM rms_recipe.recipe_modifier_version"),
      /Recipe modifier history is immutable/u,
    );
    await admin.query("SET ROLE " + role);
    await admin.query("SELECT set_config('bop.brand_id',$1,false)", [id(99)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_recipe.recipe_modifier_version")).rowCount,
      0,
    );
    await admin.query(`RESET ROLE`);
    await exerciseRecipeAdminQuery({ admin, role, id });
    await exerciseRecipePreparationContent({
      admin,
      context,
      role,
      snapshot: published,
      rule: publishRule,
      id,
    });
    await exerciseCurrentPublishedRecipeDependencyGraph({
      admin,
      context,
      role,
      published,
      writer,
      tenantContext,
      permission,
      audit,
      id,
      at,
    });
    await exerciseRecipeMeasurementDrafts({
      admin,
      context,
      role,
      published,
      tenantContext,
      permission,
      audit,
      id,
      at,
    });
    await exerciseRecipeIngredientUnitSource({ admin, context, role, published, id, at });
    await exerciseRecipeMeasurementPublication({
      admin,
      context,
      role,
      published,
      tenantContext,
      permission,
      audit,
      id,
      at,
    });
    await exerciseCurrentPublishedRecipeMeasurementGraph({ admin, context, role, id });
    await exerciseRecipeMeasurementSubrecipePublication({
      admin,
      context,
      role,
      tenantContext,
      permission,
      audit,
      id,
      at,
    });
    await exerciseCurrentProductRecipeMeasurements({ admin, context, role, id, at });
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query("DROP OWNED BY " + role);
    await admin.query("DROP ROLE IF EXISTS " + role);
    await admin.end();
  }
}
it("keeps Recipe versions, exact quantities, dual reviews and Brand RLS immutable", async () => {
  await withIsolatedDatabase({ caseId: "recipe_management", root }, prove);
}, 120_000);
