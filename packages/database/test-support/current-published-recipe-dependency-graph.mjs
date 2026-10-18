import assert from "node:assert/strict";
import pg from "pg";
import { createHash } from "node:crypto";
import { createRecipeService } from "../../rms/recipe/src/index.ts";
import { createPostgresRecipeStore } from "../../rms/recipe/src/infrastructure/persistence/recipe-store.ts";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createCurrentPublishedRecipeDependencyGraphSource,
  currentPublishedRecipeDependencyGraphFields,
  assessRecipeMeasurementAmounts,
  digestRecipeMeasurementContentV2,
  calculateRecipeMeasurementDemand,
} from "../../rms/recipe/src/index.ts";
import { exerciseCurrentProductRecipeGraphIngredients } from "./current-product-recipe-graph-ingredients.mjs";
/** Actual isolated owning writer fixture. Scope/field permission remains synthetic. */
export async function exerciseCurrentPublishedRecipeDependencyGraph({
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
}) {
  let sequence = 45000;
  const next = () => id(sequence++);
  let child;
  async function command(action, candidate, expected, tx = null) {
    const operationReference = next(),
      auditId = next();
    const evidence = {
      recipeReference: candidate.recipeReference,
      versionReference: candidate.versionReference,
      brandReference: id(2),
      snapshotDigest: candidate.snapshotDigest,
      draftAuthorActorReference: id(3),
      reviews: [
        {
          reviewReference: next(),
          reviewKind: "Cost",
          reviewerActorReference: id(13),
          evidenceDigest: "sha256:" + "b".repeat(64),
          decision: "Approved",
          reviewedAt: candidate.createdAt,
        },
        {
          reviewReference: next(),
          reviewKind: "FoodSafety",
          reviewerActorReference: id(15),
          evidenceDigest: "sha256:" + "c".repeat(64),
          decision: "Approved",
          reviewedAt: candidate.createdAt,
        },
      ],
    };
    const store = tx
      ? createPostgresRecipeStore({ run: (work) => work(tx) }, id(2), next)
      : writer();
    const service = createRecipeService({
      authorization: {
        authorize: async () => ({
          tenantContext,
          permission: permission("recipe.manage"),
          costReviewPermission: permission("recipe.cost-review"),
          foodSafetyReviewPermission: permission("recipe.food-safety-review"),
          draftAuthorActorReference: id(3),
          costReviewerActorReference: id(13),
          foodSafetyReviewerActorReference: id(15),
          publicationEvidence: evidence,
          audit: {
            ...audit,
            auditId,
            targetId: candidate.recipeReference,
            correlationId: operationReference,
            actionCode: "RECIPE_" + action.toUpperCase(),
            occurredAt: candidate.createdAt,
          },
        }),
      },
      references: {
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      },
      facts: {
        validate: async () => ({
          referencesValid: true,
          mappingsComplete: true,
          allergenEvidenceVerified: true,
          costEvidenceVerified: true,
          graphSnapshots:
            child && candidate.recipeReference !== child.recipeReference ? [child] : [],
        }),
      },
      repository: store,
    });
    assert.equal(
      (
        await service.execute({
          action,
          operationReference,
          expectedAggregateVersion: expected,
          candidate,
          occurredAt: candidate.createdAt,
        })
      ).status,
      "Applied",
    );
    const stored = await store.resolveOperation(operationReference);
    assert.equal(stored.action, action);
    return { operationReference, evidence, auditId };
  }
  const childDraft = {
    ...published,
    recipeReference: next(),
    versionReference: next(),
    stableCode: "SYNTHETIC_GRAPH_CHILD",
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Draft",
  };
  await command("CreateDraft", childDraft, null);
  child = {
    ...childDraft,
    versionReference: next(),
    aggregateVersion: 2,
    versionNumber: 2,
    lifecycle: "Published",
  };
  const childProof = await command("Publish", child, 1);
  const parentDraft = {
    ...childDraft,
    recipeReference: next(),
    versionReference: next(),
    stableCode: "SYNTHETIC_GRAPH_PARENT",
    ingredients: [
      {
        ...published.ingredients[0],
        requirementReference: next(),
        sourceKind: "SubRecipe",
        sourceReference: child.recipeReference,
        sourceVersionReference: child.versionReference,
        unitDimension: child.yieldDimension,
      },
    ],
  };
  await command("CreateDraft", parentDraft, null);
  const parent = {
    ...parentDraft,
    versionReference: next(),
    aggregateVersion: 2,
    versionNumber: 2,
    lifecycle: "Published",
  };
  const parentProof = await command("Publish", parent, 1);
  const tables = [
    "rms_recipe.recipe",
    "rms_recipe.recipe_version",
    "rms_recipe.recipe_ingredient_requirement",
    "rms_recipe.recipe_allergen_evidence",
    "rms_recipe.recipe_preparation_step",
    "rms_recipe.recipe_scope_binding",
    "rms_recipe.recipe_review_record",
    "rms_recipe.recipe_operation_record",
    "platform_audit.audit_record",
    "platform_audit.audit_chain_head",
    "platform_eventing.outbox_event",
  ];
  async function state() {
    const result = [];
    for (const table of tables)
      result.push(
        (await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`))
          .rows,
      );
    return result;
  }
  const baseline = await state();
  const input = {
    request: {
      purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
      brandReference: id(2),
      actorReference: id(3),
      operationReference: id(40000),
      catalogIntentDigest: "sha256:" + "a".repeat(64),
    },
    observedAt: at,
    validUntil: new Date(Date.parse(at) + 20000).toISOString(),
    activationAt: new Date(Date.parse(at) + 3600000).toISOString(),
    recipeVersions: [
      { recipeReference: parent.recipeReference, versionReference: parent.versionReference },
    ],
  };
  async function run(probe = null, selector = input) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    let reached = false,
      entered = false,
      armed = false,
      allowed = true,
      clock = at;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL lock_timeout='5s'");
      const tx = { query: async (sql, values) => client.query(sql, [...values]) };
      const source = createCurrentPublishedRecipeDependencyGraphSource({
        tenantReference: id(40001),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => clock },
        transactions: { run: async (work) => work(tx) },
        authority: {
          async holdUntilTransactionCompletes(actual, fields) {
            assert.equal(actual, tx);
            assert.deepEqual(fields.requiredFields, currentPublishedRecipeDependencyGraphFields);
            assert.equal(fields.permission, "recipe.manage");
            assert.equal(fields.requiredScope, "FullBrandScope");
            if (!allowed) {
              reached = armed;
              throw new Error("synthetic current content permission revoked");
            }
          },
        },
      });
      const result = await source.withCurrentGraph(selector, async (content) => {
        entered = true;
        assert.equal(content.contents.length, 2);
        const root = content.contents.find(
            (c) => c.snapshot.recipeReference === parent.recipeReference,
          ),
          pinned = content.contents.find(
            (c) => c.snapshot.recipeReference === child.recipeReference,
          );
        assert.deepEqual(root.snapshot, parent);
        assert.deepEqual(pinned.snapshot, child);
        assert.equal(root.publicationOperationReference, parentProof.operationReference);
        assert.equal(pinned.publicationOperationReference, childProof.operationReference);
        assert.equal(
          root.publicationEvidenceDigest,
          "sha256:" + sha256Hex(canonicalizeRfc8785(parentProof.evidence)),
        );
        assert.equal(content.subrecipeGraph, "PassForPinnedPublishedSubrecipes");
        assert.equal(content.publishValidation, "Incomplete");
        assert.equal(content.unitsAndConversions, "NotEvaluated");
        assert.equal(content.eligibility, "NotEvaluated");
        const { digest, ...body } = content;
        assert.equal(digest, "sha256:" + sha256Hex(canonicalizeRfc8785(body)));
        // Synthetic V2 authoring candidate; actual child facts come from the owning held graph.
        const candidate = {
          profile: "RecipeMeasurementContentV2",
          snapshot: { ...root.snapshot, lifecycle: "Draft", versionReference: next() },
          measurements: root.snapshot.ingredients.map((i) => ({
            requirementReference: i.requirementReference,
            usageUnitCode: pinned.snapshot.yieldUnitCode,
            usageDimension: i.unitDimension,
            targetUnitCode: pinned.snapshot.yieldUnitCode,
            targetDimension: pinned.snapshot.yieldDimension,
            conversionKind: "PinnedSubrecipeYieldIdentity",
            conversionReference: null,
          })),
        };
        candidate.snapshot.snapshotDigest = digestRecipeMeasurementContentV2(candidate);
        const children = content.contents
          .filter((c) => c.snapshot.versionReference !== root.snapshot.versionReference)
          .map((c) => c.snapshot);
        const amounts = assessRecipeMeasurementAmounts(candidate, children, at, at);
        assert.equal(amounts.quantityArithmetic, "Pass");
        assert.equal(amounts.sourceAuthority, "NotEvaluated");
        assert.equal(amounts.recursiveDemand, "NotEvaluated");
        assert.deepEqual(amounts.matches[0].batchFactor, { numerator: "21", denominator: "20" });
        assert.equal(amounts.matches[0].childSnapshotDigest, pinned.snapshot.snapshotDigest);
        const mismatch = {
          ...candidate,
          measurements: [
            {
              ...candidate.measurements[0],
              usageUnitCode: "UNKNOWN_UNIT",
              targetUnitCode: "UNKNOWN_UNIT",
            },
          ],
        };
        mismatch.snapshot = {
          ...candidate.snapshot,
          snapshotDigest: digestRecipeMeasurementContentV2(mismatch),
        };
        assert.equal(
          assessRecipeMeasurementAmounts(mismatch, children, at, at).matches[0].status,
          "PinnedYieldUnitMismatch",
        );
        // Complete child V2 representation is synthetic; physical graph remains legacy Published evidence.
        const childV2 = {
          profile: "RecipeMeasurementContentV2",
          snapshot: pinned.snapshot,
          measurements: pinned.snapshot.ingredients.map((i) => ({
            requirementReference: i.requirementReference,
            usageUnitCode: "KG",
            usageDimension: i.unitDimension,
            targetUnitCode: "KG",
            targetDimension: i.unitDimension,
            conversionKind: "InventoryBaseUnitIdentity",
            conversionReference: null,
          })),
        };
        childV2.snapshot = {
          ...childV2.snapshot,
          snapshotDigest: digestRecipeMeasurementContentV2(childV2),
        };
        const recursive = calculateRecipeMeasurementDemand(
          candidate,
          [childV2],
          candidate.snapshot.yieldQuantityMicrounits,
          at,
          at,
        );
        assert.equal(recursive.demands.length, 1);
        assert.equal(recursive.demands[0].quantityNumerator, "1102500");
        assert.equal(recursive.demands[0].quantityDenominator, "1");
        assert.equal(recursive.demands[0].sourcePath.length, 2);
        assert.equal(recursive.inventoryPrecision, "NotEvaluated");
        if (probe) {
          const marker = await client.query(
            "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND recipe_id=$2",
            [id(2), id(1)],
          );
          assert.equal(marker.rowCount, 1);
          armed = true;
          if (probe === "lossPrecision") {
            const fractional = {
              ...candidate,
              snapshot: {
                ...candidate.snapshot,
                ingredients: [
                  {
                    ...candidate.snapshot.ingredients[0],
                    quantityMicrounits: "1",
                    lossBasisPoints: 1,
                  },
                ],
              },
            };
            fractional.snapshot.snapshotDigest = digestRecipeMeasurementContentV2(fractional);
            const refused = assessRecipeMeasurementAmounts(fractional, children, at, at);
            assert.equal(refused.quantityArithmetic, "HardError");
            assert.equal(refused.matches[0].status, "LossRoundingRequired");
            assert.equal(refused.matches[0].batchFactor, null);
            reached = true;
            throw new Error("synthetic fractional-loss admission refusal");
          }
          if (probe === "missingV2Child") {
            assert.throws(() =>
              calculateRecipeMeasurementDemand(
                candidate,
                [],
                candidate.snapshot.yieldQuantityMicrounits,
                at,
                at,
              ),
            );
            reached = true;
            throw new Error("synthetic incomplete V2 demand admission refusal");
          }
          if (probe === "fields") allowed = false;
          if (probe === "root") {
            await client.query(
              "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND recipe_id=$2",
              [id(2), child.recipeReference],
            );
            reached = true;
          }
          if (probe === "review") {
            // Owning migration's DO INSTEAD NOTHING rule preserves review history.
            const attempted = await client.query(
              "UPDATE rms_recipe.recipe_review_record SET evidence_digest=$1 WHERE review_id=$2",
              ["sha256:" + "e".repeat(64), childProof.evidence.reviews[0].reviewReference],
            );
            assert.equal(attempted.rowCount, 0);
            const unchanged = await client.query(
              "SELECT evidence_digest FROM rms_recipe.recipe_review_record WHERE review_id=$1",
              [childProof.evidence.reviews[0].reviewReference],
            );
            assert.equal(
              unchanged.rows[0].evidence_digest,
              childProof.evidence.reviews[0].evidenceDigest,
            );
            reached = true;
            throw new Error("synthetic attempted immutable review mutation preserved");
          }
          if (probe === "archive") {
            const archived = {
              ...child,
              versionReference: next(),
              aggregateVersion: 3,
              versionNumber: 3,
              lifecycle: "Archived",
              createdAt: new Date(Date.parse(at) + 1).toISOString(),
            };
            const applied = await command("Archive", archived, 2, tx);
            const auditCount = await client.query(
              "SELECT count(*)::int AS count FROM platform_audit.audit_record WHERE audit_id=$1",
              [applied.auditId],
            );
            assert.equal(auditCount.rows[0].count, 1);
            const actual = await client.query(
              "SELECT snapshot_json->>'lifecycle' AS lifecycle FROM rms_recipe.recipe_version WHERE recipe_version_id=$1",
              [archived.versionReference],
            );
            assert.equal(actual.rows[0].lifecycle, "Archived");
            reached = true;
          }
          if (probe === "expiry") {
            clock = new Date(Date.parse(at) + 5000).toISOString();
            reached = true;
          }
          if (probe === "query") {
            tx.query = async () => ({ rows: [] });
            reached = true;
          }
        }
        return "read";
      });
      assert.equal(probe, null);
      assert.equal(result, "read");
      await client.query("COMMIT");
      return { entered, reached };
    } catch (error) {
      await client.query("ROLLBACK");
      assert.equal(error.code, "RECIPE_DEPENDENCY_UNAVAILABLE");
      if (probe) {
        assert(entered && armed && reached, "intended late probe must be reached: " + probe);
        return { entered, reached };
      }
      assert.equal(entered, false);
      return { entered, reached };
    } finally {
      await client.end();
    }
  }
  assert.equal((await run()).entered, true);
  assert.deepEqual(await state(), baseline);
  for (const selector of [
    { ...input, recipeVersions: [{ recipeReference: id(60), versionReference: id(99) }] },
    { ...input, activationAt: "2026-07-01T00:00:00.000Z" },
    { ...input, recipeVersions: [{ recipeReference: id(1), versionReference: id(4) }] },
  ]) {
    assert.equal((await run(null, selector)).entered, false);
    assert.deepEqual(await state(), baseline);
  }
  for (const probe of ["fields", "root", "review", "archive", "expiry", "query"]) {
    await run(probe);
    assert.deepEqual(await state(), baseline);
  }
  await run("lossPrecision");
  assert.deepEqual(await state(), baseline);
  await run("missingV2Child");
  assert.deepEqual(await state(), baseline);
  await exerciseCurrentProductRecipeGraphIngredients({
    admin,
    context,
    role,
    parent,
    child,
    id,
    at,
  });
}
