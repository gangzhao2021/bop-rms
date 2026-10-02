import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresBundleReferenceSourceStore,
  bundleReferenceSourceFields,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { Client } = pg;
const id = (n) => `01902414-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const past = "2026-08-01T12:00:00.000Z",
  names = JSON.stringify({ "en-CA": "Synthetic" });
const sourceTables = [
  "bundle",
  "bundle_version",
  "bundle_component_group",
  "bundle_component_sellable",
];
const rootInsert =
  "INSERT INTO rms_catalog.bundle(bundle_id,brand_id,internal_code,lifecycle,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'Draft',1,$4,$5,$6,$5)";
const versionInsert =
  "INSERT INTO rms_catalog.bundle_version(bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,price_mode,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$4::jsonb,'Computed',$5,$5)";
const groupInsert =
  "INSERT INTO rms_catalog.bundle_component_group(group_id,bundle_version_id,bundle_id,brand_id,stable_code,localized_names_json,minimum_selection,maximum_selection,sort_order) VALUES($1,$2,$3,$4,$5,$6::jsonb,0,1,$7)";
const memberInsert =
  "INSERT INTO rms_catalog.bundle_component_sellable(group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type) VALUES($1,$2,$3,$4,$5,$6)";
async function seed(client, base, brand = id(1), reverse = false) {
  const versionArgs = [id(base + 1), id(base), brand, names, past];
  if (reverse) await client.query(versionInsert, versionArgs);
  await client.query(rootInsert, [
    id(base),
    brand,
    "SYNTHETIC_BUNDLE_" + base,
    id(base + 1),
    past,
    id(2),
  ]);
  if (!reverse) await client.query(versionInsert, versionArgs);
  await client.query(
    "INSERT INTO rms_catalog.bundle_version(bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,price_mode,validation_digest,published_at,created_at,updated_at) VALUES($1,$2,$3,'Published','en-CA',$4::jsonb,$4::jsonb,'Computed',$5,$6,$6,$6)",
    [id(base + 2), id(base), brand, names, "sha256:" + "b".repeat(64), past],
  );
  for (const offset of [3, 4]) {
    await client.query(groupInsert, [
      id(base + offset),
      id(base + offset - 2),
      id(base),
      brand,
      "SYNTHETIC_GROUP",
      names,
      0,
    ]);
    await client.query(memberInsert, [
      id(base + offset),
      id(base + offset - 2),
      id(base),
      brand,
      id(90 + offset),
      offset === 3 ? "Product" : "Sku",
    ]);
  }
}
it("holds complete Bundle source graphs against effective source writes until outer COMMIT", async () => {
  await withIsolatedDatabase({ caseId: "bundle_refs", root }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const role = `wp2414_${context.runId}`,
      request = {
        purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ",
        brandReference: id(1),
        actorReference: id(2),
        operationReference: id(3),
        catalogIntentDigest: "sha256:" + "a".repeat(64),
      };
    let deny = false,
      now = () => new Date().toISOString();
    const scope = async (client, brand = id(1), store = "") =>
      client.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
        brand,
        store,
      ]);
    const authority = {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, reader);
        assert.deepEqual(input.request, request);
        assert.equal(input.requiredScope, "FullBrandScope");
        assert.deepEqual(input.requiredFields, bundleReferenceSourceFields);
        if (deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    };
    async function blocked(
      sql = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      values = ["CatalogBundleReferenceV1:" + id(1)],
    ) {
      await writer.query("BEGIN");
      await scope(writer);
      await writer.query("SET LOCAL lock_timeout='150ms'");
      try {
        await assert.rejects(writer.query(sql, values), (e) => e.code === "55P03");
      } finally {
        await writer.query("ROLLBACK");
      }
    }
    const transactions = {
      run: async (work) => {
        await reader.query("BEGIN");
        await reader.query(`SET LOCAL ROLE ${role}`);
        try {
          const value = await work(reader);
          await blocked();
          await reader.query("COMMIT");
          return value;
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
        transactions,
        authority,
      },
      source = () => createPostgresBundleReferenceSourceStore(options);
    const generation = async () =>
      (
        await admin.query(
          "SELECT generation::text FROM rms_catalog.bundle_reference_generation WHERE brand_id=$1",
          [id(1)],
        )
      ).rows[0].generation;
    try {
      await admin.query(`CREATE ROLE ${role} NOLOGIN`);
      await admin.query(`GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
      );
      await admin.query(
        "GRANT SELECT ON " +
          [...sourceTables, "bundle_reference_generation"]
            .map((t) => "rms_catalog." + t)
            .join(",") +
          " TO " +
          role,
      );
      const empty = await source().withCurrentSnapshot(request, async (s) => s);
      assert.equal(empty.generation, "0");
      assert.equal(empty.bundles.length, 0);
      await admin.query("BEGIN");
      await seed(admin, 10);
      await seed(admin, 40, id(40));
      await admin.query("COMMIT");
      // Existing DEFERRABLE root FK permits version-first construction for a genuinely new Brand.
      await admin.query("BEGIN");
      await seed(admin, 60, id(60), true);
      await admin.query("COMMIT");
      const before = await generation();
      let digest;
      const changes = [
        ["UPDATE rms_catalog.bundle SET updated_at=updated_at WHERE bundle_id=$1", [id(10)]],
        [versionInsert, [id(100), id(10), id(1), names, past]],
        [groupInsert, [id(101), id(11), id(10), id(1), "SYNTHETIC_ADDED", names, 1]],
        [memberInsert, [id(13), id(11), id(10), id(1), id(102), "Sku"]],
        [rootInsert, [id(30), id(1), "SYNTHETIC_BUNDLE_30", id(31), past, id(2)]],
      ];
      await source().withCurrentSnapshot(request, async (s) => {
        assert.equal(s.bundles.length, 1);
        assert.equal(s.versions.length, 2);
        assert.equal(s.groups.length, 2);
        assert.equal(s.members.length, 2);
        assert.equal(s.bundles[0].currentVersionReference, id(11));
        assert.equal(
          s.versions.find((v) => v.bundleVersionReference === id(12)).versionStatus,
          "Published",
        );
        assert.equal(s.applicability, "Unavailable");
        digest = s.digest;
        for (const [sql, values] of changes) await blocked(sql, values);
        await writer.query("BEGIN");
        assert.equal(
          (
            await writer.query(
              "SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) allowed",
              ["CatalogBundleReferenceV1:" + id(1)],
            )
          ).rows[0].allowed,
          true,
        );
        // Immutable child writes remain no-ops, rather than fictitious blocked mutations.
        for (const [table, column, value] of [
          ["bundle_version", "bundle_version_id", id(11)],
          ["bundle_component_group", "group_id", id(13)],
          ["bundle_component_sellable", "group_id", id(13)],
        ]) {
          assert.equal(
            (
              await writer.query(
                `UPDATE rms_catalog.${table} SET brand_id=brand_id WHERE ${column}=$1`,
                [value],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await writer.query(`DELETE FROM rms_catalog.${table} WHERE ${column}=$1`, [value]))
              .rowCount,
            0,
          );
        }
        await writer.query("ROLLBACK");
        await scope(reader, id(40), id(20));
      });
      assert.equal(await source().withCurrentSnapshot(request, async (s) => s.digest), digest);
      for (const [sql, values] of changes.slice(0, 4)) {
        await writer.query("BEGIN");
        await scope(writer);
        assert.equal((await writer.query(sql, values)).rowCount, 1);
        await writer.query("ROLLBACK");
      }
      await writer.query("BEGIN");
      await seed(writer, 30);
      await writer.query("COMMIT");
      assert.equal(await source().withCurrentSnapshot(request, async (s) => s.bundles.length), 2);
      const current = await generation();
      assert(BigInt(current) > BigInt(before));
      await admin.query(`GRANT UPDATE(updated_at) ON rms_catalog.bundle TO ${role}`);
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          assert.equal(
            (
              await reader.query(
                "UPDATE rms_catalog.bundle SET updated_at=updated_at WHERE bundle_id=$1",
                [id(10)],
              )
            ).rowCount,
            1,
          );
          await scope(reader, id(40), id(20));
          return "must not escape";
        }),
        (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(await generation(), current);
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
      await writer.query("BEGIN");
      await writer.query(`SET LOCAL ROLE ${role}`);
      await scope(writer);
      assert.equal(
        (
          await writer.query(
            "UPDATE rms_catalog.bundle SET updated_at=updated_at WHERE bundle_id=$1",
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
            "SELECT count(*)::text count FROM rms_catalog.bundle_reference_generation",
          )
        ).rows[0].count,
        "0",
      );
      await writer.query("ROLLBACK");
      assert.equal(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'rms_catalog.bundle_reference_generation','UPDATE') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'rms_catalog.maintain_bundle_reference_generation()','EXECUTE') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      const procedure = (
        await admin.query(
          "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='rms_catalog.maintain_bundle_reference_generation()'::regprocedure",
        )
      ).rows[0];
      assert(procedure.prosecdef);
      assert(procedure.proconfig.includes("search_path=pg_catalog"));
      assert(procedure.proconfig.includes("row_security=on"));
      assert.deepEqual(
        (
          await admin.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='rms_catalog.bundle_reference_generation'::regclass",
          )
        ).rows[0],
        { relrowsecurity: true, relforcerowsecurity: true },
      );
      assert.equal(
        (
          await admin.query("UPDATE rms_catalog.bundle SET brand_id=$1 WHERE bundle_id=$2", [
            id(40),
            id(10),
          ])
        ).rowCount,
        0,
      );
      assert.equal(await generation(), current);
      await admin.query("BEGIN");
      for (const table of sourceTables) {
        await admin.query(`DROP TRIGGER ${table}_reference_fence ON rms_catalog.${table}`);
        await admin.query(`DROP TRIGGER ${table}_reference_no_truncate ON rms_catalog.${table}`);
      }
      await admin.query(
        "DROP FUNCTION rms_catalog.maintain_bundle_reference_generation(); DROP FUNCTION rms_catalog.reject_bundle_reference_truncate(); DROP TABLE rms_catalog.bundle_reference_generation",
      );
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/1107-rms-catalog-bundle/1107_003_create_bundle_reference_generation.sql",
          ),
          "utf8",
        ),
      );
      assert.equal(await generation(), "0");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::text count FROM rms_catalog.bundle_reference_generation",
          )
        ).rows[0].count,
        "3",
      );
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await admin.query(
        "UPDATE rms_catalog.bundle_reference_generation SET generation=9223372036854775807 WHERE brand_id=$1",
        [id(1)],
      );
      await assert.rejects(
        admin.query("UPDATE rms_catalog.bundle SET updated_at=updated_at WHERE bundle_id=$1", [
          id(10),
        ]),
        (e) => e.code === "22003",
      );
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await admin.query("DELETE FROM rms_catalog.bundle_reference_generation WHERE brand_id=$1", [
        id(1),
      ]);
      await assert.rejects(
        admin.query(rootInsert, [id(110), id(1), "SYNTHETIC_GAP", id(111), past, id(2)]),
        (e) => e.code === "55000",
      );
      await admin.query("ROLLBACK");
      await assert.rejects(
        admin.query(
          "TRUNCATE rms_catalog.bundle,rms_catalog.bundle_version,rms_catalog.bundle_component_group,rms_catalog.bundle_component_sellable,rms_catalog.bundle_availability_rule,rms_catalog.bundle_operation_record CASCADE",
        ),
        (e) => e.code === "55000",
      );
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
