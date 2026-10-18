import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { parseProductPublicationCommand, CatalogError } from "../../rms/catalog/src/index.ts";
import { recipeReferenceSourceFields } from "../../rms/recipe/src/index.ts";
import { createCurrentProductCandidateRecipeBindingScopeSource } from "../../../apps/api/src/current-product-candidate-recipe-binding-scope.ts";

/** Actual current owner readers/UoW; Published metadata and Actor authorities
 * are controlled synthetic facts, not native Recipe publication or live IAM. */
export async function exerciseCurrentProductCandidateRecipeBindingScope({
  admin,
  role,
  id,
  transactions,
  candidateCommand,
  candidateAuthority,
  skuReference,
  createMarker,
  changeCandidate,
}) {
  const recipeReference = id(86000),
    versionReference = id(86001),
    bindingReference = id(86002),
    past = candidateCommand.occurredAt,
    brand = candidateCommand.brandReference;
  await admin.query("GRANT USAGE ON SCHEMA rms_recipe TO " + role);
  // Marker verification needs only identifiers, never audit payload or actor data.
  await admin.query("GRANT SELECT(target_id) ON platform_audit.audit_record TO " + role);
  await admin.query("GRANT SELECT(aggregate_id) ON platform_eventing.outbox_event TO " + role);
  const columns = {
    recipe: ["recipe_id", "brand_id", "aggregate_version", "current_version_id", "updated_at"],
    recipe_version: [
      "recipe_version_id",
      "recipe_id",
      "brand_id",
      "version_number",
      "snapshot_digest",
      "lifecycle",
      "effective_from",
      "effective_until",
      "effective_time_zone",
      "created_at",
    ],
    recipe_reference_generation: ["brand_id", "generation", "binding_count"],
    recipe_reference_binding: [
      "recipe_scope_binding_id",
      "recipe_version_id",
      "recipe_id",
      "brand_id",
      "sku_id",
      "store_id",
      "option_binding_id",
      "effective_from",
      "effective_until",
    ],
    recipe_modifier_version: [
      "rule_version_id",
      "rule_id",
      "brand_id",
      "version",
      "recipe_id",
      "recipe_version_id",
      "binding_id",
      "option_id",
      "selected_quantity",
      "lifecycle",
      "rule_digest",
      "effective_from",
      "effective_until",
      "occurred_at",
    ],
  };
  for (const [table, fields] of Object.entries(columns))
    await admin.query(`GRANT SELECT(${fields.join(",")}) ON rms_recipe.${table} TO ${role}`);
  await admin.query("GRANT UPDATE(updated_at) ON rms_recipe.recipe TO " + role);
  await admin.query(
    "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_VALIDATE_PAIR80',1,$3,$4,$3)",
    [recipeReference, brand, past, candidateCommand.actorReference],
  );
  await admin.query(
    "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,1,$4,'Published','SYNTHETIC_VALIDATE_PAIR80',3000000,'PORTION','Count',$5,$6,'UTC',$6)",
    [versionReference, recipeReference, brand, "sha256:" + "a".repeat(64), id(86003), past],
  );
  await admin.query(
    "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
    [versionReference, recipeReference],
  );
  await admin.query(
    "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,NULL,$6)",
    [bindingReference, versionReference, recipeReference, brand, skuReference, past],
  );

  // Exhaustive snapshots cover every possible owning producer/projection append,
  // including marker Product Audit/Outbox and controlled Recipe source generation.
  const tables = (
    await admin.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1) ORDER BY schemaname,tablename",
      [["rms_catalog", "rms_recipe", "platform_audit", "platform_eventing"]],
    )
  ).rows;
  const state = async () => {
    const result = [];
    for (const { schemaname, tablename } of tables) {
      assert.match(schemaname, /^[a-z][a-z0-9_]*$/);
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      result.push(
        (
          await admin.query(
            `SELECT to_jsonb(t) AS row FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      );
    }
    return result;
  };
  const baseline = await state();
  let operation = 86100;
  async function run(mode = null) {
    let entered = false,
      armed = false,
      reached = false,
      deniedCandidate = false,
      deniedRecipe = false,
      current = null,
      originalTx,
      markerFailure;
    const clock = { now: () => current ?? new Date().toISOString() },
      activation = new Date(Date.now() + (mode === "past" ? -60000 : 3600000)).toISOString(),
      command = parseProductPublicationCommand({
        ...candidateCommand,
        operationReference: id(++operation),
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: {
            instant: activation,
            localDateTime: activation.slice(0, 23),
            utcOffsetMinutes: 0,
          },
          effectiveUntil: null,
        },
      }),
      intent = "sha256:" + sha256Hex(canonicalizeRfc8785(command));
    const source = createCurrentProductCandidateRecipeBindingScopeSource({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      clock,
      candidateAuthority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, originalTx);
          if (deniedCandidate) {
            reached = armed;
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          }
          await candidateAuthority.holdUntilTransactionCompletes(tx, input);
        },
      },
      recipeAuthority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, originalTx);
          assert.equal(input.tenantReference, command.tenantReference);
          assert.equal(input.request.brandReference, brand);
          assert.equal(input.request.actorReference, command.actorReference);
          assert.equal(input.request.operationReference, command.operationReference);
          assert.equal(input.request.catalogIntentDigest, intent);
          assert.equal(input.permission, "recipe.manage");
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
          if (deniedRecipe) {
            reached = armed;
            throw new Error("synthetic late Recipe field denial");
          }
        },
      },
    });
    if (mode) {
      await assert.rejects(
        transactions.run(async (tx) => {
          originalTx = tx;
          const query = tx.query;
          try {
            await source.withCurrentAssessment(tx, command, async (scope) => {
              entered = true;
              assert.equal(scope.recipe.decision, "PassForStoredMembershipAndPeriods");
              assert.equal(scope.originalIntentDigest, intent);
              try {
                await createMarker(tx);
              } catch (error) {
                markerFailure = error;
                throw error;
              }
              armed = true;
              if (mode === "candidate fields") deniedCandidate = true;
              if (mode === "recipe fields") deniedRecipe = true;
              if (mode === "expiry") {
                current = scope.validUntil;
                reached = true;
              }
              if (mode === "query") {
                tx.query = async () => ({ rows: [] });
                reached = true;
              }
              if (mode === "generation") {
                const changed = await tx.query(
                  "UPDATE rms_recipe.recipe SET updated_at=$1 WHERE recipe_id=$2 AND brand_id=$3",
                  [new Date().toISOString(), recipeReference, brand],
                );
                assert.equal(changed.rowCount, 1);
                const actual = await tx.query(
                  "SELECT generation::text generation FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
                  [brand],
                );
                assert.equal(
                  actual.rows[0].generation,
                  (BigInt(scope.recipe.recipeGeneration) + 1n).toString(),
                );
                reached = true;
              }
              if (mode === "target drift") {
                await changeCandidate(tx);
                reached = true;
              }
              return scope;
            });
          } finally {
            // Restore only this isolated transaction's deliberately substituted query,
            // before its real runner executes ROLLBACK.
            tx.query = query;
          }
        }),
        (error) => {
          assert.ifError(markerFailure);
          if (mode === "past") assert.equal(entered, false);
          else
            assert(
              entered && armed && reached,
              "late refusal must follow independent real marker: " + mode,
            );
          assert.equal(
            error.code,
            mode === "candidate fields"
              ? "CATALOG_PERMISSION_DENIED"
              : "CATALOG_DEPENDENCY_UNAVAILABLE",
          );
          return true;
        },
      );
      if (mode === "past") assert.equal(entered, false);
      else assert(entered && armed && reached, "late refusal must follow independent real marker");
    } else {
      const token = {};
      const result = await transactions.run(async (tx) => {
        originalTx = tx;
        return source.withCurrentAssessment(tx, command, async (scope) => {
          entered = true;
          assert.equal(scope.recipe.decision, "PassForStoredMembershipAndPeriods");
          assert.equal(scope.recipe.bindingChecks.length, 1);
          assert.equal(scope.recipe.bindingChecks[0].bindingReference, bindingReference);
          assert.equal(scope.recipe.bindingChecks[0].recipeVersionReference, versionReference);
          assert.equal(scope.recipe.bindingChecks[0].skuReference, skuReference);
          assert.equal(scope.originalIntentDigest, intent);
          assert.equal(scope.recipe.catalogConfigurationDigest, command.configurationDigest);
          assert.equal(scope.recipe.activationAt, activation);
          assert.equal(scope.recipe.storeTopology, "NotEvaluated");
          assert.equal(scope.recipe.uniqueRecipeResolution, "NotEvaluated");
          assert.equal(scope.recipe.ingredients, "NotEvaluated");
          assert.equal(scope.publishValidation, "Incomplete");
          assert.equal(scope.eligibility, "NotEvaluated");
          assert.equal(Object.hasOwn(scope, "aggregate"), false);
          return token;
        });
      });
      assert.equal(result, token);
      assert(entered);
    }
    assert.deepEqual(await state(), baseline);
  }
  await run();
  for (const mode of [
    "candidate fields",
    "recipe fields",
    "expiry",
    "query",
    "generation",
    "target drift",
    "past",
  ])
    await run(mode);
  await assert.rejects(
    transactions.run((tx) =>
      tx.query(
        "SELECT yield_quantity_microunits FROM rms_recipe.recipe_version WHERE brand_id=$1",
        [brand],
      ),
    ),
    { code: "42501" },
  );
  assert.deepEqual(await state(), baseline);
  return Object.freeze({ tableCount: tables.length, lateRefusals: 6, pastRefusals: 1 });
}
