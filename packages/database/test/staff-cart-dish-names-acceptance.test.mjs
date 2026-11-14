import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { listStoreMenuSellableNames } from "../../rms/catalog/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01a7e550-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 staff-wording-and-expected-refusals (v15 2026-11-11): staff in 中文 saw a guest's cart
 * dish by its English name. The dish sits on two current menus of the Store: one published before
 * its Chinese name was entered (English only) and one republished after (English and Chinese).
 * Staff screens (Tables cart panel, staff round, the table's order) name a guest's cart line from
 * these names, so every language a current menu has for the dish must be there, the newest
 * publication first. Read as the pilot API role (NOBYPASSRLS, rendered pilot ACL).
 */
it("a guest's cart dish on two current menus keeps the Chinese name the newer menu has", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_cart_names" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_scn_" + context.runId,
      worker = "wp2423_scn_w_" + context.runId;
    const brand = id(1),
      store = id(2),
      otherStore = id(3),
      dish = id(10),
      onlyOld = id(11);
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      // TEST-ONLY seed of the projection rows alone (their menu-authoring parents are outside
      // this case, so the seed skips foreign keys and restores them afterwards).
      await admin.query("SET session_replication_role = replica");
      const menus = [
        // The first menu, published before the Chinese names were entered.
        {
          n: 100,
          rebuiltAt: "2026-10-01T00:00:00Z",
          stores: [store],
          lines: [
            [dish, { "en-CA": "Wonton soup (TEST)" }],
            [onlyOld, { "en-CA": "Spring roll (TEST)" }],
          ],
        },
        // The dine-in menu, republished after staff entered the Chinese name.
        {
          n: 200,
          rebuiltAt: "2026-10-25T00:00:00Z",
          stores: [store],
          lines: [[dish, { "en-CA": "Wonton soup (TEST)", "zh-Hans-CA": "馄饨汤" }]],
        },
        // Another Store's menu never names this Store's dishes.
        {
          n: 300,
          rebuiltAt: "2026-11-01T00:00:00Z",
          stores: [otherStore],
          lines: [[dish, { "en-CA": "Other store soup", "zh-Hans-CA": "别店汤" }]],
        },
      ];
      for (const menu of menus) {
        const generation = id(menu.n),
          menuReference = id(menu.n + 1),
          section = id(menu.n + 2),
          event = id(menu.n + 3);
        await admin.query(
          "INSERT INTO rms_catalog.published_menu_projection_generation VALUES($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,1,$4,$5,'Fresh')",
          [generation, brand, menuReference, event, menu.rebuiltAt],
        );
        await admin.query(
          `INSERT INTO rms_catalog.published_menu_projection VALUES($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"Menu"}',$7,'["CUSTOMER_PWA"]','["DINE_IN"]','UTC','2026-09-20T00:00:00Z',NULL)`,
          [
            generation,
            brand,
            menuReference,
            id(menu.n + 4),
            id(menu.n + 5),
            "sha256:" + "b".repeat(64),
            JSON.stringify(menu.stores),
          ],
        );
        await admin.query(
          `INSERT INTO rms_catalog.published_menu_projection_section VALUES($1,$2,$3,$4,'MAINS','{"en-CA":"Mains"}',0)`,
          [generation, brand, menuReference, section],
        );
        let order = 0;
        for (const [sellable, names] of menu.lines)
          await admin.query(
            `INSERT INTO rms_catalog.published_menu_projection_sellable VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Standard',$9,false,'Available','[]',$10)`,
            [
              generation,
              brand,
              menuReference,
              section,
              id(menu.n + 10 + order),
              sellable,
              id(menu.n + 20 + order),
              JSON.stringify(names),
              order++,
              JSON.stringify({
                items: [],
                assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                allergenFreeClaim: false,
                registryVersionReference: id(9),
              }),
            ],
          );
        await admin.query(
          "INSERT INTO rms_catalog.published_menu_projection_checkpoint VALUES('catalog.published-menu-projection',$1,$2,$3,$4,1,$5)",
          [brand, menuReference, generation, event, menu.rebuiltAt],
        );
      }
      await admin.query("SET session_replication_role = DEFAULT");

      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE " + api);
      await admin.query("SET LOCAL statement_timeout = '10s'");
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const names = await listStoreMenuSellableNames(
        admin,
        { brandReference: brand, storeReference: store },
        [dish, onlyOld, id(12)],
      );
      // The caller's Store scope is put back.
      const after = await admin.query("SELECT current_setting('bop.store_id',true) store");
      await admin.query("COMMIT");
      assert.deepEqual(names.get(dish), { "en-CA": "Wonton soup (TEST)", "zh-Hans-CA": "馄饨汤" });
      assert.deepEqual(names.get(onlyOld), { "en-CA": "Spring roll (TEST)" });
      assert.equal(names.has(id(12)), false);
      assert.equal(after.rows[0].store, store);
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
      await admin.end();
    }
  });
});
