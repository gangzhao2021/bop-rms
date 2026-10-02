import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresMenuReferenceSourceStore,
  menuReferenceSourceFields,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedPriceMenuOwnerFacts } from "../test-support/price-menu-owner-facts.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `01902415-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const past = "2026-08-01T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64),
  { Client } = pg;
const tables = [
  "menu_review_content",
  "menu_publication_revision",
  "menu_publication_release",
  "menu_release_effective_period",
];
it("holds complete Menu reference graph through caller COMMIT while preserving publication writer locks", async () => {
  await withIsolatedDatabase({ caseId: "menu_refs", root }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const role = "wp2415_" + context.runId,
      key = "CatalogMenuReferenceV1:" + id(1);
    const request = {
      purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ",
      brandReference: id(1),
      actorReference: id(2),
      operationReference: id(3),
      catalogIntentDigest: digest,
    };
    const scope = (client) =>
      client.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
        id(1),
      ]);
    const review = (n = 10, brand = id(1), menu = id(800), version = id(801), d = digest) => [
      id(n),
      brand,
      menu,
      version,
      d,
      JSON.stringify({
        lifecycleReference: id(n),
        snapshotDigest: d,
        createdAt: past,
        content: {
          brandReference: brand,
          menuReference: menu,
          menuVersionReference: version,
          sections: [
            {
              sectionReference: id(n + 20),
              sellables: [
                {
                  placementReference: id(n + 21),
                  sellableReference: id(20),
                  productVersionReference: id(900),
                },
              ],
            },
          ],
        },
      }),
      id(n + 90),
    ];
    const insertReview =
      "INSERT INTO rms_catalog.menu_review_content(lifecycle_id,brand_id,menu_id,menu_version_id,snapshot_digest,snapshot_json,audit_reference) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)";
    const insertRevision =
      "INSERT INTO rms_catalog.menu_publication_revision(lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)";
    const insertRelease =
      "INSERT INTO rms_catalog.menu_publication_release(release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,previous_release_id,release_kind,snapshot_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)";
    const insertPeriod =
      "INSERT INTO rms_catalog.menu_release_effective_period(timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES($1,$2,$3,$4,'America/Toronto',$5,$6,$7,$8,$9)";
    let deny = false,
      now = () => new Date().toISOString();
    const blocked = async (
      sql = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      values = [key],
    ) => {
      await writer.query("BEGIN");
      try {
        await scope(writer);
        await writer.query("SET LOCAL lock_timeout='150ms'");
        await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "CatalogMenuPublication:" + id(1) + ":" + id(800),
        ]);
        await assert.rejects(writer.query(sql, values), (e) => e.code === "55P03");
      } finally {
        await writer.query("ROLLBACK");
      }
    };
    const source = createPostgresMenuReferenceSourceStore({
      tenantReference: id(4),
      brandReference: id(1),
      actorReference: id(2),
      clock: { now: () => now() },
      transactions: {
        async run(work) {
          await reader.query("BEGIN");
          await reader.query("SET LOCAL ROLE " + role);
          try {
            const v = await work(reader);
            await blocked();
            await reader.query("COMMIT");
            return v;
          } catch (e) {
            await reader.query("ROLLBACK");
            throw e;
          }
        },
      },
      authority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, reader);
          assert.deepEqual(input.request, request);
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.deepEqual(input.requiredFields, menuReferenceSourceFields);
          if (deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      },
    });
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.menu_reference_generation," +
          tables.map((t) => "rms_catalog." + t).join(",") +
          " TO " +
          role,
      );
      await source.withCurrentSnapshot(request, async (s) => {
        assert.equal(s.generation, "0");
        assert.equal(s.reviews.length, 0);
      });
      await seedPriceMenuOwnerFacts(
        admin,
        role,
        { brandReference: id(1), entries: [{ sellableReference: id(20) }] },
        id,
        past,
      );
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES($1,'MENU_REF_OTHER','Synthetic other Brand','en-CA','CAD','Active',1,$2,$2)",
        [id(10001), past],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu VALUES($1,$2,'SYNTHETIC_OTHER_MENU',1,$3,$4,$3)",
        [id(10800), id(10001), past, id(10701)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
        [id(10801), id(10800), id(10001), JSON.stringify({ "en-CA": "Synthetic" }), past],
      );
      await admin.query(insertReview, review());
      await admin.query(insertReview, review(110, id(10001), id(10800), id(10801)));
      await admin.query(insertRevision, [
        id(10),
        3,
        id(800),
        id(801),
        id(1),
        digest,
        "Published",
        id(80),
        id(81),
        past,
      ]);
      await admin.query(insertRevision, [
        id(10),
        4,
        id(800),
        id(801),
        id(1),
        digest,
        "Superseded",
        id(80),
        id(81),
        past,
      ]);
      await admin.query(insertRelease, [
        id(50),
        id(10),
        3,
        id(800),
        id(801),
        id(1),
        1,
        null,
        "Publish",
        digest,
        past,
      ]);
      await admin.query(insertPeriod, [
        id(60),
        id(50),
        id(800),
        id(1),
        "2027-01-01T00:00:00.000Z",
        "2027-01-02T00:00:00.000Z",
        digest,
        id(81),
        past,
      ]);
      const generation = async () =>
        (
          await admin.query(
            "SELECT generation::text FROM rms_catalog.menu_reference_generation WHERE brand_id=$1",
            [id(1)],
          )
        ).rows[0].generation;
      const originalGeneration = await generation();
      const mutations = [
        [insertReview, review(120, id(1), id(800), id(801), "sha256:" + "c".repeat(64))],
        [
          insertRevision,
          [id(10), 5, id(800), id(801), id(1), digest, "Archived", id(80), id(81), past],
        ],
        [
          insertRelease,
          [id(51), id(10), 3, id(800), id(801), id(1), 2, id(50), "Rollback", digest, past],
        ],
        [
          insertPeriod,
          [
            id(61),
            id(50),
            id(800),
            id(1),
            "2027-02-01T00:00:00.000Z",
            "2027-02-02T00:00:00.000Z",
            digest,
            id(81),
            past,
          ],
        ],
      ];
      let firstDigest;
      await source.withCurrentSnapshot(request, async (s) => {
        assert.equal(s.reviews.length, 1);
        assert.equal(s.placements.length, 1);
        assert.equal(s.revisions.length, 2);
        assert.equal(s.releases.length, 1);
        assert.equal(s.periods.length, 1);
        assert.equal(s.applicability, "Unavailable");
        firstDigest = s.digest;
        for (const [q, v] of mutations) await blocked(q, v);
        await writer.query("BEGIN");
        await scope(writer);
        assert.equal(
          (
            await writer.query(
              "SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) held",
              [key],
            )
          ).rows[0].held,
          true,
        );
        for (const t of tables) {
          assert.equal(
            (
              await writer.query(
                "UPDATE rms_catalog." + t + " SET brand_id=brand_id WHERE brand_id=$1",
                [id(1)],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await writer.query("DELETE FROM rms_catalog." + t + " WHERE brand_id=$1", [id(1)]))
              .rowCount,
            0,
          );
        }
        await writer.query("ROLLBACK");
        await reader.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(10001), id(704)],
        );
      });
      assert.equal(await generation(), originalGeneration);
      await source.withCurrentSnapshot(request, async (s) => assert.equal(s.digest, firstDigest));
      for (const [q, v] of mutations) {
        await writer.query("BEGIN");
        try {
          await scope(writer);
          assert.equal((await writer.query(q, v)).rowCount, 1);
        } finally {
          await writer.query("ROLLBACK");
        }
      }
      await admin.query("GRANT INSERT ON rms_catalog.menu_publication_revision TO " + role);
      await assert.rejects(
        source.withCurrentSnapshot(request, async () => {
          await reader.query(...mutations[1]);
          await reader.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [id(10001), id(704)],
          );
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(await generation(), originalGeneration);
      await assert.rejects(
        source.withCurrentSnapshot(request, async () => {
          deny = true;
        }),
        { code: "CATALOG_PERMISSION_DENIED" },
      );
      deny = false;
      await assert.rejects(
        source.withCurrentSnapshot(request, async () => {
          now = () => new Date(Date.now() + 6000).toISOString();
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      now = () => new Date().toISOString();
      await writer.query("BEGIN");
      await writer.query("SET LOCAL ROLE " + role);
      await scope(writer);
      assert.equal(
        (await writer.query("SELECT count(*)::text n FROM rms_catalog.menu_reference_generation"))
          .rows[0].n,
        "1",
      );
      await writer.query("SELECT set_config('bop.store_id',$1,true)", [id(704)]);
      assert.equal(
        (await writer.query("SELECT count(*)::text n FROM rms_catalog.menu_reference_generation"))
          .rows[0].n,
        "0",
      );
      await writer.query("ROLLBACK");
      const privileges = (
        await admin.query(
          "SELECT has_table_privilege($1,'rms_catalog.menu_reference_generation','UPDATE') head,has_function_privilege($1,'rms_catalog.maintain_menu_reference_generation()','EXECUTE') helper",
          [role],
        )
      ).rows[0];
      assert.deepEqual(privileges, { head: false, helper: false });
      const fn = (
        await admin.query(
          "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='rms_catalog.maintain_menu_reference_generation()'::regprocedure",
        )
      ).rows[0];
      assert.equal(fn.prosecdef, true);
      assert(fn.proconfig.includes("search_path=pg_catalog"));
      assert(fn.proconfig.includes("row_security=on"));
      const rls = (
        await admin.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='rms_catalog.menu_reference_generation'::regclass",
        )
      ).rows[0];
      assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });
      await admin.query("BEGIN");
      for (const t of tables) {
        await admin.query("DROP TRIGGER " + t + "_reference_fence ON rms_catalog." + t);
        await admin.query("DROP TRIGGER " + t + "_reference_no_truncate ON rms_catalog." + t);
      }
      await admin.query(
        "DROP FUNCTION rms_catalog.maintain_menu_reference_generation(),rms_catalog.reject_menu_reference_truncate()",
      );
      await admin.query("DROP TABLE rms_catalog.menu_reference_generation");
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/1104-rms-catalog-menu-publishing/1104_004_create_menu_reference_generation.sql",
          ),
          "utf8",
        ),
      );
      assert.equal(
        (await admin.query("SELECT count(*)::text n FROM rms_catalog.menu_reference_generation"))
          .rows[0].n,
        "2",
      );
      assert.equal(await generation(), "0");
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await admin.query(
        "UPDATE rms_catalog.menu_reference_generation SET generation=9223372036854775807 WHERE brand_id=$1",
        [id(1)],
      );
      await assert.rejects(admin.query(...mutations[0]), (e) => e.code === "22003");
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await admin.query("DELETE FROM rms_catalog.menu_reference_generation WHERE brand_id=$1", [
        id(1),
      ]);
      await assert.rejects(admin.query(...mutations[0]), (e) => e.code === "55000");
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await assert.rejects(
        admin.query("TRUNCATE " + tables.map((t) => "rms_catalog." + t).join(",") + " CASCADE"),
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
