import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresRecipeInventoryReferenceSourceStore,
  recipeInventoryReferenceFields,
  RecipeWorkflowError,
} from "../../rms/recipe/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { Client } = pg;
const id = (n) => `01902417-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const past = "2026-08-01T12:00:00.000Z",
  future = "2027-01-01T00:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const sourceTables = [
  "recipe",
  "recipe_version",
  "recipe_scope_binding",
  "recipe_modifier_version",
];
const rootInsert =
  "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)";
const versionInsert =
  "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,$4,$5,'Draft','SYNTHETIC_NAME',1,'PORTION','Count',$6,$7,'America/Toronto',$8)";
const bindingInsert =
  "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,$7,$8)";
const modifierInsert =
  "INSERT INTO rms_recipe.recipe_modifier_version(rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,operation_id,actor_id,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'Draft',$9,$10::jsonb,$11,$12,$13,$14,$15)";
const ingredientInsert =
  "INSERT INTO rms_recipe.recipe_ingredient_requirement(requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id,quantity_microunits,unit_dimension,conversion_numerator,conversion_denominator,loss_basis_points,unit_cost_minor_numerator,unit_cost_denominator) VALUES($1,$2,$3,$4,'InventoryItem',$5,$6,1,'Count',1,1,0,0,1)";
const ingredientArgs = (requirement = 50, item = 70) => [
  id(requirement),
  id(11),
  id(10),
  id(1),
  id(item),
  id(item + 1),
];
const privateIngredient = (requirement, item) => ({
  requirementReference: id(requirement),
  sourceKind: "InventoryItem",
  sourceReference: id(item),
  sourceVersionReference: id(item + 1),
  quantityMicrounits: "1",
  unitDimension: "Count",
  conversionNumerator: "1",
  conversionDenominator: "1",
  lossBasisPoints: 0,
  unitCostMinorNumerator: "0",
  unitCostDenominator: "1",
  allergens: [],
});
const versionArgs = (version = 11, number = 1, recipe = 10, brand = 1) => [
  id(version),
  id(recipe),
  id(brand),
  number,
  digest,
  id(8),
  future,
  past,
];
const bindingArgs = (binding = 20, store = null, brand = 1, recipe = 10, version = 11) => [
  id(binding),
  id(version),
  id(recipe),
  id(brand),
  id(21),
  store === null ? null : id(store),
  id(40),
  future,
];
const modifierArgs = (
  ruleVersion = 31,
  version = 1,
  brand = 1,
  recipe = 10,
  recipeVersion = 11,
) => [
  id(ruleVersion),
  id(30),
  id(brand),
  version,
  id(recipe),
  id(recipeVersion),
  id(40),
  id(41),
  digest,
  JSON.stringify({
    ruleReference: id(30),
    ruleVersionReference: id(ruleVersion),
    ruleDigest: digest,
    brandReference: id(brand),
    recipeVersionReference: id(recipeVersion),
    selection: { bindingReference: id(40), optionReference: id(41), quantity: 1 },
    changes: [
      { action: "Add", ingredient: privateIngredient(60, 80) },
      { action: "Remove", requirementReference: id(99) },
      { action: "Replace", requirementReference: id(50), ingredient: privateIngredient(61, 90) },
    ],
  }),
  future,
  id(ruleVersion + 1000),
  id(2),
  id(ruleVersion + 2000),
  past,
];
async function seed(client, recipe = 10, brand = 1) {
  await client.query(rootInsert, [
    id(recipe),
    id(brand),
    "SYNTHETIC_RECIPE_" + recipe,
    past,
    id(2),
  ]);
  await client.query(versionInsert, versionArgs(recipe + 1, 1, recipe, brand));
  await client.query(
    "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
    [id(recipe + 1), id(recipe)],
  );
  await client.query(bindingInsert, bindingArgs(recipe + 10, null, brand, recipe, recipe + 1));
  await client.query(bindingInsert, bindingArgs(recipe + 11, 99, brand, recipe, recipe + 1));
  await client.query(modifierInsert, modifierArgs(recipe + 21, 1, brand, recipe, recipe + 1));
}
it("holds complete stored Recipe Inventory references through outer COMMIT", async () => {
  await withIsolatedDatabase({ caseId: "recipe_inv_refs", root }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const role = `wp2417_${context.runId}`,
      request = {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ",
        brandReference: id(1),
        actorReference: id(2),
        operationReference: id(3),
        catalogIntentDigest: digest,
      };
    let deny = false,
      now = () => new Date().toISOString();
    const scope = (client, brand = id(1), store = "") =>
      client.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
        brand,
        store,
      ]);
    const authority = {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, reader);
        assert.deepEqual(input.request, request);
        assert.equal(input.permission, "recipe.manage");
        assert.equal(input.requiredScope, "FullBrandScope");
        assert.deepEqual(input.requiredFields, recipeInventoryReferenceFields);
        if (deny) throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
      },
    };
    async function blocked(
      sql = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      values = ["RecipeCatalogReferenceV1:" + id(1)],
      store = "",
      modifier = false,
    ) {
      await writer.query("BEGIN");
      await scope(writer, id(1), store);
      await writer.query("SET LOCAL lock_timeout='150ms'");
      try {
        if (modifier)
          await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "RecipeModifier:" + id(1) + ":" + id(30),
          ]);
        await assert.rejects(writer.query(sql, values), (e) => e.code === "55P03");
      } finally {
        await writer.query("ROLLBACK");
      }
    }
    const transactions = {
      async run(work) {
        await reader.query("BEGIN");
        await reader.query(`SET LOCAL ROLE ${role}`);
        try {
          const result = await work(reader);
          await blocked();
          await reader.query("COMMIT");
          return result;
        } catch (e) {
          await reader.query("ROLLBACK");
          throw e;
        }
      },
    };
    const options = {
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(2),
        clock: { now: () => now() },
        transactions,
        authority,
      },
      source = () => createPostgresRecipeInventoryReferenceSourceStore(options);
    const generation = async () =>
      (
        await admin.query(
          "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
          [id(1)],
        )
      ).rows[0].generation;
    try {
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA rms_recipe,platform_helpers TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
      );
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
        recipe_modifier_version: [
          "rule_version_id",
          "rule_id",
          "brand_id",
          "version",
          "recipe_id",
          "recipe_version_id",
          "binding_id",
          "option_id",
          "rule_json",
          "lifecycle",
          "rule_digest",
          "effective_from",
          "effective_until",
          "occurred_at",
        ],
        recipe_reference_generation: ["brand_id", "generation", "binding_count"],
        recipe_reference_binding: ["brand_id"],
        recipe_ingredient_requirement: [
          "requirement_id",
          "recipe_version_id",
          "recipe_id",
          "brand_id",
          "source_kind",
          "source_id",
          "source_version_id",
        ],
      };
      for (const [table, fields] of Object.entries(columns))
        await admin.query(`GRANT SELECT(${fields.join(",")}) ON rms_recipe.${table} TO ${role}`);
      const empty = await source().withCurrentSnapshot(request, async (s) => s);
      assert.equal(empty.generation, "0");
      assert.equal(empty.recipes.length, 0);
      await admin.query("BEGIN");
      await seed(admin);
      await admin.query(ingredientInsert, ingredientArgs());
      await seed(admin, 60, 60);
      await admin.query(rootInsert, [id(12), id(1), "SYNTHETIC_EMPTY", past, id(2)]);
      await admin.query("COMMIT");
      const changes = [
        [ingredientInsert, ingredientArgs(52, 72)],
        ["UPDATE rms_recipe.recipe SET updated_at=updated_at WHERE recipe_id=$1", [id(10)]],
        [versionInsert, versionArgs(100, 2)],
        [bindingInsert, bindingArgs(101, 98), id(98)],
        [modifierInsert, modifierArgs(32, 2), "", true],
        [rootInsert, [id(110), id(1), "SYNTHETIC_PHANTOM", past, id(2)]],
      ];
      let digestBefore;
      await source().withCurrentSnapshot(request, async (s) => {
        assert.equal(s.recipes.length, 2);
        assert.equal(
          s.recipes.find((r) => r.recipeReference === id(12)).currentVersionReference,
          null,
        );
        assert.equal(s.versions.length, 1);
        assert.equal(s.ingredients.length, 1);
        assert.equal(s.ingredients[0].sourceVersionReference, id(71));
        assert.equal(s.changes.length, 3);
        assert.deepEqual(
          s.changes.map((c) => c.action),
          ["Add", "Remove", "Replace"],
        );
        assert.equal(s.changes[1].requirementReference, id(99));
        assert.equal(s.removalResolution, "Unavailable");
        assert(!JSON.stringify(s).includes("unitCostMinorNumerator"));
        assert(!JSON.stringify(s).includes("allergens"));
        assert.equal(s.modifiers.length, 1);
        assert.equal(s.applicability, "Unavailable");
        digestBefore = s.digest;
        for (const [sql, values, store, modifier] of changes)
          await blocked(sql, values, store, modifier);
        await writer.query("BEGIN");
        assert.equal(
          (
            await writer.query(
              "SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) allowed",
              ["RecipeCatalogReferenceV1:" + id(1)],
            )
          ).rows[0].allowed,
          true,
        );
        for (const [table, column, value] of [
          ["recipe_version", "recipe_version_id", id(11)],
          ["recipe_scope_binding", "recipe_scope_binding_id", id(20)],
          ["recipe_ingredient_requirement", "requirement_id", id(50)],
        ]) {
          assert.equal(
            (
              await writer.query(
                `UPDATE rms_recipe.${table} SET brand_id=brand_id WHERE ${column}=$1`,
                [value],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await writer.query(`DELETE FROM rms_recipe.${table} WHERE ${column}=$1`, [value]))
              .rowCount,
            0,
          );
        }
        await writer.query("ROLLBACK");
        await scope(reader, id(60), id(99));
      });
      assert.equal(
        await source().withCurrentSnapshot(request, async (s) => s.digest),
        digestBefore,
      );
      for (const [sql, values, store] of changes) {
        await writer.query("BEGIN");
        await scope(writer, id(1), store);
        assert.equal((await writer.query(sql, values)).rowCount, 1);
        await writer.query("ROLLBACK");
      }
      await admin.query(`GRANT SELECT ON rms_recipe.recipe_scope_binding TO ${role}`);
      await admin.query(`GRANT INSERT ON rms_recipe.recipe_scope_binding TO ${role}`);
      await writer.query("BEGIN");
      await writer.query(`SET LOCAL ROLE ${role}`);
      await scope(writer);
      assert.equal(
        (await writer.query("SELECT count(*)::text n FROM rms_recipe.recipe_scope_binding")).rows[0]
          .n,
        "1",
      );
      await scope(writer, id(1), id(98));
      assert.equal((await writer.query(bindingInsert, bindingArgs(101, 98))).rowCount, 1);
      assert.deepEqual(
        (
          await writer.query(
            "SELECT current_setting('bop.brand_id') brand,current_setting('bop.store_id') store",
          )
        ).rows[0],
        { brand: id(1), store: id(98) },
      );
      assert.equal(
        (
          await writer.query(
            "SELECT count(brand_id)::text n FROM rms_recipe.recipe_reference_generation",
          )
        ).rows[0].n,
        "0",
      );
      assert.equal(
        (
          await writer.query(
            "SELECT count(brand_id)::text n FROM rms_recipe.recipe_reference_binding",
          )
        ).rows[0].n,
        "0",
      );
      await writer.query("ROLLBACK");
      await admin.query(`GRANT INSERT ON rms_recipe.recipe_ingredient_requirement TO ${role}`);
      const beforeOrdinary = await generation();
      await writer.query("BEGIN");
      await writer.query(`SET LOCAL ROLE ${role}`);
      await scope(writer);
      assert.equal((await writer.query(ingredientInsert, ingredientArgs(52, 72))).rowCount, 1);
      assert.deepEqual(
        (
          await writer.query(
            "SELECT current_setting('bop.brand_id') brand,current_setting('bop.store_id') store",
          )
        ).rows[0],
        { brand: id(1), store: "" },
      );
      assert.equal(
        (
          await writer.query(
            "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
            [id(1)],
          )
        ).rows[0].generation,
        String(BigInt(beforeOrdinary) + 1n),
      );
      await writer.query("ROLLBACK");
      assert.equal(await generation(), beforeOrdinary);
      for (const [table, column] of [
        ["recipe_version", "snapshot_json"],
        ["recipe_modifier_version", "review_evidence_json"],
        ["recipe_ingredient_requirement", "unit_cost_minor_numerator"],
        ["recipe_allergen_evidence", "allergen_id"],
      ])
        assert.equal(
          (
            await admin.query("SELECT has_column_privilege($1,$2,$3,'SELECT') allowed", [
              role,
              "rms_recipe." + table,
              column,
            ])
          ).rows[0].allowed,
          false,
        );
      await admin.query(`GRANT UPDATE(updated_at) ON rms_recipe.recipe TO ${role}`);
      const current = await generation();
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          assert.equal(
            (
              await reader.query(
                "UPDATE rms_recipe.recipe SET updated_at=updated_at WHERE recipe_id=$1",
                [id(10)],
              )
            ).rowCount,
            1,
          );
          await scope(reader, id(60), id(99));
          return "must not escape";
        }),
        (e) => e.code === "RECIPE_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(await generation(), current);
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          deny = true;
        }),
        (e) => e.code === "RECIPE_PERMISSION_DENIED",
      );
      deny = false;
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          now = () => new Date(Date.now() + 6000).toISOString();
        }),
        (e) => e.code === "RECIPE_DEPENDENCY_UNAVAILABLE",
      );
      now = () => new Date().toISOString();
      for (const table of ["recipe_reference_generation", "recipe_reference_binding"]) {
        assert.equal(
          (
            await admin.query("SELECT has_table_privilege($1,$2,'UPDATE') allowed", [
              role,
              "rms_recipe." + table,
            ])
          ).rows[0].allowed,
          false,
        );
        assert.deepEqual(
          (
            await admin.query(
              "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
              ["rms_recipe." + table],
            )
          ).rows[0],
          { relrowsecurity: true, relforcerowsecurity: true },
        );
      }
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'rms_recipe.maintain_recipe_reference_projection()','EXECUTE') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      const procedure = (
        await admin.query(
          "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='rms_recipe.maintain_recipe_reference_projection()'::regprocedure",
        )
      ).rows[0];
      assert(procedure.prosecdef);
      assert(procedure.proconfig.includes("search_path=pg_catalog"));
      assert(procedure.proconfig.includes("row_security=on"));
      for (const sql of [
        "UPDATE rms_recipe.recipe_modifier_version SET brand_id=brand_id WHERE rule_version_id=$1",
        "DELETE FROM rms_recipe.recipe_modifier_version WHERE rule_version_id=$1",
      ])
        await assert.rejects(admin.query(sql, [id(31)]), (e) => e.code === "23514");
      await admin.query("BEGIN");
      await admin.query(
        "DROP TRIGGER recipe_ingredient_requirement_reference_fence ON rms_recipe.recipe_ingredient_requirement; DROP TRIGGER recipe_ingredient_requirement_reference_no_truncate ON rms_recipe.recipe_ingredient_requirement",
      );
      for (const table of sourceTables) {
        await admin.query(`DROP TRIGGER ${table}_reference_fence ON rms_recipe.${table}`);
        if (table !== "recipe_modifier_version")
          await admin.query(`DROP TRIGGER ${table}_reference_no_truncate ON rms_recipe.${table}`);
      }
      await admin.query(
        "DROP FUNCTION rms_recipe.maintain_recipe_reference_projection(); DROP FUNCTION rms_recipe.reject_recipe_reference_truncate(); DROP TABLE rms_recipe.recipe_reference_binding; DROP TABLE rms_recipe.recipe_reference_generation",
      );
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/1250-rms-recipe/1250_008_create_recipe_reference_projection.sql",
          ),
          "utf8",
        ),
      );
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/1250-rms-recipe/1250_009_alter_recipe_inventory_reference_fence.sql",
          ),
          "utf8",
        ),
      );
      assert.equal(await generation(), "0");
      assert.deepEqual(
        (
          await admin.query(
            "SELECT brand_id::text,binding_count::text FROM rms_recipe.recipe_reference_generation ORDER BY brand_id",
          )
        ).rows,
        [
          { brand_id: id(1), binding_count: "2" },
          { brand_id: id(60), binding_count: "2" },
        ],
      );
      assert.equal(
        (await admin.query("SELECT count(*)::text n FROM rms_recipe.recipe_reference_binding"))
          .rows[0].n,
        "4",
      );
      await admin.query("ROLLBACK");
      for (const column of ["generation", "binding_count"]) {
        await admin.query("BEGIN");
        await admin.query(
          `UPDATE rms_recipe.recipe_reference_generation SET ${column}=9223372036854775807 WHERE brand_id=$1`,
          [id(1)],
        );
        await assert.rejects(
          admin.query(
            column === "generation" ? changes[0][0] : bindingInsert,
            column === "generation" ? changes[0][1] : bindingArgs(101, 98),
          ),
          (e) => e.code === "22003",
        );
        await admin.query("ROLLBACK");
      }
      await admin.query("BEGIN");
      await admin.query("DELETE FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1", [
        id(1),
      ]);
      await assert.rejects(
        admin.query(rootInsert, [id(110), id(1), "SYNTHETIC_GAP", past, id(2)]),
        (e) => e.code === "55000",
      );
      await admin.query("ROLLBACK");
      for (const [table, column, value] of [["recipe_reference_generation", "brand_id", id(1)]]) {
        // Committed corruption in this disposable fixture must be visible to the separate reader.
        const saved = (
          await admin.query(`DELETE FROM rms_recipe.${table} WHERE ${column}=$1 RETURNING *`, [
            value,
          ])
        ).rows[0];
        assert(saved);
        let called = false;
        try {
          await assert.rejects(
            source().withCurrentSnapshot(request, async () => {
              called = true;
              return true;
            }),
            (e) => e.code === "RECIPE_DEPENDENCY_UNAVAILABLE",
          );
          assert.equal(called, false);
        } finally {
          await admin.query(
            `INSERT INTO rms_recipe.${table} SELECT * FROM jsonb_populate_record(NULL::rms_recipe.${table},$1::jsonb)`,
            [JSON.stringify(saved)],
          );
        }
      }
      for (const table of [...sourceTables, "recipe_ingredient_requirement"])
        await assert.rejects(
          admin.query(`TRUNCATE rms_recipe.${table} CASCADE`),
          (e) => e.code === (table === "recipe_modifier_version" ? "23514" : "55000"),
        );
    } finally {
      await Promise.allSettled([
        admin.query("ROLLBACK"),
        reader.query("ROLLBACK"),
        writer.query("ROLLBACK"),
      ]);
      await Promise.allSettled([admin.end(), reader.end(), writer.end()]);
    }
  });
});
