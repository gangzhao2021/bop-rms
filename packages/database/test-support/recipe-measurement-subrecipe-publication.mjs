import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { createCurrentRecipeMeasurementPublicationService } from "../../../apps/api/src/current-recipe-measurement-publication.ts";
import {
  createRecipeMeasurementDraftService,
  createPostgresRecipeMeasurementDraftStore,
  digestRecipeMeasurementContentV2,
  requireRecipeMeasurementContentDigest,
  createCurrentPublishedRecipeMeasurementGraphSource,
  calculateRecipeMeasurementDemand,
} from "../../rms/recipe/src/index.ts";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";
/** Actual full pinned V2 child/owning units/publication; authorization/review/reference declarations synthetic. */
export async function exerciseRecipeMeasurementSubrecipePublication({
  admin,
  context,
  role,
  tenantContext,
  permission,
  audit,
  id,
  at,
}) {
  let sequence = 85000;
  const next = () => id(++sequence),
    scope = { tenantReference: id(40001), brandReference: id(2) };
  const child = requireRecipeMeasurementContentDigest(
    (
      await admin.query(
        "SELECT content_json FROM rms_recipe.recipe_measurement_content WHERE brand_id=$1 AND recipe_version_id=$2",
        [id(2), id(73001)],
      )
    ).rows[0].content_json,
  );
  const complete = (raw) =>
    requireRecipeMeasurementContentDigest({
      ...raw,
      snapshot: { ...raw.snapshot, snapshotDigest: digestRecipeMeasurementContentV2(raw) },
    });
  const ingredient = child.snapshot.ingredients[0];
  assert(ingredient);
  const draftRaw = {
    profile: "RecipeMeasurementContentV2",
    snapshot: {
      ...child.snapshot,
      recipeReference: id(80001),
      versionReference: id(80002),
      stableCode: "SYNTHETIC_V2_PARENT",
      lifecycle: "Draft",
      aggregateVersion: 1,
      versionNumber: 1,
      ingredients: [
        {
          ...ingredient,
          requirementReference: id(80003),
          sourceKind: "SubRecipe",
          sourceReference: child.snapshot.recipeReference,
          sourceVersionReference: child.snapshot.versionReference,
          quantityMicrounits: "2000000",
          unitDimension: child.snapshot.yieldDimension,
          conversionNumerator: "1",
          conversionDenominator: "1",
          lossBasisPoints: 0,
        },
      ],
    },
    measurements: [
      {
        requirementReference: id(80003),
        usageUnitCode: child.snapshot.yieldUnitCode,
        usageDimension: child.snapshot.yieldDimension,
        targetUnitCode: child.snapshot.yieldUnitCode,
        targetDimension: child.snapshot.yieldDimension,
        conversionKind: "PinnedSubrecipeYieldIdentity",
        conversionReference: null,
      },
    ],
  };
  const draft = complete(draftRaw),
    content = complete({
      ...draftRaw,
      snapshot: {
        ...draftRaw.snapshot,
        lifecycle: "Published",
        aggregateVersion: 2,
        versionNumber: 2,
        versionReference: id(80004),
      },
    });
  const input = {
    action: "Publish",
    operationReference: id(80005),
    expectedAggregateVersion: 1,
    candidate: content,
    occurredAt: at,
  };
  const tables = [
    "rms_recipe.recipe",
    "rms_recipe.recipe_version",
    "rms_recipe.recipe_ingredient_requirement",
    "rms_recipe.recipe_allergen_evidence",
    "rms_recipe.recipe_preparation_step",
    "rms_recipe.recipe_scope_binding",
    "rms_recipe.recipe_review_record",
    "rms_recipe.recipe_operation_record",
    "rms_recipe.recipe_reference_generation",
    "rms_recipe.recipe_reference_binding",
    "rms_recipe.recipe_measurement_content",
    "rms_inventory.inventory_item",
    "rms_inventory.inventory_item_version",
    "rms_inventory.inventory_item_operation",
    "rms_inventory.configuration_reference_generation",
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
  async function transaction(work) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT set_config('bop.brand_id',$1,true)", [id(2)]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }
  let revoked = false;
  function ports(candidate) {
    return {
      authorization: {
        async authorize(request) {
          if (revoked) return null;
          return {
            tenantContext,
            permission: permission("recipe.manage"),
            costReviewPermission: permission("recipe.cost-review"),
            foodSafetyReviewPermission: permission("recipe.food-safety-review"),
            draftAuthorActorReference: id(3),
            costReviewerActorReference: id(4),
            foodSafetyReviewerActorReference: id(5),
            publicationEvidence: {
              recipeReference: candidate.snapshot.recipeReference,
              versionReference: candidate.snapshot.versionReference,
              brandReference: id(2),
              snapshotDigest: candidate.snapshot.snapshotDigest,
              draftAuthorActorReference: id(3),
              reviews: [
                {
                  reviewReference: next(),
                  reviewKind: "Cost",
                  reviewerActorReference: id(4),
                  evidenceDigest: "sha256:" + "c".repeat(64),
                  decision: "Approved",
                  reviewedAt: at,
                },
                {
                  reviewReference: next(),
                  reviewKind: "FoodSafety",
                  reviewerActorReference: id(5),
                  evidenceDigest: "sha256:" + "d".repeat(64),
                  decision: "Approved",
                  reviewedAt: at,
                },
              ],
            },
            audit: {
              ...audit,
              auditId: next(),
              targetId: request.recipeReference,
              correlationId: request.operationReference,
              actionCode: "RECIPE_" + request.action.toUpperCase(),
              occurredAt: request.observedAt,
            },
          };
        },
      },
      references: {
        hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
        equals: (a, b) => a === b,
      },
      facts: {
        validate: async () => ({
          referencesValid: true,
          mappingsComplete: true,
          allergenEvidenceVerified: true,
          costEvidenceVerified: true,
          graphSnapshots: [child.snapshot],
        }),
      },
    };
  }
  async function writeDraft(candidate, action, expected) {
    return transaction(async (client) => {
      const tx = { query: (sql, values) => client.query(sql, [...values]) };
      const service = createRecipeMeasurementDraftService({
        ...ports(candidate),
        repositoryForContent: () =>
          createPostgresRecipeMeasurementDraftStore(
            { run: (work) => work(tx) },
            id(2),
            next,
            candidate,
          ),
      });
      return service.execute({
        action,
        operationReference: next(),
        expectedAggregateVersion: expected,
        candidate,
        occurredAt: at,
      });
    });
  }
  assert.equal((await writeDraft(draft, "CreateDraft", null)).status, "Applied");
  // Native Recipe service currently refuses Published -> ReplaceDraft. Do not bypass
  // that owning lifecycle to fabricate a physical newer Draft fixture.
  async function deactivate(tx) {
    const result = await executeInventoryItemCommand(
      {
        ...scope,
        actorReference: id(3),
        purpose: "InventoryItemManagement",
        permission: "inventory.manage",
        occurredAt: new Date(Date.parse(at) + 2).toISOString(),
        action: "Deactivate",
        operationReference: next(),
        payload: {
          itemReference: id(7),
          expectedVersion: 2,
          reasonCode: "SYNTHETIC_SUBRECIPE_REPLAY",
        },
      },
      {
        authorization: { authorize: async () => ({ authorized: true }) },
        references: {
          generate: next,
          hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
          equals: (a, b) => a === b,
        },
        audit: {
          create: async ({ command, after }) => ({
            auditId: next(),
            brandId: id(2),
            actor: { type: "User", reference: id(3) },
            actionCode: "INVENTORY_ITEM_DEACTIVATE",
            targetType: "InventoryItem",
            targetId: after.itemReference,
            reasonCode: "SYNTHETIC_SUBRECIPE_REPLAY",
            correlationId: command.operationReference,
            occurredAt: command.occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          }),
        },
        repository: createPostgresInventoryItemStore({ run: (work) => work(tx) }, scope),
      },
    );
    assert.equal(result.outcome, "Applied");
    assert.equal(result.item.lifecycle, "Inactive");
  }
  async function execute(value = input, mode = null) {
    let armed = false,
      appended = false,
      denied = false,
      offset = 0,
      childHolds = 0,
      unitHolds = 0;
    try {
      return await transaction(async (client) => {
        if (mode) {
          const marker = await client.query(
            "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE recipe_id=$1 AND brand_id=$2",
            [id(1), id(2)],
          );
          assert.equal(marker.rowCount, 1);
          armed = true;
        }
        const tx = {
          async query(sql, values) {
            const result = await client.query(sql, [...values]);
            if (sql.startsWith("INSERT INTO rms_recipe.recipe_measurement_content")) {
              appended = true;
              assert.equal(result.rowCount, 1);
              if (mode === "fields") denied = true;
              if (mode === "expiry") offset = 5000;
              if (mode === "query") tx.query = async () => ({ rows: [] });
            }
            return result;
          },
        };
        if (mode === "replay") await deactivate(tx);
        const service = createCurrentRecipeMeasurementPublicationService({
          ...scope,
          actorReference: id(3),
          clock: { now: () => new Date(Date.now() + offset).toISOString() },
          generateReference: next,
          recipePorts: ports(value.candidate),
          recipeAuthority: {
            async holdUntilTransactionCompletes(actual) {
              assert.equal(actual, tx);
            },
          },
          pinnedRecipes: {
            authority: {
              async holdUntilTransactionCompletes(actual) {
                assert.equal(actual, tx);
                childHolds++;
              },
            },
            measurementAuthority: {
              async holdUntilTransactionCompletes(actual) {
                assert.equal(actual, tx);
                childHolds++;
                if (denied) throw Error("synthetic late child fields refusal");
              },
            },
          },
          inventory: {
            authority: {
              async holdUntilTransactionCompletes(actual) {
                assert.equal(actual, tx);
                unitHolds++;
              },
            },
            unitAuthority: {
              async holdUntilTransactionCompletes(actual, fields) {
                assert.equal(actual, tx);
                assert.deepEqual(fields.itemReferences, [id(7)]);
                unitHolds++;
              },
            },
          },
        });
        const result = await service.execute(tx, value);
        if (result.status === "AlreadyApplied") {
          assert.equal(childHolds, 0);
          assert.equal(unitHolds, 0);
        }
        if (mode === "replay") {
          assert.equal(result.status, "AlreadyApplied");
          assert.deepEqual(result.content, content);
          throw Error("SYNTHETIC_REPLAY_CLEANUP");
        }
        if (mode) assert.fail("negative publication must refuse");
        return result;
      });
    } catch (error) {
      if (mode) {
        assert(armed);
        if (["fields", "expiry", "query"].includes(mode))
          assert(appended, "actual parent Published V2 append precedes failure");
        if (mode === "replay") assert.equal(error.message, "SYNTHETIC_REPLAY_CLEANUP");
        else assert.equal(error.code, "RECIPE_DEPENDENCY_UNAVAILABLE");
      }
      throw error;
    }
  }
  const before = await state();
  for (const mode of ["fields", "expiry", "query"]) {
    await assert.rejects(execute(input, mode), { code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    assert.deepEqual(await state(), before);
  }
  const fraction = complete({
    ...content,
    snapshot: {
      ...content.snapshot,
      ingredients: [{ ...content.snapshot.ingredients[0], quantityMicrounits: "1" }],
    },
  });
  await assert.rejects(execute({ ...input, candidate: fraction }, "precision"), {
    code: "RECIPE_DEPENDENCY_UNAVAILABLE",
  });
  assert.deepEqual(await state(), before);
  const result = await execute();
  assert.equal(result.status, "Applied");
  assert.deepEqual(result.content, content);
  const stored = (
    await admin.query(
      "SELECT m.content_json FROM rms_recipe.recipe_measurement_content m JOIN rms_recipe.recipe_version v USING(recipe_version_id,recipe_id,brand_id) WHERE v.recipe_version_id=$1 AND v.lifecycle='Published'",
      [content.snapshot.versionReference],
    )
  ).rows;
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].content_json, content);
  assert.deepEqual(
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_recipe.recipe_review_record WHERE recipe_version_id=$1) AS reviews,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$2) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$2) AS events",
        [content.snapshot.versionReference, content.snapshot.recipeReference],
      )
    ).rows,
    [{ reviews: 2, audits: 2, events: 2 }],
  );
  const baseline = await state();
  assert.equal((await execute()).status, "AlreadyApplied");
  assert.deepEqual(await state(), baseline);
  await assert.rejects(execute(input, "replay"), { message: "SYNTHETIC_REPLAY_CLEANUP" });
  assert.deepEqual(await state(), baseline);
  await assert.rejects(execute({ ...input, candidate: fraction }), {
    code: "RECIPE_IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(await state(), baseline);
  revoked = true;
  await assert.rejects(execute(), { code: "RECIPE_PERMISSION_DENIED" });
  revoked = false;
  assert.deepEqual(await state(), baseline);
  await transaction(async (client) => {
    const tx = { query: (sql, values) => client.query(sql, [...values]) },
      observedAt = new Date().toISOString();
    const source = createCurrentPublishedRecipeMeasurementGraphSource({
      ...scope,
      actorReference: id(3),
      clock: { now: () => new Date().toISOString() },
      transactions: { run: (work) => work(tx) },
      authority: {
        async holdUntilTransactionCompletes(actual) {
          assert.equal(actual, tx);
        },
      },
      measurementAuthority: {
        async holdUntilTransactionCompletes(actual) {
          assert.equal(actual, tx);
        },
      },
    });
    await source.withCurrentGraph(
      {
        request: {
          purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
          brandReference: id(2),
          actorReference: id(3),
          operationReference: next(),
          catalogIntentDigest: "sha256:" + "a".repeat(64),
        },
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        activationAt: observedAt,
        recipeVersions: [
          {
            recipeReference: content.snapshot.recipeReference,
            versionReference: content.snapshot.versionReference,
          },
        ],
      },
      async (graph) => {
        assert.equal(graph.contents.length, 2);
        assert.deepEqual(
          graph.contents.find(
            (c) => c.snapshot.versionReference === child.snapshot.versionReference,
          ).content,
          child,
        );
        assert.equal(
          graph.contents.find(
            (c) => c.snapshot.versionReference === child.snapshot.versionReference,
          ).currentRootVersionReference,
          child.snapshot.versionReference,
        );
        const demand = calculateRecipeMeasurementDemand(
          content,
          [child],
          content.snapshot.yieldQuantityMicrounits,
          observedAt,
          observedAt,
        );
        assert.equal(demand.demands.length, 1);
        assert.equal(demand.demands[0].quantityNumerator, "2100000");
        assert.equal(demand.demands[0].quantityDenominator, "1");
        assert.equal(demand.demands[0].sourcePath.length, 2);
      },
    );
  });
  assert.deepEqual(await state(), baseline);
}
