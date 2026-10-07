import { createCurrentOptionSetDraftRecipeYieldSource } from "../../../apps/api/src/current-option-set-draft-recipe-yields.ts";
import { createCurrentOptionSetDraftInventoryUnitSource } from "../../../apps/api/src/current-option-set-draft-inventory-units.ts";
import { createCurrentOptionSetDraftGraphSource } from "../../../apps/api/src/current-option-set-draft-graph.ts";
import { createCurrentOptionSetDraftConsumptionReferenceSource } from "../../../apps/api/src/current-option-set-draft-consumption-references.ts";
import {
  createPostgresFullOptionSetDraftStore,
  parseCatalogOptionSetEditorContent,
} from "../../rms/catalog/src/index.ts";
import {
  createInventoryItem,
  createPostgresInventoryConfigurationReferenceSourceStore,
  inventoryConfigurationReferenceFields,
  inventoryOptionConsumptionUnitFields,
  inventoryConfigurationReferencePermissions,
} from "../../rms/inventory/src/index.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresRecipeReferenceSourceStore,
  createPostgresRecipeOptionConsumptionYieldSource,
  recipeReferenceSourceFields,
  recipeOptionConsumptionYieldFields,
  RecipeWorkflowError,
} from "../../rms/recipe/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { Client } = pg;
const id = (n) => `01902416-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
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
    changes: [],
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
it("holds complete minimal Recipe references and all-Store projection through outer COMMIT", async () => {
  await withIsolatedDatabase({ caseId: "recipe_refs", root }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const role = `wp2416_${context.runId}`,
      request = {
        purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
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
        assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
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
      source = () => createPostgresRecipeReferenceSourceStore(options);
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
          "selected_quantity",
          "lifecycle",
          "rule_digest",
          "effective_from",
          "effective_until",
          "occurred_at",
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
      };
      for (const [table, fields] of Object.entries(columns))
        await admin.query(`GRANT SELECT(${fields.join(",")}) ON rms_recipe.${table} TO ${role}`);
      const empty = await source().withCurrentSnapshot(request, async (s) => s);
      assert.equal(empty.generation, "0");
      assert.equal(empty.recipes.length, 0);
      await admin.query("BEGIN");
      await seed(admin);
      await seed(admin, 60, 60);
      await admin.query(rootInsert, [id(12), id(1), "SYNTHETIC_EMPTY", past, id(2)]);
      await admin.query("COMMIT");
      const changes = [
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
        assert.equal(s.bindings.length, 2);
        assert.equal(s.bindingCount, "2");
        assert.equal(s.bindings.find((b) => b.storeReference !== null).storeReference, id(99));
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
      await admin.query(
        `GRANT SELECT ON rms_recipe.recipe_scope_binding,rms_recipe.recipe_scope_binding_end TO ${role}`,
      );
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
      for (const [table, column] of [
        ["recipe_version", "snapshot_json"],
        ["recipe_modifier_version", "rule_json"],
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
      for (const [table, column, value] of [
        ["recipe_reference_generation", "brand_id", id(1)],
        ["recipe_reference_binding", "recipe_scope_binding_id", id(20)],
      ]) {
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
      for (const table of sourceTables)
        await assert.rejects(
          admin.query(`TRUNCATE rms_recipe.${table} CASCADE`),
          (e) => e.code === (table === "recipe_modifier_version" ? "23514" : "55000"),
        );
      // Milestone58: actual full Draft + complete current Inventory/Recipe consumption metadata.
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_catalog,rms_inventory,platform_audit,platform_eventing TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,platform_audit.audit_record,platform_eventing.outbox_event TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      await admin.query(
        `GRANT SELECT ON rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,rms_inventory.configuration_reference_generation TO ${role}`,
      );
      await admin.query(
        `GRANT INSERT ON rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation TO ${role}`,
      );
      // Version trigger locks immutable root FOR UPDATE; column grant permits the lock, not a history mutation.
      await admin.query(`GRANT UPDATE(item_id) ON rms_inventory.inventory_item TO ${role}`);
      // Explicit controlled metadata: this does not certify Recipe publication or current unit/Binding eligibility.
      const published58 = versionArgs(21112, 2, 10, 1);
      published58[6] = past;
      assert.equal(
        (await admin.query(versionInsert.replace("'Draft'", "'Published'"), published58)).rowCount,
        1,
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=3 WHERE recipe_id=$2",
            [id(21112), id(10)],
          )
        ).rowCount,
        1,
      );
      const item58 = createInventoryItem({
        tenantReference: id(4),
        brandReference: id(1),
        itemReference: id(21000),
        internalCode: "SYNTHETIC_CONSUMPTION58",
        itemType: "FinishedGood",
        localizedNames: { en: "Synthetic item" },
        baseUnit: {
          unitCode: "EA",
          dimension: "Count",
          displayPrecision: 0,
          ledgerPrecision: 0,
          roundingMode: "HalfEven",
        },
        trackingPolicy: {
          stockTrackingEnabled: true,
          lotTrackingMode: "NoLot",
          defaultShelfLifeDays: null,
          expiryWarningDays: null,
          issuePolicy: "FIFO",
          negativeStockPolicy: "Block",
        },
        occurredAt: past,
        actorReference: id(2),
      });
      await admin.query(
        "INSERT INTO rms_inventory.inventory_item(tenant_id,brand_id,item_id,internal_code,item_type,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id(4), id(1), id(21000), "SYNTHETIC_CONSUMPTION58", "FinishedGood", past, id(2)],
      );
      for (const v of [1, 2, 3]) {
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
          [
            id(4),
            id(1),
            id(21000),
            v,
            JSON.stringify({
              ...item58,
              aggregateVersion: v,
              lifecycle: v === 3 ? "Active" : "Inactive",
            }),
            past,
          ],
        );
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id(4),
            id(1),
            id(21100 + v),
            id(21000),
            v,
            digest,
            v === 1 ? "Create" : v === 2 ? "Update" : "Activate",
            id(21200 + v),
          ],
        );
      }
      const original58 = new Date().toISOString(),
        end58 = new Date(Date.parse(original58) + 30000).toISOString();
      let override58 = null,
        allocated58 = 22000,
        aux58 = 23000,
        actual58 = null,
        readAllowed58 = true,
        inventoryAllowed58 = true,
        recipeAllowed58 = true;
      const current58 = () => override58 ?? new Date().toISOString();
      const transaction58 = async (work) => {
        await reader.query("BEGIN");
        await reader.query(`SET LOCAL ROLE ${role}`);
        try {
          const value = await work(reader);
          await reader.query("COMMIT");
          return value;
        } catch (e) {
          await reader.query("ROLLBACK");
          throw e;
        }
      };
      const writer58 = (run) =>
        createPostgresFullOptionSetDraftStore({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(2),
          clock: { now: current58 },
          transactions: { run },
          authority: {
            holdUntilTransactionCompletes: async (_tx, input) => ({
              observedAt: input.observedAt,
              validUntil: end58,
            }),
          },
          creation: {
            authority: {
              holdUntilTransactionCompletes: async (_tx, input) => ({
                observedAt: input.observedAt,
                validUntil: end58,
              }),
            },
            references: { generate: () => id(++allocated58) },
          },
          audit: {
            create(input) {
              return {
                auditId: id(++aux58),
                brandId: id(1),
                actor: { type: "User", reference: id(2) },
                actionCode: "CATALOG_OPTION_SET_CREATE",
                targetType: "CatalogOptionSet",
                targetId: input.result.sourceAggregate.optionSetReference,
                reasonCode: input.reasonCode,
                correlationId: input.operationReference,
                occurredAt: input.occurredAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              };
            },
          },
          events: { generateReference: () => id(++aux58) },
        });
      const create58 = (code, operation) => ({
        internalCode: code,
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic consumption" },
          localizedDescriptions: {},
          displayStyle: "MultiChoice",
          minimumSelection: 0,
          maximumSelection: 2,
          allowRepeatedOption: false,
          perOptionMaximumQuantity: 1,
          maximumTotalQuantity: 2,
          options: ["INVENTORY", "RECIPE"].map((stableCode, i) => ({
            stableCode,
            sortOrder: i,
            lifecycle: "Draft",
            localizedNames: { "en-CA": "Synthetic option" },
            localizedDescriptions: {},
            defaultEligible: true,
            triggeredOptionSetReference: null,
            conflictOptionCodes: [],
          })),
        },
        additionalContent: {
          profile: "CatalogOptionSetEditorContentV1",
          optionDetails: [
            {
              stableCode: "INVENTORY",
              quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
              media: null,
              pricingRule: null,
              consumption: {
                kind: "Inventory",
                reference: id(21000),
                versionReference: id(21103),
                quantity: "1",
                unitCode: "EA",
              },
              triggeredOptionSetVersionReference: null,
            },
            {
              stableCode: "RECIPE",
              quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
              media: null,
              pricingRule: null,
              consumption: {
                kind: "Recipe",
                reference: id(10),
                versionReference: id(21112),
                quantity: "1",
                unitCode: "PORTION",
              },
              triggeredOptionSetVersionReference: null,
            },
          ],
          conditionalRules: [],
          conflictRules: [],
          scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: past, localDateTime: past.slice(0, 23), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
        },
        operationReference: operation,
        occurredAt: current58(),
        reasonCode: "INITIAL_CONFIGURATION",
      });
      const draft58 = await writer58(transaction58).create(create58("CONSUMPTION58", id(24000)));
      const { sourceAggregate: root58, ...additional58 } = draft58.content,
        parsed58 = parseCatalogOptionSetEditorContent(root58, additional58);
      const input58 = {
        graphRequest: {
          optionSetReference: root58.optionSetReference,
          versionReference: root58.draft.versionReference,
          expectedAggregateVersion: 1,
          sourceDigest: parsed58.sourceDigest,
          contentDigest: draft58.contentDigest,
          configurationDigest: draft58.configurationDigest,
          observedAt: original58,
          validUntil: end58,
        },
        inventoryRequest: {
          purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(2),
          operationReference: id(24010),
          catalogIntentDigest: digest,
        },
        recipeRequest: { ...request, operationReference: id(24010) },
        activationAt: new Date(Date.parse(original58) + 15000).toISOString(),
      };
      const provider58 = () =>
        createCurrentOptionSetDraftConsumptionReferenceSource({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(2),
          clock: { now: current58 },
          readAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual58);
              assert.equal(input.action, "catalog.option_set.read");
              if (!readAllowed58) throw Error("synthetic read denial");
              return { observedAt: input.observedAt, validUntil: end58 };
            },
          },
          inventoryAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual58);
              assert.equal(input.requiredScope, "FullBrandScope");
              assert.deepEqual(input.requiredFields, inventoryConfigurationReferenceFields);
              assert.deepEqual(
                input.requiredPermissions,
                inventoryConfigurationReferencePermissions,
              );
              if (!inventoryAllowed58) throw Error("synthetic Inventory denial");
            },
          },
          recipeAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual58);
              assert.equal(input.permission, "recipe.manage");
              assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
              if (!recipeAllowed58) throw Error("synthetic Recipe denial");
            },
          },
        });
      const tables58 = [
        "rms_catalog.option_set",
        "rms_catalog.option_set_version",
        "rms_catalog.option",
        "rms_catalog.option_conflict",
        "rms_catalog.option_set_operation_record",
        "rms_catalog.option_set_draft_content_snapshot",
        "rms_inventory.inventory_item",
        "rms_inventory.inventory_item_version",
        "rms_inventory.inventory_item_operation",
        "rms_inventory.configuration_reference_generation",
        "rms_recipe.recipe",
        "rms_recipe.recipe_version",
        "rms_recipe.recipe_scope_binding",
        "rms_recipe.recipe_modifier_version",
        "rms_recipe.recipe_reference_binding",
        "rms_recipe.recipe_reference_generation",
        "platform_audit.audit_record",
        "platform_audit.audit_chain_head",
        "platform_eventing.outbox_event",
      ];
      const take58 = async () => {
        const result = {};
        for (const table of tables58)
          result[table] = (
            await admin.query(
              "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
            )
          ).rows;
        return result;
      };
      const baseline58 = await take58();
      // Diagnose each actual owning acquisition before admitting the combined source.
      await transaction58(async (tx) => {
        actual58 = tx;
        await createCurrentOptionSetDraftGraphSource({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(2),
          clock: { now: current58 },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              return { observedAt: input.observedAt, validUntil: end58 };
            },
          },
        }).withCurrentGraph(tx, input58.graphRequest, async (root) => root);
      });
      await transaction58(async (tx) => {
        await createPostgresInventoryConfigurationReferenceSourceStore({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(2),
          clock: { now: current58 },
          transactions: { run: (action) => action(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual) {
              assert.equal(actual, tx);
            },
          },
        }).withCurrentSnapshot(input58.inventoryRequest, async (source) => source);
      });
      await transaction58(async (tx) => {
        await createPostgresRecipeReferenceSourceStore({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(2),
          clock: { now: current58 },
          transactions: { run: (action) => action(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual) {
              assert.equal(actual, tx);
            },
          },
        }).withCurrentSnapshot(input58.recipeRequest, async (source) => {
          assert.equal(
            source.recipes.find((r) => r.recipeReference === id(10)).currentVersionReference,
            id(21112),
          );
          assert.equal(
            source.versions.find((r) => r.recipeVersionReference === id(21112)).lifecycle,
            "Published",
          );
          assert.equal(
            source.versions.find((r) => r.recipeVersionReference === id(11)).lifecycle,
            "Draft",
          );
          return source;
        });
      });
      let callbackFailure58;
      try {
        await transaction58(async (tx) => {
          actual58 = tx;
          await provider58().withCurrentAssessment(tx, input58, async (v) => {
            try {
              assert.equal(v.inventory.matches.length, 1);
              assert.equal(v.inventory.matches[0].versionReference, id(21103));
              assert.equal(v.inventory.matches[0].status, "CurrentActiveMetadata");
              assert.equal(v.recipe.matches.length, 1);
              assert.equal(v.recipe.matches[0].status, "CurrentPublishedMetadata");
              assert.equal(v.inventory.decision, "PassForMetadata");
              assert.equal(v.recipe.decision, "PassForMetadata");
              assert.equal(v.inventory.unitConversionEligibility, "NotEvaluated");
              assert.equal(v.recipe.bindingApplicability, "NotEvaluated");
              assert.equal(v.eligibility, "NotEvaluated");
              assert.equal(v.publishValidation, "Incomplete");
              return v;
            } catch (e) {
              callbackFailure58 = e;
              throw e;
            }
          });
        });
      } catch (e) {
        throw callbackFailure58 ?? e;
      }
      assert.deepEqual(await take58(), baseline58);
      for (const mode58 of [
        "root-fields",
        "inventory-fields",
        "recipe-fields",
        "expiry",
        "backward",
        "root-head",
        "inventory-generation",
        "recipe-generation",
      ]) {
        override58 = null;
        readAllowed58 = true;
        inventoryAllowed58 = true;
        recipeAllowed58 = true;
        let probeFailure58;
        let reached58 = false,
          armed58 = false;
        await assert.rejects(
          transaction58(async (tx) => {
            actual58 = tx;
            await provider58().withCurrentAssessment(tx, input58, async (v) => {
              reached58 = true;
              try {
                const temporary = await writer58(async (work) => work(tx)).create(
                  create58("TENTATIVE58", id(25000)),
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT count(*)::int n FROM rms_catalog.option_set_operation_record WHERE operation_id=$1",
                      [id(25000)],
                    )
                  ).rows[0].n,
                  1,
                );
                assert.ok(temporary.content.sourceAggregate.optionSetReference);
                if (mode58 === "root-fields") readAllowed58 = false;
                if (mode58 === "inventory-fields") inventoryAllowed58 = false;
                if (mode58 === "recipe-fields") recipeAllowed58 = false;
                if (mode58 === "expiry") override58 = v.validUntil;
                if (mode58 === "backward")
                  override58 = new Date(Date.parse(original58) - 1).toISOString();
                if (mode58 === "root-head")
                  assert.equal(
                    (
                      await tx.query(
                        "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1",
                        [root58.optionSetReference],
                      )
                    ).rowCount,
                    1,
                  );
                if (mode58 === "inventory-generation") {
                  const before = (
                    await tx.query(
                      "SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
                      [id(4), id(1)],
                    )
                  ).rows[0].generation;
                  const nextAt = new Date(Date.parse(past) + 1).toISOString();
                  assert.equal(
                    (
                      await tx.query(
                        "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,4,$4::jsonb,$5)",
                        [
                          id(4),
                          id(1),
                          id(21000),
                          JSON.stringify({
                            ...item58,
                            aggregateVersion: 4,
                            lifecycle: "Active",
                            updatedAt: nextAt,
                          }),
                          nextAt,
                        ],
                      )
                    ).rowCount,
                    1,
                  );
                  assert.equal(
                    (
                      await tx.query(
                        "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES($1,$2,$3,$4,4,$5,'Update',$6)",
                        [id(4), id(1), id(21104), id(21000), digest, id(21204)],
                      )
                    ).rowCount,
                    1,
                  );
                  const after = (
                    await tx.query(
                      "SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
                      [id(4), id(1)],
                    )
                  ).rows[0].generation;
                  assert.notEqual(after, before);
                }
                if (mode58 === "recipe-generation") {
                  const before = (
                    await tx.query(
                      "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
                      [id(1)],
                    )
                  ).rows[0].generation;
                  await tx.query(
                    "UPDATE rms_recipe.recipe SET updated_at=updated_at+interval '1 millisecond' WHERE recipe_id=$1",
                    [id(10)],
                  );
                  const after = (
                    await tx.query(
                      "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
                      [id(1)],
                    )
                  ).rows[0].generation;
                  assert.notEqual(after, before);
                }
                armed58 = true;
                return "tentative";
              } catch (e) {
                probeFailure58 = e;
                throw e;
              }
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal(reached58, true);
        if (probeFailure58) throw probeFailure58;
        assert.equal(armed58, true, mode58);
        assert.deepEqual(await take58(), baseline58);
      }
      override58 = null;
      // Milestone59: owning current unit fields and exact decimal consumption.
      const unitItem59 = { ...item58, itemReference: id(26000), internalCode: "SYNTHETIC_UNIT59" };
      const conversions59 = [
        [26003, "CASE", "6"],
        [26005, "PALLET", "12"],
        [26006, "PALLET", "24"],
      ].map(([n, code, multiplier]) => ({
        conversionReference: id(n),
        fromUnitCode: code,
        toBaseUnitCode: "EA",
        multiplier,
        effectiveFrom: past,
        reasonCode: "INITIAL_CONFIGURATION",
        status: "Active",
      }));
      assert.equal(
        (
          await admin.query(
            "INSERT INTO rms_inventory.inventory_item(tenant_id,brand_id,item_id,internal_code,item_type,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [id(4), id(1), id(26000), "SYNTHETIC_UNIT59", "FinishedGood", past, id(2)],
          )
        ).rowCount,
        1,
      );
      for (const v of [1, 2]) {
        const recorded = new Date(Date.parse(past) + v - 1).toISOString();
        assert.equal(
          (
            await admin.query(
              "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
              [
                id(4),
                id(1),
                id(26000),
                v,
                JSON.stringify({
                  ...unitItem59,
                  aggregateVersion: v,
                  updatedAt: recorded,
                  lifecycle: v === 2 ? "Active" : "Inactive",
                  unitConversions: v === 2 ? conversions59 : [],
                }),
                recorded,
              ],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await admin.query(
              "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
              [
                id(4),
                id(1),
                id(26000 + v),
                id(26000),
                v,
                digest,
                v === 1 ? "Create" : "Activate",
                id(26010 + v),
              ],
            )
          ).rowCount,
          1,
        );
      }
      const original59 = new Date().toISOString(),
        end59 = new Date(Date.parse(original59) + 30000).toISOString();
      const createUnits59 = (code, operation, unitCode = "CASE", quantity = "2") => {
        const input = create58(code, operation);
        input.additionalContent.optionDetails[0].consumption = {
          kind: "Inventory",
          reference: id(26000),
          versionReference: id(26002),
          quantity,
          unitCode,
        };
        input.additionalContent.optionDetails[1].consumption = null;
        return input;
      };
      const created59 = [];
      for (const [code, operation, unitCode, quantity] of [
        ["UNITS59", 27000, "CASE", "2"],
        ["MISSING59", 27001, "UNKNOWN", "2"],
        ["ROUNDING59", 27002, "EA", "0.1"],
        ["AMBIGUOUS59", 27003, "PALLET", "2"],
      ])
        created59.push(
          await writer58(transaction58).create(
            createUnits59(code, id(operation), unitCode, quantity),
          ),
        );
      const input59 = (draft) => {
        const { sourceAggregate, ...additional } = draft.content,
          parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
        return {
          graphRequest: {
            optionSetReference: sourceAggregate.optionSetReference,
            versionReference: sourceAggregate.draft.versionReference,
            expectedAggregateVersion: 1,
            sourceDigest: parsed.sourceDigest,
            contentDigest: draft.contentDigest,
            configurationDigest: draft.configurationDigest,
            observedAt: original59,
            validUntil: end59,
          },
          inventoryRequest: { ...input58.inventoryRequest, operationReference: id(27020) },
          activationAt: new Date(Date.parse(original59) + 10000).toISOString(),
        };
      };
      let actual59 = null,
        unitAllowed59 = true;
      const provider59 = () =>
        createCurrentOptionSetDraftInventoryUnitSource({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(2),
          clock: { now: current58 },
          readAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual59);
              assert.equal(input.action, "catalog.option_set.read");
              if (!readAllowed58) throw Error("synthetic read denial");
              return { observedAt: input.observedAt, validUntil: end59 };
            },
          },
          inventoryAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual59);
              assert.equal(input.requiredScope, "FullBrandScope");
              assert.deepEqual(input.requiredFields, inventoryConfigurationReferenceFields);
              if (!inventoryAllowed58) throw Error("synthetic metadata denial");
            },
          },
          unitAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual59);
              assert.equal(input.requiredScope, "FullBrandScope");
              assert.deepEqual(input.requiredFields, inventoryOptionConsumptionUnitFields);
              assert.deepEqual(
                input.requiredPermissions,
                inventoryConfigurationReferencePermissions,
              );
              assert.deepEqual(input.itemReferences, [id(26000)]);
              assert.deepEqual(input.request, input59(created59[0]).inventoryRequest);
              if (!unitAllowed59) throw Error("synthetic unit field denial");
            },
          },
        });
      const baseline59 = await take58();
      for (const [i, draft] of created59.entries()) {
        let callbackError59;
        try {
          await transaction58(async (tx) => {
            actual59 = tx;
            await provider59().withCurrentAssessment(tx, input59(draft), async (result) => {
              try {
                assert.equal(result.inventory.matches.length, 1);
                assert.equal(result.publishValidation, "Incomplete");
                assert.equal(result.eligibility, "NotEvaluated");
                assert.equal(result.inventory.quantityPolicy, "NotEvaluated");
                if (i === 0) {
                  assert.equal(result.inventory.unitArithmetic, "Pass");
                  assert.equal(result.inventory.matches[0].baseQuantity, "12");
                  assert.equal(result.inventory.matches[0].conversionReference, id(26003));
                } else {
                  assert.equal(result.inventory.unitArithmetic, "HardError");
                  assert.equal(result.inventory.matches[0].baseQuantity, null);
                  assert.equal(
                    result.inventory.matches[0].status,
                    [null, "MissingConversion", "RoundingRequired", "AmbiguousConversion"][i],
                  );
                }
                return result;
              } catch (e) {
                callbackError59 = e;
                throw e;
              }
            });
          });
        } catch (e) {
          throw callbackError59 ?? e;
        }
        assert.deepEqual(await take58(), baseline59);
      }
      for (const mode59 of [
        "unit-fields",
        "metadata-fields",
        "root-fields",
        "expiry",
        "backward",
        "inventory-generation",
        "root-head",
      ]) {
        override58 = null;
        readAllowed58 = true;
        inventoryAllowed58 = true;
        unitAllowed59 = true;
        let reached59 = false,
          armed59 = false,
          callbackError59;
        await assert.rejects(
          transaction58(async (tx) => {
            actual59 = tx;
            await provider59().withCurrentAssessment(tx, input59(created59[0]), async (result) => {
              reached59 = true;
              try {
                await writer58(async (work) => work(tx)).create(
                  createUnits59("TENTATIVE59", id(28000)),
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT count(*)::int n FROM rms_catalog.option_set_operation_record WHERE operation_id=$1",
                      [id(28000)],
                    )
                  ).rows[0].n,
                  1,
                );
                if (mode59 === "unit-fields") unitAllowed59 = false;
                if (mode59 === "metadata-fields") inventoryAllowed58 = false;
                if (mode59 === "root-fields") readAllowed58 = false;
                if (mode59 === "expiry") override58 = result.validUntil;
                if (mode59 === "backward")
                  override58 = new Date(Date.parse(original59) - 1).toISOString();
                if (mode59 === "root-head")
                  assert.equal(
                    (
                      await tx.query(
                        "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1",
                        [input59(created59[0]).graphRequest.optionSetReference],
                      )
                    ).rowCount,
                    1,
                  );
                if (mode59 === "inventory-generation") {
                  const before = (
                    await tx.query(
                      "SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
                      [id(4), id(1)],
                    )
                  ).rows[0].generation;
                  const nextAt = new Date(Date.parse(past) + 2).toISOString();
                  assert.equal(
                    (
                      await tx.query(
                        "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,3,$4::jsonb,$5)",
                        [
                          id(4),
                          id(1),
                          id(26000),
                          JSON.stringify({
                            ...unitItem59,
                            aggregateVersion: 3,
                            updatedAt: nextAt,
                            lifecycle: "Active",
                            unitConversions: conversions59,
                          }),
                          nextAt,
                        ],
                      )
                    ).rowCount,
                    1,
                  );
                  assert.equal(
                    (
                      await tx.query(
                        "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES($1,$2,$3,$4,3,$5,'Update',$6)",
                        [id(4), id(1), id(26004), id(26000), digest, id(26013)],
                      )
                    ).rowCount,
                    1,
                  );
                  const after = (
                    await tx.query(
                      "SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
                      [id(4), id(1)],
                    )
                  ).rows[0].generation;
                  assert.notEqual(after, before);
                }
                armed59 = true;
                return "tentative";
              } catch (e) {
                callbackError59 = e;
                throw e;
              }
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        if (callbackError59) throw callbackError59;
        assert.equal(reached59, true, mode59);
        assert.equal(armed59, true, mode59);
        assert.deepEqual(await take58(), baseline59);
      }
      override58 = null;
      // Milestone60: owning current Recipe yield columns, exact proportional quantity.
      await admin.query(
        `GRANT SELECT(yield_quantity_microunits,yield_unit_code,yield_dimension) ON rms_recipe.recipe_version TO ${role}`,
      );
      assert.equal(
        (await admin.query(rootInsert, [id(30000), id(1), "SYNTHETIC_YIELD60", past, id(2)]))
          .rowCount,
        1,
      );
      const yieldInsert60 =
        "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,1,$4,'Published','SYNTHETIC_NAME',3000000,'PORTION','Count',$5,$6,'America/Toronto',$6)";
      assert.equal(
        (await admin.query(yieldInsert60, [id(30001), id(30000), id(1), digest, id(30002), past]))
          .rowCount,
        1,
      );
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
            [id(30001), id(30000)],
          )
        ).rowCount,
        1,
      );
      const original60 = new Date().toISOString(),
        end60 = new Date(Date.parse(original60) + 30000).toISOString();
      const createYield60 = (code, operation, unitCode = "PORTION", quantity = "2") => {
        const input = createUnits59(code, operation);
        input.additionalContent.optionDetails[0].consumption = {
          kind: "Recipe",
          reference: id(30000),
          versionReference: id(30001),
          quantity,
          unitCode,
        };
        return input;
      };
      const created60 = [];
      for (const [code, op, unit, quantity] of [
        ["YIELD60", 31000, "PORTION", "2"],
        ["WRONG_UNIT60", 31001, "CASE", "2"],
        ["MAXIMUM60", 31002, "PORTION", "99999999999999.123456"],
      ])
        created60.push(
          await writer58(transaction58).create(createYield60(code, id(op), unit, quantity)),
        );
      const input60 = (draft) => ({
        graphRequest: { ...input59(draft).graphRequest, observedAt: original60, validUntil: end60 },
        recipeRequest: {
          purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
          brandReference: id(1),
          actorReference: id(2),
          operationReference: id(31020),
          catalogIntentDigest: digest,
        },
        activationAt: new Date(Date.parse(original60) + 10000).toISOString(),
      });
      let actual60 = null,
        yieldAllowed60 = true;
      const options60 = () => ({
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(2),
        clock: { now: current58 },
        readAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, actual60);
            if (!readAllowed58) throw Error("synthetic root denial");
            return { observedAt: input.observedAt, validUntil: end60 };
          },
        },
        recipeAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, actual60);
            assert.equal(input.tenantReference, id(4));
            assert.equal(input.permission, "recipe.manage");
            assert.equal(input.requiredScope, "FullBrandScope");
            assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
            assert.deepEqual(input.request, input60(created60[0]).recipeRequest);
            if (!recipeAllowed58) throw Error("synthetic metadata denial");
          },
        },
        yieldAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, actual60);
            assert.equal(input.tenantReference, id(4));
            assert.equal(input.permission, "recipe.manage");
            assert.equal(input.requiredScope, "FullBrandScope");
            assert.deepEqual(input.requiredFields, recipeOptionConsumptionYieldFields);
            assert.deepEqual(input.versionReferences, [id(30001)]);
            assert.deepEqual(input.request, input60(created60[0]).recipeRequest);
            if (!yieldAllowed60) throw Error("synthetic yield denial");
          },
        },
      });
      const provider60 = () => createCurrentOptionSetDraftRecipeYieldSource(options60());
      const baseline60 = await take58();
      await assert.rejects(
        writer58(transaction58).create(
          createYield60("OVERFLOW60", id(31003), "PORTION", "9999999999999999999999999"),
        ),
        (e) => e.code === "CATALOG_INPUT_INVALID",
      );
      assert.deepEqual(await take58(), baseline60);
      await transaction58(async (tx) => {
        actual60 = tx;
        const options = options60();
        await createCurrentOptionSetDraftGraphSource({
          ...options,
          authority: options.readAuthority,
        }).withCurrentGraph(tx, input60(created60[0]).graphRequest, async (root) => root);
      });
      await transaction58(async (tx) => {
        actual60 = tx;
        const options = options60();
        await createPostgresRecipeReferenceSourceStore({
          ...options,
          authority: options.recipeAuthority,
          transactions: { run: (action) => action(tx) },
        }).withCurrentSnapshot(input60(created60[0]).recipeRequest, async (metadata) => metadata);
      });
      await transaction58(async (tx) => {
        actual60 = tx;
        const options = options60();
        await createPostgresRecipeOptionConsumptionYieldSource({
          ...options,
          authority: options.recipeAuthority,
          transactions: { run: (action) => action(tx) },
        }).withCurrentYields(
          input60(created60[0]).recipeRequest,
          [
            {
              optionReference: created60[0].content.optionDetails[0].optionReference,
              reference: id(30000),
              versionReference: id(30001),
              quantity: "2",
              unitCode: "PORTION",
            },
          ],
          input60(created60[0]).activationAt,
          async (result) => {
            assert.equal(result.yieldArithmetic, "Pass");
            return result;
          },
        );
      });
      assert.deepEqual(await take58(), baseline60);
      for (const [i, status] of [
        [0, "ExactYieldQuantity"],
        [1, "UnknownYieldUnit"],
        [2, "ExactYieldQuantity"],
      ]) {
        let reached60 = false,
          callbackError60;
        await transaction58(async (tx) => {
          actual60 = tx;
          await provider60().withCurrentAssessment(tx, input60(created60[i]), async (result) => {
            reached60 = true;
            try {
              assert.equal(result.recipe.matches[0].status, status);
              assert.equal(result.publishValidation, "Incomplete");
              assert.equal(result.eligibility, "NotEvaluated");
              assert.equal(result.recipe.ingredientEligibility, "NotEvaluated");
              if (i === 0) {
                assert.equal(result.recipe.yieldArithmetic, "Pass");
                assert.equal(result.recipe.matches[0].requestedYieldMicrounits, "2000000");
                assert.equal(result.recipe.matches[0].batchNumerator, "2");
                assert.equal(result.recipe.matches[0].batchDenominator, "3");
              } else if (i === 2) {
                assert.equal(result.recipe.yieldArithmetic, "Pass");
                assert.equal(
                  result.recipe.matches[0].requestedYieldMicrounits,
                  "99999999999999123456",
                );
              } else {
                assert.equal(result.recipe.yieldArithmetic, "HardError");
                assert.equal(result.recipe.matches[0].requestedYieldMicrounits, null);
              }
              return result;
            } catch (e) {
              callbackError60 = e;
              throw e;
            }
          });
        }).catch((e) => {
          if (callbackError60) throw callbackError60;
          throw e;
        });
        assert.equal(reached60, true);
        assert.deepEqual(await take58(), baseline60);
      }
      for (const mode60 of [
        "yield-fields",
        "metadata-fields",
        "root-fields",
        "expiry",
        "backward",
        "recipe-generation",
        "root-head",
      ]) {
        override58 = null;
        recipeAllowed58 = true;
        readAllowed58 = true;
        yieldAllowed60 = true;
        let reached60 = false,
          armed60 = false,
          callbackError60;
        await assert.rejects(
          transaction58(async (tx) => {
            actual60 = tx;
            await provider60().withCurrentAssessment(tx, input60(created60[0]), async (result) => {
              reached60 = true;
              try {
                await writer58(async (action) => action(tx)).create(
                  createYield60("TENTATIVE60", id(32000)),
                );
                assert.equal(
                  (
                    await tx.query(
                      "SELECT count(*)::int n FROM rms_catalog.option_set_operation_record WHERE operation_id=$1",
                      [id(32000)],
                    )
                  ).rows[0].n,
                  1,
                );
                if (mode60 === "yield-fields") yieldAllowed60 = false;
                if (mode60 === "metadata-fields") recipeAllowed58 = false;
                if (mode60 === "root-fields") readAllowed58 = false;
                if (mode60 === "expiry") override58 = result.validUntil;
                if (mode60 === "backward")
                  override58 = new Date(Date.parse(original60) - 1).toISOString();
                if (mode60 === "root-head")
                  assert.equal(
                    (
                      await tx.query(
                        "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1",
                        [input60(created60[0]).graphRequest.optionSetReference],
                      )
                    ).rowCount,
                    1,
                  );
                if (mode60 === "recipe-generation") {
                  const before = (
                    await tx.query(
                      "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
                      [id(1)],
                    )
                  ).rows[0].generation;
                  assert.equal(
                    (
                      await tx.query(
                        "UPDATE rms_recipe.recipe SET updated_at=$1 WHERE recipe_id=$2",
                        [new Date(Date.parse(past) + 1).toISOString(), id(30000)],
                      )
                    ).rowCount,
                    1,
                  );
                  const after = (
                    await tx.query(
                      "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
                      [id(1)],
                    )
                  ).rows[0].generation;
                  assert.notEqual(after, before);
                }
                armed60 = true;
                return "tentative";
              } catch (e) {
                callbackError60 = e;
                throw e;
              }
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        if (callbackError60) throw callbackError60;
        assert.equal(reached60, true, mode60);
        assert.equal(armed60, true, mode60);
        assert.deepEqual(await take58(), baseline60);
      }
      override58 = null;
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
