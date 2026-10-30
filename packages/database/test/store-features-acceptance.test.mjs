import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  changeStoreFeatureSetting,
  loadStoreFeatureSetting,
  StoreFeatureSettingConflictError,
} from "../../rms/store/src/index.ts";
import {
  fullServiceTemplate,
  guestServiceModes,
  navigationForStoreFeatures,
  readStoreFeatures,
} from "../../../apps/api/src/merchant-store-features.ts";
import { skuRecipeUsesStock } from "../../rms/recipe/src/index.ts";
import { waitingPickupOrders } from "../../../apps/api/src/merchant-pickup-query.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190a7f1-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the modules a Store uses, under the pilot api role holding
 * exactly the pilot ACL. A Store never set keeps every module; the owner's full-service template
 * turns counter ordering and inventory off; each change is the next version (a stale version and
 * a reused operation for something else are refused, the same operation returns); the record is
 * append-only and another Store neither sees nor changes it; the navigation drops the screens of
 * a module turned off. Synthetic TEST references only.
 */
it("keeps a Store's modules as versioned owner choices, per Store, under the pilot api role", async () => {
  await withIsolatedDatabase({ caseId: "store_features" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "store_features_api_" + context.runId,
      worker = "store_features_w_" + context.runId;
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
      const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
      const other = { ...scope, storeReference: id(4) };
      const owner = id(5);
      const asApi = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          await client.query("SET LOCAL statement_timeout='5s'");
          const value = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      const at = () => new Date(Math.floor(Date.now())).toISOString();

      // Never set: every module, version 0.
      const fresh = await asApi((tx) => loadStoreFeatureSetting(tx, scope));
      assert.deepEqual(
        [fresh.version, fresh.templateCode, fresh.counterOrder, fresh.pickup, fresh.inventory],
        [0, null, true, true, true],
      );
      const all = {
        counterOrder: true,
        pickup: true,
        inventory: true,
        loyalty: true,
        complianceDocuments: true,
      };
      // Guests at a Store never set are offered pickup.
      const offered = { state: "Open", availableServiceModes: ["DineIn", "Pickup"] };
      assert.deepEqual(await asApi((tx) => guestServiceModes(tx, scope, offered)), {
        ...offered,
        servicesTurnedOff: [],
      });
      // The owner applies the full-service template.
      const template = id(10);
      const applied = await asApi((tx) =>
        changeStoreFeatureSetting(tx, scope, {
          operationReference: template,
          expectedVersion: 0,
          template: "FullService",
          modules: { ...all, ...fullServiceTemplate },
          actorReference: owner,
          observedAt: at(),
        }),
      );
      assert.deepEqual(
        [
          applied.version,
          applied.templateCode,
          applied.counterOrder,
          applied.pickup,
          applied.inventory,
          applied.loyalty,
          applied.complianceDocuments,
        ],
        [1, "FullService", false, false, false, false, false],
      );
      // The same operation again returns what it made, and records nothing new.
      const again = await asApi((tx) =>
        changeStoreFeatureSetting(tx, scope, {
          operationReference: template,
          expectedVersion: 0,
          template: "FullService",
          modules: { ...all, ...fullServiceTemplate },
          actorReference: owner,
          observedAt: at(),
        }),
      );
      assert.equal(again.version, 1);
      // A change made on what someone saw before (version 0) is refused: read again.
      await assert.rejects(
        asApi((tx) =>
          changeStoreFeatureSetting(tx, scope, {
            operationReference: id(11),
            expectedVersion: 0,
            template: null,
            modules: { ...applied, counterOrder: true },
            actorReference: owner,
            observedAt: at(),
          }),
        ),
        StoreFeatureSettingConflictError,
      );
      // The same operation reused for another choice is refused.
      await assert.rejects(
        asApi((tx) =>
          changeStoreFeatureSetting(tx, scope, {
            operationReference: template,
            expectedVersion: 1,
            template: null,
            modules: { ...applied, inventory: true },
            actorReference: owner,
            observedAt: at(),
          }),
        ),
        StoreFeatureSettingConflictError,
      );
      // Counter ordering back on: the next version, a custom choice.
      const counter = await asApi((tx) =>
        changeStoreFeatureSetting(tx, scope, {
          operationReference: id(12),
          expectedVersion: 1,
          template: null,
          modules: { ...applied, counterOrder: true },
          actorReference: owner,
          observedAt: at(),
        }),
      );
      assert.deepEqual(
        [counter.version, counter.templateCode, counter.counterOrder, counter.inventory],
        [2, "Custom", true, false],
      );

      // Guests are no longer offered pickup (dine-in is unchanged); another Store still is.
      assert.deepEqual(await asApi((tx) => guestServiceModes(tx, scope, offered)), {
        state: "Open",
        availableServiceModes: ["DineIn"],
        servicesTurnedOff: ["Pickup"],
      });
      assert.deepEqual(
        (await asApi((tx) => guestServiceModes(tx, other, offered))).availableServiceModes,
        ["DineIn", "Pickup"],
      );
      // The navigation lists counter ordering again (and Pickup, where counter orders are handed
      // over) and leaves out inventory and recipes, read
      // inside another read without disturbing its Brand and Store context.
      const navigation = [
        { screenId: "DIN-FLOOR-BOARD" },
        { screenId: "OPS-ORDER-ENTRY" },
        { screenId: "FUL-PICKUP-QUEUE" },
        { screenId: "INV-ITEM-LIST" },
        { screenId: "RECIPE-LIST" },
        { screenId: "STORE-CAPABILITY" },
      ];
      const listed = await asApi(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
          [scope.brandReference],
        );
        const features = await readStoreFeatures(tx, scope, "Refuse");
        const after = (
          await tx.query(
            "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
            [],
          )
        ).rows[0];
        assert.deepEqual([after.brand, after.store], [scope.brandReference, ""]);
        return navigationForStoreFeatures(navigation, features).map((item) => item.screenId);
      });
      assert.deepEqual(listed, [
        "DIN-FLOOR-BOARD",
        "OPS-ORDER-ENTRY",
        "FUL-PICKUP-QUEUE",
        "STORE-CAPABILITY",
      ]);

      // v15 finding v: Fulfillment's pickup queue, read for the navigation under the api role
      // (none waiting in this database), restores the Brand and Store context it changes.
      assert.deepEqual(
        await asApi(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [scope.brandReference],
          );
          const waiting = await waitingPickupOrders(tx, {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            sha256: (value) => "sha256:" + value.length.toString(16).padStart(64, "0"),
            validateCurrentSource: async () => false,
            now: () => new Date().toISOString(),
          });
          const after = (
            await tx.query(
              "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
              [],
            )
          ).rows[0];
          return [waiting, after.brand, after.store];
        }),
        [0, scope.brandReference, ""],
      );

      // Another Store sees none of it and keeps every module.
      const elsewhere = await asApi((tx) => loadStoreFeatureSetting(tx, other));
      assert.equal(elsewhere.version, 0);
      assert.equal(
        (
          await asApi(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [other.brandReference, other.storeReference],
            );
            return tx.query("SELECT count(*)::int n FROM rms_store.store_feature_setting", []);
          })
        ).rows[0].n,
        0,
      );
      // A row for another Store cannot be written under this Store's context.
      await assert.rejects(
        asApi(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          return tx.query(
            "INSERT INTO rms_store.store_feature_setting (tenant_id,brand_id,store_id,version,operation_id,template_code,counter_order,pickup,inventory,loyalty,compliance_documents,actor_id,occurred_at) VALUES ($1,$2,$3,1,$4,'Custom',true,true,true,true,true,$5,date_trunc('milliseconds',now()))",
            [scope.tenantReference, other.brandReference, other.storeReference, id(20), owner],
          );
        }),
        /row-level security/u,
      );
      // Out-of-order versions and changes to history are refused.
      await assert.rejects(
        asApi(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          return tx.query(
            "INSERT INTO rms_store.store_feature_setting (tenant_id,brand_id,store_id,version,operation_id,template_code,counter_order,pickup,inventory,loyalty,compliance_documents,actor_id,occurred_at) VALUES ($1,$2,$3,5,$4,'Custom',true,true,true,true,true,$5,date_trunc('milliseconds',now()))",
            [scope.tenantReference, scope.brandReference, scope.storeReference, id(21), owner],
          );
        }),
        /version out of order/u,
      );
      await assert.rejects(
        asApi(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          return tx.query("UPDATE rms_store.store_feature_setting SET counter_order=false", []);
        }),
        /append-only store feature setting|permission denied/u,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT version,template_code,actor_id::text actor FROM rms_store.store_feature_setting ORDER BY version",
          )
        ).rows.map((row) => [row.version, row.template_code, row.actor]),
        [
          [1, "FullService", owner],
          [2, "Custom", owner],
        ],
      );

      // The tea dish refuses a recipe that uses stock: a binding of this Store or the Brand
      // counts, another Store's does not. Owner seed with constraints off; the read is the api role.
      const stocked = id(0x60),
        brandWide = id(0x61),
        otherStore = id(0x62),
        plain = id(0x63);
      await admin.query("SET session_replication_role = replica");
      try {
        for (const [n, sku, store] of [
          [0x70, stocked, scope.storeReference],
          [0x71, brandWide, null],
          [0x72, otherStore, other.storeReference],
        ])
          await admin.query(
            "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,now()-interval '1 minute')",
            [id(n), id(n + 0x10), id(n + 0x20), scope.brandReference, sku, store],
          );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      assert.deepEqual(
        await asApi(async (tx) => {
          const uses = [];
          for (const sku of [stocked, brandWide, otherStore, plain])
            uses.push(await skuRecipeUsesStock(tx, scope, sku));
          return uses;
        }),
        [true, true, false, false],
      );
    } finally {
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
