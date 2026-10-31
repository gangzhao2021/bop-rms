import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPostgresCurrentSkuStore } from "../../rms/catalog/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-01T16:00:00.000Z";
it("reads exact current SKU facts with Brand RLS and lifecycle/version refusal", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_current_sku" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_sku_" + context.runId;
    let active = 0;
    const runner = {
      async run(action) {
        const client = new Client(context.clientConfig);
        await client.connect();
        active++;
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL ROLE " + role);
          assert.equal(
            (await client.query("SELECT count(*)::int AS n FROM rms_catalog.sku")).rows[0].n,
            0,
          );
          const result = await action({ query: (sql, values) => client.query(sql, values) });
          await client.query("COMMIT");
          assert.equal(
            (await client.query("SELECT nullif(current_setting('bop.brand_id',true),'') AS brand"))
              .rows[0].brand,
            null,
          );
          return result;
        } finally {
          await client.query("ROLLBACK");
          await client.end();
          active--;
        }
      },
    };
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku TO " +
          role,
      );
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'TEST_SKU','PreparedFood','Active',2,$3,$4,$3)",
        [id(1), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,tax_classification_id,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$6,$6)",
        [id(4), id(1), id(2), JSON.stringify({ "en-CA": "Synthetic product" }), id(7), at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'TEST_SKU','Active',$5::jsonb,'[]'::jsonb,$6,'EACH',$7::numeric,$8,$9)",
        [
          id(5),
          id(1),
          id(2),
          id(4),
          JSON.stringify({ "en-CA": "Synthetic SKU" }),
          "sha256:" + "a".repeat(64),
          "99999999999999.123456",
          at,
          id(3),
        ],
      );
      const store = createPostgresCurrentSkuStore(runner, { brandReference: id(2) });
      const input = { sellableReference: id(5), productVersionReference: id(4), observedAt: at };
      assert.deepEqual(await store.load(input), {
        brandReference: id(2),
        sellableReference: id(5),
        productReference: id(1),
        productVersionReference: id(4),
        productLifecycle: "Active",
        skuLifecycle: "Active",
        productAggregateVersion: 2,
        catalogEligible: true,
        unitOfSale: "EACH",
        unitQuantity: "99999999999999.123456",
        taxClassificationReference: id(7),
        productUpdatedAt: at,
        observedAt: at,
      });
      for (const change of [
        { sellableReference: id(99) },
        { productVersionReference: id(99) },
        { observedAt: "2026-08-01T15:59:59.999Z" },
      ])
        assert.equal(await store.load({ ...input, ...change }), null);
      assert.equal(
        await createPostgresCurrentSkuStore(runner, { brandReference: id(99) }).load(input),
        null,
      );
      await assert.rejects(store.load({ ...input, brandReference: id(99) }), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      for (const lifecycle of ["Draft", "Suspended", "Discontinued", "Archived"]) {
        await admin.query(
          "UPDATE rms_catalog.product SET lifecycle=$2,aggregate_version=aggregate_version+1 WHERE product_id=$1",
          [id(1), lifecycle],
        );
        const result = await store.load(input);
        assert.equal(result.productLifecycle, lifecycle);
        assert.equal(result.catalogEligible, false);
      }
      await admin.query(
        "UPDATE rms_catalog.product SET lifecycle='Active',aggregate_version=aggregate_version+1 WHERE product_id=$1",
        [id(1)],
      );
      for (const lifecycle of ["Draft", "Suspended", "Discontinued", "Archived"]) {
        await admin.query("UPDATE rms_catalog.sku SET lifecycle=$2 WHERE sku_id=$1", [
          id(5),
          lifecycle,
        ]);
        const result = await store.load(input);
        assert.equal(result.skuLifecycle, lifecycle);
        assert.equal(result.catalogEligible, false);
      }
      await admin.query(
        "UPDATE rms_catalog.product SET updated_at=$2,aggregate_version=aggregate_version+1 WHERE product_id=$1",
        [id(1), "2026-08-01T16:01:00.000Z"],
      );
      assert.equal(await store.load(input), null);
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_catalog.sku")).rows[0].n,
        1,
      );
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
