import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import { createPostgresPublishedMenuQueryStore } from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";
const { Client } = pg;
const id = (n) => `018f7300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const later = "2026-08-02T16:05:00.000Z";
const contextInput = { channelCode: "DINE_IN", orderTypeCode: "TABLE_SERVICE", requestedAt: later };
const optionRules = [];
const digest = `sha256:${"a".repeat(64)}`;
const disclosure =
  '{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}';

/**
 * WP-2423 M68 (b) DEC-DATABASE-RESILIENCE: a guest's menu read never waits for a menu being
 * published. This guards the customer menu read alone (createPostgresPublishedMenuQueryStore
 * loadCandidates, as the restricted pilot API role with the pilot's 2 s lock wait). The publish
 * side is not the real Publish command: the owner client takes the advisory keys the Publish step
 * takes today (the menu's publication and reference keys, the Publishing family, the customer
 * menu's projection key) and makes the projection swap itself, holding them open. A cart quote,
 * the current-release check at order submission and the real Publish command are not run here;
 * a lock the real Publish step adds later (a row lock, or a key the quote or submission takes) is
 * not caught by this guard.
 */
it("a guest's menu read never waits for a menu being published, and shows the whole old menu until it commits", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_menu_guest" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const holder = new Client(context.clientConfig);
    await admin.connect();
    await holder.connect();
    try {
      const role = await createPilotApiRole(admin, context, "wp2423mg");
      await admin.query(
        `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
        [id(1), id(2), at, id(3)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
        [id(4), id(1), id(2), at],
      );
      // Synthetic published owner facts, not a production approval.
      for (const [table, field, value] of [
        ["menu_version_store", "store_id", id(20)],
        ["menu_version_channel", "channel_code", "DINE_IN"],
        ["menu_version_order_type", "order_type_code", "TABLE_SERVICE"],
      ])
        await admin.query(
          "INSERT INTO rms_catalog." +
            table +
            " (menu_version_id,menu_id,brand_id," +
            field +
            ") VALUES ($1,$2,$3,$4)",
          [id(4), id(1), id(2), value],
        );
      // Submitted after its content (a submitted Menu version is frozen, DEC-MENU-REVISION).
      await admin.query(
        `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
        [id(5), id(1), id(4), id(2), digest, id(6), id(7), at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
        [id(8), id(5), id(1), id(4), id(2), digest, at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.menu_release_effective_period
       (timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,period_digest,approval_evidence_id,created_at)
       VALUES ($1,$2,$3,$4,'UTC',$5,$6,$7,$5)`,
        [id(50), id(8), id(1), id(2), at, digest, id(7)],
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

      const scope = { brandReference: id(2), storeReference: id(20) };
      // A guest's request: its own connection, the pilot's limits, the restricted API role.
      const guestRunner = {
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query(`SET LOCAL ROLE ${role}`);
            await client.query("SET LOCAL lock_timeout='2s'");
            await client.query("SET LOCAL statement_timeout='5s'");
            const result = await action({ query: (sql, values) => client.query(sql, values) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const guestMenu = async () => {
        const started = Date.now();
        const candidates = await createPostgresPublishedMenuQueryStore(
          guestRunner,
          scope,
        ).loadCandidates({ ...scope, ...contextInput });
        return { candidates, elapsed: Date.now() - started };
      };
      const name = (candidates) =>
        candidates[0].snapshot.sections[0].sellables[0].localizedNames["en-CA"];
      const before = await guestMenu();
      assert.equal(before.candidates[0].generationReference, id(9));
      assert.equal(name(before.candidates), "Latte");

      // The owner publishes a revised menu: the Publish step's keys and the customer menu swap,
      // held open as long as a real review can take.
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [id(2)],
      );
      for (const key of [
        `CatalogMenuPublicationOperation:${id(2)}:${id(80)}`,
        `CatalogMenuPublication:${id(2)}:${id(1)}`,
        `PublishingFamily:${id(90)}:${id(2)}:Brand:${id(5)}`,
        `CatalogMenuReferenceV1:${id(2)}`,
        `catalog.published-menu:${id(2)}:${id(1)}`,
      ])
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      await holder.query(
        `INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Building',$4,5,$4,$5,'Fresh')`,
        [id(70), id(2), id(1), id(71), later],
      );
      await holder.query(
        `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["DINE_IN"]'::jsonb,'["TABLE_SERVICE"]'::jsonb,'UTC',$7)`,
        [id(70), id(2), id(1), id(4), id(8), digest, at, JSON.stringify([id(20)])],
      );
      await holder.query(
        `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}'::jsonb,0)`,
        [id(70), id(2), id(1), id(11)],
      );
      await holder.query(
        `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Flat white"}'::jsonb,'Standard',0,false,'Available','[]'::jsonb,$8::jsonb)`,
        [id(70), id(2), id(1), id(11), id(12), id(13), id(14), disclosure],
      );
      await holder.query(
        "UPDATE rms_catalog.published_menu_projection_generation SET generation_status='Retired' WHERE brand_id=$1 AND menu_id=$2 AND generation_status='Active'",
        [id(2), id(1)],
      );
      await holder.query(
        "UPDATE rms_catalog.published_menu_projection_generation SET generation_status='Active' WHERE brand_id=$1 AND menu_id=$2 AND generation_id=$3 AND generation_status='Building'",
        [id(2), id(1), id(70)],
      );
      await holder.query(
        "INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES('catalog.published-menu-projection',$1,$2,$3,$4,5,$5) ON CONFLICT (consumer_name,brand_id,menu_id) DO UPDATE SET active_generation_id=EXCLUDED.active_generation_id,source_event_id=EXCLUDED.source_event_id,source_aggregate_version=EXCLUDED.source_aggregate_version,projected_at=EXCLUDED.projected_at",
        [id(2), id(1), id(70), id(71), later],
      );

      // Guests keep reading the menu meanwhile: no wait, the whole old menu.
      const waiters = async () =>
        (await admin.query("SELECT count(*)::int n FROM pg_locks WHERE NOT granted")).rows[0].n;
      const during = await Promise.all([guestMenu(), guestMenu(), guestMenu()]);
      for (const read of during) {
        assert.equal(read.candidates[0].generationReference, id(9));
        assert.equal(name(read.candidates), "Latte");
        assert.ok(read.elapsed < 1500, `a guest waited ${read.elapsed} ms for the publish`);
      }
      assert.equal(await waiters(), 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await holder.query("COMMIT");

      // After the commit every guest sees the whole new menu, in one step.
      const after = await guestMenu();
      assert.equal(after.candidates[0].generationReference, id(70));
      assert.equal(name(after.candidates), "Flat white");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await admin.end();
    }
  });
}, 180_000);
