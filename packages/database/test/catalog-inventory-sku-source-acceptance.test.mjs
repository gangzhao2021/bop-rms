import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCatalogInventorySkuReferenceSourceStore,
  createPostgresProductCreationStore,
  catalogInventorySkuReferenceFields,
  catalogInventorySkuReferencePermissions,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  id = (n) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  past = "2026-08-01T00:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
it("holds actual current Catalog SKU configuration and supported writer fence through caller COMMIT", async () => {
  await withIsolatedDatabase({ caseId: "catalog_inv_sku" }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const role = "wp2409_invsku_" + context.runId;
    let denyAt = 0,
      checks = 0,
      now = () => new Date().toISOString(),
      called = false;
    const request = {
      purposeCode: "INVENTORY_FINISHED_GOOD_SKU_SOURCE_READ",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      operationReference: id(4),
      consumerIntentDigest: hash,
      productReference: id(5),
      productVersionReference: id(6),
      skuReference: id(7),
      expectedConfigurationDigest: null,
    };
    try {
      assert.match(role, /^wp2409_invsku_[a-f0-9]+$/u);
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO ${role}`);
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      const grants = {
        product: "brand_id,product_id,aggregate_version,created_at,updated_at",
        product_version:
          "brand_id,product_id,product_version_id,status,category_classification_known,primary_category_id,tax_classification_id,created_at,updated_at",
        sku: "brand_id,product_id,product_version_id,sku_id,created_at",
        product_source_head: "brand_id,source_revision",
        product_version_category_assignment: "brand_id,product_id,product_version_id,category_id",
        product_option_binding:
          "brand_id,product_id,product_version_id,binding_id,option_set_id,option_set_version_id",
        product_option_binding_option: "brand_id,product_id,binding_id,option_id",
        product_option_binding_sku_scope: "brand_id,product_id,binding_id,sku_id,scope_kind",
        product_option_binding_channel: "brand_id,product_id,binding_id,channel_code",
      };
      for (const [table, columns] of Object.entries(grants)) {
        assert.match(table, /^[a-z_]+$/);
        assert.match(columns, /^[a-z_,]+$/);
        await admin.query(`GRANT SELECT(${columns}) ON rms_catalog.${table} TO ${role}`);
      }
      // Synthetic fixed owning facts seed only; no real merchant/source receipt claim.
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_BOTTLE','NonAlcoholicBeverage','Draft',1,$3,$4,$3)",
        [id(5), id(2), past, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
        [id(6), id(5), id(2), JSON.stringify({ "en-CA": "Synthetic bottle" }), past],
      );
      await admin.query(
        "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC_BOTTLE_ONE','Draft',$5,'[]',$6,'EACH',1,$7,$8)",
        [
          id(7),
          id(5),
          id(2),
          id(6),
          JSON.stringify({ "en-CA": "Synthetic bottle one" }),
          hash,
          past,
          id(3),
        ],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_source_head(brand_id,source_revision) VALUES($1,1)",
        [id(2)],
      );
      const competitor = createPostgresProductCreationStore({
        brandReference: id(2),
        authorize: async () => true,
        transactions: {
          async run(work) {
            await writer.query("BEGIN");
            await writer.query("SET LOCAL lock_timeout='150ms'");
            try {
              const result = await work(writer);
              await writer.query("COMMIT");
              return result;
            } catch (error) {
              await writer.query("ROLLBACK");
              throw error;
            }
          },
        },
      });
      const prepare = () =>
        competitor.codeAvailable({
          brandReference: id(2),
          productCode: "SYNTHETIC_COMPETING",
          skuCodes: [],
          excludingProductReference: null,
        });
      const options = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        clock: { now: () => now() },
        transactions: {
          async run(work) {
            await reader.query("BEGIN");
            await reader.query(`SET LOCAL ROLE ${role}`);
            try {
              const result = await work(reader);
              await assert.rejects(prepare(), (e) => e.code === "55P03");
              await reader.query("COMMIT");
              return result;
            } catch (error) {
              await reader.query("ROLLBACK");
              throw error;
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, reader);
            assert.equal(input.requiredFields, catalogInventorySkuReferenceFields);
            assert.equal(input.requiredPermissions, catalogInventorySkuReferencePermissions);
            assert.equal(input.requiredScope, "FullBrandScope");
            assert.deepEqual(input.request, requestForAuthority);
            if (++checks === denyAt) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
      };
      let requestForAuthority = request;
      const source = createPostgresCatalogInventorySkuReferenceSourceStore(options),
        marker = Object.freeze({ accepted: true });
      let configurationDigest;
      assert.equal(
        await source.withCurrentSnapshot(request, async (snapshot) => {
          called = true;
          configurationDigest = snapshot.configurationDigest;
          assert.equal(snapshot.configuration.categoryCoverage, "Unavailable");
          assert.equal(snapshot.configuration.categoryReferences, null);
          assert.deepEqual(snapshot.configuration.skuReferences, [id(7)]);
          assert.equal(snapshot.sourceRevision, "1");
          assert.doesNotMatch(
            JSON.stringify(snapshot),
            /localizedNames|unitQuantity|createdByActorReference|audit|cost|allergen/,
          );
          await assert.rejects(prepare(), (e) => e.code === "55P03");
          return marker;
        }),
        marker,
      );
      assert.equal(called, true);
      assert.equal(checks, 3);
      assert.equal(await prepare(), true);
      requestForAuthority = { ...request, expectedConfigurationDigest: configurationDigest };
      await source.withCurrentSnapshot(requestForAuthority, async (snapshot) =>
        assert.equal(snapshot.configurationDigest, configurationDigest),
      );
      requestForAuthority = { ...request, expectedConfigurationDigest: hash };
      called = false;
      await assert.rejects(
        source.withCurrentSnapshot(requestForAuthority, async () => {
          called = true;
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(called, false);
      for (const change of [
        { productReference: id(99) },
        { productVersionReference: id(99) },
        { skuReference: id(99) },
      ]) {
        requestForAuthority = { ...request, ...change };
        await assert.rejects(
          source.withCurrentSnapshot(requestForAuthority, async () => true),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
      }
      requestForAuthority = request;
      for (const offset of [1, 2, 3]) {
        denyAt = checks + offset;
        await assert.rejects(
          source.withCurrentSnapshot(request, async () => true),
          (e) => e.code === "CATALOG_PERMISSION_DENIED",
        );
        denyAt = 0;
      }
      await assert.rejects(
        source.withCurrentSnapshot(request, async () => {
          now = () => new Date(Date.now() + 6000).toISOString();
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      now = () => new Date().toISOString();
      await assert.rejects(
        source.withCurrentSnapshot(request, async () => {
          await reader.query("SET LOCAL ROLE NONE");
          await reader.query(
            "UPDATE rms_catalog.product_source_head SET source_revision=source_revision+1 WHERE brand_id=$1",
            [id(2)],
          );
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT source_revision::text n FROM rms_catalog.product_source_head WHERE brand_id=$1",
            [id(2)],
          )
        ).rows[0].n,
        "1",
      );
      await source.withCurrentSnapshot(request, async () => {
        await reader.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [id(90), id(91), id(92)],
        );
      });
      await reader.query("BEGIN");
      await reader.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(
        reader.query("SELECT localized_names_json FROM rms_catalog.sku"),
        (e) => e.code === "42501",
      );
      await reader.query("ROLLBACK");
    } finally {
      await Promise.allSettled([admin.end(), reader.end(), writer.end()]);
    }
  });
});
