import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { recordStoreOpening } from "../../../apps/api/src/merchant-store-opening.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a3b-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION, v15 2026-10-31: no Store could be opened on v15.
 * Its rows were loaded after its migrations with `pg_restore --data-only --disable-triggers`, so
 * the Brand had no Store reference generation row and its Store no projection row. Here a
 * database is put in that shape (the Brand and Store written with the registry trigger off, as
 * that load does), and under the restricted pilot API role:
 * 1. the product's Store opening is refused (STORE_REFERENCE_SOURCE_INVALID), nothing written;
 * 2. the 2000_140 backfill writes what the trigger would have (generation 0 with the Store count;
 *    the Store's lifecycle, version, times, code and name) and touches nothing that exists;
 * 3. the same opening then succeeds and the registry counts both Stores.
 */
it("a database loaded without the Store registry trigger opens a Store after the backfill", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_store_ref" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const brandReference = id(2),
      storeOne = id(3),
      owner = id(4);
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_srf");
      const from = new Date(Date.parse(await dbNow(admin)) - 3 * 3600_000).toISOString();
      // The v15 shape: the roots arrive with the registry trigger switched off.
      const registry = (state) =>
        admin.query(
          `ALTER TABLE bop_tenant.brand ${state} TRIGGER brand_store_reference_projection_trigger;
           ALTER TABLE bop_tenant.store ${state} TRIGGER store_reference_projection_trigger`,
        );
      await registry("DISABLE");
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'DEMO_01','DEMO Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [storeOne, brandReference, from],
      );
      await registry("ENABLE");
      const counts = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM bop_tenant.store_reference_generation) generations,
                    (SELECT count(*)::int FROM bop_tenant.store_reference_projection) projections`,
          )
        ).rows[0];
      assert.deepEqual(await counts(), { generations: 0, projections: 0 });

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
      const open = (operation, code) =>
        (async () => {
          await admin.query("BEGIN");
          try {
            await admin.query("SET LOCAL ROLE " + role);
            await admin.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [brandReference, storeOne],
            );
            const result = await recordStoreOpening(
              { query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]) },
              {
                command: {
                  operationReference: operation,
                  code,
                  displayName: "DEMO Store 2 – not production",
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
            return result;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          }
        })();

      // 1. Refused as on v15; nothing written.
      await assert.rejects(
        open("01909a3b-1000-7000-8000-000000000010", "DEMO_02"),
        /STORE_REFERENCE_SOURCE_INVALID/u,
      );
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM bop_tenant.store")).rows[0].n,
        1,
      );

      // 2. The backfill writes what the trigger would have, once.
      const backfill = async () =>
        Number(
          (await admin.query("SELECT bop_tenant.repair_store_reference_projection() n")).rows[0].n,
        );
      assert.equal(await backfill(), 2);
      const registryRows = async () => ({
        generation: (
          await admin.query(
            "SELECT generation::int,reference_count::int FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
            [brandReference],
          )
        ).rows,
        projection: (
          await admin.query(
            `SELECT p.store_id::text store,p.lifecycle,p.version::int,p.code,p.display_name,
                    p.created_at=s.created_at AND p.updated_at=s.updated_at same_times
               FROM bop_tenant.store_reference_projection p
               JOIN bop_tenant.store s ON s.store_id=p.store_id AND s.brand_id=p.brand_id
              ORDER BY p.code`,
          )
        ).rows,
      });
      assert.deepEqual(await registryRows(), {
        generation: [{ generation: 0, reference_count: 1 }],
        projection: [
          {
            store: storeOne,
            lifecycle: "Active",
            version: 1,
            code: "DEMO_01",
            display_name: "DEMO Store",
            same_times: true,
          },
        ],
      });
      const before = await registryRows();
      assert.equal(await backfill(), 0);
      assert.deepEqual(await registryRows(), before);

      // 3. The same opening (a new request) now succeeds; the registry counts both Stores.
      const opened = await open("01909a3b-1000-7000-8000-000000000011", "DEMO_02");
      assert.equal(opened.status, "Opened");
      const after = await registryRows();
      assert.deepEqual(after.generation, [{ generation: 1, reference_count: 2 }]);
      assert.deepEqual(
        after.projection.map((row) => row.code),
        ["DEMO_01", "DEMO_02"],
      );
      // Later Brand or Store changes keep maintaining it.
      assert.equal(await backfill(), 0);
    } finally {
      await admin.end();
    }
  });
}, 240_000);
