import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPublishedMenuQueryStore,
  createCustomerMenuQueryService,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f7300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const optionRules = [
  {
    bindingReference: id(31),
    optionSetVersionReference: id(32),
    minimumSelections: 0,
    maximumSelections: 1,
    enabledOptionReferences: [id(33)],
    defaultOptionReferences: [],
    options: [
      {
        optionReference: id(33),
        localizedNames: { "en-CA": "Oat beverage" },
        maximumQuantity: 1,
        conflictOptionReferences: [],
        selectedByDefault: false,
      },
    ],
  },
];
const digest = `sha256:${"a".repeat(64)}`;
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2219_${context.runId}`;
  await admin.connect();
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
      `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
      [id(5), id(1), id(4), id(2), digest, id(6), id(7), at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
      [id(8), id(5), id(1), id(4), id(2), digest, at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,4,$4,$5,'Fresh')`,
      [id(9), id(2), id(1), id(10), at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["DINE_IN"]'::jsonb,'["TABLE_SERVICE"]'::jsonb,'UTC',$7)`,
      [id(9), id(2), id(1), id(4), id(8), digest, at, JSON.stringify([id(20)])],
    );
    await admin.query(
      `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}'::jsonb,0)`,
      [id(9), id(2), id(1), id(11)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Latte"}'::jsonb,'Standard',0,false,'Available',$8::jsonb,'{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}'::jsonb)`,
      [id(9), id(2), id(1), id(11), id(12), id(13), id(14), JSON.stringify(optionRules)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES ('catalog.published-menu-projection',$1,$2,$3,$4,4,$5)`,
      [id(2), id(1), id(9), id(10), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE rms_catalog.published_menu_projection_checkpoint SET source_aggregate_version=3 WHERE brand_id=$1 AND menu_id=$2`,
        [id(2), id(1)],
      ),
      /published menu checkpoint must advance/u,
    );
    await admin.query(
      `UPDATE rms_catalog.published_menu_projection SET snapshot_digest=$1 WHERE generation_id=$2`,
      [`sha256:${"b".repeat(64)}`, id(9)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT snapshot_digest FROM rms_catalog.published_menu_projection WHERE generation_id=$1`,
          [id(9)],
        )
      ).rows[0].snapshot_digest,
      digest,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_catalog.published_menu_projection_generation, rms_catalog.published_menu_projection, rms_catalog.published_menu_projection_section, rms_catalog.published_menu_projection_sellable, rms_catalog.published_menu_projection_checkpoint TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_catalog.published_menu_projection`)).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_catalog.published_menu_projection`)).rowCount,
      1,
    );
    await admin.query(`RESET ROLE`);
    await admin.query("RESET bop.brand_id");
    const scope = { brandReference: id(2), storeReference: id(20) };
    let reads = 0;
    const runner = {
      async run(action) {
        await admin.query("BEGIN READ ONLY");
        try {
          await admin.query(`SET LOCAL ROLE ${role}`);
          await admin.query("SET LOCAL TIME ZONE 'Pacific/Auckland'");
          const result = await action({
            query: async (sql, values) => {
              if (sql.startsWith("SELECT CASE")) reads++;
              return admin.query(sql, values);
            },
          });
          await admin.query("COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      },
    };
    const store = createPostgresPublishedMenuQueryStore(runner, scope);
    const [candidate] = await store.loadCandidates(scope);
    assert.equal(reads, 1);
    assert.equal(candidate.generationReference, id(9));
    assert.equal(candidate.lastRebuiltAt, at);
    assert.equal(candidate.snapshot.effectiveFrom, at);
    assert.equal(candidate.snapshot.effectiveUntil, null);
    assert.deepEqual(candidate.snapshot.sections[0].sellables[0].optionRules, optionRules);
    assert.equal(
      candidate.snapshot.sections[0].sellables[0].allergenDisclosure.allergenFreeClaim,
      false,
    );
    assert.deepEqual(await store.loadCandidates(scope), [candidate]);
    const beforeDenied = reads;
    await assert.rejects(store.loadCandidates({ ...scope, storeReference: id(99) }), {
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal(reads, beforeDenied);
    for (const other of [
      { ...scope, brandReference: id(99) },
      { ...scope, storeReference: id(99) },
    ])
      assert.deepEqual(
        await createPostgresPublishedMenuQueryStore(runner, other).loadCandidates(other),
        [],
      );
    const query = createCustomerMenuQueryService({
      stores: { resolvePublic: async () => ({ ...scope, status: "Active" }) },
      projections: store,
    });
    const request = {
      publicStoreReference: id(21),
      channelCode: "DINE_IN",
      orderTypeCode: "TABLE_SERVICE",
      locale: "en-CA",
      requestedAt: at,
      searchTerm: null,
      sectionReference: null,
    };
    const found = await query.getPublishedMenu(request);
    assert.equal(found.status, "Found");
    assert.equal(found.menu.sections[0].sellables[0].name, "Latte");
    assert.equal(found.menu.sections[0].sellables[0].displayPrice.status, "Unavailable");
    for (const state of ["Stale", "Rebuilding", "Failed"]) {
      await admin.query(
        "UPDATE rms_catalog.published_menu_projection_generation SET freshness_status=$1 WHERE generation_id=$2",
        [state, id(9)],
      );
      assert.deepEqual(await query.getPublishedMenu(request), { status: "ProjectionStale" });
    }
    await admin.query(
      "UPDATE rms_catalog.published_menu_projection_generation SET freshness_status='Fresh', generation_status='Building' WHERE generation_id=$1",
      [id(9)],
    );
    assert.deepEqual(await query.getPublishedMenu(request), { status: "Unavailable" });
    await admin.query(
      "UPDATE rms_catalog.published_menu_projection_generation SET generation_status='Active', source_checkpoint=$1 WHERE generation_id=$2",
      [id(99), id(9)],
    );
    assert.deepEqual(await query.getPublishedMenu(request), { status: "Unavailable" });
    await admin.query(
      "UPDATE rms_catalog.published_menu_projection_generation SET source_checkpoint=$1 WHERE generation_id=$2",
      [id(10), id(9)],
    );
    assert.deepEqual(await store.loadCandidates(scope), [candidate]);
    // A newly selected incomplete generation must never fall back to the retired content.
    await admin.query(
      "UPDATE rms_catalog.published_menu_projection_generation SET generation_status='Retired' WHERE generation_id=$1",
      [id(9)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.published_menu_projection_generation
      (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,
       source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status)
      VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,5,$4,$5,'Fresh')`,
      [id(40), id(2), id(1), id(41), at],
    );
    await admin.query(
      `UPDATE rms_catalog.published_menu_projection_checkpoint
      SET active_generation_id=$1,source_event_id=$2,source_aggregate_version=5
      WHERE brand_id=$3 AND menu_id=$4`,
      [id(40), id(41), id(2), id(1)],
    );
    assert.deepEqual(await query.getPublishedMenu(request), { status: "Unavailable" });
    await admin.query(
      `INSERT INTO rms_catalog.published_menu_projection
      (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,
       localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from,effective_until)
      SELECT $1,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,
        localized_names_json,'[]'::jsonb,channel_codes_json,order_type_codes_json,time_zone,effective_from,effective_until
      FROM rms_catalog.published_menu_projection WHERE generation_id=$2`,
      [id(40), id(9)],
    );
    const global = await store.loadCandidates(scope);
    assert.equal(global.length, 1);
    assert.equal(global[0].generationReference, id(40));
    assert.deepEqual(global[0].snapshot.storeReferences, []);
    const otherStoreScope = { ...scope, storeReference: id(99) };
    assert.deepEqual(
      await createPostgresPublishedMenuQueryStore(runner, otherStoreScope).loadCandidates(
        otherStoreScope,
      ),
      global,
    );
    for (const sql of [
      "SELECT * FROM rms_catalog.menu",
      "UPDATE rms_catalog.published_menu_projection_generation SET freshness_status='Stale'",
    ]) {
      await admin.query("BEGIN");
      await admin.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(admin.query(sql), { code: "42501" });
      await admin.query("ROLLBACK");
    }
    const contextAfter = await admin.query(
      "SELECT current_setting('bop.brand_id',true) AS brand, current_setting('bop.store_id',true) AS store",
    );
    assert(!contextAfter.rows[0].brand && !contextAfter.rows[0].store);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces Published Menu projection generation, checkpoint, immutability and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2219_menu", root }, prove);
}, 120_000);
