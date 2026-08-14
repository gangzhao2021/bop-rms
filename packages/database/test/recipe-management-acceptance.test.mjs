import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
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
    await admin.query(
      `INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,1,$4,'Published','SYNTHETIC_NAME',1000000,'PORTION','Count',$5,$6,'America/Toronto',$6)`,
      [id(4), id(1), id(2), digest("a"), id(5), at],
    );
    await admin.query(
      `UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2,updated_at=$2 WHERE recipe_id=$3`,
      [id(4), at, id(1)],
    );
    await admin.query(
      `INSERT INTO rms_recipe.recipe_ingredient_requirement(requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id,quantity_microunits,unit_dimension,conversion_numerator,conversion_denominator,loss_basis_points,unit_cost_minor_numerator,unit_cost_denominator) VALUES($1,$2,$3,$4,'InventoryItem',$5,$6,1000000,'Mass',1,1,500,3,1000000)`,
      [id(6), id(4), id(1), id(2), id(7), id(8)],
    );
    await admin.query(
      `INSERT INTO rms_recipe.recipe_allergen_evidence(recipe_allergen_evidence_id,requirement_id,brand_id,allergen_id,evidence_id,verified) VALUES($1,$2,$3,$4,$5,true)`,
      [id(9), id(6), id(2), id(10), id(11)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_recipe.recipe_allergen_evidence(recipe_allergen_evidence_id,requirement_id,brand_id,allergen_id,evidence_id,verified) VALUES($1,$2,$3,$4,$5,true)`,
        [id(19), id(6), id(99), id(20), id(21)],
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
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_recipe,platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO ${role}`);
    await admin.query(
      `GRANT SELECT ON rms_recipe.recipe,rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_recipe.recipe`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_recipe.recipe`)).rowCount, 1);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_recipe.recipe_ingredient_requirement`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_recipe.recipe`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("keeps Recipe versions, exact quantities, dual reviews and Brand RLS immutable", async () => {
  await withIsolatedDatabase({ caseId: "recipe_management", root }, prove);
}, 120_000);
