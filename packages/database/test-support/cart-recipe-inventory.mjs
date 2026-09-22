import { insertRecipeVersion } from "../../rms/recipe/src/infrastructure/persistence/recipe-version-write.ts";
import { seedRecipeObservationInventory } from "./recipe-inventory-observation.mjs";

// Explicit synthetic published Recipe/stock for the actual Cart HTTP scenario.
// Publication workflow and live Store approval are not claimed by fixture setup.
export async function seedCartRecipeInventory({
  admin,
  role,
  runner,
  id,
  at,
  skuReference,
  storeReference,
  publishRecipe,
}) {
  const recipe = id(28001),
    version = id(28002),
    item = id(28003),
    itemVersion = id(28004);
  await admin.query("GRANT USAGE ON SCHEMA rms_recipe,rms_catalog,rms_ordering TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_catalog.sku,rms_catalog.product,rms_catalog.product_version,rms_catalog.category,rms_ordering.cart,rms_ordering.cart_line,rms_recipe.recipe,rms_recipe.recipe_version,rms_recipe.recipe_scope_binding,rms_recipe.recipe_modifier_version TO " +
      role,
  );
  const snapshot = {
    recipeReference: recipe,
    versionReference: version,
    brandReference: id(2),
    stableCode: "SYNTHETIC_CART_RECIPE",
    aggregateVersion: 2,
    versionNumber: publishRecipe ? 2 : 1,
    snapshotDigest: "sha256:" + "b".repeat(64),
    lifecycle: "Published",
    displayNameCode: "SYNTHETIC_CART_RECIPE",
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: "EACH",
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(28005),
        sourceKind: "InventoryItem",
        sourceReference: item,
        sourceVersionReference: itemVersion,
        quantityMicrounits: "2000000",
        unitDimension: "Mass",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "1",
        unitCostDenominator: "1",
        allergens: [],
      },
    ],
    preparationVersionReference: id(28006),
    steps: [
      {
        stepReference: id(28007),
        sequenceGroup: 0,
        instructionCode: "PREPARE",
        durationSeconds: 60,
        capabilityCode: "PREP",
      },
    ],
    substitutionPolicyReference: null,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    invalidationReasonCode: null,
    createdAt: at,
  };
  if (publishRecipe) await publishRecipe({ admin, role, runner, snapshot, id, at });
  else {
    await admin.query(
      "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_CART_RECIPE',1,$3,$4,$3)",
      [recipe, id(2), at, id(3)],
    );
  }
  await admin.query("BEGIN");
  try {
    if (!publishRecipe) {
      await insertRecipeVersion(
        { query: (sql, values) => admin.query(sql, [...values]) },
        snapshot,
        () => id(28008),
      );
      await admin.query(
        "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
        [version, recipe],
      );
    }
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id(28009), version, recipe, id(2), skuReference, storeReference, at],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  const prepared = await seedRecipeObservationInventory({
    admin,
    role,
    runner,
    id,
    at,
    saleInput: { skuReference, storeReference, selections: [] },
    requirements: [
      { itemReference: item, itemVersionReference: itemVersion, unitDimension: "Mass" },
    ],
  });
  await admin.query("RESET ROLE");
  return prepared.scope;
}
