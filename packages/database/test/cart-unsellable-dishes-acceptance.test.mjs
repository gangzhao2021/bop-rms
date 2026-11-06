import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import {
  createPostgresCatalogLineStandingSource,
  createPostgresCatalogSelectionService,
  createPostgresCurrentOptionBindingsStore,
} from "../../rms/catalog/src/index.ts";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
const { Client } = pg;
const id = (n) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-11-06T16:00:00.000Z";
const minute = (n) => new Date(Date.parse(at) + n * 60_000).toISOString();
const digest = "sha256:" + "b".repeat(64);
const brand = id(2),
  store = id(20),
  sku = id(13),
  hot = id(31),
  iced = id(32),
  binding = id(35);

/**
 * WP-2423 (cart-unsellable-dishes): Soy milk, "Serve" choose one of Hot (the default) or Iced.
 * Staff hide the dish, or untick Offer Hot under Option sets: the guest's cart, quote and menu are
 * told which dish or choice can't be had now, line by line, never a Catalog outage for the cart.
 * Synthetic isolated Catalog rows; every read runs as the pilot api role (rendered pilot ACL) in a
 * Repeatable Read, read-only transaction with the Store selected, as the customer runtime does.
 */
it("WP-2423 (cart-unsellable-dishes): a hidden dish or a default choice turned off is named per line, never a cart outage", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_unsellable" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_us_" + context.runId,
      worker = "wp2423_us_w_" + context.runId;
    let active = 0;
    const readRunner = {
      async run(action) {
        const client = new Client(context.clientConfig);
        await client.connect();
        active++;
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await client.query("SET LOCAL ROLE " + api);
          await client.query("SET LOCAL statement_timeout='5s'");
          await client.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } finally {
          await client.query("ROLLBACK");
          await client.end();
          active--;
        }
      },
    };
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));
      await seed(admin);
      const now = minute(10);
      const safety = {
        clock: { now: () => now },
        killSwitch: {
          loadEvidence: async (request) => ({
            kind: "KillSwitch",
            ...pick(request),
            status: "Clear",
            observedAt: request.observedAt,
            expiresAt: minute(1000),
            reasonCode: "SYNTHETIC_SAFETY",
          }),
        },
        inventory: {
          loadEvidence: async (request) => ({
            kind: "Inventory",
            ...pick(request),
            status: "Available",
            observedAt: request.observedAt,
            expiresAt: minute(1000),
            reasonCode: "SYNTHETIC_STOCK",
          }),
        },
      };
      const scope = {
        brandReference: brand,
        storeReference: store,
        menuReference: id(1),
        sourceChannel: "Qr",
        orderType: "Pickup",
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
      };
      const selection = createPostgresCatalogSelectionService(readRunner, scope, safety);
      const standing = createPostgresCatalogLineStandingSource(readRunner, scope, safety);
      const line = (option) => ({
        brandReference: brand,
        storeReference: store,
        sourceChannel: "Qr",
        orderType: "Pickup",
        sellableReference: sku,
        optionSelections: option === null ? [] : [{ optionReference: option, quantity: 1 }],
        observedAt: now,
      });
      const validate = async (option) => (await selection.validateSelection(line(option))).status;

      // Ordinary: both choices sell.
      assert.equal(await validate(hot), "Accepted");
      assert.equal(await validate(iced), "Accepted");
      assert.deepEqual(await standing.explainMany([line(hot), line(iced)]), [
        "Available",
        "Available",
      ]);

      // Staff hide the dish (StopOffering deactivates its Store rule): not available, named.
      await admin.query(
        "UPDATE rms_catalog.availability_rule SET lifecycle='Inactive' WHERE availability_rule_id=$1",
        [id(60)],
      );
      assert.deepEqual(await standing.explainMany([line(hot)]), ["Unavailable"]);
      await admin.query(
        "UPDATE rms_catalog.availability_rule SET lifecycle='Active' WHERE availability_rule_id=$1",
        [id(60)],
      );
      assert.deepEqual(await standing.explainMany([line(hot)]), ["Available"]);

      // Untick Offer Hot (as Option sets Save writes it): the stored default is now off.
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Inactive' WHERE option_id=$1", [
        hot,
      ]);
      // Iced still sells; Hot is refused as a choice; the cart explains each line on its own.
      assert.equal(await validate(iced), "Accepted");
      assert.deepEqual(await selection.validateSelection(line(hot)), {
        status: "Rejected",
        reason: "OPTION_NOT_ENABLED",
      });
      assert.deepEqual(await standing.explainMany([line(hot), line(iced)]), [
        "OptionsChanged",
        "Available",
      ]);
      // List it's read (Listing rules) still names the default that is off; selling reads it.
      const bindingInput = {
        sellableReference: sku,
        productVersionReference: id(14),
        channelCode: "CUSTOMER_PWA",
        observedAt: now,
      };
      await assert.rejects(
        createPostgresCurrentOptionBindingsStore(readRunner, { brandReference: brand }).load(
          bindingInput,
        ),
        { name: "OptionBindingSourceError", rule: "DefaultUnavailable" },
      );
      const sale = await createPostgresCurrentOptionBindingsStore(readRunner, {
        brandReference: brand,
        rules: "Sale",
      }).load(bindingInput);
      assert.equal(sale.bindings.length, 1);
      assert.deepEqual(sale.bindings[0].binding.defaultSelections, [
        { optionReference: hot, quantity: 1 },
      ]);

      // The guest menu (Store selected) marks Hot as not offered now.
      const facts = await createCustomerMenuStoreFacts({
        transactions: readRunner,
        currencyMetadata: {
          currencyCode: "CAD",
          minorUnitExponent: 2,
          metadataVersion: 1,
          metadataVersionReference: id(90),
          metadataDigest: digest,
        },
        priceChannelCode: "CUSTOMER_WEB",
      }).load({
        brandReference: brand,
        storeReference: store,
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
        requestedAt: now,
        sellableReferences: [sku],
        options: [
          { sellableReference: sku, bindingReference: binding, optionReference: hot },
          { sellableReference: sku, bindingReference: binding, optionReference: iced },
        ],
      });
      assert.deepEqual([...(facts.get(sku)?.notOfferedOptions ?? [])], [hot]);
      assert.equal(facts.get(sku)?.availability, "Available");

      // Both choices off: the required group has nothing to choose, so the dish can't be had now.
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Inactive' WHERE option_id=$1", [
        iced,
      ]);
      assert.deepEqual(await standing.explainMany([line(iced)]), ["Unavailable"]);
      assert.deepEqual(await selection.validateSelection(line(null)), {
        status: "Rejected",
        reason: "RULE_UNSATISFIED",
      });

      // A choice the dish offers was removed for good (archived): that line's setup is broken.
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Active' WHERE option_id=$1", [
        hot,
      ]);
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Archived' WHERE option_id=$1", [
        iced,
      ]);
      assert.deepEqual(await standing.explainMany([line(hot)]), ["SetupIncomplete"]);

      // Reading wrote nothing.
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_catalog.availability_rule")).rows[0]
          .n,
        1,
      );
      assert.equal(active, 0);
    } finally {
      await admin.query("RESET ROLE");
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

const pick = (request) => ({
  brandReference: request.brandReference,
  storeReference: request.storeReference,
  sellableReference: request.sellableReference,
});

/** One published menu offering Soy milk with its "Serve" choice group (synthetic rows). */
async function seed(admin) {
  const q = (sql, values) => admin.query(sql, values);
  const names = (en) => JSON.stringify({ "en-CA": en });
  await q(
    `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
    [id(1), brand, at, id(3)],
  );
  await q(
    `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
    [id(4), id(1), brand, at],
  );
  await q(
    "INSERT INTO rms_catalog.menu_version_store(menu_version_id,menu_id,brand_id,store_id) VALUES($1,$2,$3,$4)",
    [id(4), id(1), brand, store],
  );
  await q(
    "INSERT INTO rms_catalog.menu_version_channel(menu_version_id,menu_id,brand_id,channel_code) VALUES($1,$2,$3,'CUSTOMER_PWA')",
    [id(4), id(1), brand],
  );
  await q(
    "INSERT INTO rms_catalog.menu_version_order_type(menu_version_id,menu_id,brand_id,order_type_code) VALUES($1,$2,$3,'PICKUP')",
    [id(4), id(1), brand],
  );
  await q(
    `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
    [id(5), id(1), id(4), brand, digest, id(6), id(7), at],
  );
  await q(
    `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
    [id(8), id(5), id(1), id(4), brand, digest, at],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,4,$4,$5,'Fresh')`,
    [id(9), brand, id(1), id(10), at],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["CUSTOMER_PWA"]'::jsonb,'["PICKUP"]'::jsonb,'UTC',$7)`,
    [id(9), brand, id(1), id(4), id(8), digest, at, JSON.stringify([store])],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}'::jsonb,0)`,
    [id(9), brand, id(1), id(11)],
  );
  const option = (reference, name, selectedByDefault) => ({
    optionReference: reference,
    localizedNames: { "en-CA": name },
    maximumQuantity: 1,
    conflictOptionReferences: [],
    selectedByDefault,
  });
  const rules = [
    {
      localizedNames: { "en-CA": "Serve" },
      bindingReference: binding,
      optionSetVersionReference: id(34),
      minimumSelections: 1,
      maximumSelections: 1,
      enabledOptionReferences: [hot, iced],
      defaultOptionReferences: [hot],
      options: [option(hot, "Hot", true), option(iced, "Iced", false)],
    },
  ];
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Soy milk"}'::jsonb,'Standard',0,false,'Available',$8::jsonb,'{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}'::jsonb)`,
    [id(9), brand, id(1), id(11), id(12), sku, id(14), JSON.stringify(rules)],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES ('catalog.published-menu-projection',$1,$2,$3,$4,4,$5)`,
    [brand, id(1), id(9), id(10), at],
  );
  await q(
    "INSERT INTO rms_catalog.menu_release_effective_period(timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES($1,$2,$3,$4,'UTC',$5,NULL,$6,$7,$5)",
    [id(50), id(8), id(1), brand, at, digest, id(7)],
  );
  await q(
    "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SOY_MILK','PreparedFood','Active',1,$3,$4,$3)",
    [id(40), brand, at, id(3)],
  );
  await q(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,tax_classification_id,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$6,$6)",
    [id(14), id(40), brand, names("Soy milk"), id(41), at],
  );
  await q(
    "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SOY_MILK','Active',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)",
    [sku, id(40), brand, id(14), names("Soy milk"), digest, at, id(3)],
  );
  await q(
    `INSERT INTO rms_catalog.option_set (option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'SERVE','Draft',1,$3,$4,$3)`,
    [id(33), brand, at, id(3)],
  );
  await q(
    `INSERT INTO rms_catalog.option_set_version (option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'SingleChoice',1,1,false,1,NULL,$5,$5)`,
    [id(34), id(33), brand, names("Serve"), at],
  );
  await q(
    `INSERT INTO rms_catalog.option (option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,localized_names_json,localized_descriptions_json,sort_order,default_eligible,created_at,created_by_actor_id) VALUES
     ($1,$2,$3,$4,'HOT','Active',$5::jsonb,'{}'::jsonb,0,true,$7,$8),
     ($9,$2,$3,$4,'ICED','Active',$6::jsonb,'{}'::jsonb,1,false,$7,$8)`,
    [hot, id(34), id(33), brand, names("Hot"), names("Iced"), at, id(3), iced],
  );
  await q(
    `INSERT INTO rms_catalog.product_option_binding (binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,purpose,sort_order,minimum_selection_override,maximum_selection_override,store_override_allowed) VALUES ($1,$2,$3,$4,$5,$6,'CUSTOMER_CHOICE',0,NULL,NULL,false)`,
    [binding, id(14), id(40), brand, id(33), id(34)],
  );
  await q(
    `INSERT INTO rms_catalog.product_option_binding_option (binding_id,product_id,brand_id,option_id,option_set_id,default_quantity) VALUES ($1,$2,$3,$4,$5,1),($1,$2,$3,$6,$5,NULL)`,
    [binding, id(40), brand, hot, id(33), iced],
  );
  // The Store offers the dish (a Store availability rule, as CAT-AVAILABILITY "Offer" creates).
  await q(
    "INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_OFFER',1,'Active',$3,$4,'[]'::jsonb,'[]'::jsonb,$5,NULL,'Available',100,'STORE_OFFERED',$5,$6,$5)",
    [id(60), brand, sku, store, at, id(3)],
  );
}
