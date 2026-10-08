import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPostgresCurrentMenuReleaseStore } from "../../rms/catalog/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-01T16:00:00.000Z";
const digest = "sha256:" + "a".repeat(64);
it("reads effective current menu authority under scoped RLS and denies withdrawn/mismatched scope", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_menu_release" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_release_" + context.runId;
    let active = 0;
    const tables = [
      "menu_publication_revision",
      "menu_publication_release",
      "menu_release_effective_period",
      "menu_version_store",
      "menu_version_channel",
      "menu_version_order_type",
    ];
    const runner = {
      async run(action) {
        const client = new Client(context.clientConfig);
        await client.connect();
        active++;
        try {
          await client.query("BEGIN READ ONLY");
          await client.query("SET LOCAL ROLE " + role);
          assert.equal(
            (
              await client.query(
                "SELECT count(*)::int AS n FROM rms_catalog.menu_publication_release",
              )
            ).rows[0].n,
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
    try {
      await admin.query(
        `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
        [id(1), id(2), at, id(3)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
        [id(4), id(1), id(2), at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version_store(menu_version_id,menu_id,brand_id,store_id) VALUES($1,$2,$3,$4)",
        [id(4), id(1), id(2), id(12)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version_channel(menu_version_id,menu_id,brand_id,channel_code) VALUES($1,$2,$3,'CUSTOMER_PWA')",
        [id(4), id(1), id(2)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version_order_type(menu_version_id,menu_id,brand_id,order_type_code) VALUES($1,$2,$3,'PICKUP'),($1,$2,$3,'DINE_IN')",
        [id(4), id(1), id(2)],
      );
      // Published after its content (a submitted Menu version is frozen, DEC-MENU-REVISION).
      await admin.query(
        `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
        [id(5), id(1), id(4), id(2), digest, id(6), id(7), at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
        [id(8), id(5), id(1), id(4), id(2), digest, at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.menu_release_effective_period (timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES ($1,$2,$3,$4,'UTC',$5,$6,$7,$8,$5)`,
        [id(9), id(8), id(1), id(2), at, "2026-08-02T00:00:00.000Z", digest, id(7)],
      );

      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
      );
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON " + tables.map((t) => "rms_catalog." + t).join(",") + " TO " + role,
      );
      const store = createPostgresCurrentMenuReleaseStore(runner, {
        brandReference: id(2),
        storeReference: id(12),
      });
      const input = {
        menuReference: id(1),
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
        observedAt: at,
      };
      const result = await store.load(input);
      assert.deepEqual(result, {
        brandReference: id(2),
        storeReference: id(12),
        menuReference: id(1),
        menuVersionReference: id(4),
        releaseReference: id(8),
        snapshotDigest: digest,
        lifecycleVersion: 4,
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
        releasedAt: at,
        effectiveFrom: at,
        effectiveUntil: "2026-08-02T00:00:00.000Z",
        observedAt: at,
      });
      assert.equal(
        (await store.load({ ...input, orderTypeCode: "DINE_IN" })).releaseReference,
        id(8),
      );
      for (const change of [
        { observedAt: "2026-08-01T15:59:59.999Z" },
        { observedAt: "2026-08-02T00:00:00.000Z" },
        { channelCode: "OTHER" },
        { orderTypeCode: "DELIVERY" },
        { menuReference: id(99) },
      ])
        assert.equal(await store.load({ ...input, ...change }), null);
      assert.equal(
        await createPostgresCurrentMenuReleaseStore(runner, {
          brandReference: id(2),
          storeReference: id(99),
        }).load(input),
        null,
      );
      assert.equal(
        await createPostgresCurrentMenuReleaseStore(runner, {
          brandReference: id(99),
          storeReference: id(12),
        }).load(input),
        null,
      );
      await assert.rejects(store.load({ ...input, brandReference: id(99) }), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      await admin.query(
        "INSERT INTO rms_catalog.menu_publication_revision(lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES($1,5,$2,$3,$4,$5,'Archived',$6,$7,$8)",
        [id(5), id(1), id(4), id(2), digest, id(6), id(7), "2026-08-01T16:01:00.000Z"],
      );
      assert.equal(await store.load({ ...input, observedAt: "2026-08-01T16:02:00.000Z" }), null);
      // Historical observedAt never resurrects a currently withdrawn lifecycle.
      assert.equal(await store.load(input), null);
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_catalog.menu_publication_release"))
          .rows[0].n,
        1,
      );
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
