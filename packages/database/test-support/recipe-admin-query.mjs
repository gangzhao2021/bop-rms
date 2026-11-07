import assert from "node:assert/strict";
import { createPostgresRecipeAdminQueryStore } from "../../rms/recipe/src/index.ts";

export async function exerciseRecipeAdminQuery({ admin, role, id }) {
  const brand = id(7100);
  const generation = id(7101);
  const recipe = id(7102);
  const at = "2026-08-13T18:00:00.000Z";
  await admin.query("RESET ROLE");
  await admin.query(
    "INSERT INTO rms_recipe.recipe_admin_projection_generation(generation_id,brand_id,projection_version,source_event_sequence,built_at) VALUES($1,$2,1,9007199254740993,$3)",
    [generation, brand, at],
  );
  await admin.query(
    "INSERT INTO rms_recipe.recipe_admin_projection_checkpoint(brand_id,active_generation_id,projection_version,source_event_sequence,updated_at) VALUES($1,$2,1,9007199254740993,$3)",
    [brand, generation, at],
  );
  await admin.query(
    `INSERT INTO rms_recipe.recipe_admin_projection(generation_id,brand_id,recipe_id,recipe_version_id,
      stable_code,display_name,lifecycle,yield_summary,cost_minor,allergen_status,usage_summary,
      mapping_missing,cost_changed,aggregate_version,snapshot_digest,effective_from,projected_at)
     VALUES($1,$2,$3,$4,'SYNTHETIC_ADMIN','Synthetic admin recipe','Draft','1 PORTION',
       9007199254740993.00,'MissingEvidence','Synthetic usage',true,false,1,$5,$6,$6)`,
    [generation, brand, recipe, id(7103), `sha256:${"a".repeat(64)}`, at],
  );
  await admin.query(
    `GRANT SELECT ON rms_recipe.recipe_admin_projection_generation,
      rms_recipe.recipe_admin_projection_checkpoint,rms_recipe.recipe_admin_projection TO ${role}`,
  );
  const runner = {
    async run(work) {
      await admin.query("BEGIN");
      try {
        await admin.query(`SET LOCAL ROLE ${role}`);
        const result = await work({ query: (sql, values) => admin.query(sql, [...values]) });
        await admin.query("COMMIT");
        return result;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    },
  };
  const store = createPostgresRecipeAdminQueryStore(runner, brand);
  const view = await store.load(recipe);
  assert.equal(view.generationReference, generation);
  assert.equal(view.sourceEventSequence, "9007199254740993");
  assert.equal(view.item.costMinor, "9007199254740993");
  assert.equal(view.item.recipeReference, recipe);
  assert.equal(view.item.allergenStatus, "MissingEvidence");
  assert.equal((await store.load(id(7199))).item, null);
  assert.equal(await createPostgresRecipeAdminQueryStore(runner, id(7199)).load(recipe), null);
  await runner.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true)", [id(7199)]);
    for (const table of [
      "recipe_admin_projection",
      "recipe_admin_projection_generation",
      "recipe_admin_projection_checkpoint",
    ]) {
      assert.equal(
        (await tx.query(`SELECT * FROM rms_recipe.${table} WHERE brand_id=$1`, [brand])).rows
          .length,
        0,
      );
    }
  });
  await admin.query(
    "UPDATE rms_recipe.recipe_admin_projection_checkpoint SET source_event_sequence=1 WHERE brand_id=$1",
    [brand],
  );
  await assert.rejects(store.load(recipe), { code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
}
