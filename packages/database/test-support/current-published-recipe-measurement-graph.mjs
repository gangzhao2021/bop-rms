import assert from "node:assert/strict";
import pg from "pg";
import {
  createCurrentPublishedRecipeMeasurementGraphSource,
  currentPublishedRecipeDependencyGraphFields,
  currentPublishedRecipeMeasurementGraphFields,
  requireRecipeMeasurementContentDigest,
} from "../../rms/recipe/src/index.ts";
/** Actual owning full V2 source, synthetic identity/field authorization and negative protocol probes. */
export async function exerciseCurrentPublishedRecipeMeasurementGraph({ admin, context, role, id }) {
  const scope = { tenantReference: id(40001), brandReference: id(2), actorReference: id(3) };
  const physical = (
    await admin.query(
      "SELECT content_json FROM rms_recipe.recipe_measurement_content WHERE brand_id=$1 AND recipe_version_id=$2",
      [id(2), id(73001)],
    )
  ).rows;
  assert.equal(physical.length, 1);
  const content = requireRecipeMeasurementContentDigest(physical[0].content_json);
  const legacy = (
    await admin.query(
      "SELECT v.snapshot_json FROM rms_recipe.recipe r JOIN rms_recipe.recipe_version v ON v.recipe_id=r.recipe_id AND v.brand_id=r.brand_id AND v.recipe_version_id=r.current_version_id WHERE r.brand_id=$1 AND r.recipe_id<>$2 AND v.lifecycle='Published' AND NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_measurement_content m WHERE m.recipe_version_id=v.recipe_version_id) ORDER BY r.recipe_id LIMIT 1",
      [id(2), id(1)],
    )
  ).rows;
  assert.equal(legacy.length, 1);
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
  const baseline = await state();
  async function run(mode = null) {
    const client = new pg.Client(context.clientConfig);
    await client.connect();
    let armed = false,
      entered = false,
      attachmentReads = 0,
      missing = false,
      denied = false,
      coreDenied = false,
      offset = 0;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE " + role);
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SELECT set_config('bop.brand_id',$1,true)", [id(2)]);
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
          if (sql.startsWith("SELECT content_json,content_digest")) {
            attachmentReads++;
            if (missing) return { rows: [] }; // Synthetic final read refusal; immutable physical history unchanged.
          }
          return result;
        },
      };
      const source = createCurrentPublishedRecipeMeasurementGraphSource({
        ...scope,
        clock: { now: () => new Date(Date.now() + offset).toISOString() },
        transactions: { run: (work) => work(tx) },
        authority: {
          async holdUntilTransactionCompletes(actual, fields) {
            assert.equal(actual, tx);
            assert.deepEqual(fields.requiredFields, currentPublishedRecipeDependencyGraphFields);
            assert.equal(fields.requiredScope, "FullBrandScope");
            if (coreDenied) throw Error("synthetic late core refusal");
          },
        },
        measurementAuthority: {
          async holdUntilTransactionCompletes(actual, fields) {
            assert.equal(actual, tx);
            assert.equal(fields.permission, "recipe.manage");
            assert.deepEqual(fields.requiredFields, currentPublishedRecipeMeasurementGraphFields);
            assert.equal(fields.tenantReference, scope.tenantReference);
            assert.equal(fields.requiredScope, "FullBrandScope");
            if (denied) throw Error("synthetic late measurement fields refusal");
          },
        },
      });
      const observedAt = new Date().toISOString(),
        selected = mode === "legacy" ? legacy[0].snapshot_json : content.snapshot;
      const value = {
        request: {
          purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
          brandReference: id(2),
          actorReference: id(3),
          operationReference: id(79001),
          catalogIntentDigest: "sha256:" + "a".repeat(64),
        },
        observedAt,
        validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        activationAt: observedAt,
        recipeVersions: [
          {
            recipeReference: selected.recipeReference,
            versionReference: selected.versionReference,
          },
        ],
      };
      const answer = await source.withCurrentGraph(value, async (graph) => {
        entered = true;
        assert.equal(graph.contents.length, 1);
        assert.equal(graph.contents[0].publicationOperationReference, id(73002));
        assert.deepEqual(graph.contents[0].content, content);
        assert.equal(graph.measurementRepresentation, "CompleteV2");
        assert.equal(graph.unitArithmetic, "NotEvaluated");
        assert.equal(graph.publishValidation, "Incomplete");
        if (mode === "expiry") offset = 5000;
        if (mode === "query") tx.query = async () => ({ rows: [] });
        if (mode === "fields") denied = true;
        if (mode === "core") coreDenied = true;
        if (mode === "missingFinal") missing = true;
        return Object.freeze({ original: true });
      });
      if (mode) assert.fail("negative source must refuse");
      assert.equal(attachmentReads, 2);
      assert.deepEqual(answer, { original: true });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (mode) {
        assert(armed);
        assert.equal(error.code, "RECIPE_DEPENDENCY_UNAVAILABLE");
        if (mode === "legacy") {
          assert(!entered);
          assert(attachmentReads > 0, "legacy owning publication has no V2 attachment");
        } else assert(entered, "late source refusal follows actual full Published V2 read");
        if (mode === "missingFinal") assert.equal(attachmentReads, 2);
      }
      throw error;
    } finally {
      await client.end();
    }
  }
  await run();
  assert.deepEqual(await state(), baseline);
  for (const mode of ["fields", "core", "query", "expiry", "missingFinal", "legacy"]) {
    await assert.rejects(run(mode), { code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
    assert.deepEqual(await state(), baseline);
  }
}
