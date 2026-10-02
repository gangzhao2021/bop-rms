import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { createCurrentRecipeMeasurementPublicationService } from "../../../apps/api/src/current-recipe-measurement-publication.ts";
import {
  createPostgresRecipeMeasurementDraftStore,
  createPostgresRecipeMeasurementPublicationStore,
  digestRecipeMeasurementContentV2,
  requireRecipeMeasurementContentDigest,
  createCurrentPublishedRecipeDependencyGraphSource,
} from "../../rms/recipe/src/index.ts";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";
/** Actual current owning unit/source and V2 Published writer. Identity, review decisions and reference facts synthetic. */
export async function exerciseRecipeMeasurementPublication({
  admin,
  context,
  role,
  published,
  tenantContext,
  permission,
  audit,
  id,
  at,
}) {
  let sequence = 73500;
  const next = () => id(++sequence),
    scope = { tenantReference: id(40001), brandReference: id(2) };
  const core = {
    ...published,
    recipeReference: id(50001),
    versionReference: id(73001),
    stableCode: "SYNTHETIC_MEASUREMENT_DRAFT",
    lifecycle: "Published",
    aggregateVersion: 3,
    versionNumber: 3,
  };
  const raw = {
    profile: "RecipeMeasurementContentV2",
    snapshot: core,
    measurements: core.ingredients.map((i) => ({
      requirementReference: i.requirementReference,
      usageUnitCode: "KG",
      usageDimension: i.unitDimension,
      targetUnitCode: "KG",
      targetDimension: i.unitDimension,
      conversionKind: "InventoryBaseUnitIdentity",
      conversionReference: null,
    })),
  };
  const complete = (value) =>
    requireRecipeMeasurementContentDigest({
      ...value,
      snapshot: { ...value.snapshot, snapshotDigest: digestRecipeMeasurementContentV2(value) },
    });
  const content = complete(raw),
    input = {
      action: "Publish",
      operationReference: id(73002),
      expectedAggregateVersion: 2,
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
  const state = async () => {
    const rows = [];
    for (const table of tables)
      rows.push(
        (await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`))
          .rows,
      );
    return rows;
  };
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
        payload: { itemReference: id(7), expectedVersion: 2, reasonCode: "SYNTHETIC_LATE" },
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
            reasonCode: "SYNTHETIC_V2_PUBLICATION",
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
    assert.equal(
      (
        await tx.query(
          "SELECT count(*)::int AS count FROM platform_audit.audit_record WHERE audit_id=$1",
          [result.audit.auditId],
        )
      ).rows[0].count,
      1,
    );
  }
  let revoked = false;
  async function execute(value = input, mode = null) {
    let armed = false,
      reached = false,
      appended = false,
      metadataCalls = 0,
      unitDenied = false,
      recipeDenied = false,
      offset = 0;
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
              assert.equal(
                (
                  await client.query(
                    "SELECT count(*)::int AS count FROM rms_recipe.recipe_measurement_content WHERE recipe_version_id=$1",
                    [value.candidate.snapshot.versionReference],
                  )
                ).rows[0].count,
                1,
              );
              if (mode === "query") {
                reached = true;
                tx.query = async () => ({ rows: [] });
              }
              if (mode === "expiry") {
                reached = true;
                offset = 5000;
              }
              if (mode === "recipe") {
                reached = true;
                recipeDenied = true;
              }
              if (mode === "units") {
                reached = true;
                unitDenied = true;
              }
            }
            return result;
          },
        };
        if (mode === "inactive" || mode === "historicalReplay") {
          await deactivate(tx);
          reached = true;
        }
        const service = createCurrentRecipeMeasurementPublicationService({
          ...scope,
          actorReference: id(3),
          clock: { now: () => new Date(Date.now() + offset).toISOString() },
          generateReference: next,
          recipeAuthority: {
            async holdUntilTransactionCompletes(actual, fields) {
              assert.equal(actual, tx);
              assert.equal(fields.permission, "recipe.manage");
              assert.equal(fields.contentDigest, value.candidate.snapshot.snapshotDigest);
              if (recipeDenied) throw Error("synthetic late Recipe permission refusal");
            },
          },
          inventory: {
            authority: {
              async holdUntilTransactionCompletes(actual, fields) {
                assert.equal(actual, tx);
                assert.equal(fields.requiredScope, "FullBrandScope");
                metadataCalls++;
              },
            },
            unitAuthority: {
              async holdUntilTransactionCompletes(actual, fields) {
                assert.equal(actual, tx);
                assert.deepEqual(fields.itemReferences, [id(7)]);
                if (unitDenied) throw Error("synthetic late unit permission refusal");
              },
            },
          },
          recipePorts: {
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
                    recipeReference: value.candidate.snapshot.recipeReference,
                    versionReference: value.candidate.snapshot.versionReference,
                    brandReference: id(2),
                    snapshotDigest: value.candidate.snapshot.snapshotDigest,
                    draftAuthorActorReference: id(3),
                    reviews: [
                      {
                        reviewReference: id(73003),
                        reviewKind: "Cost",
                        reviewerActorReference: id(4),
                        evidenceDigest: "sha256:" + "c".repeat(64),
                        reviewedAt: at,
                        decision: "Approved",
                      },
                      {
                        reviewReference: id(73004),
                        reviewKind: "FoodSafety",
                        reviewerActorReference: id(5),
                        evidenceDigest: "sha256:" + "d".repeat(64),
                        reviewedAt: at,
                        decision: "Approved",
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
          },
        });
        const result = await service.execute(tx, value);
        if (result.status === "AlreadyApplied")
          assert.equal(metadataCalls, 0, "historical replay cannot demand old Item currentness");
        if (mode === "historicalReplay") {
          assert.equal(result.status, "AlreadyApplied");
          assert.deepEqual(result.content, content);
          assert.equal(metadataCalls, 0);
          throw Error("SYNTHETIC_REPLAY_CLEANUP");
        }
        if (mode) return assert.fail("negative mode must refuse");
        return result;
      });
    } catch (error) {
      if (mode) {
        assert(armed, "independent marker armed");
        if (["query", "expiry", "recipe", "units"].includes(mode)) {
          assert(appended && reached, "actual V2 Published append precedes late refusal");
        }
        if (mode === "inactive") assert(reached);
        if (mode === "historicalReplay") {
          assert(
            reached && !appended,
            "actual Item Deactivate precedes exact command replay without a new append",
          );
          assert.equal(error.message, "SYNTHETIC_REPLAY_CLEANUP");
        } else assert.equal(error.code, "RECIPE_DEPENDENCY_UNAVAILABLE");
      }
      throw error;
    }
  }
  const before = await state();
  for (const mode of ["query", "expiry", "recipe", "units", "inactive"]) {
    await assert.rejects(execute(input, mode), { code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    assert.deepEqual(await state(), before);
  }
  for (const mode of ["precision", "target"]) {
    const i = content.snapshot.ingredients[0];
    assert(i);
    const altered =
      mode === "precision"
        ? complete({
            ...raw,
            snapshot: { ...core, ingredients: [{ ...i, quantityMicrounits: "1" }] },
          })
        : complete({
            ...raw,
            measurements: raw.measurements.map((m) => ({
              ...m,
              usageUnitCode: "G",
              targetUnitCode: "G",
            })),
          });
    await assert.rejects(execute({ ...input, candidate: altered }, mode), {
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    });
    assert.deepEqual(await state(), before);
  }
  // Published writer cannot accept a Draft, create a Published root without CAS,
  // or perform a different command. These guards refuse before entering SQL.
  let factoryRuns = 0;
  const runner = {
    run: () => {
      factoryRuns++;
      throw Error("must not enter");
    },
  };
  const draftContent = complete({ ...raw, snapshot: { ...core, lifecycle: "Draft" } });
  assert.throws(
    () => createPostgresRecipeMeasurementPublicationStore(runner, id(2), next, draftContent),
    {
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    },
  );
  const publicationStore = createPostgresRecipeMeasurementPublicationStore(
    runner,
    id(2),
    next,
    content,
  );
  await assert.rejects(
    publicationStore.create({ record: { action: "Publish", aggregate: content.snapshot } }),
    {
      code: "RECIPE_DEPENDENCY_UNAVAILABLE",
    },
  );
  for (const action of ["CreateDraft", "ReplaceDraft", "Invalidate", "Archive"])
    await assert.rejects(
      publicationStore.commit({
        expectedAggregateVersion: 2,
        record: { action, aggregate: content.snapshot },
      }),
      {
        code: "RECIPE_DEPENDENCY_UNAVAILABLE",
      },
    );
  assert.equal(factoryRuns, 0);
  assert.deepEqual(await state(), before);
  const applied = await execute();
  assert.equal(applied.status, "Applied");
  assert.deepEqual(applied.content, content);
  const physical = await admin.query(
    "SELECT v.lifecycle,v.snapshot_json,m.content_json,m.content_digest FROM rms_recipe.recipe_version v JOIN rms_recipe.recipe_measurement_content m USING(recipe_version_id,recipe_id,brand_id) WHERE v.recipe_version_id=$1",
    [content.snapshot.versionReference],
  );
  assert.equal(physical.rowCount, 1);
  assert.equal(physical.rows[0].lifecycle, "Published");
  assert.deepEqual(physical.rows[0].content_json, content);
  assert.deepEqual(physical.rows[0].snapshot_json, content.snapshot);
  assert.equal(physical.rows[0].content_digest, content.snapshot.snapshotDigest);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM rms_recipe.recipe_review_record WHERE recipe_version_id=$1",
        [content.snapshot.versionReference],
      )
    ).rows[0].count,
    2,
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) AS events",
        [id(50001)],
      )
    ).rows,
    [{ audits: 3, events: 3 }],
  );
  const baseline = await state();
  assert.equal((await execute()).status, "AlreadyApplied");
  assert.deepEqual(await state(), baseline);
  const changed = complete({
    ...raw,
    measurements: raw.measurements.map((m) => ({ ...m, usageUnitCode: "G", targetUnitCode: "G" })),
  });
  await assert.rejects(execute({ ...input, candidate: changed }), {
    code: "RECIPE_IDEMPOTENCY_CONFLICT",
  });
  assert.deepEqual(await state(), baseline);
  revoked = true;
  await assert.rejects(execute(), { code: "RECIPE_PERMISSION_DENIED" });
  revoked = false;
  assert.deepEqual(await state(), baseline);
  await assert.rejects(execute(input, "historicalReplay"), {
    message: "SYNTHETIC_REPLAY_CLEANUP",
  });
  assert.deepEqual(await state(), baseline);
  await transaction(async (client) => {
    const tx = { query: (sql, values) => client.query(sql, [...values]) },
      observedAt = new Date().toISOString();
    const source = createCurrentPublishedRecipeDependencyGraphSource({
      ...scope,
      actorReference: id(3),
      clock: { now: () => new Date().toISOString() },
      transactions: { run: (work) => work(tx) },
      authority: {
        async holdUntilTransactionCompletes(actual, fields) {
          assert.equal(actual, tx);
          assert.equal(fields.permission, "recipe.manage");
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
          { recipeReference: id(50001), versionReference: content.snapshot.versionReference },
        ],
      },
      async (graph) => {
        assert.equal(graph.contents.length, 1);
        assert.deepEqual(graph.contents[0].snapshot, content.snapshot);
        assert.equal(graph.contents[0].publicationOperationReference, input.operationReference);
      },
    );
  });
  assert.deepEqual(await state(), baseline);
  // Existing Draft-only factory remains unable to grant Published admission.
  assert.throws(
    () =>
      createPostgresRecipeMeasurementDraftStore(
        {
          run: () => {
            throw Error("not entered");
          },
        },
        id(2),
        next,
        content,
      ),
    { code: "RECIPE_DEPENDENCY_UNAVAILABLE" },
  );
}
