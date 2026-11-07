import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import {
  createPostgresInventoryRecipeIngredientUnitSource,
  inventoryRecipeIngredientUnitFields,
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
  assessRecipeIngredientUnits,
  assessRecipeBaseDemands,
  InventoryItemError,
} from "../../rms/inventory/src/index.ts";
import {
  createPostgresRecipeMeasurementDraftStore,
  requireRecipeMeasurementContentDigest,
  digestRecipeMeasurementContentV2,
  calculateRecipeMeasurementDemand,
} from "../../rms/recipe/src/index.ts";
/** Actual owning unit source/physical V2 draft recovery in original local SQL Tx.
 * Identity/permissions remain synthetic; Draft selectors do not grant publication. */
export async function exerciseRecipeIngredientUnitSource({
  admin,
  context,
  role,
  published,
  id,
  at,
}) {
  const scope = { tenantReference: id(40001), brandReference: id(2) };
  let sequence = 62000;
  const next = () => id(++sequence);
  const core = {
    ...published,
    recipeReference: id(50001),
    versionReference: id(50005),
    stableCode: "SYNTHETIC_MEASUREMENT_DRAFT",
    lifecycle: "Draft",
    aggregateVersion: 2,
    versionNumber: 2,
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
  const draft = requireRecipeMeasurementContentDigest({
    ...raw,
    snapshot: { ...core, snapshotDigest: digestRecipeMeasurementContentV2(raw) },
  });
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
      const value = await work(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }
  async function deactivate(tx) {
    const op = next();
    const result = await executeInventoryItemCommand(
      {
        ...scope,
        actorReference: id(3),
        purpose: "InventoryItemManagement",
        occurredAt: new Date(Date.parse(at) + 2).toISOString(),
        action: "Deactivate",
        operationReference: op,
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
            reasonCode: "SYNTHETIC_UNIT_SOURCE",
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
    assert.equal(result.item.aggregateVersion, 3);
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
  const baseline = await state();
  async function run(mode = null) {
    let entered = false,
      armed = false,
      reached = false,
      denied = false,
      metadataDenied = false,
      offset = 0;
    try {
      await transaction(async (client) => {
        const tx = { query: (sql, values) => client.query(sql, [...values]) };
        const durable = await createPostgresRecipeMeasurementDraftStore(
          { run: (work) => work(tx) },
          id(2),
          next,
          draft,
        ).resolveMeasurementOperation(id(50004));
        assert(durable);
        assert.deepEqual(durable.content, draft);
        const pins = durable.content.snapshot.ingredients
          .filter((i) => i.sourceKind === "InventoryItem")
          .map((i) => ({
            recipeReference: durable.content.snapshot.recipeReference,
            recipeVersionReference: durable.content.snapshot.versionReference,
            requirementReference: i.requirementReference,
            itemReference: i.sourceReference,
            operationReference: i.sourceVersionReference,
          }));
        assert.equal(pins.length, 1);
        assert.equal(pins[0].itemReference, id(7));
        assert.equal(pins[0].operationReference, id(8));
        if (mode === "missing") {
          pins[0] = { ...pins[0], itemReference: id(69999) };
          reached = true;
        }
        if (mode === "stale") {
          pins[0] = { ...pins[0], operationReference: id(41001) };
          reached = true;
        }
        if (mode === "inactive") {
          await deactivate(tx);
          reached = true;
        }
        const request = {
          purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
          ...scope,
          actorReference: id(3),
          operationReference: next(),
          catalogIntentDigest: "sha256:" + "a".repeat(64),
        };
        const inventory = createPostgresInventoryRecipeIngredientUnitSource({
          ...scope,
          actorReference: id(3),
          clock: { now: () => new Date(Date.now() + offset).toISOString() },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, fields) {
              assert.equal(actual, tx);
              assert.equal(fields.requiredScope, "FullBrandScope");
              assert.deepEqual(fields.requiredPermissions, [
                "inventory.item.read",
                "inventory.item.history.read",
              ]);
              if (metadataDenied) {
                reached = armed;
                throw Error("synthetic late metadata refusal");
              }
            },
          },
          unitAuthority: {
            async holdUntilTransactionCompletes(actual, fields) {
              assert.equal(actual, tx);
              assert.equal(fields.requiredFields, inventoryRecipeIngredientUnitFields);
              assert.deepEqual(
                fields.itemReferences,
                [...new Set(pins.map((p) => p.itemReference))].sort(),
              );
              assert.equal(fields.requiredScope, "FullBrandScope");
              if (denied) {
                reached = armed;
                throw Error("synthetic late unit field refusal");
              }
            },
          },
        });
        await inventory.withCurrentUnits(
          mode === "scope" ? { ...request, tenantReference: id(69999) } : request,
          pins,
          async (facts) => {
            entered = true;
            assert.equal(facts.profile, "CurrentRecipeIngredientUnitFactsV1");
            assert.equal(facts.units.length, 1);
            assert.equal(facts.units[0].itemReference, id(7));
            assert.equal(facts.units[0].itemVersion, 2);
            assert.equal(facts.units[0].operationReference, id(8));
            assert.equal(facts.units[0].baseUnit.unitCode, "KG");
            assert.equal(facts.units[0].baseUnit.dimension, "Mass");
            assert.equal(facts.units[0].baseUnit.ledgerPrecision, 4);
            assert.deepEqual(facts.units[0].unitConversions, []);
            assert.equal(facts.unitArithmetic, "NotEvaluated");
            assert.equal(facts.conversionApplicability, "NotEvaluated");
            assert.equal(Date.parse(facts.validUntil) - Date.parse(facts.ownerObservedAt), 5000);
            const ingredient = durable.content.snapshot.ingredients[0];
            const measurement = durable.content.measurements[0];
            assert(ingredient && measurement);
            const selected = {
              ...pins[0],
              usageUnitCode: measurement.usageUnitCode,
              usageDimension: measurement.usageDimension,
              targetUnitCode: measurement.targetUnitCode,
              targetDimension: measurement.targetDimension,
              conversionKind: measurement.conversionKind,
              conversionReference: measurement.conversionReference,
              quantityMicrounits: ingredient.quantityMicrounits,
              conversionNumerator: ingredient.conversionNumerator,
              conversionDenominator: ingredient.conversionDenominator,
            };
            const assessedAt = new Date().toISOString();
            const exact = assessRecipeIngredientUnits([selected], facts, assessedAt, assessedAt);
            assert.equal(exact.unitArithmetic, "Pass");
            assert.equal(exact.unitSourceDigest, facts.digest);
            assert.equal(exact.matches[0].baseQuantityMicrounits, ingredient.quantityMicrounits);
            assert.equal(exact.loss, "NotEvaluated");
            assert.equal(exact.eligibility, "NotEvaluated");
            // Actual immutable V2 Draft root plus current physical owning Inventory units.
            const demand = calculateRecipeMeasurementDemand(
              durable.content,
              [],
              durable.content.snapshot.yieldQuantityMicrounits,
              assessedAt,
              assessedAt,
            );
            const finalRows = demand.demands.map((d) => ({
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
                "sha256:" + createHash("sha256").update(JSON.stringify(d.sourcePath)).digest("hex"),
            }));
            const finalDemand = assessRecipeBaseDemands(finalRows, facts, assessedAt, assessedAt);
            assert.equal(finalDemand.inventoryPrecision, "Pass");
            assert.equal(finalDemand.unitSourceDigest, facts.digest);
            assert.equal(finalDemand.ownerSourceDigest, facts.ownerSourceDigest);
            assert.equal(finalDemand.aggregates.length, 1);
            assert.equal(finalDemand.aggregates[0].ledgerPrecision, 4);
            assert.equal(
              finalDemand.aggregates[0].baseQuantityMicrounits,
              (
                (BigInt(ingredient.quantityMicrounits) *
                  (10000n + BigInt(ingredient.lossBasisPoints))) /
                10000n
              ).toString(),
            );
            assert.equal(finalDemand.conversionApplicability, "NotEvaluated");
            assert.equal(finalDemand.publishValidation, "Incomplete");
            // Changed selectors below are synthetic comparison inputs, not persisted V2 content.
            const standard = assessRecipeIngredientUnits(
              [
                {
                  ...selected,
                  usageUnitCode: "G",
                  conversionKind: "StandardDimensionConversion",
                  conversionNumerator: "1",
                  conversionDenominator: "1000",
                },
              ],
              facts,
              assessedAt,
              assessedAt,
            );
            assert.equal(standard.unitArithmetic, "Pass");
            assert.equal(standard.matches[0].baseQuantityMicrounits, "1000");
            assert.equal(
              assessRecipeIngredientUnits(
                [
                  {
                    ...selected,
                    targetUnitCode: "G",
                  },
                ],
                facts,
                assessedAt,
                assessedAt,
              ).matches[0].status,
              "BaseUnitMismatch",
            );
            assert.equal(
              assessRecipeIngredientUnits(
                [
                  {
                    ...selected,
                    usageUnitCode: "CASE",
                    conversionKind: "InventoryRecordedConversion",
                    conversionReference: id(69998),
                  },
                ],
                facts,
                assessedAt,
                assessedAt,
              ).matches[0].status,
              "MissingConversion",
            );
            if (mode) {
              const marker = await client.query(
                "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE recipe_id=$1 AND brand_id=$2",
                [id(1), id(2)],
              );
              assert.equal(marker.rowCount, 1);
              armed = true;
              if (mode === "finalDemandPrecision") {
                assert.equal(finalRows.length, 1);
                // Synthetic fractional selector negative, never appended into immutable V2 content.
                const result = assessRecipeBaseDemands(
                  [{ ...finalRows[0], quantityNumerator: "1", quantityDenominator: "3" }],
                  facts,
                  assessedAt,
                  assessedAt,
                );
                assert.equal(result.inventoryPrecision, "HardError");
                assert.equal(result.matches[0].status, "RoundingRequired");
                assert.equal(result.matches[0].baseQuantityMicrounits, null);
                assert.deepEqual(result.aggregates, []);
                reached = true;
                throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
              }
              if (mode === "assessmentPrecision") {
                const result = assessRecipeIngredientUnits(
                  [
                    {
                      ...selected,
                      quantityMicrounits: "1",
                    },
                  ],
                  facts,
                  assessedAt,
                  assessedAt,
                );
                assert.equal(result.unitArithmetic, "HardError");
                assert.equal(result.matches[0].status, "RoundingRequired");
                assert.equal(result.matches[0].baseQuantity, null);
                reached = true;
                throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
              }
              if (mode === "fields") denied = true;
              if (mode === "metadataFields") metadataDenied = true;
              if (mode === "deactivate") {
                await deactivate(tx);
                reached = true;
              }
              if (mode === "generation") {
                const result = await client.query(
                  "UPDATE rms_inventory.configuration_reference_generation SET generation=generation+1 WHERE tenant_id=$1 AND brand_id=$2",
                  [scope.tenantReference, scope.brandReference],
                );
                assert.equal(result.rowCount, 1);
                const value = await client.query(
                  "SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
                  [scope.tenantReference, scope.brandReference],
                );
                assert.equal(
                  value.rows[0].generation,
                  (BigInt(facts.ownerGeneration) + 1n).toString(),
                );
                reached = true;
              }
              if (mode === "expiry") {
                offset = 5000;
                reached = true;
              }
              if (mode === "query") {
                tx.query = async () => ({ rows: [] });
                reached = true;
              }
            }
            return "read";
          },
        );
        assert.equal(mode, null);
      });
    } catch (error) {
      assert.equal(error.code, "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
      if (["missing", "stale", "inactive", "scope"].includes(mode)) {
        assert.equal(entered, false);
        if (mode !== "scope") assert(reached);
      } else
        assert(entered && armed && reached, "actual late unit probe must be armed and reached");
      return;
    }
    assert.equal(mode, null);
    assert.equal(entered, true);
  }
  await run();
  assert.deepEqual(await state(), baseline);
  for (const mode of [
    "missing",
    "stale",
    "inactive",
    "scope",
    "fields",
    "metadataFields",
    "deactivate",
    "generation",
    "expiry",
    "query",
    "assessmentPrecision",
    "finalDemandPrecision",
  ]) {
    await run(mode);
    assert.deepEqual(await state(), baseline);
  }
}
