import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { createCurrentPublishedRecipeDependencyGraphSource } from "../../rms/recipe/src/index.ts";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
  createPostgresInventoryConfigurationReferenceSourceStore,
  assessCurrentRecipeIngredientInventoryReferences,
} from "../../rms/inventory/src/index.ts";
/** Actual complete pinned graph/Inventory pair; fixture identity/permissions are synthetic.
 * This is not the full Product/Store/Brand API composition or normal publishing HTTP. */
export async function exerciseCurrentProductRecipeGraphIngredients({
  admin,
  context,
  role,
  parent,
  child,
  id,
  at,
}) {
  const scope = { tenantReference: id(40001), brandReference: id(2) };
  let sequence = 47000;
  const next = () => id(++sequence),
    hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  async function transaction(work) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL lock_timeout='5s'");
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
  function itemPorts(tx) {
    return {
      authorization: { authorize: async () => ({ authorized: true }) },
      references: { generate: () => id(7), hashIntent: hash, equals: (a, b) => a === b },
      audit: {
        create: async ({ command, after }) => ({
          auditId: next(),
          brandId: scope.brandReference,
          actor: { type: "User", reference: id(3) },
          actionCode: "INVENTORY_ITEM_" + command.action.toUpperCase(),
          targetType: "InventoryItem",
          targetId: after.itemReference,
          reasonCode: "SYNTHETIC_INGREDIENT_REFERENCE",
          correlationId: command.operationReference,
          occurredAt: command.occurredAt,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC_AUDIT",
          retentionPolicyVersion: 1,
        }),
      },
      repository: createPostgresInventoryItemStore({ run: (work) => work(tx) }, scope),
    };
  }
  const common = {
    ...scope,
    actorReference: id(3),
    purpose: "InventoryItemManagement",
    permission: "inventory.manage",
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
    "rms_inventory.inventory_item",
    "rms_inventory.inventory_item_version",
    "rms_inventory.inventory_item_operation",
    "rms_inventory.configuration_reference_generation",
    "platform_audit.audit_record",
    "platform_audit.audit_chain_head",
    "platform_eventing.outbox_event",
  ];
  const state = async () => {
    const result = [];
    for (const table of tables)
      result.push(
        (await admin.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`))
          .rows,
      );
    return result;
  };
  const baseline = await state();
  async function deactivate(tx) {
    const operation = next();
    const applied = await executeInventoryItemCommand(
      {
        ...common,
        occurredAt: new Date(Date.parse(at) + 1).toISOString(),
        action: "Deactivate",
        operationReference: operation,
        payload: { itemReference: id(7), expectedVersion: 2, reasonCode: "SYNTHETIC_LATE" },
      },
      itemPorts(tx),
    );
    assert.equal(applied.outcome, "Applied");
    assert.equal(applied.item.lifecycle, "Inactive");
    assert.equal(applied.item.aggregateVersion, 3);
    const stored = await itemPorts(tx).repository.resolveOperation(operation);
    assert.equal(stored.audit.auditId, applied.audit.auditId);
    const audit = await tx.query(
      "SELECT count(*)::int AS count FROM platform_audit.audit_record WHERE audit_id=$1",
      [applied.audit.auditId],
    );
    assert.equal(audit.rows[0].count, 1);
    return operation;
  }
  async function run(mode = null) {
    let entered = false,
      armed = false,
      reached = false;
    let denied = false,
      graphDenied = false,
      offset = 0;
    try {
      await transaction(async (client) => {
        const tx = { query: (sql, values) => client.query(sql, [...values]) };
        if (mode === "staleBefore") {
          await deactivate(tx);
          reached = true;
        }
        const observedAt = new Date().toISOString(),
          activationAt = new Date(Date.parse(observedAt) + 3600000).toISOString(),
          clock = { now: () => new Date(Date.now() + offset).toISOString() };
        const recipeRequest = {
          purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
          brandReference: id(2),
          actorReference: id(3),
          operationReference: next(),
          catalogIntentDigest: "sha256:" + "a".repeat(64),
        };
        const inventoryRequest = {
          purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
          ...scope,
          actorReference: id(3),
          operationReference: recipeRequest.operationReference,
          catalogIntentDigest: recipeRequest.catalogIntentDigest,
        };
        const recipe = createCurrentPublishedRecipeDependencyGraphSource({
          ...scope,
          actorReference: id(3),
          clock,
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, fields) {
              assert.equal(actual, tx);
              assert.equal(fields.permission, "recipe.manage");
              assert.equal(fields.requiredScope, "FullBrandScope");
              assert(fields.requiredFields.includes("Recipe.PinnedSubrecipeVersions"));
              if (graphDenied) {
                reached = armed;
                throw new Error("synthetic late graph field denial");
              }
            },
          },
        });
        const inventory = createPostgresInventoryConfigurationReferenceSourceStore({
          ...scope,
          actorReference: id(3),
          clock,
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.deepEqual(input.requiredPermissions, [
                "inventory.item.read",
                "inventory.item.history.read",
              ]);
              if (denied) {
                reached = armed;
                throw new Error("synthetic late Inventory field denial");
              }
            },
          },
        });
        await recipe.withCurrentGraph(
          {
            request: recipeRequest,
            observedAt,
            validUntil: new Date(Date.parse(observedAt) + 20000).toISOString(),
            activationAt,
            recipeVersions: [
              {
                recipeReference: parent.recipeReference,
                versionReference: parent.versionReference,
              },
            ],
          },
          async (contents) => {
            assert.equal(contents.contents.length, 2);
            assert.equal(contents.subrecipeGraph, "PassForPinnedPublishedSubrecipes");
            assert.deepEqual(contents.rootVersionReferences, [parent.versionReference]);
            const root = contents.contents.find(
              (r) => r.snapshot.recipeReference === parent.recipeReference,
            );
            const pinned = contents.contents.find(
              (r) => r.snapshot.recipeReference === child.recipeReference,
            );
            assert.deepEqual(root.snapshot, parent);
            assert.deepEqual(pinned.snapshot, child);
            assert.equal(
              root.snapshot.ingredients.every((i) => i.sourceKind === "SubRecipe"),
              true,
            );
            const targets = contents.contents.flatMap((row) =>
              row.snapshot.ingredients
                .filter((i) => i.sourceKind === "InventoryItem")
                .map((i) => ({
                  recipeReference: row.snapshot.recipeReference,
                  recipeVersionReference: row.snapshot.versionReference,
                  requirementReference: i.requirementReference,
                  itemReference: i.sourceReference,
                  operationReference: i.sourceVersionReference,
                })),
            );
            assert.equal(targets.length, 1);
            assert.equal(targets[0].recipeReference, child.recipeReference);
            assert.equal(targets[0].recipeVersionReference, child.versionReference);
            assert.equal(targets[0].itemReference, id(7));
            assert.equal(targets[0].operationReference, id(8));
            if (mode === "missing") targets[0] = { ...targets[0], itemReference: id(49999) };
            const requested =
              mode === "scope"
                ? { ...inventoryRequest, tenantReference: id(49999) }
                : inventoryRequest;
            return inventory.withCurrentSnapshot(requested, async (metadata) => {
              const assessment = assessCurrentRecipeIngredientInventoryReferences(
                targets,
                metadata,
                requested,
                clock.now(),
                activationAt,
              );
              if (assessment.decision !== "PassForDirectInventoryConfigurationReferences") {
                reached = true;
                throw new Error("synthetic refused direct dependency");
              }
              assert.equal(assessment.resolutions[0].selectedItemVersion, 2);
              assert.equal(assessment.resolutions[0].currentItemVersion, 2);
              assert.equal(assessment.stock, "NotEvaluated");
              entered = true;
              if (mode) {
                const marker = await client.query(
                  "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND recipe_id=$2",
                  [id(2), id(1)],
                );
                assert.equal(marker.rowCount, 1);
                armed = true;
                if (mode === "fields") denied = true;
                if (mode === "graphFields") graphDenied = true;
                if (mode === "graphRoot") {
                  const changed = await client.query(
                    "UPDATE rms_recipe.recipe SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND recipe_id=$2",
                    [id(2), child.recipeReference],
                  );
                  assert.equal(changed.rowCount, 1);
                  reached = true;
                }
                if (mode === "generation") {
                  const changed = await client.query(
                    "UPDATE rms_inventory.configuration_reference_generation SET generation=generation+1 WHERE tenant_id=$1 AND brand_id=$2",
                    [scope.tenantReference, scope.brandReference],
                  );
                  assert.equal(changed.rowCount, 1);
                  const generation = await client.query(
                    "SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
                    [scope.tenantReference, scope.brandReference],
                  );
                  assert.equal(
                    generation.rows[0].generation,
                    (BigInt(metadata.generation) + 1n).toString(),
                  );
                  reached = true;
                }
                if (mode === "deactivate") {
                  await deactivate(tx);
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
            });
          },
        );
        assert.equal(mode, null);
      });
    } catch (error) {
      assert.equal(error.code, "RECIPE_DEPENDENCY_UNAVAILABLE");
      if (["missing", "scope", "staleBefore"].includes(mode)) {
        assert.equal(entered, false);
        if (mode !== "scope") assert(reached);
      } else assert(entered && armed && reached, "late probe must be reached");
      return entered;
    }
    assert.equal(mode, null);
    assert.equal(entered, true);
    return entered;
  }
  assert.equal(await run(), true);
  assert.deepEqual(await state(), baseline);
  for (const mode of [
    "missing",
    "scope",
    "staleBefore",
    "fields",
    "graphFields",
    "graphRoot",
    "generation",
    "deactivate",
    "expiry",
    "query",
  ]) {
    await run(mode);
    assert.deepEqual(await state(), baseline);
  }
}
