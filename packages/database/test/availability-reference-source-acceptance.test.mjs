import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { it } from "vitest";
import {
  createPostgresAvailabilityReferenceSourceStore,
  availabilityReferenceSourceFields,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { Client } = pg;
const id = (n) => `01902413-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const past = "2026-08-01T12:00:00.000Z";
it("holds complete Availability references against real source writes until outer COMMIT", async () => {
  await withIsolatedDatabase({ caseId: "availability_refs", root }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const role = `wp2413_${context.runId}`;
    let now = () => new Date().toISOString(),
      deny = false;
    const request = {
      purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ",
      brandReference: id(1),
      actorReference: id(2),
      operationReference: id(3),
      catalogIntentDigest: "sha256:" + "a".repeat(64),
    };
    const authorize = async (tx, input) => {
      assert.equal(tx, reader);
      assert.equal(input.requiredScope, "FullBrandScope");
      assert.deepEqual(input.requiredFields, availabilityReferenceSourceFields);
      assert.deepEqual(input.request, request);
      if (deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    };
    const runner = {
      run: async (work) => {
        await reader.query("BEGIN");
        await reader.query(`SET LOCAL ROLE ${role}`);
        try {
          const result = await work(reader);
          await blocked();
          await reader.query("COMMIT");
          return result;
        } catch (error) {
          await reader.query("ROLLBACK");
          throw error;
        }
      },
    };
    const options = {
      tenantReference: id(4),
      brandReference: id(1),
      actorReference: id(2),
      clock: { now: () => now() },
      authority: { holdUntilTransactionCompletes: authorize },
      transactions: runner,
    };
    const source = () => createPostgresAvailabilityReferenceSourceStore(options);
    const scope = async (tx, brand = id(1), store = "") => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
    };
    const ruleInsert = `INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,product_id,bundle_id,sellable_type,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,NULL,$5,NULL,'Product',$6,'[]'::jsonb,'[]'::jsonb,$7,NULL,'Unavailable',1,'SYNTHETIC',$8,$9,$8)`;
    async function blocked() {
      await writer.query("BEGIN");
      await scope(writer);
      await writer.query("SET LOCAL lock_timeout='150ms'");
      try {
        await assert.rejects(
          writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "CatalogAvailabilityReferenceV1:" + id(1),
          ]),
          (error) => error.code === "55P03",
        );
      } finally {
        await writer.query("ROLLBACK");
      }
    }
    try {
      for (const [brand, product] of [
        [id(1), id(5)],
        [id(40), id(41)],
      ])
        await admin.query(
          `INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC','PreparedFood','Draft',1,$3,$4,$3)`,
          [product, brand, past, id(2)],
        );
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT ON rms_catalog.availability_rule,rms_catalog.availability_reference_generation TO ${role}`,
      );
      // True empty still requires exact full-Brand field authority and has no invented rules.
      const empty = await source().withCurrentSnapshot(request, async (s) => s);
      assert.equal(empty.generation, "0");
      assert.equal(empty.rules.length, 0);
      for (const [i, lifecycle] of ["Draft", "Active", "Inactive", "Archived"].entries())
        await admin.query(ruleInsert, [
          id(10 + i),
          id(1),
          `SYNTHETIC_${i}`,
          lifecycle,
          id(5),
          i === 0 ? id(20) : null,
          i === 0 ? "2027-01-01T00:00:00.000Z" : past,
          past,
          id(2),
        ]);
      const before = (
        await admin.query(
          "SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
          [id(1)],
        )
      ).rows[0].generation;
      let digest;
      await source().withCurrentSnapshot(request, async (s) => {
        assert.equal(s.generation, before);
        assert.equal(s.rules.length, 4);
        assert.equal(s.applicability, "Unavailable");
        assert.equal(s.rules[0].storeReference, id(20));
        assert.equal(s.rules[0].effectiveFrom, "2027-01-01T00:00:00.000Z");
        digest = s.digest;
        for (const [sql, values] of [
          [
            "UPDATE rms_catalog.availability_rule SET priority=priority WHERE availability_rule_id=$1",
            [id(10)],
          ],
          ["DELETE FROM rms_catalog.availability_rule WHERE availability_rule_id=$1", [id(10)]],
          [ruleInsert, [id(30), id(1), "SYNTHETIC_NEW", "Draft", id(5), null, past, past, id(2)]],
        ]) {
          await writer.query("BEGIN");
          await scope(writer);
          await writer.query("SET LOCAL lock_timeout='150ms'");
          try {
            await assert.rejects(writer.query(sql, values), (e) => e.code === "55P03");
          } finally {
            await writer.query("ROLLBACK");
          }
        }
        // Compatible reader fences coexist; no source row write or private helper grant required.
        await writer.query("BEGIN");
        assert.equal(
          (
            await writer.query(
              "SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) allowed",
              ["CatalogAvailabilityReferenceV1:" + id(1)],
            )
          ).rows[0].allowed,
          true,
        );
        await writer.query("ROLLBACK");
        // Callback can change Store SQL context; final header reread must restore full Brand.
        await scope(reader, id(1), id(20));
      });
      await writer.query("BEGIN");
      await scope(writer);
      await writer.query("SET LOCAL lock_timeout='150ms'");
      await writer.query(
        "UPDATE rms_catalog.availability_rule SET priority=priority WHERE availability_rule_id=$1",
        [id(10)],
      );
      await writer.query("ROLLBACK");
      assert.equal(await source().withCurrentSnapshot(request, async (s) => s.digest), digest);
      // Source writes in the same UoW invalidate the counter and roll back the operation.
      await admin.query(`GRANT UPDATE(priority) ON rms_catalog.availability_rule TO ${role}`);
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          await reader.query(
            "UPDATE rms_catalog.availability_rule SET priority=2 WHERE availability_rule_id=$1",
            [id(10)],
          );
          await scope(reader, id(1), id(20));
          return "must not escape";
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
            [id(1)],
          )
        ).rows[0].generation,
        before,
      );
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          deny = true;
        }),
        (e) => e.code === "CATALOG_PERMISSION_DENIED",
      );
      deny = false;
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          now = () => new Date(Date.now() + 6000).toISOString();
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      now = () => new Date().toISOString();
      // Narrow writer can mutate source with nullStore; no direct counter grant or helper execution.
      await writer.query("BEGIN");
      await writer.query(`SET LOCAL ROLE ${role}`);
      await scope(writer, id(1));
      assert.equal(
        (
          await writer.query(
            "UPDATE rms_catalog.availability_rule SET priority=priority WHERE availability_rule_id=$1",
            [id(10)],
          )
        ).rowCount,
        1,
      );
      assert.deepEqual(
        (
          await writer.query(
            "SELECT current_setting('bop.brand_id') brand,current_setting('bop.store_id') store",
          )
        ).rows[0],
        { brand: id(1), store: "" },
      );
      await scope(writer, id(1), id(20));
      assert.equal(
        (
          await writer.query(
            "UPDATE rms_catalog.availability_rule SET priority=priority WHERE availability_rule_id=$1",
            [id(10)],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await writer.query(
            "SELECT count(*)::text count FROM rms_catalog.availability_reference_generation",
          )
        ).rows[0].count,
        "0",
      );
      await writer.query("ROLLBACK");
      assert.equal(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'rms_catalog.availability_reference_generation','UPDATE') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'rms_catalog.maintain_availability_reference_generation()','EXECUTE') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      const procedure = (
        await admin.query(
          "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='rms_catalog.maintain_availability_reference_generation()'::regprocedure",
        )
      ).rows[0];
      assert.equal(procedure.prosecdef, true);
      assert(procedure.proconfig.includes("search_path=pg_catalog"));
      assert(procedure.proconfig.includes("row_security=on"));
      const flags = (
        await admin.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='rms_catalog.availability_reference_generation'::regclass",
        )
      ).rows[0];
      assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
      // Existing Brand identity remains immutable and leaves all source counters unchanged.
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_catalog.availability_rule SET brand_id=$1,product_id=$2 WHERE availability_rule_id=$3",
            [id(40), id(41), id(13)],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
            [id(1)],
          )
        ).rows[0].generation,
        before,
      );
      await admin.query(ruleInsert, [
        id(40),
        id(40),
        "SYNTHETIC_OTHER",
        "Draft",
        id(41),
        null,
        past,
        past,
        id(2),
      ]);
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
            [id(40)],
          )
        ).rows[0].generation,
        "1",
      );
      assert.equal(await source().withCurrentSnapshot(request, async (s) => s.rules.length), 4);
      // Exact migration replay in an isolated rollback proves populated backfill.
      await admin.query("BEGIN");
      await admin.query(
        "DROP TRIGGER availability_rule_reference_fence ON rms_catalog.availability_rule; DROP TRIGGER availability_rule_reference_no_truncate ON rms_catalog.availability_rule; DROP FUNCTION rms_catalog.maintain_availability_reference_generation(); DROP FUNCTION rms_catalog.reject_availability_reference_truncate(); DROP TABLE rms_catalog.availability_reference_generation",
      );
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/1103-rms-catalog-availability/1103_002_create_availability_reference_generation.sql",
          ),
          "utf8",
        ),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
            [id(1)],
          )
        ).rows[0].generation,
        "0",
      );
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
            [id(40)],
          )
        ).rows[0].generation,
        "0",
      );
      await admin.query("ROLLBACK");
      await admin.query("DELETE FROM rms_catalog.availability_rule WHERE availability_rule_id=$1", [
        id(40),
      ]);
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
            [id(40)],
          )
        ).rows[0].generation,
        "2",
      );
      assert.equal(await source().withCurrentSnapshot(request, async (s) => s.rules.length), 4);
      await admin.query("BEGIN");
      await admin.query(
        "UPDATE rms_catalog.availability_reference_generation SET generation=9223372036854775807 WHERE brand_id=$1",
        [id(1)],
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.availability_rule SET priority=priority WHERE availability_rule_id=$1",
          [id(10)],
        ),
        (e) => e.code === "22003",
      );
      await admin.query("ROLLBACK");
      await assert.rejects(
        admin.query(
          "TRUNCATE rms_catalog.availability_rule,rms_catalog.availability_rule_operation_record",
        ),
        (e) => e.code === "55000",
      );
      await admin.query("BEGIN");
      await admin.query(
        "DELETE FROM rms_catalog.availability_reference_generation WHERE brand_id=$1",
        [id(1)],
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.availability_rule SET priority=priority WHERE availability_rule_id=$1",
          [id(10)],
        ),
        (e) => e.code === "55000",
      );
      await admin.query("ROLLBACK");
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
