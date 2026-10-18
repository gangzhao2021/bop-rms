import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresTenantStoreReferenceSource,
  tenantStoreReferenceDigest,
} from "../../bop/tenant/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f3f7a-8b1c-7a11-8d01-${String(n).padStart(12, "0")}`;
const at = "2026-09-29T00:00:00.000Z";
const request = {
  brandReference: id(1),
  actorReference: id(9),
  purposeCode: "REFERENCE_REVIEW",
  originalIntentDigest: "sha256:" + "a".repeat(64),
  observedAt: at,
};
async function insertBrand(c, n) {
  await c.query(
    "INSERT INTO bop_tenant.brand VALUES ($1,$2,'Synthetic Brand','en-CA','CAD','Active',1,$3,$3)",
    [id(n), "SYNTHETIC_" + n, at],
  );
}
async function insertStore(c, n, brand, lifecycle = "Draft") {
  await c.query(
    "INSERT INTO bop_tenant.store VALUES ($1,$2,$3,'Synthetic Store','America/Toronto','en-CA','CAD',$4,1,$5,$5)",
    [id(n), id(brand), "SYNTHETIC_" + n, lifecycle, at],
  );
}
it("proves complete Tenant registry, upgrade backfill, atomic metadata, scope/ACL, precision, corruption and writer fencing", async () => {
  await withIsolatedDatabase({ caseId: "store_refs", root }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    const role = `bop_wp2410_${context.runId}`;
    await admin.connect();
    await reader.connect();
    await writer.connect();
    try {
      await insertBrand(admin, 1);
      await insertBrand(admin, 2);
      await insertBrand(admin, 3);
      for (const [n, state] of [
        [11, "Draft"],
        [12, "Active"],
        [13, "Suspended"],
        [14, "Archived"],
      ])
        await insertStore(admin, n, 1, state);
      await insertStore(admin, 21, 2);
      // Exercise exact forward SQL in a rollback-only synthetic upgrade fixture.
      // Applied runner history/bytes and the actual installation remain unchanged.
      await admin.query("BEGIN");
      await admin.query(
        "DROP TRIGGER brand_store_reference_projection_trigger ON bop_tenant.brand; DROP TRIGGER store_reference_projection_trigger ON bop_tenant.store; DROP FUNCTION bop_tenant.maintain_store_reference_projection(); DROP TABLE bop_tenant.store_reference_projection; DROP TABLE bop_tenant.store_reference_generation;",
      );
      await insertStore(admin, 15, 1);
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/0200-bop-identity-tenancy/0200_020_create_store_reference_projection.sql",
          ),
          "utf8",
        ),
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT generation::text,reference_count::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
            [id(1)],
          )
        ).rows,
        [{ generation: "0", reference_count: "5" }],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT * FROM bop_tenant.store_reference_projection WHERE brand_id=$1",
            [id(1)],
          )
        ).rowCount,
        5,
      );
      await admin.query("ROLLBACK");
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA bop_tenant,platform_helpers TO ${role}`);
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT ON bop_tenant.brand,bop_tenant.store,bop_tenant.store_reference_generation,bop_tenant.store_reference_projection TO ${role}`,
      );
      await admin.query(`GRANT INSERT,UPDATE ON bop_tenant.store TO ${role}`);
      await reader.query(`SET ROLE ${role}`);
      await writer.query(`SET ROLE ${role}`);
      let current = true,
        held = false;
      const source = (brand) =>
        createPostgresTenantStoreReferenceSource({
          brandReference: id(brand),
          transactions: {
            async run(work) {
              await reader.query("BEGIN");
              try {
                const result = await work(reader);
                assert.equal(held, true);
                await reader.query("COMMIT");
                return result;
              } catch (error) {
                await reader.query("ROLLBACK");
                throw error;
              }
            },
          },
          authority: {
            async withCurrentBrandReferenceRead(r, work) {
              assert.equal(r.brandReference, id(brand));
              assert.equal(held, false);
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
        });
      let original;
      await source(1).withCurrentSnapshot(request, async (s) => {
        original = s;
        assert.equal(s.referenceCount, "4");
        assert.deepEqual(
          s.references.map((r) => r.lifecycle),
          ["Draft", "Active", "Suspended", "Archived"],
        );
        assert.equal((await reader.query("SELECT * FROM bop_tenant.store")).rowCount, 0);
        assert.equal(
          (
            await reader.query(
              "SELECT * FROM bop_tenant.store_reference_projection WHERE brand_id=$1",
              [id(2)],
            )
          ).rowCount,
          0,
        );
      });
      await source(3).withCurrentSnapshot({ ...request, brandReference: id(3) }, async (s) =>
        assert.equal(s.referenceCount, "0"),
      );
      await reader.query("BEGIN");
      await reader.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(11)],
      );
      assert.equal((await reader.query("SELECT * FROM bop_tenant.store")).rowCount, 1);
      assert.equal(
        (await reader.query("SELECT * FROM bop_tenant.store_reference_projection")).rowCount,
        0,
      );
      await reader.query("ROLLBACK");
      await writer.query("BEGIN");
      await writer.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(15)],
      );
      await insertStore(writer, 15, 1);
      assert.deepEqual(
        (
          await writer.query(
            "SELECT current_setting('bop.brand_id') AS brand,current_setting('bop.store_id') AS store",
          )
        ).rows,
        [{ brand: id(1), store: id(15) }],
      );
      await writer.query("ROLLBACK");
      await source(1).withCurrentSnapshot(request, async (s) =>
        assert.equal(tenantStoreReferenceDigest(s), tenantStoreReferenceDigest(original)),
      );
      // Writer waits on the root-maintenance fence held by the public reader.
      await source(1).withCurrentSnapshot(request, async () => {
        await writer.query("BEGIN");
        await writer.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(1), id(11)],
        );
        await writer.query("SET LOCAL lock_timeout='150ms'");
        await assert.rejects(
          writer.query(
            "UPDATE bop_tenant.store SET lifecycle='Active',version=version+1 WHERE store_id=$1",
            [id(11)],
          ),
          (e) => e.code === "55P03",
        );
        await writer.query("ROLLBACK");
      });
      await writer.query("BEGIN");
      await writer.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(11)],
      );
      await writer.query(
        "UPDATE bop_tenant.store SET lifecycle='Active',version=version+1 WHERE store_id=$1",
        [id(11)],
      );
      await writer.query("COMMIT");
      await source(1).withCurrentSnapshot(request, async (s) => {
        assert.equal(s.generation, "5");
        assert.equal(s.references[0].version, "2");
        assert.equal(s.references[0].lifecycle, "Active");
      });
      await reader.query("BEGIN");
      await reader.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [id(1)],
      );
      await assert.rejects(
        reader.query(
          "UPDATE bop_tenant.store_reference_generation SET generation=99 WHERE brand_id=$1",
          [id(1)],
        ),
        (e) => e.code === "42501",
      );
      await reader.query("ROLLBACK");
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'bop_tenant.maintain_store_reference_projection()','EXECUTE') AS allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS count FROM pg_class WHERE oid IN ('bop_tenant.store_reference_generation'::regclass,'bop_tenant.store_reference_projection'::regclass) AND relrowsecurity AND relforcerowsecurity",
          )
        ).rows[0].count,
        2,
      );
      current = false;
      let called = false;
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => {
          called = true;
        }),
        /TENANT_STORE_REFERENCE_UNAVAILABLE/,
      );
      assert.equal(called, false);
      current = true;
      // A source cannot reuse a snapshot acquired before the writer fence.
      const stale = createPostgresTenantStoreReferenceSource({
        brandReference: id(1),
        transactions: {
          async run(work) {
            await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
            try {
              return await work(reader);
            } finally {
              await reader.query("ROLLBACK");
            }
          },
        },
        authority: {
          async withCurrentBrandReferenceRead(_r, work) {
            return work();
          },
          async isCurrent() {
            return true;
          },
        },
      });
      await assert.rejects(
        stale.withCurrentSnapshot(request, async () => true),
        /TENANT_STORE_REFERENCE_UNAVAILABLE/,
      );
      // A callback that updates its own source must roll back with its consumer.
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => {
          await reader.query("SELECT set_config('bop.store_id',$1,true)", [id(11)]);
          await reader.query(
            "UPDATE bop_tenant.store SET lifecycle='Suspended',version=version+1 WHERE store_id=$1",
            [id(11)],
          );
          await reader.query("SELECT set_config('bop.store_id','',true)");
        }),
        /TENANT_STORE_REFERENCE_UNAVAILABLE/,
      );
      assert.equal(
        (await admin.query("SELECT lifecycle FROM bop_tenant.store WHERE store_id=$1", [id(11)]))
          .rows[0].lifecycle,
        "Active",
      );
      const publicAcl = await admin.query(`SELECT count(*)::int AS count FROM pg_class AS c
        CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) AS a
        WHERE c.oid IN ('bop_tenant.store_reference_generation'::regclass,'bop_tenant.store_reference_projection'::regclass) AND a.grantee=0`);
      assert.equal(publicAcl.rows[0].count, 0);
      // Root precision is preserved, not silently rounded by node-pg's Date decoder.
      await admin.query(
        "UPDATE bop_tenant.store SET updated_at=$2,version=version+1 WHERE store_id=$1",
        [id(11), "2026-09-29T00:00:00.000001Z"],
      );
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => true),
        /TENANT_STORE_REFERENCE_UNAVAILABLE/,
      );
      await admin.query(
        "UPDATE bop_tenant.store SET updated_at=$2,version=version+1 WHERE store_id=$1",
        [id(11), at],
      );
      await admin.query(
        "DELETE FROM bop_tenant.store_reference_projection WHERE brand_id=$1 AND store_id=$2",
        [id(1), id(11)],
      );
      await assert.rejects(
        source(1).withCurrentSnapshot(request, async () => true),
        /TENANT_STORE_REFERENCE_UNAVAILABLE/,
      );
      await assert.rejects(
        admin.query(
          "UPDATE bop_tenant.store SET lifecycle='Suspended',version=version+1 WHERE store_id=$1",
          [id(11)],
        ),
        (e) => e.code === "55000",
      );
      assert.equal(
        (await admin.query("SELECT lifecycle FROM bop_tenant.store WHERE store_id=$1", [id(11)]))
          .rows[0].lifecycle,
        "Active",
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
