import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresCurrentSelectionFactsStore,
  createPostgresCatalogSelectionService,
  createPostgresCatalogOrderSnapshotSource,
} from "../../rms/catalog/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-02T16:00:00.000Z";
const digest = "sha256:" + "a".repeat(64);
it("joins actual published membership and current owner facts in one repeatable read", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_facts" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_facts_" + context.runId;
    let active = 0;
    const tables = [
      "availability_rule",
      "menu_publication_revision",
      "menu_publication_release",
      "menu_release_effective_period",
      "menu_version_store",
      "menu_version_channel",
      "menu_version_order_type",
      "published_menu_projection_generation",
      "published_menu_projection",
      "published_menu_projection_section",
      "published_menu_projection_sellable",
      "published_menu_projection_checkpoint",
      "product",
      "product_version",
      "sku",
      "option_set",
      "option_set_version",
      "option",
      "option_conflict",
      "product_option_binding",
      "product_option_binding_option",
      "product_option_binding_sku_scope",
      "product_option_binding_channel",
    ];
    let isolation = "REPEATABLE READ",
      afterProjection = null,
      transactions = 0;
    const runner = {
      async run(action) {
        const client = new Client(context.clientConfig);
        await client.connect();
        active++;
        transactions++;
        try {
          await client.query("BEGIN ISOLATION LEVEL " + isolation + " READ ONLY");
          await client.query("SET LOCAL ROLE " + role);
          assert.equal(
            (
              await client.query(
                "SELECT count(*)::int AS n FROM rms_catalog.menu_publication_release",
              )
            ).rows[0].n,
            0,
          );
          const result = await action({
            query: async (sql, values) => {
              const result = await client.query(sql, values);
              if (
                afterProjection &&
                sql.includes("FROM rms_catalog.published_menu_projection_checkpoint")
              ) {
                const hook = afterProjection;
                afterProjection = null;
                await hook();
              }
              return result;
            },
          });
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
        `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["CUSTOMER_PWA"]'::jsonb,'["PICKUP"]'::jsonb,'UTC',$7)`,
        [id(9), id(2), id(1), id(4), id(8), digest, at, JSON.stringify([id(20)])],
      );
      await admin.query(
        `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}'::jsonb,0)`,
        [id(9), id(2), id(1), id(11)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Latte"}'::jsonb,'Standard',0,false,'Available',$8::jsonb,'{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}'::jsonb)`,
        [id(9), id(2), id(1), id(11), id(12), id(13), id(14), JSON.stringify([])],
      );
      await admin.query(
        `INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES ('catalog.published-menu-projection',$1,$2,$3,$4,4,$5)`,
        [id(2), id(1), id(9), id(10), at],
      );

      await admin.query(
        "INSERT INTO rms_catalog.menu_release_effective_period(timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES($1,$2,$3,$4,'UTC',$5,NULL,$6,$7,$5)",
        [id(50), id(8), id(1), id(2), at, digest, id(7)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version_store(menu_version_id,menu_id,brand_id,store_id) VALUES($1,$2,$3,$4)",
        [id(4), id(1), id(2), id(20)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version_channel(menu_version_id,menu_id,brand_id,channel_code) VALUES($1,$2,$3,'CUSTOMER_PWA')",
        [id(4), id(1), id(2)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.menu_version_order_type(menu_version_id,menu_id,brand_id,order_type_code) VALUES($1,$2,$3,'PICKUP')",
        [id(4), id(1), id(2)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC','PreparedFood','Active',1,$3,$4,$3)",
        [id(40), id(2), at, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
        [id(14), id(40), id(2), JSON.stringify({ "en-CA": "Synthetic product" }), at],
      );
      await admin.query(
        "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC','Active',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)",
        [
          id(13),
          id(40),
          id(2),
          id(14),
          JSON.stringify({ "en-CA": "Synthetic SKU" }),
          digest,
          at,
          id(3),
        ],
      );
      await admin.query(
        "CREATE ROLE " +
          role +
          " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
      );
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON " + tables.map((t) => "rms_catalog." + t).join(",") + " TO " + role,
      );
      const scope = { brandReference: id(2), storeReference: id(20) };
      const facts = createPostgresCurrentSelectionFactsStore(runner, scope);
      const input = {
        ...scope,
        sourceChannel: "Web",
        orderType: "Pickup",
        sellableReference: id(13),
        observedAt: at,
        menuReference: id(1),
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
      };
      const first = await facts.load(input);
      assert.equal(first.sku.productVersionReference, id(14));
      assert.deepEqual(first.bindings, []);
      assert.equal(transactions, 1);

      let inventoryStatus = "Available",
        killStatus = "Clear",
        missingInventory = false;
      const safety = (request, kind, status) => ({
        kind,
        brandReference: request.brandReference,
        storeReference: request.storeReference,
        sellableReference: request.sellableReference,
        status,
        observedAt: request.observedAt,
        expiresAt: "2026-08-02T16:01:00.000Z",
        reasonCode: "SYNTHETIC_SAFETY",
      });
      const safetyPorts = {
        clock: { now: () => at },
        killSwitch: {
          async loadEvidence(request) {
            return safety(request, "KillSwitch", killStatus);
          },
        },
        inventory: {
          async loadEvidence(request) {
            return missingInventory ? null : safety(request, "Inventory", inventoryStatus);
          },
        },
      };
      const selection = createPostgresCatalogSelectionService(
        runner,
        {
          ...scope,
          menuReference: id(1),
          sourceChannel: "Web",
          orderType: "Pickup",
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "PICKUP",
        },
        safetyPorts,
      );
      const request = {
        ...scope,
        sourceChannel: "Web",
        orderType: "Pickup",
        sellableReference: id(13),
        observedAt: at,
        optionSelections: [],
      };

      assert.equal((await selection.validateSelection(request)).status, "Rejected");
      await admin.query(
        "INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_RULE',1,'Active',$3,$4,'[\"CUSTOMER_PWA\"]'::jsonb,'[\"PICKUP\"]'::jsonb,$5,NULL,'Available',10,'SYNTHETIC_AVAILABLE',$5,$6,$5)",
        [id(60), id(2), id(13), id(20), at, id(3)],
      );
      assert.equal((await selection.validateSelection(request)).status, "Accepted");
      let snapshotReferences = 0;
      const snapshots = createPostgresCatalogOrderSnapshotSource(
        runner,
        {
          ...scope,
          menuReference: id(1),
          sourceChannel: "Web",
          orderType: "Pickup",
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "PICKUP",
        },
        safetyPorts,
        {
          generate: () => {
            snapshotReferences++;
            return id(70);
          },
          hash: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        },
      );
      assert.equal(
        await snapshots.capture(request),
        null,
        "missing tax classification must not default",
      );
      assert.equal(snapshotReferences, 0);
      await admin.query(
        "UPDATE rms_catalog.product_version SET tax_classification_id=$1 WHERE product_version_id=$2",
        [id(71), id(14)],
      );
      const snapshot = await snapshots.capture(request);
      assert(snapshot);
      assert.deepEqual(snapshot.localizedNames, { "en-CA": "Latte" });
      assert.equal(snapshot.productReference, id(40));
      assert.equal(snapshot.skuReference, id(13));
      assert.equal(snapshot.taxClassificationReference, id(71));
      assert.equal(snapshot.unitQuantity, "1");
      assert.deepEqual(snapshot.options, []);
      assert.equal(snapshot.capturedAt, at);
      const { snapshotDigest, ...body } = snapshot;
      assert.equal(
        snapshotDigest,
        "sha256:" + createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      );
      assert.equal(
        await snapshots.capture({
          ...request,
          optionSelections: [{ optionReference: id(99), quantity: 1 }],
        }),
        null,
      );
      assert.equal(snapshotReferences, 1);
      for (const mode of ["missing", "inventory", "kill"]) {
        missingInventory = mode === "missing";
        inventoryStatus = mode === "inventory" ? "Unavailable" : "Available";
        killStatus = mode === "kill" ? "Blocked" : "Clear";
        assert.equal((await selection.validateSelection(request)).status, "Rejected");
        assert.equal(await snapshots.capture(request), null);
      }
      missingInventory = false;
      inventoryStatus = "Available";
      killStatus = "Clear";
      await admin.query(
        "UPDATE rms_catalog.availability_rule SET decision='Unavailable',aggregate_version=2 WHERE availability_rule_id=$1",
        [id(60)],
      );
      assert.equal((await selection.validateSelection(request)).status, "Rejected");
      await admin.query(
        "UPDATE rms_catalog.availability_rule SET decision='Available',aggregate_version=3 WHERE availability_rule_id=$1",
        [id(60)],
      );
      assert.equal((await selection.validateSelection(request)).status, "Accepted");

      assert.equal(await facts.load({ ...input, storeReference: id(99) }), null);
      assert.equal(await facts.load({ ...input, sellableReference: id(99) }), null);
      await admin.query(
        "UPDATE rms_catalog.published_menu_projection_generation SET freshness_status='Stale' WHERE generation_id=$1",
        [id(9)],
      );
      assert.equal(await facts.load(input), null);
      await admin.query(
        "UPDATE rms_catalog.published_menu_projection_generation SET freshness_status='Fresh' WHERE generation_id=$1",
        [id(9)],
      );
      afterProjection = async () => {
        await admin.query("UPDATE rms_catalog.sku SET lifecycle='Archived' WHERE sku_id=$1", [
          id(13),
        ]);
      };
      assert.equal((await facts.load(input)).sku.catalogEligible, true);
      assert.equal(await facts.load(input), null);
      assert.equal((await selection.validateSelection(request)).status, "Rejected");
      assert.equal(await snapshots.capture(request), null);
      assert.equal(snapshotReferences, 1);
      isolation = "READ COMMITTED";
      await assert.rejects(facts.load(input), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
