import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresBrandTaxReferenceSourceStore,
  parseBrandTaxReferenceSnapshot,
} from "../../rms/pricing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `01902411-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const past = "2026-08-01T00:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
  brandReference: id(1),
  actorReference: id(9),
  operationReference: id(8),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
async function insertRoot(c, n, store, brand = 1) {
  await c.query(
    "INSERT INTO rms_pricing.tax_configuration (tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,$3,$4,1,$5,$6,$5)",
    [id(n), id(brand), id(store), "SYNTHETIC_" + n, past, id(9)],
  );
}
it("proves complete actual Tenant/Pricing source composition, orphan denial, tombstones, rollback and both writer fences", async () => {
  await withIsolatedDatabase({ root, caseId: "brand_tax_refs" }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig),
      role = `bop_wp2411_${context.runId}`;
    await admin.connect();
    await reader.connect();
    await writer.connect();
    try {
      for (const n of [1, 2, 3])
        await admin.query(
          "INSERT INTO bop_tenant.brand VALUES ($1,$2,'Synthetic Brand','en-CA','CAD','Active',1,$3,$3)",
          [id(n), "SYNTHETIC_" + n, past],
        );
      for (const [n, state] of [
        [11, "Active"],
        [12, "Archived"],
        [13, "Draft"],
        [14, "Suspended"],
      ])
        await admin.query(
          "INSERT INTO bop_tenant.store VALUES ($1,$2,$3,'Synthetic Store','America/Toronto','en-CA','CAD',$4,1,$5,$5)",
          [id(n), id(1), "SYNTHETIC_" + n, state, past],
        );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'OTHER','Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [id(21), id(2), past],
      );
      await insertRoot(admin, 31, 11);
      await insertRoot(admin, 32, 12);
      await insertRoot(admin, 33, 21, 2);
      // Real Draft rule metadata, with no invented registration/professional approval.
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version (tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_time_zone,created_at) VALUES ($1,$2,$3,$4,1,$5,'Draft','CA-ON','CAD',1,$6,$5,$7,'America/Toronto',$7)`,
        [id(41), id(31), id(1), id(11), "sha256:" + "b".repeat(64), id(49), past],
      );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
        [id(41), id(31)],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_rule (tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,receipt_presentation_code) VALUES ($1,$2,$3,$4,$5,$6,'Pickup','Sellable','SYNTHETIC_COMPONENT','Taxable',0.13,'Exclusive','HalfUp',1,false,'SYNTHETIC_LINE')`,
        [id(51), id(41), id(31), id(1), id(11), id(59)],
      );
      // Rollback-only exact forward-SQL backfill includes an orphan reference.
      await admin.query("BEGIN");
      await admin.query(
        "DROP TRIGGER tax_reference_root_scope_trigger ON rms_pricing.tax_configuration; DROP TRIGGER tax_reference_version_fence_trigger ON rms_pricing.tax_configuration_version; DROP TRIGGER tax_reference_rule_fence_trigger ON rms_pricing.tax_configuration_rule; DROP FUNCTION rms_pricing.maintain_tax_reference_scope(); DROP TABLE rms_pricing.tax_reference_scope; DROP TABLE rms_pricing.tax_reference_generation;",
      );
      await insertRoot(admin, 39, 99);
      await admin.query(
        await readFile(
          path.join(root, "migrations/1200-rms-pricing/1200_012_create_tax_reference_scope.sql"),
          "utf8",
        ),
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT generation::text,reference_count::text FROM rms_pricing.tax_reference_generation WHERE brand_id=$1",
            [id(1)],
          )
        ).rows,
        [{ generation: "0", reference_count: "3" }],
      );
      await admin.query("ROLLBACK");
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
      await admin.query(`GRANT USAGE ON SCHEMA bop_tenant,rms_pricing,platform_helpers TO ${role}`);
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT ON bop_tenant.brand,bop_tenant.store_reference_generation,bop_tenant.store_reference_projection,rms_pricing.tax_reference_generation,rms_pricing.tax_reference_scope,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO ${role}`,
      );
      await admin.query(`GRANT INSERT,UPDATE,DELETE ON rms_pricing.tax_configuration TO ${role}`);
      await admin.query(`GRANT SELECT,UPDATE ON bop_tenant.store TO ${role}`);
      await reader.query(`SET ROLE ${role}`);
      await writer.query(`SET ROLE ${role}`);
      let held = false,
        current = true,
        deniedStore = null,
        denyBrand = false;
      const checked = [];
      let clockOffset = 0;
      const clock = { now: () => new Date(Date.now() + clockOffset).toISOString() };
      const source = (brand) =>
        createPostgresBrandTaxReferenceSourceStore({
          tenantReference: id(7),
          brandReference: id(brand),
          actorReference: id(9),
          clock,
          transactions: {
            async run(work) {
              await reader.query("BEGIN");
              try {
                const result = await work(reader);
                assert.equal(held, true);
                await reader.query("COMMIT");
                return result;
              } catch (e) {
                await reader.query("ROLLBACK");
                throw e;
              }
            },
          },
          tenantAuthority: {
            async withCurrentBrandReferenceRead(r, work) {
              assert.equal(r.actorReference, id(9));
              assert.equal(r.originalIntentDigest, request.catalogIntentDigest);
              held = true;
              try {
                return await work();
              } finally {
                held = false;
              }
            },
            async isCurrent() {
              return current;
            },
          },
          brandAuthority: {
            async holdUntilTransactionCompletes(_tx, input) {
              assert.equal(input.permission, "pricing.tax-config.manage");
              assert.equal(input.requiredScope, "Brand");
              assert(input.requiredFields.includes("present"));
              assert.equal(input.request.catalogIntentDigest, request.catalogIntentDigest);
              if (denyBrand) throw new Error("synthetic denied");
            },
          },
          taxAuthority: {
            async holdUntilTransactionCompletes(_tx, input) {
              assert.equal(input.tenantReference, id(7));
              assert.equal(input.permission, "pricing.tax-config.manage");
              assert.equal(input.request.catalogIntentDigest, request.catalogIntentDigest);
              checked.push(input.request.storeReference);
              if (input.request.storeReference === deniedStore) throw new Error("synthetic denied");
            },
          },
        });
      await source(1).withCurrentSnapshot(request, async (s) => {
        assert.equal(s.stores.length, 4);
        assert.equal(s.rootScope.length, 2);
        assert.equal(s.stores[0].versions[0].rules[0].taxClassificationReference, id(59));
        assert.equal(s.stores[1].roots.length, 1);
        assert.equal(s.stores[2].roots.length, 0);
        assert.deepEqual(
          s.storeInventory.references.map((r) => r.lifecycle),
          ["Active", "Archived", "Draft", "Suspended"],
        );
        assert.deepEqual(parseBrandTaxReferenceSnapshot(s, request, clock.now()), s);
        assert.equal(
          (await reader.query("SELECT * FROM rms_pricing.tax_configuration")).rowCount,
          0,
        );
      });
      for (const n of [11, 12, 13, 14]) assert(checked.includes(id(n)));
      await source(3).withCurrentSnapshot({ ...request, brandReference: id(3) }, async (s) =>
        assert.equal(s.stores.length, 0),
      );
      deniedStore = id(13);
      let called = false;
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => {
          called = true;
        }),
        (e) => e.code === "BRAND_TAX_REFERENCE_SOURCE_UNAVAILABLE",
      );
      assert.equal(called, false);
      deniedStore = null;
      denyBrand = true;
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => true),
        (e) => e.code === "BRAND_TAX_REFERENCE_SOURCE_UNAVAILABLE",
      );
      denyBrand = false;
      await source(1).withCurrentSnapshot(request, async () => {
        await writer.query("BEGIN");
        await writer.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(1), id(11)],
        );
        await writer.query("SET LOCAL lock_timeout='150ms'");
        await assert.rejects(insertRoot(writer, 34, 11), (e) => e.code === "55P03");
        await writer.query("ROLLBACK");
      });
      // The composed source still holds the Tenant owning fence as well.
      await source(1).withCurrentSnapshot(request, async () => {
        await writer.query("BEGIN");
        await writer.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(1), id(11)],
        );
        await writer.query("SET LOCAL lock_timeout='150ms'");
        await assert.rejects(
          writer.query(
            "UPDATE bop_tenant.store SET lifecycle='Suspended',version=version+1 WHERE store_id=$1",
            [id(11)],
          ),
          (e) => e.code === "55P03",
        );
        await writer.query("ROLLBACK");
      });
      // Retire an empty root under the limited-role writer; its scope remains explicit.
      await writer.query("BEGIN");
      await writer.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(12)],
      );
      await writer.query(
        "DELETE FROM rms_pricing.tax_configuration WHERE tax_configuration_id=$1",
        [id(32)],
      );
      await writer.query("COMMIT");
      await source(1).withCurrentSnapshot(request, async (s) => {
        assert.equal(s.rootScope.find((r) => r.configurationReference === id(32)).present, false);
        assert.equal(s.stores[1].roots.length, 0);
      });
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => {
          await reader.query("SELECT set_config('bop.store_id',$1,true)", [id(11)]);
          await insertRoot(reader, 35, 11);
          await reader.query("SELECT set_config('bop.store_id','',true)");
        }),
        (e) => e.code === "BRAND_TAX_REFERENCE_SOURCE_UNAVAILABLE",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT * FROM rms_pricing.tax_configuration WHERE tax_configuration_id=$1",
            [id(35)],
          )
        ).rowCount,
        0,
      );
      // A callback cannot extend the accepted source freshness window.
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => {
          clockOffset = 6000;
        }),
        (e) => e.code === "BRAND_TAX_REFERENCE_SOURCE_UNAVAILABLE",
      );
      clockOffset = 0;
      // Exact legacy root moves retain the old scope and create a new Brand header.
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'THIRD','Synthetic Store','America/Toronto','en-CA','CAD','Draft',1,$3,$3)",
        [id(31), id(3), past],
      );
      await insertRoot(admin, 36, 13);
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET brand_id=$1,store_id=$2 WHERE tax_configuration_id=$3",
        [id(3), id(31), id(36)],
      );
      await source(1).withCurrentSnapshot(request, async (s) =>
        assert.equal(s.rootScope.find((r) => r.configurationReference === id(36)).present, false),
      );
      await source(3).withCurrentSnapshot({ ...request, brandReference: id(3) }, async (s) => {
        assert.equal(s.stores.length, 1);
        assert.equal(s.stores[0].roots[0].configurationReference, id(36));
      });
      // Brand-scoped metadata remains invisible in a selected Store context.
      await reader.query("BEGIN");
      await reader.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(11)],
      );
      assert.equal(
        (await reader.query("SELECT * FROM rms_pricing.tax_reference_scope")).rowCount,
        0,
      );
      await reader.query("ROLLBACK");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_class WHERE oid IN ('rms_pricing.tax_reference_generation'::regclass,'rms_pricing.tax_reference_scope'::regclass) AND relrowsecurity AND relforcerowsecurity",
          )
        ).rows[0].count,
        2,
      );
      const publicAcl = await admin.query(
        `SELECT count(*)::int AS count FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN ('rms_pricing.tax_reference_generation'::regclass,'rms_pricing.tax_reference_scope'::regclass) AND a.grantee=0`,
      );
      assert.equal(publicAcl.rows[0].count, 0);
      current = false;
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => true),
        (e) => e.code === "BRAND_TAX_REFERENCE_SOURCE_UNAVAILABLE",
      );
      current = true;
      await insertRoot(admin, 39, 99);
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => true),
        (e) => e.code === "BRAND_TAX_REFERENCE_SOURCE_UNAVAILABLE",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'rms_pricing.maintain_tax_reference_scope()','EXECUTE') AS allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
    } finally {
      await reader.query("ROLLBACK").catch(() => undefined);
      await writer.query("ROLLBACK").catch(() => undefined);
      await reader.end();
      await writer.end();
      await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await admin.end();
    }
  });
});
