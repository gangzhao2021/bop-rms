import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { recordStoreOpening } from "../../../apps/api/src/merchant-store-opening.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import { createPostgresStockPlaceStore } from "../../rms/inventory/src/index.ts";
import {
  createInternalTestStockSite,
  readStoreDefaultStockSite,
  renderStockSiteRoleSql,
} from "../../../tooling/environment/pilot-internal-test-stock-site.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a3c-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION, coordinator 2026-10-31 (option B): a TEST Store
 * opened in the product gets its default stock site before its first service, through the
 * Inventory owner's own stock-place Create commands, as the restricted setup role:
 * 1. the default site and its default storage location are written, each audited under the
 *    approver with the approval wording;
 * 2. running it again answers the same site and writes nothing;
 * 3. the services' own role (the pilot API grants) reads each Store's own default site — never
 *    another Store's — and nothing for a Store without one, and that no stock was ever received
 *    at the new site;
 * 4. a Store not opened in the product, or not labelled TEST, is refused.
 */
it("a TEST Store gets its own default stock site once, audited under the approver", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_stock_site" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeOne = id(3),
      owner = id(4),
      approver = id(5);
    const binding = { tenantReference, brandReference, storeReference: storeOne };
    let next = 0x9000;
    const nextReference = () =>
      "01909a3c-1000-7000-8000-" + (next++).toString(16).padStart(12, "0");
    try {
      const apiRole = await createPilotApiRole(admin, context, "wp2423_sts");
      const role = "wp2423_stock_site_" + context.runId;
      for (const sql of renderStockSiteRoleSql(role)) await admin.query(sql);
      const from = new Date(Date.parse(await dbNow(admin)) - 3 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'DEMO_01','DEMO Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [storeOne, brandReference, from],
      );
      const ownerRole = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: brandRoleTemplateActions("brand-owner"),
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference: storeOne,
        actorReference: owner,
        name: "Sam",
        roles: [ownerRole],
        from,
        enrolledAt: from,
      });
      // Stores opened in the product, as the Brand Owner does on the Stores page.
      const open = async (operation, code, displayName) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + apiRole);
          await admin.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brandReference, storeOne],
          );
          await recordStoreOpening(
            { query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]) },
            {
              command: {
                operationReference: operation,
                code,
                displayName,
                timeZone: "America/Toronto",
                locale: "en-CA",
              },
              brandReference,
              openedFromStoreReference: storeOne,
              actorReference: owner,
              membershipReference: id(400),
              openedAt: new Date().toISOString(),
            },
          );
          await admin.query("COMMIT");
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const storeTwo = "01909a3c-2000-7000-8000-000000000002",
        storeThree = "01909a3c-2000-7000-8000-000000000003";
      await open(storeTwo, "DEMO_02", "DEMO Store 2 – not production");
      await open(storeThree, "DEMO_03", "DEMO Store 3 – not production");
      const run = (storeReference, approval = "Owner approves the TEST stock site") =>
        createInternalTestStockSite(admin, {
          environment: "InternalTest",
          database: context.databaseName,
          role,
          binding,
          storeReference,
          approverActorReference: approver,
          now: () => new Date().toISOString(),
          evidence: {
            operationReference: nextReference(),
            approvedBy: "Owner",
            approval,
            reason: "Multi-store live check",
          },
          nextReference,
        });
      const owned = async (store, sql, values) => {
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false),set_config('bop.store_id',$3,false)",
          [tenantReference, brandReference, store],
        );
        return (await admin.query(sql, values)).rows;
      };

      // 1. Created, with its default storage location, audited under the approver.
      const created = await run(storeTwo);
      assert.equal(created.status, "Created");
      const site = created.stockSiteReference;
      assert.deepEqual(
        await owned(
          storeTwo,
          "SELECT stock_site_id::text site,is_default,code FROM rms_inventory.stock_site WHERE store_id=$1",
          [storeTwo],
        ),
        [{ site, is_default: true, code: "STORE" }],
      );
      assert.deepEqual(
        await owned(
          storeTwo,
          "SELECT stock_site_id::text site,is_default,code FROM rms_inventory.storage_location WHERE store_id=$1",
          [storeTwo],
        ),
        [{ site, is_default: true, code: "MAIN" }],
      );
      const audits = await owned(
        storeTwo,
        "SELECT action_code,actor_reference::text actor,after_summary_json->>'approval' approval FROM platform_audit.audit_record WHERE store_id=$1 AND action_code LIKE 'INVENTORY_STOCK_PLACE_CREATE_%' ORDER BY action_code",
        [storeTwo],
      );
      assert.deepEqual(audits, [
        {
          action_code: "INVENTORY_STOCK_PLACE_CREATE_LOCATION",
          actor: approver,
          approval: "Owner approves the TEST stock site",
        },
        {
          action_code: "INVENTORY_STOCK_PLACE_CREATE_SITE",
          actor: approver,
          approval: "Owner approves the TEST stock site",
        },
      ]);

      // 2. Again: the same site, nothing written.
      const count = async () =>
        (
          await owned(
            storeTwo,
            `SELECT (SELECT count(*)::int FROM rms_inventory.stock_site WHERE store_id=$1) sites,
                    (SELECT count(*)::int FROM rms_inventory.stock_place_operation WHERE store_id=$1) operations,
                    (SELECT count(*)::int FROM platform_audit.audit_record WHERE store_id=$1) audits`,
            [storeTwo],
          )
        )[0];
      const before = await count();
      assert.deepEqual(await run(storeTwo, "asked again"), {
        status: "AlreadyPresent",
        storeReference: storeTwo,
        stockSiteReference: site,
      });
      assert.deepEqual(await count(), before);

      // 3. Each Store's own default site, as the services read it; none for a Store without one.
      await admin.query("RESET ROLE");
      const third = (await run(storeThree)).stockSiteReference;
      const read = (storeReference) =>
        readStoreDefaultStockSite(admin, { role: apiRole, binding, storeReference });
      assert.equal(await read(storeTwo), site);
      assert.equal(await read(storeThree), third);
      assert.notEqual(third, site);
      assert.equal(await read(storeOne), null);
      // Its stock starts empty: the services read that nothing was ever received there (Item
      // availability then tells staff so; stock-tracked dishes stay sold out until a delivery).
      await admin.query("BEGIN READ ONLY");
      try {
        await admin.query("SET LOCAL ROLE " + apiRole);
        const tx = { query: (sql, values = []) => admin.query(sql, [...values]) };
        assert.equal(
          await createPostgresStockPlaceStore(
            { run: async (work) => work(tx) },
            { tenantReference, brandReference, storeReference: storeTwo },
          ).siteHasHeldStock(site),
          false,
        );
      } finally {
        await admin.query("ROLLBACK");
      }

      // 4. The installation's own Store, or a Store not opened in the product: refused.
      await assert.rejects(run(storeOne), { reason: "input-invalid" });
      await assert.rejects(run(id(99)), { reason: "store-not-opened-in-product" });
    } finally {
      await admin.end();
    }
  });
}, 240_000);
