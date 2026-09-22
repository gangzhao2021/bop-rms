import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresCurrentOptionBindingsStore,
  createPostgresMenuReviewOptionSource,
  buildReviewedMenuOptionRules,
  parseReviewedMenuContent,
  resolveCurrentCatalogSelectionRules,
  createCatalogSelectionValidationService,
} from "../../rms/catalog/src/index.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-01T14:00:00.000Z";
const names = JSON.stringify({ "en-CA": "Synthetic" });
it("reads complete current option bindings with exact SKU/channel applicability and source validation", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_option_source" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_options_" + context.runId;
    let active = 0;
    const tables = [
      "sku",
      "product_version",
      "option_set",
      "option_set_version",
      "option",
      "option_conflict",
      "product_option_binding",
      "product_option_binding_option",
      "product_option_binding_sku_scope",
      "product_option_binding_channel",
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
            (await client.query("SELECT count(*)::int AS n FROM rms_catalog.option_set")).rows[0].n,
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
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON " + tables.map((t) => "rms_catalog." + t).join(",") + " TO " + role,
      );
      await admin.query(
        `INSERT INTO rms_catalog.option_set
       (option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'MILK','Draft',1,$3,$4,$3)`,
        [id(1), id(2), at, id(3)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.option_set_version
       (option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,
        localized_descriptions_json,display_style,minimum_selection,maximum_selection,
        allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'SingleChoice',1,1,false,1,1,$5,$5)`,
        [id(4), id(1), id(2), names, at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.option
       (option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,
        localized_names_json,localized_descriptions_json,sort_order,default_eligible,
        created_at,created_by_actor_id)
       VALUES
       ($1,$2,$3,$4,'WHOLE','Draft',$5::jsonb,'{}'::jsonb,0,true,$6,$7),
       ($8,$2,$3,$4,'OAT','Draft',$5::jsonb,'{}'::jsonb,1,true,$6,$7)`,
        [id(5), id(4), id(1), id(2), names, at, id(3), id(6)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.option_conflict (option_id,conflict_option_id,option_set_id,brand_id)
       VALUES ($1,$2,$3,$4)`,
        [id(5), id(6), id(1), id(2)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.product
       (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'LATTE','PreparedFood','Draft',1,$3,$4,$3)`,
        [id(10), id(2), at, id(3)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.product_version
       (product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)`,
        [id(11), id(10), id(2), names, at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.sku
       (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,
        variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id)
       VALUES ($1,$2,$3,$4,'LATTE-EACH','Draft',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)`,
        [id(12), id(10), id(2), id(11), names, `sha256:${"a".repeat(64)}`, at, id(3)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.product_option_binding
       (binding_id,product_version_id,product_id,brand_id,option_set_id,option_set_version_id,
        purpose,sort_order,minimum_selection_override,maximum_selection_override,store_override_allowed)
       VALUES ($1,$2,$3,$4,$5,$6,'MILK',0,1,1,false)`,
        [id(13), id(11), id(10), id(2), id(1), id(4)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.product_option_binding_option
       (binding_id,product_id,brand_id,option_id,option_set_id,default_quantity)
       VALUES ($1,$2,$3,$4,$5,1)`,
        [id(13), id(10), id(2), id(5), id(1)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.product_option_binding_sku_scope
       (binding_id,product_id,brand_id,sku_id,scope_kind)
       VALUES ($1,$2,$3,$4,'Include')`,
        [id(13), id(10), id(2), id(12)],
      );

      const store = createPostgresCurrentOptionBindingsStore(runner, { brandReference: id(2) });
      const input = {
        sellableReference: id(12),
        productVersionReference: id(11),
        channelCode: "CUSTOMER_PWA",
        observedAt: at,
      };
      const source = await store.load(input);
      assert.equal(source.bindings.length, 1);
      const { binding, optionSet } = source.bindings[0];
      assert.equal(binding.bindingReference, id(13));
      assert.deepEqual(binding.defaultSelections, [{ optionReference: id(5), quantity: 1 }]);
      assert.deepEqual(binding.enabledOptionReferences, [id(5)]);
      assert.deepEqual(binding.includedSkuReferences, [id(12)]);
      assert.equal(optionSet.draft.versionReference, id(4));
      assert.equal(optionSet.draft.minimumSelection, 1);
      assert.equal(optionSet.draft.maximumSelection, 1);
      assert.equal(optionSet.draft.maximumTotalQuantity, 1);
      assert.equal(optionSet.draft.allowRepeatedOption, false);
      assert.equal(optionSet.draft.perOptionMaximumQuantity, 1);
      assert.deepEqual(optionSet.draft.options[0].conflictOptionReferences, [id(6)]);
      assert.equal(optionSet.draft.options[0].lifecycle, "Draft");
      assert.equal(optionSet.draft.options[1].triggeredOptionSetReference, null);
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Active' WHERE option_set_id=$1", [
        id(1),
      ]);
      const actualRules = resolveCurrentCatalogSelectionRules((await store.load(input)).bindings);
      await admin.query(
        "GRANT UPDATE ON " +
          tables.map((table) => "rms_catalog." + table).join(",") +
          " TO " +
          role,
      );
      const reviewRun = async (work) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        active++;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
          active--;
        }
      };
      const reviewInput = {
        sellableReference: id(12),
        productVersionReference: id(11),
        channelCodes: ["POS", "CUSTOMER_PWA"],
        observedAt: at,
      };
      const reviewOptions = createPostgresMenuReviewOptionSource({
        brandReference: id(2),
        authorize: async () => true,
      });
      const reviewed = await reviewRun((tx) => reviewOptions(tx, reviewInput));
      assert.deepEqual(
        reviewed.channels.map((channel) => channel.channelCode),
        ["CUSTOMER_PWA", "POS"],
      );
      assert.deepEqual(reviewed.channels[0].rules, actualRules);
      assert.deepEqual(reviewed.channels[0].bindings[0].binding.defaultSelections, [
        { optionReference: id(5), quantity: 1 },
      ]);
      assert.deepEqual(
        reviewed.channels[0].bindings[0].optionSet.draft.options[0].conflictOptionReferences,
        [id(6)],
      );
      assert.equal(reviewed.productReference, id(10));
      const later = await reviewRun((tx) =>
        reviewOptions(tx, {
          ...reviewInput,
          channelCodes: ["CUSTOMER_PWA", "POS"],
          observedAt: "2026-08-01T14:00:01.000Z",
        }),
      );
      assert.equal(later.sourceDigest, reviewed.sourceDigest);
      for (const invalid of [
        { channelCodes: [] },
        { channelCodes: ["POS", "POS"] },
        { sellableReference: id(99) },
        { productVersionReference: id(99) },
      ])
        await assert.rejects(reviewRun((tx) => reviewOptions(tx, { ...reviewInput, ...invalid })));
      await assert.rejects(
        reviewRun((tx) =>
          createPostgresMenuReviewOptionSource({
            brandReference: id(99),
            authorize: async () => true,
          })(tx, reviewInput),
        ),
      );
      let permissionCalls = 0;
      await assert.rejects(
        reviewRun((tx) =>
          createPostgresMenuReviewOptionSource({
            brandReference: id(2),
            authorize: async () => ++permissionCalls === 1,
          })(tx, reviewInput),
        ),
        { code: "CATALOG_PERMISSION_DENIED" },
      );

      const selection = createCatalogSelectionValidationService({
        snapshots: {
          resolveCurrent: async ({ observedAt, ...request }) => ({
            ...request,
            availability: "Available",
            freshnessStatus: "Fresh",
            menuVersionReference: id(90),
            productVersionReference: id(11),
            catalogChannelCode: "CUSTOMER_PWA",
            catalogOrderTypeCode: "PICKUP",
            effectiveFrom: at,
            effectiveUntil: null,
            resolvedAt: observedAt,
            rules: actualRules,
          }),
        },
      });
      const selectionInput = {
        brandReference: id(2),
        storeReference: id(99),
        sourceChannel: "Web",
        orderType: "Pickup",
        sellableReference: id(12),
        observedAt: at,
      };
      assert.equal(
        (
          await selection.validateSelection({
            ...selectionInput,
            optionSelections: [{ optionReference: id(5), quantity: 1 }],
          })
        ).status,
        "Accepted",
      );
      assert.equal(
        (await selection.validateSelection({ ...selectionInput, optionSelections: [] })).reason,
        "RULE_UNSATISFIED",
      );
      assert.equal(
        (
          await selection.validateSelection({
            ...selectionInput,
            optionSelections: [{ optionReference: id(6), quantity: 1 }],
          })
        ).reason,
        "OPTION_NOT_ENABLED",
      );

      for (const change of [
        { sellableReference: id(99) },
        { productVersionReference: id(99) },
        { observedAt: "2026-08-01T13:59:59.999Z" },
      ])
        assert.equal(await store.load({ ...input, ...change }), null);
      assert.equal(
        await createPostgresCurrentOptionBindingsStore(runner, { brandReference: id(99) }).load(
          input,
        ),
        null,
      );
      await assert.rejects(store.load({ ...input, brandReference: id(99) }), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      await admin.query(
        "INSERT INTO rms_catalog.product_option_binding_channel(binding_id,product_id,brand_id,channel_code) VALUES($1,$2,$3,'CUSTOMER_PWA')",
        [id(13), id(10), id(2)],
      );
      assert.equal((await store.load({ ...input, channelCode: "POS" })).bindings.length, 0);
      assert.equal((await store.load(input)).bindings.length, 1);
      const filtered = await reviewRun((tx) => reviewOptions(tx, reviewInput));
      assert.notEqual(filtered.sourceDigest, reviewed.sourceDigest);
      assert.equal(filtered.channels[0].bindings.length, 1);
      assert.equal(filtered.channels[1].bindings.length, 0);
      assert.equal(filtered.channels[1].rules.length, 0);
      await admin.query(
        "UPDATE rms_catalog.product_option_binding_sku_scope SET scope_kind='Exclude' WHERE binding_id=$1",
        [id(13)],
      );
      assert.equal((await store.load(input)).bindings.length, 0);
      await admin.query(
        "UPDATE rms_catalog.product_option_binding_sku_scope SET scope_kind='Include' WHERE binding_id=$1",
        [id(13)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'TRIGGER_TARGET','Draft',1,$3,$4,$3)",
        [id(30), id(2), at, id(3)],
      );
      await admin.query(
        "UPDATE rms_catalog.option SET triggered_option_set_id=$2 WHERE option_id=$1",
        [id(6), id(30)],
      );
      assert.equal(
        (await store.load(input)).bindings[0].optionSet.draft.options[1]
          .triggeredOptionSetReference,
        id(30),
      );
      await admin.query(
        "UPDATE rms_catalog.option_set_version SET allow_repeated_option=true,per_option_maximum_quantity=3,maximum_selection=2,maximum_total_quantity=6 WHERE option_set_version_id=$1",
        [id(4)],
      );
      const quantity = (await store.load(input)).bindings[0].optionSet.draft;
      assert.equal(quantity.allowRepeatedOption, true);
      assert.equal(quantity.perOptionMaximumQuantity, 3);
      assert.equal(quantity.maximumTotalQuantity, 6);
      assert.equal(quantity.maximumSelection, 2);
      await admin.query(
        "UPDATE rms_catalog.product_option_binding SET maximum_selection_override=2 WHERE binding_id=$1",
        [id(13)],
      );
      await admin.query(
        "UPDATE rms_catalog.product_option_binding_option SET default_quantity=2 WHERE binding_id=$1",
        [id(13)],
      );
      const repeated = await reviewRun((tx) => reviewOptions(tx, reviewInput));
      assert.notEqual(repeated.sourceDigest, filtered.sourceDigest);
      const repeatedChannel = repeated.channels[0];
      assert.equal(repeatedChannel.bindings[0].binding.defaultSelections[0].quantity, 2);
      assert.equal(repeatedChannel.bindings[0].optionSet.draft.perOptionMaximumQuantity, 3);
      assert.equal(repeatedChannel.bindings[0].optionSet.draft.maximumTotalQuantity, 6);
      assert.equal(
        repeatedChannel.bindings[0].optionSet.draft.options[1].triggeredOptionSetReference,
        id(30),
      );
      assert.equal(repeatedChannel.rules[0].maximumQuantity, 2);
      assert.equal(repeatedChannel.rules[0].options[0].maximumQuantity, 2);
      const publishedRules = buildReviewedMenuOptionRules(repeated.channels, "en-CA");
      const content = parseReviewedMenuContent({
        brandReference: id(2),
        menuReference: id(90),
        menuVersionReference: id(91),
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic Menu" },
        storeReferences: [],
        channelCodes: ["CUSTOMER_PWA", "POS"],
        orderTypeCodes: ["PICKUP"],
        sections: [
          {
            sectionReference: id(92),
            internalCode: "SECTION",
            localizedNames: { "en-CA": "Options" },
            sortOrder: 0,
            sellables: [
              {
                placementReference: id(93),
                sellableReference: id(12),
                productVersionReference: id(11),
                localizedNames: { "en-CA": "Synthetic" },
                presentationRole: "Standard",
                sortOrder: 0,
                pinned: false,
                configuredAvailability: "Available",
                optionRules: publishedRules,
                allergenDisclosure: {
                  registryVersionReference: id(94),
                  items: [],
                  allergenFreeClaim: false,
                  assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
                },
              },
            ],
          },
        ],
      });
      assert.equal(content.sections[0].sellables[0].optionRules[0].options[0].defaultQuantity, 2);
      assert.equal(content.sections[0].sellables[0].optionRules[0].maximumSelections, 2);
      assert.deepEqual(content.sections[0].sellables[0].optionRules[0].channelCodes, [
        "CUSTOMER_PWA",
      ]);

      await admin.query(
        "UPDATE rms_catalog.option_set SET lifecycle='Archived',aggregate_version=2 WHERE option_set_id=$1",
        [id(1)],
      );
      assert.equal((await store.load(input)).bindings[0].optionSet.lifecycle, "Archived");
      await admin.query(
        "UPDATE rms_catalog.option_set SET updated_at=$2,aggregate_version=3 WHERE option_set_id=$1",
        [id(1), "2026-08-01T14:01:00.000Z"],
      );
      await assert.rejects(store.load(input), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      await admin.query(
        "UPDATE rms_catalog.option_set SET updated_at=$2,aggregate_version=4 WHERE option_set_id=$1",
        [id(1), at],
      );
      await admin.query(
        "UPDATE rms_catalog.option_set SET updated_at=$2,aggregate_version=5 WHERE option_set_id=$1",
        [id(1), "2026-08-01T14:00:00.000001Z"],
      );
      await assert.rejects(store.load(input), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      await admin.query(
        "UPDATE rms_catalog.option_set SET updated_at=$2,aggregate_version=6 WHERE option_set_id=$1",
        [id(1), at],
      );
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Archived' WHERE option_id=$1", [
        id(5),
      ]);
      await assert.rejects(store.load(input), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.equal(active, 0);
    } finally {
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
