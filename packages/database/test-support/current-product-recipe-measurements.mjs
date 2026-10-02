import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  createCurrentPublishedRecipeMeasurementGraphSource,
  calculateRecipeMeasurementBatchDemands,
} from "../../rms/recipe/src/index.ts";
import {
  createPostgresInventoryRecipeIngredientUnitSource,
  assessRecipeIngredientUnits,
  assessRecipeBaseDemands,
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
} from "../../rms/inventory/src/index.ts";
/** Actual full Published V2 graph/current Item units/multi-root batch arithmetic pair.
 * Identity/authority and operation intent are synthetic. No Product/Store/Brand or HTTP proof. */
export async function exerciseCurrentProductRecipeMeasurements({ admin, context, role, id, at }) {
  const scope = { tenantReference: id(40001), brandReference: id(2) },
    actorReference = id(3);
  let sequence = 89000;
  const next = () => id(++sequence);
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

  const baseline = await state();
  async function run(mode = null, multi = false) {
    let entered = false,
      armed = false,
      offset = 0,
      denyUnits = false,
      denyCore = false,
      denyMeasurement = false;
    try {
      await transaction(async (client) => {
        if (mode) {
          const marker = await client.query(
            "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE recipe_id=$1 AND brand_id=$2",
            [id(1), id(2)],
          );
          assert.equal(marker.rowCount, 1);
          armed = true;
        }
        const tx = { query: (sql, values) => client.query(sql, [...values]) },
          clock = { now: () => new Date(Date.now() + offset).toISOString() },
          observedAt = clock.now(),
          activationAt = new Date(Date.parse(observedAt) + 3600000).toISOString();
        const request = {
          purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
          brandReference: id(2),
          actorReference,
          operationReference: next(),
          catalogIntentDigest: "sha256:" + "a".repeat(64),
        };
        const graphSource = createCurrentPublishedRecipeMeasurementGraphSource({
          ...scope,
          actorReference,
          clock,
          transactions: { run: (w) => w(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, fields) {
              assert.equal(actual, tx);
              assert.equal(fields.requiredScope, "FullBrandScope");
              if (denyCore) throw Error("synthetic late core fields");
            },
          },
          measurementAuthority: {
            async holdUntilTransactionCompletes(actual, fields) {
              assert.equal(actual, tx);
              assert(fields.requiredFields.includes("Recipe.CompleteMeasurementContent"));
              if (denyMeasurement) throw Error("synthetic late measurement fields");
            },
          },
        });
        const unitsSource = createPostgresInventoryRecipeIngredientUnitSource({
          ...scope,
          actorReference,
          clock,
          transactions: { run: (w) => w(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual) {
              assert.equal(actual, tx);
            },
          },
          unitAuthority: {
            async holdUntilTransactionCompletes(actual, fields) {
              assert.equal(actual, tx);
              assert.deepEqual(fields.requiredPermissions, [
                "inventory.item.read",
                "inventory.item.history.read",
              ]);
              if (denyUnits) throw Error("synthetic late unit fields");
            },
          },
        });
        await graphSource.withCurrentGraph(
          {
            request,
            observedAt,
            validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
            activationAt,
            recipeVersions: multi
              ? [
                  { recipeReference: id(80001), versionReference: id(80004) },
                  { recipeReference: id(50001), versionReference: id(73001) },
                ]
              : [{ recipeReference: id(80001), versionReference: id(80004) }],
          },
          async (graph) => {
            assert.equal(graph.contents.length, 2);
            assert.equal(graph.profile, "CurrentPublishedRecipeMeasurementGraphV2");
            const selections = graph.contents.flatMap(({ content }) =>
              content.snapshot.ingredients
                .filter((i) => i.sourceKind === "InventoryItem")
                .map((i) => ({
                  recipeReference: content.snapshot.recipeReference,
                  recipeVersionReference: content.snapshot.versionReference,
                  requirementReference: i.requirementReference,
                  itemReference: i.sourceReference,
                  operationReference: i.sourceVersionReference,
                })),
            );
            const inventoryRequest = {
              ...request,
              purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
              tenantReference: scope.tenantReference,
            };
            await unitsSource.withCurrentUnits(inventoryRequest, selections, async (facts) => {
              const now = clock.now();
              const measurements = graph.contents.flatMap(({ content }) =>
                content.snapshot.ingredients
                  .filter((i) => i.sourceKind === "InventoryItem")
                  .map((i) => {
                    const m = content.measurements.find(
                      (m) => m.requirementReference === i.requirementReference,
                    );
                    assert(m);
                    return {
                      recipeReference: content.snapshot.recipeReference,
                      recipeVersionReference: content.snapshot.versionReference,
                      requirementReference: i.requirementReference,
                      itemReference: i.sourceReference,
                      operationReference: i.sourceVersionReference,
                      usageUnitCode: m.usageUnitCode,
                      usageDimension: m.usageDimension,
                      targetUnitCode: m.targetUnitCode,
                      targetDimension: m.targetDimension,
                      conversionKind: m.conversionKind,
                      conversionReference: m.conversionReference,
                      quantityMicrounits: i.quantityMicrounits,
                      conversionNumerator: i.conversionNumerator,
                      conversionDenominator: i.conversionDenominator,
                    };
                  }),
              );
              assert.equal(
                assessRecipeIngredientUnits(measurements, facts, now, activationAt).unitArithmetic,
                "Pass",
              );
              const batches = calculateRecipeMeasurementBatchDemands(
                graph.rootVersionReferences,
                graph.contents.map((c) => c.content),
                now,
                activationAt,
              );
              assert.equal(batches.quantityBasis, "OneIndependentRecipeBatchPerRoot");
              assert.equal(batches.productQuantity, "NotEvaluated");
              assert.equal(batches.batches.length, multi ? 2 : 1);
              const results = batches.batches.map((batch) =>
                assessRecipeBaseDemands(
                  batch.demands.map((d) => ({
                    recipeReference: d.recipeReference,
                    recipeVersionReference: d.recipeVersionReference,
                    requirementReference: d.requirementReference,
                    itemReference: d.itemReference,
                    operationReference: d.operationReference,
                    targetUnitCode: d.targetUnitCode,
                    targetDimension: d.targetDimension,
                    quantityNumerator: d.quantityNumerator,
                    quantityDenominator: d.quantityDenominator,
                    pathDigest:
                      "sha256:" +
                      createHash("sha256").update(JSON.stringify(d.sourcePath)).digest("hex"),
                  })),
                  facts,
                  now,
                  activationAt,
                ),
              );
              assert(results.every((r) => r.inventoryPrecision === "Pass"));
              assert.deepEqual(
                results.map((r) => r.aggregates[0].baseQuantityMicrounits).sort(),
                multi ? ["1050000", "2100000"] : ["2100000"],
              );
              assert(batches.batches.some((b) => b.demands[0].sourcePath.length === 2));
              entered = true;
              if (mode === "units") denyUnits = true;
              if (mode === "core") denyCore = true;
              if (mode === "measurement") denyMeasurement = true;
              if (mode === "expiry") offset = 5000;
              if (mode === "query") tx.query = async () => ({ rows: [] });
              if (mode === "deactivate") await deactivate(tx);
            });
          },
        );
      });
      assert.equal(mode, null, "negative probe must reject");
      assert.equal(entered, true);
    } catch (error) {
      if (!mode) throw error;
      assert.equal(armed, true);
      assert.equal(entered, true);
      assert.notEqual(error.code, "ERR_ASSERTION");
    }
    assert.deepEqual(await state(), baseline);
  }
  await run();
  await run(null, true);
  for (const mode of ["units", "core", "measurement", "expiry", "query", "deactivate"])
    await run(mode);
}
