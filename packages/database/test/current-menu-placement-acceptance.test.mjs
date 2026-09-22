import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPostgresCurrentMenuPlacementStore } from "../../rms/catalog/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-01T16:00:00.000Z";
it("reads exact menu placement and SKU version with Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_placement" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_placement_" + context.runId;
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
        "GRANT SELECT ON rms_catalog.menu,rms_catalog.menu_version,rms_catalog.menu_section,rms_catalog.sellable_placement,rms_catalog.sku TO " +
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

      await admin.query(
        "INSERT INTO rms_catalog.menu(menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_MENU',1,$3,$4,$3)",
        [id(10), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
        [id(11), id(10), id(2), JSON.stringify({ "en-CA": "Synthetic menu" }), at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_section(menu_section_id,menu_version_id,menu_id,brand_id,internal_code,localized_names_json,sort_order) VALUES($1,$2,$3,$4,'MAIN',$5::jsonb,0)",
        [id(12), id(11), id(10), id(2), JSON.stringify({ "en-CA": "Synthetic section" })],
      );
      const store = createPostgresCurrentMenuPlacementStore(runner, { brandReference: id(2) });
      const input = {
        menuReference: id(10),
        menuVersionReference: id(11),
        sellableReference: id(5),
        observedAt: at,
      };
      assert.equal(await store.load(input), null); // SKU existence alone is insufficient.
      for (const [n, role] of [
        [13, "Standard"],
        [14, "Featured"],
        [15, "Hidden"],
      ]) {
        await admin.query(
          "INSERT INTO rms_catalog.sellable_placement(placement_id,menu_section_id,menu_id,brand_id,sku_id,sellable_type,presentation_role,sort_order,pinned,localized_name_overrides_json,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,'Sku',$6,$7,false,'{}'::jsonb,$8,$9)",
          [id(n), id(12), id(10), id(2), id(5), role, n, at, id(3)],
        );
      }
      assert.deepEqual(await store.load(input), {
        brandReference: id(2),
        menuReference: id(10),
        menuVersionReference: id(11),
        sellableReference: id(5),
        productVersionReference: id(4),
        presentationRoles: ["Featured", "Hidden", "Standard"],
        observedAt: at,
      });
      for (const change of [
        { menuReference: id(99) },
        { menuVersionReference: id(99) },
        { sellableReference: id(99) },
        { observedAt: "2026-08-01T15:59:59.999Z" },
      ])
        assert.equal(await store.load({ ...input, ...change }), null);
      assert.equal(
        await createPostgresCurrentMenuPlacementStore(runner, { brandReference: id(99) }).load(
          input,
        ),
        null,
      );
      await assert.rejects(store.load({ ...input, brandReference: id(99) }), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      // Changes newer than the observation cannot pass as the original current menu.
      await admin.query(
        "UPDATE rms_catalog.menu_version SET updated_at=$2::timestamptz + interval '1 microsecond' WHERE menu_version_id=$1",
        [id(11), at],
      );
      assert.equal(await store.load(input), null);
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
