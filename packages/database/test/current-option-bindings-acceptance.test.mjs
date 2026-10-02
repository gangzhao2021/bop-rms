import { createCurrentOptionSetDraftGraphSource } from "../../../apps/api/src/current-option-set-draft-graph.ts";
import { createMerchantProductEditorPinnedOptionAuthority } from "../../../apps/api/src/merchant-product-editor-pinned-option-authority.ts";
import { remainingProductEditorVariantReferenceChecks } from "../../../apps/api/src/merchant-product-editor-variant-content-authority.ts";
import { createCurrentProductCandidateOptionRuleSource } from "../../../apps/api/src/current-product-candidate-option-rules.ts";
import { createFrozenFullOptionBindingRuleSource } from "../../../apps/api/src/frozen-full-option-binding-rule-source.ts";
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
  parseCatalogOptionSetEditorContent,
  createPostgresFullOptionSetDraftStore,
  createPostgresFullOptionSetContentSealStore,
  fullOptionSealChecks,
  createPostgresCurrentFullOptionSetDraftStore,
  createPostgresFrozenFullOptionSetContentStore,
  createCatalogFullOptionSetPublicationMaterialization,
  parseCatalogFullOptionSetPublicationContent,
  CatalogError,
  productEditorContentFields,
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
      const activeSource = await store.load(input);
      const actualRules = resolveCurrentCatalogSelectionRules(activeSource.bindings);
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
      // Persisted disabled defaults must refuse even when another Active choice has capacity.
      await admin.query(
        `INSERT INTO rms_catalog.product_option_binding_option
         (binding_id,product_id,brand_id,option_id,option_set_id,default_quantity)
         VALUES ($1,$2,$3,$4,$5,NULL)`,
        [id(13), id(10), id(2), id(6), id(1)],
      );
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Inactive' WHERE option_id=$1", [
        id(5),
      ]);
      await assert.rejects(store.load(input), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      const draftBeforeRefusal = (
        await admin.query(
          "SELECT localized_names_json,updated_at FROM rms_catalog.product_version WHERE product_version_id=$1",
          [id(11)],
        )
      ).rows;
      let tentativeDraftWrites = 0;
      await assert.rejects(
        reviewRun(async (tx) => {
          await tx.query("SELECT set_config('bop.brand_id',$1,true)", [id(2)]);
          const changed = await tx.query(
            "UPDATE rms_catalog.product_version SET localized_names_json=$2::jsonb WHERE product_version_id=$1 RETURNING product_version_id",
            [id(11), JSON.stringify({ "en-CA": "Synthetic rejected review" })],
          );
          assert.equal(changed.rowCount, 1);
          tentativeDraftWrites++;
          return reviewOptions(tx, reviewInput);
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(tentativeDraftWrites, 1);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT localized_names_json,updated_at FROM rms_catalog.product_version WHERE product_version_id=$1",
            [id(11)],
          )
        ).rows,
        draftBeforeRefusal,
      );
      await admin.query("UPDATE rms_catalog.option SET lifecycle='Active' WHERE option_id=$1", [
        id(5),
      ]);
      await admin.query(
        "DELETE FROM rms_catalog.product_option_binding_option WHERE binding_id=$1 AND option_id=$2",
        [id(13), id(6)],
      );
      assert.deepEqual((await store.load(input)).bindings, activeSource.bindings);
      const recoveredReview = await reviewRun((tx) => reviewOptions(tx, reviewInput));
      assert.equal(recoveredReview.sourceDigest, reviewed.sourceDigest);
      assert.deepEqual(recoveredReview.channels, reviewed.channels);
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

it("preserves full Option Draft history with exact operation binding and Tenant/Brand storage isolation", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_option_full" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_full_option_" + context.runId;
    const tenant = id(800),
      brand = id(802),
      set = id(801),
      version = id(804),
      actor = id(803);
    const digest = "sha256:" + "a".repeat(64);
    const source = {
      optionSetReference: set,
      brandReference: brand,
      internalCode: "FULL_OPTION",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: actor,
      updatedAt: at,
      draft: {
        versionReference: version,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic full options" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection: 0,
        maximumSelection: 3,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 2,
        maximumTotalQuantity: 3,
        createdAt: at,
        updatedAt: at,
        options: [805, 806, 807].map((n) => ({
          optionReference: id(n),
          optionSetReference: set,
          brandReference: brand,
          stableCode: "CHOICE_" + n,
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: n - 805,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: actor,
        })),
      },
    };
    const details = {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [805, 806, 807].map((n) => ({
        optionReference: id(n),
        quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
        media: {
          mediaReference: id(810),
          assetReference: id(811),
          assetVersionReference: id(812),
          altText: { "en-CA": "Synthetic choice image" },
        },
        pricingRule: { reference: id(820), versionReference: id(821) },
        consumption: {
          kind: n === 805 ? "Inventory" : "Recipe",
          reference: id(830 + n),
          versionReference: id(840 + n),
          quantity: "0.125",
          unitCode: "GRAM",
        },
        triggeredOptionSetVersionReference: null,
      })),
      conditionalRules: [
        { ruleReference: id(850), whenAllSelected: [id(805)], requiredOptionReferences: [id(806)] },
      ],
      conflictRules: [{ ruleReference: id(851), forbiddenTogether: [id(805), id(807)] }],
      scopeSet: [
        { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    };
    const prepared = parseCatalogOptionSetEditorContent(source, details);
    const insertOperation = (tx, operation, revision = 1, action = "Create") =>
      tx.query(
        `INSERT INTO rms_catalog.option_set_operation_record
       (operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [operation, brand, set, action, digest, revision, at],
      );
    const insertSnapshot = (tx, operation, revision = 1, data = prepared, overrides = {}) => {
      const fields = {
        tenant,
        brand,
        set,
        version,
        action: revision === 1 ? "Create" : "ReplaceDraft",
        intent: digest,
        occurredAt: at,
        source: data.sourceDigest,
        body: data.contentDigest,
        config: data.configurationDigest,
        snapshot: data.content,
        ...overrides,
      };
      return tx.query(
        `INSERT INTO rms_catalog.option_set_draft_content_snapshot
       (operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,
        result_aggregate_version,occurred_at,source_digest,content_digest,configuration_digest,snapshot_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [
          operation,
          fields.tenant,
          fields.brand,
          fields.set,
          fields.version,
          fields.action,
          fields.intent,
          revision,
          fields.occurredAt,
          fields.source,
          fields.body,
          fields.config,
          JSON.stringify(fields.snapshot),
        ],
      );
    };
    async function scoped(settings, work) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        for (const [name, value] of Object.entries(settings))
          await client.query("SELECT set_config($1,$2,true)", ["bop." + name, value]);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    }
    const scope = { tenant_id: tenant, brand_id: brand };
    const table = "rms_catalog.option_set_draft_content_snapshot";
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON " + table + " TO " + role);
      await admin.query(
        `INSERT INTO rms_catalog.option_set
       (option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES($1,$2,'FULL_OPTION','Draft',1,$3,$4,$3)`,
        [set, brand, at, actor],
      );
      await admin.query(
        `INSERT INTO rms_catalog.option_set_version
       (option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,
        localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,
        per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at)
       VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'Quantity',0,3,true,2,3,$5,$5)`,
        [version, set, brand, JSON.stringify(source.draft.localizedNames), at],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT editor_content_json FROM rms_catalog.option_set_version WHERE option_set_version_id=$1",
            [version],
          )
        ).rows[0].editor_content_json,
        null,
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.option_set_version SET editor_content_json='{}'::jsonb WHERE option_set_version_id=$1",
          [version],
        ),
        { code: "23514" },
      );
      await admin.query(
        "UPDATE rms_catalog.option_set_version SET editor_content_json=$2::jsonb WHERE option_set_version_id=$1",
        [version, JSON.stringify(details)],
      );
      await insertOperation(admin, id(860));
      await scoped(scope, (tx) => insertSnapshot(tx, id(860)));
      const original = (await scoped(scope, (tx) => tx.query("SELECT * FROM " + table))).rows;
      assert.equal(original.length, 1);
      const stored = original[0];
      const { sourceAggregate, ...storedDetails } = stored.snapshot_json;
      const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, storedDetails);
      assert.deepEqual(parsed.content, prepared.content);
      assert.deepEqual(
        [parsed.sourceDigest, parsed.contentDigest, parsed.configurationDigest],
        [stored.source_digest, stored.content_digest, stored.configuration_digest],
      );
      assert.equal(parsed.referenceEligibility, "NotEvaluated");
      assert.equal(parsed.content.optionDetails[0].consumption.quantity, "0.125");
      for (const settings of [
        {},
        { brand_id: brand },
        { tenant_id: tenant },
        { tenant_id: id(899), brand_id: brand },
        { tenant_id: tenant, brand_id: id(898) },
        { ...scope, store_id: id(897) },
      ]) {
        assert.equal(
          (await scoped(settings, (tx) => tx.query("SELECT * FROM " + table))).rows.length,
          0,
        );
        await assert.rejects(
          scoped(settings, (tx) => insertSnapshot(tx, id(860))),
          { code: "42501" },
        );
      }
      await scoped(scope, async (tx) => {
        assert.equal(
          (
            await tx.query("UPDATE " + table + " SET content_digest=$1", [
              "sha256:" + "b".repeat(64),
            ])
          ).rowCount,
          0,
        );
        assert.equal((await tx.query("DELETE FROM " + table)).rowCount, 0);
      });
      const nextSource = { ...source, aggregateVersion: 2 };
      const next = parseCatalogOptionSetEditorContent(nextSource, details);
      let operationNumber = 861;
      for (const [overrides, code] of [
        [{ action: "Create" }, "23503"],
        [{ intent: "sha256:" + "b".repeat(64) }, "23503"],
        [{ version: id(896) }, "23514"],
        [{ brand: id(895) }, "23514"],
        [{ occurredAt: "2026-08-01T14:00:01.000Z" }, "23514"],
        [{ body: "invalid" }, "23514"],
        [{ snapshot: {} }, "23514"],
        [{ snapshot: { ...next.content, profile: "CatalogFullOptionSetDraftContentV2" } }, "23514"],
        [
          {
            snapshot: { ...next.content, sourceAggregate: { ...nextSource, aggregateVersion: 3 } },
          },
          "23514",
        ],
      ]) {
        const operation = id(operationNumber++);
        await admin.query("BEGIN");
        try {
          await insertOperation(admin, operation, 2, "ReplaceDraft");
          await assert.rejects(insertSnapshot(admin, operation, 2, next, overrides), { code });
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      await admin.query("BEGIN");
      try {
        await insertOperation(admin, id(880));
        await assert.rejects(insertSnapshot(admin, id(880)), { code: "23505" });
      } finally {
        await admin.query("ROLLBACK");
      }
      await admin.query(
        "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb,editor_content_json=NULL WHERE option_set_version_id=$1",
        [version, JSON.stringify({ "en-CA": "Later synthetic Draft" })],
      );
      assert.deepEqual(
        (await scoped(scope, (tx) => tx.query("SELECT * FROM " + table))).rows,
        original,
      );
      const before = (
        await admin.query(
          "SELECT * FROM rms_catalog.option_set_version WHERE option_set_version_id=$1",
          [version],
        )
      ).rows;
      let returnedWrites = 0;
      await admin.query("BEGIN");
      try {
        const root = await admin.query(
          "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1 AND aggregate_version=1",
          [set],
        );
        returnedWrites += root.rowCount;
        assert.equal(
          (
            await admin.query(
              "SELECT aggregate_version FROM rms_catalog.option_set WHERE option_set_id=$1",
              [set],
            )
          ).rows[0].aggregate_version,
          2,
        );
        const contentWrite = await admin.query(
          "UPDATE rms_catalog.option_set_version SET editor_content_json=$2::jsonb WHERE option_set_version_id=$1 RETURNING option_set_version_id",
          [version, JSON.stringify(details)],
        );
        returnedWrites += contentWrite.rowCount;
        await insertOperation(admin, id(890), 2, "ReplaceDraft");
        returnedWrites += (await insertSnapshot(admin, id(890), 2, next)).rowCount;
        assert.equal(returnedWrites, 3);
      } finally {
        await admin.query("ROLLBACK");
      }
      assert.equal(
        (
          await admin.query(
            "SELECT aggregate_version FROM rms_catalog.option_set WHERE option_set_id=$1",
            [set],
          )
        ).rows[0].aggregate_version,
        1,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT * FROM rms_catalog.option_set_version WHERE option_set_version_id=$1",
            [version],
          )
        ).rows,
        before,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_catalog.option_set_operation_record WHERE operation_id=$1",
            [id(890)],
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(
        (await scoped(scope, (tx) => tx.query("SELECT * FROM " + table))).rows,
        original,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
            [table],
          )
        ).rows[0].relforcerowsecurity,
        true,
      );
    } finally {
      await admin.query("ROLLBACK");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});

it("replaces complete Option Draft with original recovery, current authority and atomic Audit/Outbox rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_option_write" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_option_writer_" + context.runId;
    const tenant = id(1000),
      brand = id(1002),
      actor = id(1003),
      set = id(1001),
      version = id(1004);
    const plus = (seconds) => new Date(Date.parse(at) + seconds * 1000).toISOString();
    const draft = {
      versionReference: version,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic current options" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 2,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 2,
      createdAt: at,
      updatedAt: at,
      options: [1005, 1006].map((n) => ({
        optionReference: id(n),
        optionSetReference: set,
        brandReference: brand,
        stableCode: "CHOICE_" + n,
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Synthetic choice" },
        localizedDescriptions: {},
        sortOrder: n - 1005,
        defaultEligible: true,
        triggeredOptionSetReference: null,
        conflictOptionReferences: [],
        createdAt: at,
        createdByActorReference: actor,
      })),
    };
    const details = {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [1005, 1006].map((n) => ({
        optionReference: id(n),
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: {
          mediaReference: id(1010),
          assetReference: id(1011),
          assetVersionReference: id(1012),
          altText: { "en-CA": "Synthetic option image" },
        },
        pricingRule: { reference: id(1020), versionReference: id(1021) },
        consumption: {
          kind: n === 1005 ? "Inventory" : "Recipe",
          reference: id(1030 + n),
          versionReference: id(1040 + n),
          quantity: "0.125",
          unitCode: "GRAM",
        },
        triggeredOptionSetVersionReference: null,
      })),
      conditionalRules: [],
      conflictRules: [{ ruleReference: id(1050), forbiddenTogether: [id(1005), id(1006)] }],
      scopeSet: [
        { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    };
    let clock = plus(1),
      mode = "normal",
      holds = 0,
      rootWrites = 0,
      snapshotWrites = 0,
      currentReads = 0,
      eventNumber = 0;
    const take = async () =>
      (
        await admin.query(
          `SELECT
      (SELECT to_jsonb(s) FROM rms_catalog.option_set s WHERE option_set_id=$1) root,
      (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY option_set_version_id),'[]'::jsonb) FROM rms_catalog.option_set_version v WHERE option_set_id=$1) versions,
      (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY option_id),'[]'::jsonb) FROM rms_catalog.option o WHERE option_set_id=$1) options,
      (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY option_id,conflict_option_id),'[]'::jsonb) FROM rms_catalog.option_conflict c WHERE option_set_id=$1) conflicts,
      (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY operation_id),'[]'::jsonb) FROM rms_catalog.option_set_operation_record o WHERE option_set_id=$1) operations,
      (SELECT COALESCE(jsonb_agg(to_jsonb(f) ORDER BY operation_id),'[]'::jsonb) FROM rms_catalog.option_set_draft_content_snapshot f WHERE option_set_id=$1) snapshots,
      (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY audit_id),'[]'::jsonb) FROM platform_audit.audit_record a WHERE target_id=$1) audit,
      (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY brand_id,scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains,
      (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY event_id),'[]'::jsonb) FROM platform_eventing.outbox_event e WHERE aggregate_id=$1) outbox`,
          [set],
        )
      ).rows[0];
    const reset = (nextMode = "normal") => {
      mode = nextMode;
      holds = 0;
      rootWrites = 0;
      snapshotWrites = 0;
      currentReads = 0;
    };
    const transactions = {
      async run(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await work({
            query: async (sql, values) => {
              if (
                mode === "audit-failure" &&
                sql.includes("INSERT INTO platform_audit.audit_record")
              )
                throw new Error("synthetic audit failure");
              if (
                mode === "outbox-failure" &&
                sql.includes("INSERT INTO platform_eventing.outbox_event")
              )
                throw new Error("synthetic outbox failure");
              const r = await client.query(sql, [...values]);
              if (sql.startsWith("UPDATE rms_catalog.option_set SET")) rootWrites += r.rowCount;
              if (sql.startsWith("INSERT INTO rms_catalog.option_set_draft_content_snapshot"))
                snapshotWrites += r.rowCount;
              if (
                sql.includes("jsonb_build_object(") &&
                sql.includes("'optionSetReference',s.option_set_id")
              ) {
                currentReads++;
                if (mode === "divergent-reread" && rootWrites === 1)
                  return { ...r, rows: r.rows.map((row) => ({ ...row, coherent: false })) };
              }
              if (mode === "missing-recovery-snapshot" && sql.includes("f.snapshot_json snapshot"))
                return {
                  ...r,
                  rows: r.rows.map((row) => ({ ...row, snapshot: null, coherent: false })),
                };
              if (
                mode === "corrupt-recovery-recomputed" &&
                sql.includes("f.snapshot_json snapshot")
              )
                return {
                  ...r,
                  rows: r.rows.map((row) => {
                    const changed = globalThis.structuredClone(row.snapshot);
                    changed.optionDetails[0].media.altText["en-CA"] = "Synthetic tampered original";
                    const { sourceAggregate, ...details } = changed;
                    const recomputed = parseCatalogOptionSetEditorContent(sourceAggregate, details);
                    return {
                      ...row,
                      snapshot: recomputed.content,
                      source_digest: recomputed.sourceDigest,
                      content_digest: recomputed.contentDigest,
                      configuration_digest: recomputed.configurationDigest,
                    };
                  }),
                };
              if (mode === "corrupt-recovery" && sql.includes("f.snapshot_json snapshot"))
                return {
                  ...r,
                  rows: r.rows.map((row) => ({
                    ...row,
                    content_digest: "sha256:" + "f".repeat(64),
                  })),
                };
              return r;
            },
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
    const authority = {
      async holdUntilTransactionCompletes(tx, input) {
        holds++;
        assert.equal(input.tenantReference, tenant);
        assert.equal(input.brandReference, brand);
        assert.equal(input.actorReference, actor);
        assert.equal(input.actorKind, "User");
        assert.equal(input.action, "catalog.option_set.update");
        assert.equal(input.permission, "catalog.manage");
        assert.equal(input.purposeCode, "CATALOG_OPTION_SET_DRAFT");
        assert.ok(input.requiredFields.includes("effectivePeriod"));
        assert.ok(input.requiredFields.includes("defaultLocale"));
        assert.ok(input.requiredFields.includes("optionDetails"));
        if (mode === "deny-initial" || (mode === "deny-final" && holds === 2))
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (mode === "expiry-final" && holds === 2)
          clock = new Date(Date.parse(input.observedAt) + 5000).toISOString();
        if (mode === "held-root") {
          input.additionalContent.optionDetails[0].media.altText["en-CA"] =
            "Synthetic holder copy change";
        }
        if (mode === "held-root" && holds === 2) {
          const blocked = new Client(context.clientConfig);
          await blocked.connect();
          try {
            await blocked.query("SET lock_timeout='100ms'");
            await assert.rejects(
              blocked.query(
                "UPDATE rms_catalog.option_set SET aggregate_version=aggregate_version+1 WHERE option_set_id=$1",
                [set],
              ),
              { code: "55P03" },
            );
          } finally {
            await blocked.end();
          }
        }
        return {
          observedAt: input.observedAt,
          validUntil: new Date(
            Date.parse(input.observedAt) + (holds === 1 ? 5000 : 30000),
          ).toISOString(),
        };
      },
    };
    const store = createPostgresFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => clock },
      transactions,
      authority,
      audit: {
        create(input) {
          return {
            auditId: id(2000 + Number.parseInt(input.operationReference.slice(-4), 16)),
            brandId: brand,
            actor: { type: "User", reference: actor },
            actionCode: "CATALOG_OPTION_SET_REPLACEDRAFT",
            targetType: "CatalogOptionSet",
            targetId: set,
            reasonCode: input.reasonCode,
            correlationId: input.operationReference,
            occurredAt: input.occurredAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "OPERATIONAL",
            retentionPolicyVersion: 1,
          };
        },
      },
      events: { generateReference: () => id(3000 + ++eventNumber) },
    });
    const request = {
      optionSetReference: set,
      expectedAggregateVersion: 1,
      draft: {
        ...draft,
        localizedNames: { "en-CA": "Synthetic replacement" },
        updatedAt: plus(1),
        options: [...draft.options].reverse().map((o, i) => ({
          ...o,
          sortOrder: i,
          localizedNames: { "en-CA": "Synthetic renamed choice" },
        })),
      },
      additionalContent: details,
      operationReference: id(1100),
      occurredAt: plus(1),
      reasonCode: "CONFIGURATION_EDIT",
    };
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        `INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'FULL_WRITER','Draft',1,$3,$4,$3)`,
        [set, brand, at, actor],
      );
      await admin.query(
        `INSERT INTO rms_catalog.option_set_version(option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,display_style,minimum_selection,maximum_selection,allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,'{}'::jsonb,'MultiChoice',0,2,false,1,2,$5,$5)`,
        [version, set, brand, JSON.stringify(draft.localizedNames), at],
      );
      for (const o of draft.options)
        await admin.query(
          `INSERT INTO rms_catalog.option(option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,localized_names_json,localized_descriptions_json,sort_order,default_eligible,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,'Draft',$6::jsonb,'{}'::jsonb,$7,true,$8,$9)`,
          [
            o.optionReference,
            version,
            set,
            brand,
            o.stableCode,
            JSON.stringify(o.localizedNames),
            o.sortOrder,
            at,
            actor,
          ],
        );
      const initial = await take();
      let accessed = 0;
      const accessor = { ...request };
      Object.defineProperty(accessor, "reasonCode", {
        enumerable: true,
        get() {
          accessed++;
          return "CONFIGURATION_EDIT";
        },
      });
      await assert.rejects(store.replace(accessor), { code: "CATALOG_INPUT_INVALID" });
      assert.equal(accessed, 0);
      assert.equal(holds, 0);
      for (const bad of [
        { ...request, expectedAggregateVersion: 2 },
        { ...request, draft: { ...request.draft, versionReference: id(1199) } },
        { ...request, draft: { ...request.draft, options: request.draft.options.slice(1) } },
        {
          ...request,
          draft: {
            ...request.draft,
            options: request.draft.options.map((o, i) => (i ? o : { ...o, stableCode: "CHANGED" })),
          },
        },
        { ...request, additionalContent: { ...details, clientReady: true } },
        { ...request, expectedAggregateVersion: 2147483647 },
      ]) {
        reset();
        await assert.rejects(store.replace(bad));
        assert.equal(rootWrites, 0);
        assert.deepEqual(await take(), initial);
      }
      reset("held-root");
      const first = await store.replace(request);
      assert.equal(first.status, "Applied");
      assert.equal(first.content.sourceAggregate.aggregateVersion, 2);
      assert.equal(first.referenceEligibility, "NotEvaluated");
      assert.equal(first.content.optionDetails[0].media.altText["en-CA"], "Synthetic option image");
      assert.equal(details.optionDetails[0].media.altText["en-CA"], "Synthetic option image");
      assert.equal(snapshotWrites, 1);
      assert.equal(rootWrites, 1);
      assert.deepEqual(
        first.content.sourceAggregate.draft.options.map((o) => o.optionReference),
        request.draft.options.map((o) => o.optionReference),
      );
      const committed = await take();
      assert.equal(committed.operations.length, 1);
      assert.equal(committed.snapshots.length, 1);
      assert.equal(committed.audit.length, 1);
      assert.equal(committed.outbox.length, 1);
      assert.equal(committed.outbox[0].event_type, "OptionSetDraftReplaced");
      assert.deepEqual(Object.keys(committed.outbox[0].payload_json).sort(), [
        "aggregateVersion",
        "configurationDigest",
        "contentDigest",
        "operationReference",
        "optionSetReference",
        "tenantReference",
        "versionReference",
      ]);
      assert.deepEqual(committed.snapshots[0].snapshot_json, first.content);
      assert.equal(
        committed.versions[0].editor_content_json.profile,
        "CatalogOptionSetEditorContentV1",
      );
      const second = {
        ...request,
        expectedAggregateVersion: 2,
        operationReference: id(1101),
        draft: {
          ...first.content.sourceAggregate.draft,
          updatedAt: plus(2),
          localizedNames: { "en-CA": "Synthetic next Draft" },
        },
        occurredAt: plus(2),
      };
      for (const failure of [
        "deny-final",
        "expiry-final",
        "audit-failure",
        "outbox-failure",
        "divergent-reread",
      ]) {
        clock = plus(2);
        reset(failure);
        await assert.rejects(store.replace(second));
        assert.equal(rootWrites, 1);
        assert.equal(snapshotWrites, failure === "divergent-reread" ? 0 : 1);
        assert.deepEqual(await take(), committed);
      }
      clock = at;
      reset();
      await assert.rejects(store.replace(request), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.equal(rootWrites, 0);
      assert.equal(currentReads, 0);
      assert.deepEqual(await take(), committed);
      clock = plus(60);
      reset();
      const replay = await store.replace(request);
      assert.equal(replay.status, "Replayed");
      assert.deepEqual(replay.content, first.content);
      assert.equal(currentReads, 0);
      assert.equal(rootWrites, 0);
      assert.deepEqual(await take(), committed);
      reset("deny-initial");
      await assert.rejects(store.replace(request), { code: "CATALOG_PERMISSION_DENIED" });
      assert.equal(currentReads, 0);
      assert.deepEqual(await take(), committed);
      reset("missing-recovery-snapshot");
      await assert.rejects(store.replace(request), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.equal(currentReads, 0);
      assert.deepEqual(await take(), committed);
      reset("corrupt-recovery-recomputed");
      await assert.rejects(store.replace(request));
      assert.equal(currentReads, 0);
      assert.deepEqual(await take(), committed);
      reset("corrupt-recovery");
      await assert.rejects(store.replace(request));
      assert.equal(currentReads, 0);
      assert.deepEqual(await take(), committed);
      reset();
      await assert.rejects(store.replace({ ...request, reasonCode: "ALTERED_INTENT" }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      assert.equal(currentReads, 0);
      clock = plus(61);
      reset();
      const third = await store.replace({
        ...second,
        occurredAt: plus(61),
        draft: { ...second.draft, updatedAt: plus(61) },
      });
      assert.equal(third.content.sourceAggregate.aggregateVersion, 3);
      const later = await take();
      clock = plus(65);
      reset();
      const old = await store.replace(request);
      assert.deepEqual(old.content, first.content);
      assert.equal(old.content.sourceAggregate.aggregateVersion, 2);
      assert.equal(currentReads, 0);
      assert.deepEqual(await take(), later);
      await admin.query(
        "UPDATE rms_catalog.option_set SET updated_at=$2::timestamptz WHERE option_set_id=$1",
        [set, plus(61).replace(".000Z", ".000001Z")],
      );
      clock = plus(66);
      reset();
      const futureWrite = {
        ...request,
        expectedAggregateVersion: 3,
        operationReference: id(1102),
        occurredAt: plus(66),
        draft: { ...third.content.sourceAggregate.draft, updatedAt: plus(66) },
      };
      await assert.rejects(store.replace(futureWrite), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.equal(rootWrites, 0);
      await admin.query(
        "UPDATE rms_catalog.option_set SET updated_at=$2::timestamptz WHERE option_set_id=$1",
        [set, plus(61)],
      );
      assert.deepEqual(await take(), later);
    } finally {
      await admin.query("ROLLBACK");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});

it("creates complete Option Draft with server identities, original recovery and atomic rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_option_create" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_option_creator_" + context.runId,
      tenant = id(6000),
      brand = id(6001),
      actor = id(6002);
    const plus = (seconds) => new Date(Date.parse(at) + seconds * 1000).toISOString();
    const request = {
      internalCode: "FULL_CREATE",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic initial choices" },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 3,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 3,
        options: ["OAT", "SOY", "DAIRY"].map((stableCode, sortOrder) => ({
          stableCode,
          sortOrder,
          lifecycle: "Draft",
          localizedNames: { "en-CA": stableCode },
          localizedDescriptions: {},
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: stableCode === "OAT" ? ["DAIRY"] : [],
        })),
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: ["OAT", "SOY", "DAIRY"].map((stableCode) => ({
          stableCode,
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: {
            mediaReference: id(6050),
            assetReference: id(6051),
            assetVersionReference: id(6052),
            altText: { "en-CA": "Synthetic image" },
          },
          pricingRule: { reference: id(6060), versionReference: id(6061) },
          consumption: {
            kind: "Inventory",
            reference: id(6070),
            versionReference: id(6071),
            quantity: "0.125",
            unitCode: "GRAM",
          },
          triggeredOptionSetVersionReference: null,
        })),
        conditionalRules: [
          { ruleReference: id(6080), whenAllSelectedCodes: ["OAT"], requiredOptionCodes: ["SOY"] },
        ],
        conflictRules: [{ ruleReference: id(6081), forbiddenTogetherCodes: ["OAT", "DAIRY"] }],
        scopeSet: [
          { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
        ],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
      operationReference: id(6100),
      occurredAt: at,
      reasonCode: "INITIAL_CONFIGURATION",
    };
    let clock = plus(1),
      mode = "normal",
      holds = 0,
      rootWrites = 0,
      snapshotWrites = 0,
      currentReads = 0,
      allocationCalls = 0,
      nextId = 6200,
      eventId = 0,
      allocatedRoot = null;
    const take = async () => {
      const result = {};
      for (const table of [
        "rms_catalog.option_set",
        "rms_catalog.option_set_version",
        "rms_catalog.option",
        "rms_catalog.option_conflict",
        "rms_catalog.option_set_operation_record",
        "rms_catalog.option_set_draft_content_snapshot",
        "platform_audit.audit_record",
        "platform_audit.audit_chain_head",
        "platform_eventing.outbox_event",
      ])
        result[table] = (
          await admin.query(
            "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
          )
        ).rows;
      return result;
    };
    const reset = (next = "normal") => {
      mode = next;
      holds = 0;
      rootWrites = 0;
      snapshotWrites = 0;
      currentReads = 0;
      clock = plus(1);
    };
    const transactions = {
      async run(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await work({
            query: async (sql, values) => {
              if (
                mode === "audit-failure" &&
                sql.includes("INSERT INTO platform_audit.audit_record")
              )
                throw new Error("synthetic audit failure");
              if (
                mode === "outbox-failure" &&
                sql.includes("INSERT INTO platform_eventing.outbox_event")
              )
                throw new Error("synthetic outbox failure");
              const r = await client.query(sql, [...values]);
              if (sql.startsWith("INSERT INTO rms_catalog.option_set(")) rootWrites += r.rowCount;
              if (sql.startsWith("INSERT INTO rms_catalog.option_set_draft_content_snapshot"))
                snapshotWrites += r.rowCount;
              if (sql.includes("'optionSetReference',s.option_set_id")) {
                currentReads++;
                if (mode === "divergent-reread")
                  return { ...r, rows: r.rows.map((row) => ({ ...row, coherent: false })) };
              }
              if (mode === "malformed-original" && sql.includes("f.snapshot_json snapshot"))
                return {
                  ...r,
                  rows: r.rows.map((row) => ({
                    ...row,
                    snapshot: { ...row.snapshot, profile: "Unsupported" },
                  })),
                };
              if (mode === "missing-original" && sql.includes("f.snapshot_json snapshot"))
                return {
                  ...r,
                  rows: r.rows.map((row) => ({ ...row, snapshot: null, coherent: false })),
                };
              if (mode === "tampered-original" && sql.includes("f.snapshot_json snapshot"))
                return {
                  ...r,
                  rows: r.rows.map((row) => {
                    const changed = globalThis.structuredClone(row.snapshot);
                    changed.sourceAggregate.draft.localizedNames["en-CA"] =
                      "Synthetic altered original";
                    const { sourceAggregate, ...details } = changed,
                      p = parseCatalogOptionSetEditorContent(sourceAggregate, details);
                    return {
                      ...row,
                      snapshot: p.content,
                      source_digest: p.sourceDigest,
                      content_digest: p.contentDigest,
                      configuration_digest: p.configurationDigest,
                    };
                  }),
                };
              return r;
            },
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
    const authority = {
      async holdUntilTransactionCompletes(tx, input) {
        holds++;
        assert.equal(input.tenantReference, tenant);
        assert.equal(input.brandReference, brand);
        assert.equal(input.actorReference, actor);
        assert.equal(input.actorKind, "User");
        assert.equal(input.action, "catalog.option_set.create");
        assert.equal(input.permission, "catalog.manage");
        assert.equal(input.purposeCode, "CATALOG_OPTION_SET_DRAFT");
        assert.ok(input.requiredFields.includes("internalCode"));
        assert.ok(input.requiredFields.includes("defaultLocale"));
        assert.ok(input.requiredFields.includes("optionDetails"));
        assert.equal(input.optionSetReference === null, holds === 1);
        input.proposedCommand.draft.localizedNames["en-CA"] = "Synthetic detached holder edit";
        if (
          mode === "deny-initial" ||
          (mode === "deny-after-allocation" && holds === 2) ||
          (mode === "deny-replay-final" && holds === 2) ||
          (mode === "deny-final" && holds === 3)
        )
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (mode === "expiry-final" && holds === 3) clock = plus(6);
        if (mode === "held-root" && holds === 3) {
          const other = new Client(context.clientConfig);
          await other.connect();
          try {
            await other.query("SET lock_timeout='100ms'");
            await assert.rejects(
              other.query(
                "INSERT INTO rms_catalog.option_set(option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'FULL_CREATE','Draft',1,$3,$4,$3)",
                [id(9900), brand, at, actor],
              ),
              { code: "55P03" },
            );
          } finally {
            await other.end();
          }
        }
        return {
          observedAt: input.observedAt,
          validUntil: new Date(
            Date.parse(input.observedAt) + (holds === 1 ? 5000 : 30000),
          ).toISOString(),
        };
      },
    };
    const store = createPostgresFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => clock },
      transactions,
      authority: {
        async holdUntilTransactionCompletes() {
          throw new Error("update authority must not authorize create");
        },
      },
      creation: {
        authority,
        references: {
          generate(kind) {
            allocationCalls++;
            if (mode === "existing-root" && kind === "OptionSet") return allocatedRoot;
            return mode === "bad-allocator" ? id(7999) : id(nextId++);
          },
        },
      },
      audit: {
        create(input) {
          return {
            auditId: id(8000 + Number.parseInt(input.operationReference.slice(-4), 16)),
            brandId: brand,
            actor: { type: "User", reference: actor },
            actionCode: "CATALOG_OPTION_SET_CREATE",
            targetType: "CatalogOptionSet",
            targetId: input.result.sourceAggregate.optionSetReference,
            reasonCode: input.reasonCode,
            correlationId: input.operationReference,
            occurredAt: input.occurredAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "OPERATIONAL",
            retentionPolicyVersion: 1,
          };
        },
      },
      events: { generateReference: () => id(9000 + ++eventId) },
    });
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const empty = await take();
      reset("deny-initial");
      await assert.rejects(store.create(request), { code: "CATALOG_PERMISSION_DENIED" });
      assert.equal(allocationCalls, 0);
      assert.deepEqual(await take(), empty);
      reset("bad-allocator");
      await assert.rejects(store.create(request), { code: "CATALOG_INPUT_INVALID" });
      assert.equal(rootWrites, 0);
      assert.deepEqual(await take(), empty);
      reset("deny-after-allocation");
      await assert.rejects(store.create(request), { code: "CATALOG_PERMISSION_DENIED" });
      assert.equal(rootWrites, 0);
      assert.deepEqual(await take(), empty);
      for (const failure of [
        "deny-final",
        "expiry-final",
        "audit-failure",
        "outbox-failure",
        "divergent-reread",
      ]) {
        reset(failure);
        await assert.rejects(store.create(request), {
          code:
            failure === "deny-final"
              ? "CATALOG_PERMISSION_DENIED"
              : "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
        assert.equal(rootWrites, 1);
        assert.equal(snapshotWrites, failure === "divergent-reread" ? 0 : 1);
        assert.deepEqual(await take(), empty);
      }
      reset("held-root");
      const applied = await store.create(request),
        root = applied.content.sourceAggregate;
      allocatedRoot = root.optionSetReference;
      assert.equal(applied.status, "Applied");
      assert.equal(root.aggregateVersion, 1);
      assert.equal(root.internalCode, request.internalCode);
      assert.equal(root.createdByActorReference, actor);
      assert.equal(root.draft.localizedNames["en-CA"], request.draft.localizedNames["en-CA"]);
      assert.equal(applied.referenceEligibility, "NotEvaluated");
      assert.equal(rootWrites, 1);
      assert.equal(snapshotWrites, 1);
      assert.equal(currentReads, 1);
      const oat = root.draft.options.find((o) => o.stableCode === "OAT"),
        soy = root.draft.options.find((o) => o.stableCode === "SOY"),
        dairy = root.draft.options.find((o) => o.stableCode === "DAIRY");
      assert.deepEqual(oat.conflictOptionReferences, [dairy.optionReference]);
      assert.deepEqual(applied.content.conditionalRules[0].requiredOptionReferences, [
        soy.optionReference,
      ]);
      assert.deepEqual(
        applied.content.conflictRules[0].forbiddenTogether,
        [oat.optionReference, dairy.optionReference].sort(),
      );
      assert.ok(
        new Set([
          root.optionSetReference,
          root.draft.versionReference,
          ...root.draft.options.map((o) => o.optionReference),
        ]).size === 5,
      );
      const persisted = await take();
      assert.equal(persisted["rms_catalog.option_set_operation_record"].length, 1);
      assert.equal(persisted["rms_catalog.option_set_draft_content_snapshot"].length, 1);
      assert.equal(persisted["platform_audit.audit_record"].length, 1);
      assert.equal(persisted["platform_eventing.outbox_event"].length, 1);
      const envelope = persisted["platform_eventing.outbox_event"][0].row;
      assert.equal(envelope.event_type, "OptionSetDraftCreated");
      const allocations = allocationCalls;
      reset();
      await assert.rejects(store.create({ ...request, operationReference: id(6101) }), {
        code: "CATALOG_CODE_CONFLICT",
      });
      assert.equal(allocationCalls, allocations);
      assert.deepEqual(await take(), persisted);
      reset();
      await assert.rejects(store.create({ ...request, reasonCode: "DIFFERENT_REASON" }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      assert.equal(allocationCalls, allocations);
      assert.deepEqual(await take(), persisted);
      await admin.query(
        "UPDATE rms_catalog.option_set SET aggregate_version=2,updated_at=$2 WHERE option_set_id=$1",
        [root.optionSetReference, plus(2)],
      );
      await admin.query(
        "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb,updated_at=$3 WHERE option_set_version_id=$1",
        [
          root.draft.versionReference,
          JSON.stringify({ "en-CA": "Later synthetic draft" }),
          plus(2),
        ],
      );
      const later = await take();
      reset();
      clock = plus(60);
      const replayed = await store.create(request);
      assert.equal(replayed.status, "Replayed");
      assert.deepEqual(replayed.content, applied.content);
      assert.equal(allocationCalls, allocations);
      assert.equal(rootWrites, 0);
      assert.equal(currentReads, 0);
      assert.deepEqual(await take(), later);
      for (const failure of [
        "deny-initial",
        "deny-replay-final",
        "missing-original",
        "malformed-original",
        "tampered-original",
      ]) {
        reset(failure);
        clock = plus(60);
        await assert.rejects(store.create(request), {
          code:
            failure === "deny-initial" || failure === "deny-replay-final"
              ? "CATALOG_PERMISSION_DENIED"
              : "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
        assert.equal(allocationCalls, allocations);
        assert.equal(currentReads, 0);
        assert.deepEqual(await take(), later);
      }
      reset();
      clock = new Date(Date.parse(at) - 1).toISOString();
      await assert.rejects(store.create(request), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      assert.equal(allocationCalls, allocations);
      assert.deepEqual(await take(), later);
      reset("existing-root");
      await assert.rejects(
        store.create({
          ...request,
          internalCode: "FULL_CREATE_SECOND",
          operationReference: id(6102),
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(rootWrites, 0);
      assert.deepEqual(await take(), later);
    } finally {
      await admin.query("ROLLBACK");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});

it("reads actual current full Option Draft with held fields, provenance and no business writes", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_option_read" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const writerRole = "wp2421_option_read_seed_" + context.runId,
      readerRole = "wp2421_option_read_" + context.runId;
    const tenant = id(6000),
      brand = id(6001),
      actor = id(6002),
      plus = (seconds) => new Date(Date.parse(at) + seconds * 1000).toISOString();
    const request = {
      internalCode: "FULL_CREATE",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic initial choices" },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 3,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 3,
        options: ["OAT", "SOY", "DAIRY"].map((stableCode, sortOrder) => ({
          stableCode,
          sortOrder,
          lifecycle: "Draft",
          localizedNames: { "en-CA": stableCode },
          localizedDescriptions: {},
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: stableCode === "OAT" ? ["DAIRY"] : [],
        })),
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: ["OAT", "SOY", "DAIRY"].map((stableCode) => ({
          stableCode,
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: {
            mediaReference: id(6050),
            assetReference: id(6051),
            assetVersionReference: id(6052),
            altText: { "en-CA": "Synthetic image" },
          },
          pricingRule: { reference: id(6060), versionReference: id(6061) },
          consumption: {
            kind: "Inventory",
            reference: id(6070),
            versionReference: id(6071),
            quantity: "0.125",
            unitCode: "GRAM",
          },
          triggeredOptionSetVersionReference: null,
        })),
        conditionalRules: [
          { ruleReference: id(6080), whenAllSelectedCodes: ["OAT"], requiredOptionCodes: ["SOY"] },
        ],
        conflictRules: [{ ruleReference: id(6081), forbiddenTogetherCodes: ["OAT", "DAIRY"] }],
        scopeSet: [
          { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
        ],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
      operationReference: id(6100),
      occurredAt: at,
      reasonCode: "INITIAL_CONFIGURATION",
    };

    let clock = plus(1),
      mode = "normal",
      holds = 0,
      reads = 0,
      queries = 0,
      allocations = 0,
      nextId = 6200,
      eventId = 0,
      nowCalls = 0;
    const take = async () => {
      const result = {};
      for (const table of [
        "rms_catalog.option_set",
        "rms_catalog.option_set_version",
        "rms_catalog.option",
        "rms_catalog.option_conflict",
        "rms_catalog.option_set_operation_record",
        "rms_catalog.option_set_draft_content_snapshot",
        "platform_audit.audit_record",
        "platform_audit.audit_chain_head",
        "platform_eventing.outbox_event",
      ])
        result[table] = (
          await admin.query(
            "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
          )
        ).rows;
      return result;
    };
    const runner = (role, reading = false) => ({
      async run(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await work({
            query: async (sql, values) => {
              if (reading) {
                queries++;
                assert.ok(!/^(INSERT|UPDATE|DELETE)\s/.test(sql));
              }
              const result = await client.query(sql, [...values]);
              if (reading && sql.includes("'optionSetReference',s.option_set_id")) {
                reads++;
                if (mode === "divergent-reread" && reads === 2)
                  return {
                    ...result,
                    rows: result.rows.map((row) => ({ ...row, coherent: false })),
                  };
              }
              if (
                reading &&
                mode === "bounded-count" &&
                sql.includes("count(*)::text FROM rms_catalog.option WHERE")
              )
                return { ...result, rows: result.rows.map((row) => ({ ...row, n: "101" })) };
              return result;
            },
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    });
    const lease = (input) => ({
      observedAt: input.observedAt,
      validUntil: new Date(Date.parse(input.observedAt) + 30000).toISOString(),
    });
    const writer = createPostgresFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => clock },
      transactions: runner(writerRole),
      authority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(input.action, "catalog.option_set.update");
          return lease(input);
        },
      },
      creation: {
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(input.action, "catalog.option_set.create");
            return lease(input);
          },
        },
        references: {
          generate() {
            allocations++;
            return id(nextId++);
          },
        },
      },
      audit: {
        create(input) {
          return {
            auditId: id(8000 + Number.parseInt(input.operationReference.slice(-4), 16)),
            brandId: brand,
            actor: { type: "User", reference: actor },
            actionCode:
              input.result.sourceAggregate.aggregateVersion === 1
                ? "CATALOG_OPTION_SET_CREATE"
                : "CATALOG_OPTION_SET_REPLACEDRAFT",
            targetType: "CatalogOptionSet",
            targetId: input.result.sourceAggregate.optionSetReference,
            reasonCode: input.reasonCode,
            correlationId: input.operationReference,
            occurredAt: input.occurredAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "OPERATIONAL",
            retentionPolicyVersion: 1,
          };
        },
      },
      events: { generateReference: () => id(9000 + ++eventId) },
    });
    const readerFor = (readTenant = tenant, readBrand = brand) =>
      createPostgresCurrentFullOptionSetDraftStore({
        tenantReference: readTenant,
        brandReference: readBrand,
        actorReference: actor,
        clock: {
          now() {
            nowCalls++;
            if (mode === "advance-before-initial" && nowCalls === 2) clock = plus(2);
            return clock;
          },
        },
        transactions: runner(readerRole, true),
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            holds++;
            assert.equal(input.tenantReference, readTenant);
            assert.equal(input.brandReference, readBrand);
            assert.equal(input.actorReference, actor);
            assert.equal(input.actorKind, "User");
            assert.equal(input.permission, "catalog.manage");
            assert.equal(input.action, "catalog.option_set.read");
            assert.equal(input.purposeCode, "CATALOG_OPTION_SET_DRAFT");
            for (const field of [
              "internalCode",
              "createdByActorReference",
              "lifecycle",
              "aggregateVersion",
              "defaultLocale",
              "optionDetails",
              "effectivePeriod",
            ])
              assert.ok(input.requiredFields.includes(field));
            if (holds === 1) assert.equal(input.content, null);
            else
              assert.equal(
                input.content.sourceAggregate.optionSetReference,
                input.optionSetReference,
              );
            if (mode === "deny-initial" || (mode === "deny-final" && holds === 3))
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (mode === "expiry-final" && holds === 3)
              clock = new Date(Date.parse(input.observedAt) + 5000).toISOString();
            if (mode === "backward-final" && holds === 3) clock = at;
            if (mode === "held-rows" && holds === 3) {
              input.content.optionDetails[0].media.altText["en-CA"] =
                "Synthetic detached read holder edit";
              const other = new Client(context.clientConfig);
              await other.connect();
              try {
                await other.query("BEGIN");
                assert.equal(
                  (
                    await other.query(
                      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked",
                      ["CatalogFullOptionSource:" + brand + ":" + input.optionSetReference],
                    )
                  ).rows[0].locked,
                  false,
                );
                await other.query("ROLLBACK");
                await other.query("SET lock_timeout='100ms'");
                for (const statement of [
                  "UPDATE rms_catalog.option_set SET updated_at=updated_at WHERE option_set_id=$1",
                  "UPDATE rms_catalog.option_set_version SET updated_at=updated_at WHERE option_set_id=$1",
                  "UPDATE rms_catalog.option SET sort_order=sort_order WHERE option_set_id=$1",
                  "UPDATE rms_catalog.option_conflict SET brand_id=brand_id WHERE option_set_id=$1",
                ])
                  await assert.rejects(other.query(statement, [input.optionSetReference]), {
                    code: "55P03",
                  });
              } finally {
                await other.end();
              }
            }
            return {
              observedAt: input.observedAt,
              validUntil: new Date(
                Date.parse(input.observedAt) +
                  (mode === "bad-lease"
                    ? 31000
                    : mode === "advance-before-initial"
                      ? 30000
                      : holds === 1
                        ? 5000
                        : 30000),
              ).toISOString(),
            };
          },
        },
      });
    const reset = (next = "normal") => {
      mode = next;
      holds = 0;
      reads = 0;
      queries = 0;
      nowCalls = 0;
      clock = plus(1);
    };
    await admin.query(
      "CREATE ROLE " +
        writerRole +
        " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    await admin.query(
      "CREATE ROLE " +
        readerRole +
        " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      for (const role of [writerRole, readerRole]) {
        await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
        await admin.query(
          "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
            role,
        );
        await admin.query(
          "GRANT SELECT ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot TO " +
            role,
        );
        await admin.query(
          "GRANT UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict TO " +
            role,
        );
      }
      await admin.query("GRANT USAGE ON SCHEMA platform_audit,platform_eventing TO " + writerRole);
      await admin.query(
        "GRANT INSERT,DELETE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot TO " +
          writerRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
          writerRole,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + writerRole,
      );
      const created = await writer.create(request),
        root = created.content.sourceAggregate,
        set = root.optionSetReference,
        version = root.draft.versionReference;
      const input = { optionSetReference: set, expectedAggregateVersion: null },
        reader = readerFor(),
        before = await take();
      let accessed = 0;
      const getter = { ...input };
      Object.defineProperty(getter, "expectedAggregateVersion", {
        enumerable: true,
        get() {
          accessed++;
          return null;
        },
      });
      await assert.rejects(reader.readCurrent(getter), { code: "CATALOG_INPUT_INVALID" });
      assert.equal(accessed, 0);
      assert.equal(holds, 0);
      for (const invalid of [
        { ...input, expectedAggregateVersion: 2147483648 },
        { ...input, expectedAggregateVersion: 0 },
        { ...input, sourceStatus: "Ready" },
        { ...input, actorReference: actor },
      ])
        await assert.rejects(reader.readCurrent(invalid), { code: "CATALOG_INPUT_INVALID" });
      assert.equal(queries, 0);
      reset("held-rows");
      const first = await reader.readCurrent(input);
      assert.deepEqual(first.content, created.content);
      assert.equal(first.referenceEligibility, "NotEvaluated");
      assert.equal(first.observedAt, plus(1));
      assert.equal(first.validUntil, plus(6));
      assert.equal(reads, 2);
      assert.equal(holds, 3);
      assert.deepEqual(await take(), before);
      reset("advance-before-initial");
      const bounded = await reader.readCurrent(input);
      assert.equal(bounded.observedAt, plus(1));
      assert.equal(bounded.validUntil, plus(31));
      assert.deepEqual(await take(), before);
      for (const failure of [
        "deny-initial",
        "deny-final",
        "expiry-final",
        "backward-final",
        "bad-lease",
        "divergent-reread",
        "bounded-count",
      ]) {
        reset(failure);
        await assert.rejects(reader.readCurrent(input), {
          code: failure.startsWith("deny-")
            ? "CATALOG_PERMISSION_DENIED"
            : "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
        if (failure === "deny-initial") assert.equal(queries, 0);
        assert.deepEqual(await take(), before);
      }
      reset();
      await assert.rejects(reader.readCurrent({ ...input, expectedAggregateVersion: 2 }), {
        code: "CATALOG_VERSION_CONFLICT",
      });
      assert.deepEqual(await take(), before);
      reset();
      await assert.rejects(readerFor(id(6998), brand).readCurrent(input), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await take(), before);
      reset();
      await assert.rejects(readerFor(tenant, id(6999)).readCurrent(input), {
        code: "CATALOG_UNAVAILABLE",
      });
      assert.deepEqual(await take(), before);
      const { sourceAggregate, ...details } = created.content;
      for (const [change, restore] of [
        [
          () =>
            admin.query(
              "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1",
              [set],
            ),
          () =>
            admin.query(
              "UPDATE rms_catalog.option_set SET aggregate_version=1 WHERE option_set_id=$1",
              [set],
            ),
        ],
        [
          () =>
            admin.query(
              "UPDATE rms_catalog.option_set_version SET editor_content_json=NULL WHERE option_set_version_id=$1",
              [version],
            ),
          () =>
            admin.query(
              "UPDATE rms_catalog.option_set_version SET editor_content_json=$2::jsonb WHERE option_set_version_id=$1",
              [version, JSON.stringify(details)],
            ),
        ],
        [
          () =>
            admin.query("UPDATE rms_catalog.option_set SET updated_at=$2 WHERE option_set_id=$1", [
              set,
              plus(2),
            ]),
          () =>
            admin.query("UPDATE rms_catalog.option_set SET updated_at=$2 WHERE option_set_id=$1", [
              set,
              sourceAggregate.updatedAt,
            ]),
        ],
        [
          () =>
            admin.query("UPDATE rms_catalog.option_set SET updated_at=$2 WHERE option_set_id=$1", [
              set,
              at.slice(0, -1) + "001Z",
            ]),
          () =>
            admin.query("UPDATE rms_catalog.option_set SET updated_at=$2 WHERE option_set_id=$1", [
              set,
              sourceAggregate.updatedAt,
            ]),
        ],
        [
          () =>
            admin.query(
              "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb WHERE option_set_version_id=$1",
              [version, JSON.stringify({ "en-CA": "Unlogged synthetic mutation" })],
            ),
          () =>
            admin.query(
              "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb WHERE option_set_version_id=$1",
              [version, JSON.stringify(root.draft.localizedNames)],
            ),
        ],
      ]) {
        await change();
        reset();
        await assert.rejects(reader.readCurrent(input), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
        await restore();
        assert.deepEqual(await take(), before);
      }
      clock = plus(2);
      const replacement = await writer.replace({
        optionSetReference: set,
        expectedAggregateVersion: 1,
        draft: {
          ...root.draft,
          updatedAt: plus(2),
          localizedNames: { "en-CA": "Later actual owning draft" },
        },
        additionalContent: details,
        operationReference: id(6103),
        occurredAt: plus(2),
        reasonCode: "CONFIGURATION_EDIT",
      });
      const later = await take();
      reset();
      clock = plus(2);
      const current = await reader.readCurrent({ ...input, expectedAggregateVersion: 2 });
      assert.deepEqual(current.content, replacement.content);
      assert.deepEqual(await take(), later);
      const allocationCount = allocations;
      const original = await writer.create(request);
      assert.deepEqual(original.content, created.content);
      assert.equal(allocations, allocationCount);
      assert.deepEqual(await take(), later);
      // Controlled near-exhausted mutable root seed; actual owning ReplaceDraft
      // records the final legal root, and current reading can still return it.
      await admin.query(
        "UPDATE rms_catalog.option_set SET aggregate_version=2147483646 WHERE option_set_id=$1",
        [set],
      );
      clock = plus(3);
      const final = await writer.replace({
        optionSetReference: set,
        expectedAggregateVersion: 2147483646,
        draft: { ...replacement.content.sourceAggregate.draft, updatedAt: plus(3) },
        additionalContent: details,
        operationReference: id(6104),
        occurredAt: plus(3),
        reasonCode: "CONFIGURATION_EDIT",
      });
      const terminal = await take();
      reset();
      clock = plus(3);
      const last = await reader.readCurrent({ ...input, expectedAggregateVersion: 2147483647 });
      assert.deepEqual(last.content, final.content);
      assert.deepEqual(await take(), terminal);

      // Milestone53: actual owning current root -> same-transaction singleton graph.
      // Permission/Actor controls and reference facts remain synthetic; no current
      // Published child or Media/Inventory/Pricing qualification is inferred.
      const graphInput = {
        optionSetReference: set,
        versionReference: last.content.sourceAggregate.draft.versionReference,
        expectedAggregateVersion: 2147483647,
        sourceDigest: last.sourceDigest,
        contentDigest: last.contentDigest,
        configurationDigest: last.configurationDigest,
        observedAt: plus(3),
        validUntil: plus(13),
      };
      let graphClock = plus(3),
        graphMode = "normal",
        graphHolds = 0,
        graphTx,
        graphCallbacks = 0;
      const graphAuthority = {
        async holdUntilTransactionCompletes(actualTx, request) {
          graphHolds++;
          assert.equal(actualTx, graphTx);
          assert.equal(request.tenantReference, tenant);
          assert.equal(request.brandReference, brand);
          assert.equal(request.actorReference, actor);
          assert.equal(request.actorKind, "User");
          assert.equal(request.permission, "catalog.manage");
          assert.equal(request.action, "catalog.option_set.read");
          assert.equal(request.purposeCode, "CATALOG_OPTION_SET_DRAFT");
          for (const field of [
            "aggregateVersion",
            "optionDetails",
            "conditionalRules",
            "effectivePeriod",
          ])
            assert.ok(request.requiredFields.includes(field));
          if (graphMode === "deny-initial" || (graphMode === "deny-after-work" && graphHolds === 4))
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          return { observedAt: request.observedAt, validUntil: plus(33) };
        },
      };
      const graphCall = async (selectedMode, callback, override = {}) => {
        graphMode = selectedMode;
        graphClock = plus(3);
        graphHolds = 0;
        graphCallbacks = 0;
        const provider = createCurrentOptionSetDraftGraphSource({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: () => graphClock },
          authority: graphAuthority,
        });
        return runner(writerRole).run(async (tx) => {
          graphTx = tx;
          return provider.withCurrentGraph(tx, { ...graphInput, ...override }, async (value) => {
            graphCallbacks++;
            assert.equal(value.profile, "CurrentOptionSetDraftGraphV1");
            assert.equal(value.sourceAuthority, "CurrentDraftRootOnly");
            assert.equal(value.publishValidation, "Incomplete");
            assert.equal(value.referenceEligibility, "NotEvaluated");
            assert.equal(value.eligibility, "NotEvaluated");
            assert.equal(value.originalObservedAt, plus(3));
            assert.equal(value.observedAt, plus(3));
            assert.equal(value.validUntil, plus(13));
            assert.equal(value.graph.contents.length, 1);
            assert.deepEqual(value.graph.contents[0], last.content);
            assert.match(value.graphDigest, /^sha256:[0-9a-f]{64}$/);
            return callback(tx, value);
          });
        });
      };
      assert.equal(
        await graphCall("normal", async () => "ACTUAL_CURRENT_ROOT"),
        "ACTUAL_CURRENT_ROOT",
      );
      assert.equal(graphCallbacks, 1);
      assert.equal(graphHolds, 6);
      assert.deepEqual(await take(), terminal);
      for (const override of [
        { versionReference: id(6999) },
        { sourceDigest: "sha256:" + "f".repeat(64) },
        { expectedAggregateVersion: 2147483646 },
      ]) {
        await assert.rejects(
          graphCall("normal", async () => assert.fail("stale graph reached work"), override),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.equal(graphCallbacks, 0);
        assert.deepEqual(await take(), terminal);
      }
      await assert.rejects(
        graphCall("deny-initial", async () => assert.fail("denied graph reached work")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(graphCallbacks, 0);
      assert.deepEqual(await take(), terminal);
      for (const late of [
        "deny-after-work",
        "exclusive-expiry",
        "backward-clock",
        "own-head-change",
      ]) {
        await assert.rejects(
          graphCall(late, async (tx) => {
            // Controlled synthetic same-Tx mutation, NOT owning publication. Observe
            // the changed head directly and require exact outer rollback preservation.
            await tx.query(
              "UPDATE rms_catalog.option_set SET aggregate_version=2147483646 WHERE option_set_id=$1 AND brand_id=$2",
              [set, brand],
            );
            const changed = await tx.query(
              "SELECT aggregate_version FROM rms_catalog.option_set WHERE option_set_id=$1 AND brand_id=$2",
              [set, brand],
            );
            assert.equal(Number(changed.rows[0].aggregate_version), 2147483646);
            if (late === "exclusive-expiry") graphClock = plus(13);
            if (late === "backward-clock") graphClock = plus(2);
            return "TENTATIVE_UNQUALIFIED_WORK";
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.equal(graphCallbacks, 1);
        assert.deepEqual(await take(), terminal);
      }
    } finally {
      await admin.query("ROLLBACK");
      for (const role of [readerRole, writerRole]) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE IF EXISTS " + role);
      }
      await admin.end();
    }
  });
});

it("preserves immutable full Option content with exact successor, deferred rollback and isolated storage", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_option_seal" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_option_seal_" + context.runId;
    const pinnedRole = "wp2421_option_pin_" + context.runId;
    const tenant = id(800),
      brand = id(802),
      set = id(801),
      version = id(804),
      actor = id(803);
    const digest = "sha256:" + "a".repeat(64);
    const source = {
      optionSetReference: set,
      brandReference: brand,
      internalCode: "FULL_OPTION",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: actor,
      updatedAt: at,
      draft: {
        versionReference: version,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic full options" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection: 0,
        maximumSelection: 3,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 2,
        maximumTotalQuantity: 3,
        createdAt: at,
        updatedAt: at,
        options: [805, 806, 807].map((n) => ({
          optionReference: id(n),
          optionSetReference: set,
          brandReference: brand,
          stableCode: "CHOICE_" + n,
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: n - 805,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionReferences: [],
          createdAt: at,
          createdByActorReference: actor,
        })),
      },
    };
    const details = {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [805, 806, 807].map((n) => ({
        optionReference: id(n),
        quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
        media: {
          mediaReference: id(810),
          assetReference: id(811),
          assetVersionReference: id(812),
          altText: { "en-CA": "Synthetic choice image" },
        },
        pricingRule: { reference: id(820), versionReference: id(821) },
        consumption: {
          kind: n === 805 ? "Inventory" : "Recipe",
          reference: id(830 + n),
          versionReference: id(840 + n),
          quantity: "0.125",
          unitCode: "GRAM",
        },
        triggeredOptionSetVersionReference: null,
      })),
      conditionalRules: [
        { ruleReference: id(850), whenAllSelected: [id(805)], requiredOptionReferences: [id(806)] },
      ],
      conflictRules: [{ ruleReference: id(851), forbiddenTogether: [id(805), id(807)] }],
      scopeSet: [
        { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    };
    const prepared = parseCatalogOptionSetEditorContent(source, details);

    const plus = (n) => new Date(Date.parse(at) + n * 1000).toISOString();
    const scope = { tenant_id: tenant, brand_id: brand };
    const table = "rms_catalog.option_set_publication_content";
    const tables = [
      "option_set",
      "option_set_version",
      "option",
      "option_conflict",
      "option_set_operation_record",
      "option_set_draft_content_snapshot",
      "option_set_publication_content",
    ];
    const take = async () => {
      const result = {};
      for (const name of tables)
        result[name] = (
          await admin.query(
            "SELECT to_jsonb(t) row FROM rms_catalog." + name + " t ORDER BY to_jsonb(t)::text",
          )
        ).rows;
      return result;
    };
    async function scoped(settings, action) {
      const client = new Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        for (const [name, value] of Object.entries(settings))
          await client.query("SELECT set_config($1,$2,true)", ["bop." + name, value]);
        const result = await action(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    }
    const currentReader = createPostgresCurrentFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => plus(3) },
      transactions: {
        run: (action) =>
          scoped(scope, (client) => action({ query: (sql, values) => client.query(sql, values) })),
      },
      authority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(input.action, "catalog.option_set.read");
          return { observedAt: input.observedAt, validUntil: plus(8) };
        },
      },
    });
    let pinMode = "normal",
      pinHolds = 0,
      pinReads = 0,
      pinClock = plus(3),
      clockCalls = 0;
    const pinnedFor = (readTenant = tenant, readBrand = brand) =>
      createPostgresFrozenFullOptionSetContentStore({
        tenantReference: readTenant,
        brandReference: readBrand,
        actorReference: actor,
        clock: {
          now() {
            clockCalls++;
            if (pinMode === "observation-cap" && clockCalls === 2) pinClock = plus(4);
            return pinClock;
          },
        },
        transactions: {
          async run(action) {
            const client = new Client(context.clientConfig);
            await client.connect();
            try {
              await client.query(
                pinMode === "stale-isolation"
                  ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
                  : "BEGIN READ ONLY",
              );
              await client.query("SET LOCAL ROLE " + pinnedRole);
              const result = await action({
                async query(sql, values) {
                  assert.ok(
                    !/FROM rms_catalog\.(option_set|option)\s/.test(sql),
                    "no current mutable source reads",
                  );
                  const result = await client.query(sql, values);
                  if (sql.includes("FROM rms_catalog.option_set_publication_content p")) {
                    pinReads++;
                    if (pinMode === "missing-transport") return { ...result, rows: [] };
                    if (pinMode === "drift-transport" && pinReads === 2)
                      return {
                        ...result,
                        rows: result.rows.map((r) => ({ ...r, coherent: false })),
                      };
                    if (pinMode === "altered-transport") {
                      const changed = {
                        ...source,
                        draft: {
                          ...source.draft,
                          localizedNames: { "en-CA": "Altered historical transport" },
                        },
                      };
                      return {
                        ...result,
                        rows: result.rows.map((r) => ({
                          ...r,
                          snapshot: materialize(changed, id(861), id(870), plus(1)).content,
                        })),
                      };
                    }
                    if (pinMode === "microsecond-transport")
                      return {
                        ...result,
                        rows: result.rows.map((r) => ({
                          ...r,
                          metadata: { ...r.metadata, sealedAt: "2026-08-01T14:00:01.000001Z" },
                        })),
                      };
                  }
                  return result;
                },
              });
              if (pinMode === "deny-commit") throw new CatalogError("CATALOG_PERMISSION_DENIED");
              await client.query("COMMIT");
              return result;
            } catch (error) {
              await client.query("ROLLBACK");
              throw error;
            } finally {
              await client.end();
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            pinHolds++;
            assert.equal(input.tenantReference, readTenant);
            assert.equal(input.brandReference, readBrand);
            assert.equal(input.actorReference, actor);
            assert.equal(input.actorKind, "User");
            assert.equal(input.permission, "catalog.manage");
            assert.equal(input.action, "catalog.option_set.read");
            assert.equal(input.purposeCode, "CATALOG_OPTION_SET_FROZEN_CONTENT");
            assert.equal(input.optionSetReference, set);
            assert.match(input.versionReference, /^[0-9a-f-]{36}$/);
            for (const f of [
              "createdByActorReference",
              "optionDetails",
              "scopeSet",
              "effectivePeriod",
              "publicationOperationReference",
              "digest",
            ])
              assert.ok(input.requiredFields.includes(f));
            if (pinHolds === 1) assert.equal(input.content, null);
            else {
              assert.deepEqual(input.content, first.content);
              assert.equal(Object.isFrozen(input.content), false);
              input.content.editorContent.sourceAggregate.draft.localizedNames["en-CA"] =
                "Holder-owned detached copy";
            }
            if (pinMode === "deny-initial" || (pinMode === "deny-final" && pinHolds === 3))
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (pinMode === "expiry-final" && pinHolds === 3) pinClock = plus(8);
            if (pinMode === "backward-final" && pinHolds === 3) pinClock = plus(2);
            return {
              observedAt: input.observedAt,
              validUntil:
                pinMode === "observation-cap" ? plus(34) : pinHolds === 1 ? plus(8) : plus(33),
            };
          },
        },
      });
    const resetPinned = (mode = "normal") => {
      pinMode = mode;
      pinHolds = 0;
      pinReads = 0;
      pinClock = plus(3);
      clockCalls = 0;
    };
    const insertVersion = (tx, aggregate, additional, status = "Draft") => {
      const d = aggregate.draft;
      return tx.query(
        `INSERT INTO rms_catalog.option_set_version
       (option_set_version_id,option_set_id,brand_id,status,default_locale,localized_names_json,
        localized_descriptions_json,display_style,minimum_selection,maximum_selection,
        allow_repeated_option,per_option_maximum_quantity,maximum_total_quantity,created_at,updated_at,editor_content_json)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
        [
          d.versionReference,
          set,
          brand,
          status,
          d.defaultLocale,
          JSON.stringify(d.localizedNames),
          JSON.stringify(d.localizedDescriptions),
          d.displayStyle,
          d.minimumSelection,
          d.maximumSelection,
          d.allowRepeatedOption,
          d.perOptionMaximumQuantity,
          d.maximumTotalQuantity,
          d.createdAt,
          d.updatedAt,
          JSON.stringify(additional),
        ],
      );
    };
    const insertOperation = (tx, operation, action, root, instant) =>
      tx.query(
        `INSERT INTO rms_catalog.option_set_operation_record
       (operation_id,brand_id,option_set_id,action_code,intent_digest,result_aggregate_version,occurred_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [operation, brand, set, action, digest, root, instant],
      );
    const insertFull = (tx, operation, action, full, instant) => {
      const { sourceAggregate, ...additional } = full;
      const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
      return tx.query(
        `INSERT INTO rms_catalog.option_set_draft_content_snapshot
       (operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,action_code,intent_digest,
        result_aggregate_version,occurred_at,source_digest,content_digest,configuration_digest,snapshot_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [
          operation,
          tenant,
          brand,
          set,
          sourceAggregate.draft.versionReference,
          action,
          digest,
          sourceAggregate.aggregateVersion,
          instant,
          parsed.sourceDigest,
          parsed.contentDigest,
          parsed.configurationDigest,
          JSON.stringify(parsed.content),
        ],
      );
    };
    const materialize = (aggregate, operation, successor, instant) => {
      const identity = parseCatalogOptionSetEditorContent(aggregate, details);
      return createCatalogFullOptionSetPublicationMaterialization(aggregate, details, {
        tenantReference: tenant,
        brandReference: brand,
        optionSetReference: set,
        versionReference: aggregate.draft.versionReference,
        sourceAggregateVersion: aggregate.aggregateVersion,
        publicationOperationReference: operation,
        publicationIntentDigest: digest,
        successorDraftVersionReference: successor,
        sealedAt: instant,
        sourceDigest: identity.sourceDigest,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      });
    };
    const first = materialize(source, id(861), id(870), plus(1));
    const insertContent = (tx, frozen, overrides = {}) => {
      const s = frozen.supportedContent;
      const values = {
        operation: s.publicationOperationReference,
        tenant,
        brand,
        set,
        version: s.versionReference,
        successor: s.successorDraftVersionReference,
        action: "Publish",
        intent: s.publicationIntentDigest,
        sourceRoot: s.sourceAggregateVersion,
        resultRoot: s.sourceAggregateVersion + 1,
        sealedAt: s.sealedAt,
        source: frozen.sourceDigest,
        body: frozen.contentDigest,
        config: frozen.configurationDigest,
        record: frozen.digest,
        snapshot: frozen,
        ...overrides,
      };
      return tx.query(
        `INSERT INTO rms_catalog.option_set_publication_content
       (operation_id,tenant_id,brand_id,option_set_id,option_set_version_id,successor_draft_version_id,
        action_code,intent_digest,source_aggregate_version,result_aggregate_version,sealed_at,
        source_digest,content_digest,configuration_digest,record_digest,snapshot_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
        [
          values.operation,
          values.tenant,
          values.brand,
          values.set,
          values.version,
          values.successor,
          values.action,
          values.intent,
          values.sourceRoot,
          values.resultRoot,
          values.sealedAt,
          values.source,
          values.body,
          values.config,
          values.record,
          JSON.stringify(values.snapshot),
        ],
      );
    };
    let tentative = 0;
    const transition = (plan, mode = "normal") =>
      scoped(scope, async (tx) => {
        tentative = 0;
        const s = plan.content.supportedContent;
        if (mode === "changed-frozen-core")
          await tx.query(
            "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb WHERE option_set_version_id=$1",
            [s.versionReference, JSON.stringify({ "en-CA": "Unlogged old core" })],
          );
        tentative += (
          await tx.query(
            "UPDATE rms_catalog.option_set_version SET status='Frozen' WHERE option_set_version_id=$1 RETURNING option_set_version_id",
            [s.versionReference],
          )
        ).rowCount;
        tentative += (await insertVersion(tx, plan.successor, details)).rowCount;
        if (mode !== "missing-operation")
          tentative += (
            await insertOperation(
              tx,
              s.publicationOperationReference,
              "Publish",
              plan.successor.aggregateVersion,
              s.sealedAt,
            )
          ).rowCount;
        if (mode !== "missing-content")
          tentative += (await insertContent(tx, plan.content)).rowCount;
        if (mode !== "wrong-root")
          tentative += (
            await tx.query(
              "UPDATE rms_catalog.option_set SET aggregate_version=$2,updated_at=$3 WHERE option_set_id=$1",
              [set, plan.successor.aggregateVersion, s.sealedAt],
            )
          ).rowCount;
        if (mode !== "missing-content" && mode !== "wrong-root") {
          const changed = await tx.query(
            "UPDATE rms_catalog.option SET option_set_version_id=$1 WHERE option_set_version_id=$2 AND ($3::uuid IS NULL OR option_id<>$3)",
            [
              s.successorDraftVersionReference,
              s.versionReference,
              mode === "partial-options" ? id(807) : null,
            ],
          );
          assert.equal(changed.rowCount, mode === "partial-options" ? 2 : 3);
          tentative += changed.rowCount;
        }
        if (mode === "changed-option")
          await tx.query(
            "UPDATE rms_catalog.option SET localized_names_json=$2::jsonb WHERE option_id=$1",
            [id(805), JSON.stringify({ "en-CA": "Unlogged current choice" })],
          );
        if (mode !== "missing-result") {
          const full =
            mode === "changed-successor"
              ? {
                  ...plan.successorEditorContent,
                  optionDetails: plan.successorEditorContent.optionDetails.map((o) => ({
                    ...o,
                    media: { ...o.media, altText: { "en-CA": "Unlogged successor text" } },
                  })),
                }
              : plan.successorEditorContent;
          tentative += (
            await insertFull(tx, s.publicationOperationReference, "Publish", full, s.sealedAt)
          ).rowCount;
        }
        return tentative;
      });
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query(
        "CREATE ROLE " +
          pinnedRole +
          " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
      );
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + pinnedRole);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          pinnedRole,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.option_set_publication_content,rms_catalog.option_set_version,rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot TO " +
          pinnedRole,
      );
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog,platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON " +
          tables.map((t) => "rms_catalog." + t).join(",") +
          " TO " +
          role,
      );
      await admin.query(
        `INSERT INTO rms_catalog.option_set
       (option_set_id,brand_id,internal_code,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES($1,$2,'FULL_OPTION','Draft',1,$3,$4,$3)`,
        [set, brand, at, actor],
      );
      await insertVersion(admin, source, details);
      for (const o of source.draft.options)
        await admin.query(
          `INSERT INTO rms_catalog.option
         (option_id,option_set_version_id,option_set_id,brand_id,stable_code,lifecycle,
          localized_names_json,localized_descriptions_json,sort_order,default_eligible,created_at,created_by_actor_id)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)`,
          [
            o.optionReference,
            version,
            set,
            brand,
            o.stableCode,
            o.lifecycle,
            JSON.stringify(o.localizedNames),
            JSON.stringify(o.localizedDescriptions),
            o.sortOrder,
            o.defaultEligible,
            o.createdAt,
            actor,
          ],
        );
      await insertOperation(admin, id(860), "Create", 1, at);
      await scoped(scope, (tx) => insertFull(tx, id(860), "Create", prepared.content, at));
      const before = await take();
      for (const mode of [
        "missing-operation",
        "missing-content",
        "missing-result",
        "wrong-root",
        "changed-successor",
        "partial-options",
        "changed-option",
        "changed-frozen-core",
      ]) {
        await assert.rejects(transition(first, mode), (e) => ["23503", "23514"].includes(e.code));
        assert.ok(tentative >= 4, "actual tentative writes before deferred failure");
        assert.deepEqual(await take(), before);
      }
      // Source root7 is a controlled unlogged source, not contiguous history.
      const noProvenance = materialize(
        { ...source, aggregateVersion: 7 },
        id(861),
        id(870),
        plus(1),
      );
      await assert.rejects(transition(noProvenance), { code: "23514" });
      assert.ok(tentative >= 8);
      assert.deepEqual(await take(), before);
      // A standalone frozen version cannot be committed without its exact content.
      await assert.rejects(
        scoped(scope, (tx) =>
          tx.query(
            "UPDATE rms_catalog.option_set_version SET status='Frozen' WHERE option_set_version_id=$1",
            [version],
          ),
        ),
        { code: "23514" },
      );
      assert.deepEqual(await take(), before);
      await assert.rejects(
        scoped(scope, (tx) =>
          tx.query(
            "UPDATE rms_catalog.option_set_version SET created_at=$2 WHERE option_set_version_id=$1",
            [version, plus(1)],
          ),
        ),
        { code: "23514" },
      );
      assert.equal(
        (
          await scoped(scope, (tx) =>
            tx.query(
              "UPDATE rms_catalog.option_set_version SET localized_names_json=localized_names_json WHERE option_set_version_id=$1 RETURNING option_set_version_id",
              [version],
            ),
          )
        ).rowCount,
        1,
      );
      for (const [overrides, code] of [
        [{ action: "Create" }, "23514"],
        [{ sourceRoot: 0 }, "23514"],
        [{ resultRoot: 3 }, "23514"],
        [{ sourceRoot: 2147483647, resultRoot: 2147483647 }, "23514"],
        [{ source: "invalid" }, "23514"],
        [{ record: "sha256:" + "b".repeat(64) }, "23514"],
        [{ snapshot: {} }, "23514"],
        [{ snapshot: { ...first.content, eligibility: "Ready" } }, "23514"],
        [{ tenant: id(899) }, "42501"],
        [{ version: id(899) }, "23514"],
        [{ sealedAt: "2026-08-01T14:00:01.000001Z" }, "23514"],
      ]) {
        await assert.rejects(
          scoped(scope, (tx) => insertContent(tx, first.content, overrides)),
          { code },
        );
        assert.deepEqual(await take(), before);
      }
      assert.ok((await transition(first)) >= 8);
      const readBefore = await take();
      const currentTwo = await currentReader.readCurrent({
        optionSetReference: set,
        expectedAggregateVersion: 2,
      });
      assert.deepEqual(currentTwo.content, first.successorEditorContent);
      assert.equal(currentTwo.referenceEligibility, "NotEvaluated");
      assert.deepEqual(await take(), readBefore);
      const persisted = await scoped(scope, (tx) => tx.query("SELECT * FROM " + table));
      assert.equal(persisted.rows.length, 1);
      assert.deepEqual(
        parseCatalogFullOptionSetPublicationContent(persisted.rows[0].snapshot_json),
        first.content,
      );
      assert.equal(persisted.rows[0].record_digest, first.content.digest);
      assert.equal(
        persisted.rows[0].snapshot_json.editorContent.optionDetails[0].consumption.quantity,
        "0.125",
      );
      assert.equal(persisted.rows[0].snapshot_json.eligibility, "NotEvaluated");
      for (const settings of [
        {},
        { brand_id: brand },
        { tenant_id: tenant },
        { tenant_id: id(899), brand_id: brand },
        { tenant_id: tenant, brand_id: id(898) },
        { ...scope, store_id: id(897) },
      ]) {
        assert.equal(
          (await scoped(settings, (tx) => tx.query("SELECT * FROM " + table))).rows.length,
          0,
        );
        await assert.rejects(
          scoped(settings, (tx) => insertContent(tx, first.content)),
          { code: "42501" },
        );
      }
      const frozen = await take();
      for (const sql of [
        "UPDATE " + table + " SET content_digest=content_digest",
        "DELETE FROM " + table,
        "UPDATE rms_catalog.option_set_version SET status='Draft' WHERE option_set_version_id=$1",
        "UPDATE rms_catalog.option_set_version SET localized_names_json='{}'::jsonb WHERE option_set_version_id=$1",
        "DELETE FROM rms_catalog.option_set_version WHERE option_set_version_id=$1",
      ]) {
        await assert.rejects(
          scoped(scope, (tx) => tx.query(sql, sql.includes("$1") ? [version] : undefined)),
          { code: "55000" },
        );
        assert.deepEqual(await take(), frozen);
      }
      await assert.rejects(
        scoped(scope, (tx) =>
          tx.query("UPDATE rms_catalog.option SET option_set_version_id=$1 WHERE option_id=$2", [
            version,
            id(805),
          ]),
        ),
        { code: "23514" },
      );
      assert.deepEqual(await take(), frozen);
      const second = materialize(first.successor, id(862), id(871), plus(2));
      assert.ok((await transition(second)) >= 8);
      const currentThree = await currentReader.readCurrent({
        optionSetReference: set,
        expectedAggregateVersion: 3,
      });
      assert.deepEqual(currentThree.content, second.successorEditorContent);
      assert.equal(currentThree.referenceEligibility, "NotEvaluated");
      const state = await take();
      assert.equal(state.option_set_version.filter((r) => r.row.status === "Frozen").length, 2);
      assert.equal(state.option_set_version.filter((r) => r.row.status === "Draft").length, 1);
      assert.equal(state.option_set_publication_content.length, 2);
      assert.deepEqual(
        (
          await scoped(scope, (tx) =>
            tx.query("SELECT * FROM " + table + " WHERE operation_id=$1", [id(861)]),
          )
        ).rows,
        persisted.rows,
      );
      assert.deepEqual(
        state.option.map((r) => r.row.option_id).sort(),
        source.draft.options.map((o) => o.optionReference).sort(),
      );
      assert.ok(state.option.every((r) => r.row.option_set_version_id === id(871)));
      await assert.rejects(
        scoped(scope, (tx) =>
          insertVersion(
            tx,
            {
              ...second.successor,
              draft: { ...second.successor.draft, versionReference: id(872) },
            },
            details,
          ),
        ),
        { code: "23505" },
      );
      await scoped(scope, (tx) =>
        tx.query(
          "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb,editor_content_json=NULL WHERE option_set_version_id=$1 RETURNING option_set_version_id",
          [id(871), JSON.stringify({ "en-CA": "Later editable Draft" })],
        ),
      );
      assert.deepEqual(
        (
          await scoped(scope, (tx) =>
            tx.query("SELECT * FROM " + table + " WHERE operation_id=$1", [id(861)]),
          )
        ).rows,
        persisted.rows,
      );
      const unavailableBefore = await take();
      await assert.rejects(
        currentReader.readCurrent({ optionSetReference: set, expectedAggregateVersion: null }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await take(), unavailableBefore);
      assert.equal(
        parseCatalogFullOptionSetPublicationContent(persisted.rows[0].snapshot_json).editorContent
          .sourceAggregate.draft.versionReference,
        version,
      );
      // This actual held source reads the old full version after two seals and
      // later unlogged changes/NULL in today's Draft. No current eligibility asserted.
      const pinnedInput = {
        optionSetReference: set,
        versionReference: version,
        expectedRecordDigest: first.content.digest,
      };
      resetPinned();
      const pinnedBefore = await take(),
        pinned = await pinnedFor().readPinned(pinnedInput);
      assert.deepEqual(pinned.content, first.content);
      assert.equal(pinned.eligibility, "NotEvaluated");
      assert.equal(pinned.observedAt, plus(3));
      assert.equal(pinned.validUntil, plus(8));
      assert.equal(pinReads, 2);
      assert.equal(pinHolds, 3);
      assert.deepEqual(await take(), pinnedBefore);
      resetPinned("observation-cap");
      const capped = await pinnedFor().readPinned(pinnedInput);
      assert.equal(capped.validUntil, plus(33));
      assert.equal(capped.observedAt, plus(3));
      for (const mode of [
        "deny-initial",
        "deny-final",
        "deny-commit",
        "expiry-final",
        "backward-final",
        "stale-isolation",
        "missing-transport",
        "drift-transport",
        "altered-transport",
        "microsecond-transport",
      ]) {
        resetPinned(mode);
        await assert.rejects(pinnedFor().readPinned(pinnedInput), {
          code: mode.startsWith("deny")
            ? "CATALOG_PERMISSION_DENIED"
            : mode === "missing-transport"
              ? "CATALOG_UNAVAILABLE"
              : "CATALOG_DEPENDENCY_UNAVAILABLE",
        });
        assert.deepEqual(await take(), pinnedBefore);
      }
      resetPinned();
      pinClock = at;
      await assert.rejects(pinnedFor().readPinned(pinnedInput), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      for (const [t, b] of [
        [id(899), brand],
        [tenant, id(898)],
      ]) {
        resetPinned();
        await assert.rejects(pinnedFor(t, b).readPinned(pinnedInput), {
          code: "CATALOG_UNAVAILABLE",
        });
      }
      for (const ref of [id(871), id(899)]) {
        resetPinned();
        await assert.rejects(pinnedFor().readPinned({ ...pinnedInput, versionReference: ref }), {
          code: "CATALOG_UNAVAILABLE",
        });
      }
      resetPinned();
      await assert.rejects(
        pinnedFor().readPinned({
          ...pinnedInput,
          expectedRecordDigest: "sha256:" + "b".repeat(64),
        }),
        { code: "CATALOG_VERSION_CONFLICT" },
      );
      resetPinned();
      const getter = { ...pinnedInput };
      Object.defineProperty(getter, "versionReference", {
        enumerable: true,
        get() {
          return assert.fail("getter must not run");
        },
      });
      await assert.rejects(pinnedFor().readPinned(getter), { code: "CATALOG_INPUT_INVALID" });
      assert.equal(pinHolds, 0);
      for (const invalid of [
        { ...pinnedInput, eligibility: "Ready" },
        { ...pinnedInput, expectedRecordDigest: "invalid" },
        { ...pinnedInput, versionReference: "invalid" },
      ])
        await assert.rejects(pinnedFor().readPinned(invalid), { code: "CATALOG_INPUT_INVALID" });
      assert.deepEqual(await take(), pinnedBefore);
      // The proposed Binding is the only source request; graph content comes
      // from actual pinned Frozen records in this same caller transaction.
      const proposedBinding = {
        bindingReference: id(890),
        optionSetReference: set,
        optionSetVersionReference: version,
        purpose: "CUSTOMIZATION",
        sortOrder: 0,
        enabledOptionReferences: [id(805), id(806), id(807)],
        defaultSelections: [
          { optionReference: id(805), quantity: 1 },
          { optionReference: id(806), quantity: 1 },
        ],
        minimumSelectionOverride: null,
        maximumSelectionOverride: null,
        includedSkuReferences: [],
        excludedSkuReferences: [],
        channelCodes: ["POS"],
        storeOverrideAllowed: false,
      };
      let assessmentClock = plus(3),
        assessmentHolds = 0,
        afterWork = false,
        assessmentMode = "normal";
      const graphSource = createFrozenFullOptionBindingRuleSource({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now: () => assessmentClock },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assessmentHolds++;
            assert.equal(input.action, "catalog.option_set.read");
            assert.equal(input.purposeCode, "CATALOG_OPTION_SET_FROZEN_CONTENT");
            assert.equal(input.optionSetReference, set);
            assert.equal(input.versionReference, version);
            if (afterWork && assessmentMode === "deny-late")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            return { observedAt: input.observedAt, validUntil: plus(8) };
          },
        },
      });
      const assess = (binding, work) =>
        scoped(scope, (client) =>
          graphSource.withPinnedAssessment(
            { query: (sql, values) => client.query(sql, values) },
            binding,
            work,
          ),
        );
      const assessmentBefore = await take();
      const assessed = await assess(proposedBinding, async (result) => result);
      assert.equal(assessed.profile, "FrozenFullOptionBindingRuleAssessmentV1");
      assert.deepEqual(assessed.rules, { status: "Satisfiable", reason: null, searchNodes: 1 });
      assert.equal(assessed.eligibility, "NotEvaluated");
      assert.equal(assessed.referenceEligibility, "NotEvaluated");
      assert.equal(assessed.publishValidation, "Incomplete");
      assert.equal(assessed.validUntil, plus(8));
      assert.equal(assessmentHolds, 6);
      assert.deepEqual(assessed.sourceRecords, [
        {
          optionSetReference: set,
          versionReference: version,
          recordDigest: first.content.digest,
          observedAt: plus(3),
        },
      ]);
      for (const field of ["content", "graph", "binding", "witness"])
        assert.equal(Object.hasOwn(assessed, field), false);
      const unmet = await assess(
        { ...proposedBinding, defaultSelections: [{ optionReference: id(805), quantity: 1 }] },
        async (result) => result,
      );
      assert.equal(unmet.rules.status, "Unsatisfiable");
      assert.equal(unmet.rules.reason, "NoSelection");
      const conflicting = await assess(
        {
          ...proposedBinding,
          defaultSelections: [
            { optionReference: id(805), quantity: 1 },
            { optionReference: id(807), quantity: 1 },
          ],
        },
        async (result) => result,
      );
      assert.equal(conflicting.rules.status, "Unsatisfiable");
      assert.deepEqual(await take(), assessmentBefore);
      for (const mode of ["deny-late", "expiry-late"]) {
        assessmentMode = mode;
        assessmentClock = plus(3);
        afterWork = false;
        assessmentHolds = 0;
        let wrote = false;
        await assert.rejects(
          scoped(scope, (client) =>
            graphSource.withPinnedAssessment(
              { query: (sql, values) => client.query(sql, values) },
              proposedBinding,
              async (result) => {
                assert.equal(result.rules.status, "Satisfiable");
                const changed = await client.query(
                  "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb WHERE option_set_version_id=$1 RETURNING option_set_version_id",
                  [id(871), JSON.stringify({ "en-CA": "Tentative consumer Draft" })],
                );
                assert.equal(changed.rowCount, 1);
                wrote = true;
                afterWork = true;
                if (mode === "expiry-late") assessmentClock = plus(8);
                return "written";
              },
            ),
          ),
          {
            code:
              mode === "deny-late" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
          },
        );
        assert.equal(wrote, true);
        assert.ok(assessmentHolds >= 3);
        assert.deepEqual(await take(), assessmentBefore);
      }
      assessmentMode = "normal";
      assessmentClock = plus(3);
      afterWork = false;
      let called = false;
      await assert.rejects(
        assess({ ...proposedBinding, graph: first.content }, async () => {
          called = true;
        }),
        { code: "CATALOG_INPUT_INVALID" },
      );
      assert.equal(called, false);
      assert.deepEqual(await take(), assessmentBefore);
      // New actual current Product consumer. Owning Create/ReplaceDraft writes
      // persist the Binding; reference/field holders remain controlled synthetic.
      const {
        createPostgresProductCreationStore,
        createPostgresProductDraftStore,
        createPostgresProductLifecycleStore,
        parseProductAggregate,
        deriveCatalogProductPublicationContentIdentity,
      } = await import("../../rms/catalog/src/index.ts");
      const { sha256Hex } = await import("../../bop/audit/src/index.ts");
      await admin.query("GRANT USAGE ON SCHEMA platform_audit,platform_eventing TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product_source_head,platform_audit.audit_chain_head TO " +
          role,
      );
      const product = id(910),
        productVersion = id(911),
        sku = id(912),
        productTime = plus(3);
      const productDetails = {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [{ selections: [], disposition: "Valid", skuReference: sku }],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      };
      const initialProduct = parseProductAggregate({
        productReference: product,
        brandReference: brand,
        internalCode: "OPTION_RULE_SYNTHETIC",
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: productTime,
        createdByActorReference: actor,
        updatedAt: productTime,
        draft: {
          versionReference: productVersion,
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic bound Product" },
          taxClassificationReference: null,
          createdAt: productTime,
          updatedAt: productTime,
          editorContent: productDetails,
          skus: [
            {
              skuReference: sku,
              productReference: product,
              brandReference: brand,
              skuCode: "OPTION_RULE_SYNTHETIC_ONE",
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic SKU" },
              variantSelections: [],
              unitOfSale: "EA",
              unitQuantity: "1",
              createdAt: productTime,
              createdByActorReference: actor,
            },
          ],
          optionBindings: [],
        },
      });
      const productOptions = {
        brandReference: brand,
        transactions: {
          run: (action) =>
            scoped(scope, (client) =>
              action({ query: (sql, values) => client.query(sql, values) }),
            ),
        },
        authorize: async () => true,
        editorContentAuthority: {
          async holdUntilTransactionCompletes() {
            return undefined;
          },
        },
      };
      const productAudit = (n, actionCode) => ({
        auditId: id(n),
        brandId: brand,
        actor: { type: "User", reference: actor },
        actionCode,
        targetType: "CatalogProduct",
        targetId: product,
        correlationId: id(n),
        occurredAt: productTime,
        reasonCode: "SYNTHETIC_OPTION_SOURCE",
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      await createPostgresProductCreationStore(productOptions).create({
        record: {
          action: "Create",
          operationReference: id(913),
          operationIntentHash: sha256Hex("synthetic bound Product creation"),
          aggregate: initialProduct,
        },
        audit: productAudit(913, "CATALOG_PRODUCT_CREATE"),
      });
      const boundProduct = parseProductAggregate({
        ...initialProduct,
        aggregateVersion: 2,
        draft: {
          ...initialProduct.draft,
          optionBindings: [proposedBinding],
          editorContent: {
            ...productDetails,
            optionRules: [
              {
                bindingReference: proposedBinding.bindingReference,
                versionResolution: "Pinned",
                pricingRule: null,
                conditionalRule: null,
                conflictRule: null,
                variantCondition: [],
              },
            ],
          },
        },
      });
      await createPostgresProductDraftStore(productOptions).commit({
        record: {
          action: "ReplaceDraft",
          operationReference: id(914),
          operationIntentHash: sha256Hex("synthetic persisted Option Binding"),
          aggregate: boundProduct,
        },
        expectedAggregateVersion: 1,
        audit: productAudit(914, "CATALOG_PRODUCT_REPLACEDRAFT"),
      });
      const identity = deriveCatalogProductPublicationContentIdentity(boundProduct);
      const validateProduct = {
        purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        operationReference: id(915),
        productReference: product,
        versionReference: productVersion,
        expectedProductAggregateVersion: 2,
        expectedPublicationVersion: 0,
        action: "Validate",
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        scopeSet: [{ level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: {
            instant: productTime,
            localDateTime: productTime.slice(0, 23),
            utcOffsetMinutes: 0,
          },
          effectiveUntil: null,
        },
        scheduleReference: null,
        replacementVersionReference: null,
        successorDraftVersionReference: null,
        occurredAt: productTime,
        reasonCode: "SYNTHETIC_OPTION_VALIDATE",
      };
      let joinedClock = plus(3),
        joinedMode = "normal",
        joinedAfterWork = false,
        joinedCandidateHolds = 0,
        joinedOptionHolds = 0;
      const joinedSource = createCurrentProductCandidateOptionRuleSource({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now: () => joinedClock },
        candidateAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            joinedCandidateHolds++;
            assert.equal(input.owningAction, "catalog.product.validate");
            assert.ok(input.requiredFields.includes("optionBindings"));
            if (joinedAfterWork && joinedMode === "candidate-deny")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (joinedAfterWork && joinedMode === "candidate-final-expiry") joinedClock = plus(8);
          },
        },
        optionAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            joinedOptionHolds++;
            assert.equal(input.versionReference, version);
            assert.equal(input.action, "catalog.option_set.read");
            if (joinedAfterWork && joinedMode === "option-deny")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            return { observedAt: input.observedAt, validUntil: plus(8) };
          },
        },
      });
      const joinedRun = (command, work) =>
        scoped(scope, (client) =>
          joinedSource.withCurrentAssessment(
            { query: (sql, values) => client.query(sql, values) },
            command,
            work,
          ),
        );
      const productCounts = async () =>
        (
          await admin.query(
            "SELECT (SELECT aggregate_version FROM rms_catalog.product WHERE product_id=$1) root,(SELECT count(*)::int FROM rms_catalog.product_operation_record WHERE product_id=$1) operations,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot WHERE product_id=$1) snapshots,(SELECT count(*)::int FROM rms_catalog.product_source_commit WHERE product_id=$1) commits,(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) audit,(SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE aggregate_id=$1) outbox",
            [product],
          )
        ).rows[0];
      const joinedBefore = await productCounts(),
        optionBeforeJoined = await take();
      // Complete Draft pinned-rule prerequisite; Product/current fields and
      // all remaining-five qualification holders are explicitly synthetic.
      let draftClock = plus(3),
        draftMode = "normal",
        draftAfterWork = false,
        draftOptionHolds = 0,
        draftFieldHolds = 0,
        draftWrote = 0;
      const draftInput = (aggregate = boundProduct, mode = "DraftWrite") => ({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        storeReference: id(916),
        sessionReference: id(917),
        productReference: product,
        operationReference: id(918),
        permission: "catalog.manage",
        owningAction: "catalog.product.manage",
        purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE",
        observedAt: plus(3),
        validUntil: plus(8),
        mode,
        aggregate,
        requiredFields: productEditorContentFields,
        requiredReferenceChecks:
          mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
      });
      const draftAuthority = () =>
        createMerchantProductEditorPinnedOptionAuthority({
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          clock: { now: () => draftClock },
          optionAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              draftOptionHolds++;
              assert.equal(input.tenantReference, tenant);
              assert.equal(input.brandReference, brand);
              assert.equal(input.actorReference, actor);
              assert.equal(input.action, "catalog.option_set.read");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_FROZEN_CONTENT");
              assert.equal(input.versionReference, version);
              if (draftMode === "initial-deny" || (draftAfterWork && draftMode === "source-deny"))
                throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return { observedAt: input.observedAt, validUntil: plus(30) };
            },
          },
          async remainingAuthority(tx, input) {
            draftFieldHolds++;
            assert.deepEqual(input.requiredFields, productEditorContentFields);
            assert.deepEqual(
              input.requiredReferenceChecks,
              input.mode === "Read" ? [] : remainingProductEditorVariantReferenceChecks,
            );
            assert.equal(input.validUntil, plus(8));
            if (input.mode === "Read" || draftMode === "normal") return;
            const changed = await tx.query(
              "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb WHERE option_set_version_id=$1 RETURNING option_set_version_id",
              [id(871), JSON.stringify({ "en-CA": "Tentative complete Draft consumer" })],
            );
            assert.equal(changed.rowCount, 1);
            const observed = await tx.query(
              "SELECT localized_names_json->>'en-CA' name FROM rms_catalog.option_set_version WHERE option_set_version_id=$1",
              [id(871)],
            );
            assert.equal(observed.rows[0].name, "Tentative complete Draft consumer");
            draftWrote++;
            draftAfterWork = true;
            if (draftMode === "field-deny") throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (draftMode === "expiry") draftClock = plus(8);
          },
        });
      const draftRun = (input, after = async () => undefined) =>
        scoped(scope, async (client) => {
          const tx = { query: (sql, values) => client.query(sql, values) };
          await draftAuthority()(tx, input);
          await after();
        });
      await draftRun(draftInput());
      assert.equal(draftOptionHolds, 6);
      assert.equal(draftFieldHolds, 1);
      assert.deepEqual(await take(), optionBeforeJoined);
      assert.deepEqual(await productCounts(), joinedBefore);
      const withoutDefaults = parseProductAggregate({
        ...boundProduct,
        draft: {
          ...boundProduct.draft,
          optionBindings: [
            { ...proposedBinding, defaultSelections: [{ optionReference: id(805), quantity: 1 }] },
          ],
        },
      });
      const fieldsBeforeConflict = draftFieldHolds,
        sourceBeforeConflict = draftOptionHolds;
      await assert.rejects(draftRun(draftInput(withoutDefaults)), {
        code: "CATALOG_LIFECYCLE_CONFLICT",
      });
      assert.equal(draftFieldHolds, fieldsBeforeConflict);
      assert.equal(
        draftOptionHolds - sourceBeforeConflict,
        6,
        "known conflict waits for owning final holds",
      );
      const currentPublished = parseProductAggregate({
        ...boundProduct,
        draft: {
          ...boundProduct.draft,
          editorContent: {
            ...boundProduct.draft.editorContent,
            optionRules: boundProduct.draft.editorContent.optionRules.map((rule) => ({
              ...rule,
              versionResolution: "CurrentPublished",
            })),
          },
        },
      });
      const beforeCurrent = draftOptionHolds;
      await assert.rejects(draftRun(draftInput(currentPublished)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal(draftOptionHolds, beforeCurrent);
      draftMode = "initial-deny";
      await assert.rejects(draftRun(draftInput()), { code: "CATALOG_PERMISSION_DENIED" });
      await draftRun(draftInput(boundProduct, "Read"));
      for (const mode of ["source-deny", "field-deny", "expiry", "controlled-complete"]) {
        draftMode = mode;
        draftClock = plus(3);
        draftAfterWork = false;
        draftWrote = 0;
        await assert.rejects(
          draftRun(draftInput(), async () => {
            throw new Error("SYNTHETIC_DRAFT_OPTION_PROBE_ROLLBACK");
          }),
          mode === "controlled-complete"
            ? { message: "SYNTHETIC_DRAFT_OPTION_PROBE_ROLLBACK" }
            : {
                code:
                  mode === "expiry"
                    ? "CATALOG_DEPENDENCY_UNAVAILABLE"
                    : "CATALOG_PERMISSION_DENIED",
              },
        );
        assert.equal(draftWrote, 1);
        assert.deepEqual(await take(), optionBeforeJoined);
        assert.deepEqual(await productCounts(), joinedBefore);
      }
      draftMode = "normal";
      draftClock = plus(3);
      draftAfterWork = false;
      await draftRun(draftInput());
      assert.deepEqual(await take(), optionBeforeJoined);
      assert.deepEqual(await productCounts(), joinedBefore);
      const joined = await joinedRun(validateProduct, async (result) => result);
      assert.equal(joined.profile, "CurrentProductCandidateOptionRulesV1");
      assert.equal(joined.aggregateVersion, 2);
      assert.equal(joined.productReference, product);
      assert.equal(joined.contentDigest, identity.contentDigest);
      assert.equal(joined.configurationDigest, identity.configurationDigest);
      assert.equal(joined.bindingCount, 1);
      assert.equal(joined.bindings[0].bindingReference, proposedBinding.bindingReference);
      assert.equal(joined.bindings[0].assessmentDigest, assessed.digest);
      assert.equal(joined.bindings[0].rules.status, "Satisfiable");
      assert.equal(joined.validUntil, plus(8));
      assert.equal(joined.publishValidation, "Incomplete");
      assert.equal(joined.eligibility, "NotEvaluated");
      assert.equal(joinedOptionHolds, 6);
      assert.ok(joinedCandidateHolds >= 2);
      for (const field of ["aggregate", "content", "graph", "witness"])
        assert.equal(Object.hasOwn(joined, field), false);
      const optionsBeforeWrong = joinedOptionHolds;
      await assert.rejects(
        joinedRun({ ...validateProduct, contentDigest: "sha256:" + "f".repeat(64) }, async () =>
          assert.fail("wrong candidate"),
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(joinedOptionHolds, optionsBeforeWrong);
      for (const mode of ["candidate-deny", "option-deny", "expiry", "candidate-final-expiry"]) {
        joinedMode = mode;
        joinedClock = plus(3);
        joinedAfterWork = false;
        let wrote = 0;
        await assert.rejects(
          scoped(scope, (client) => {
            const tx = { query: (sql, values) => client.query(sql, values) };
            return joinedSource.withCurrentAssessment(tx, validateProduct, async (result) => {
              assert.equal(result.bindingCount, 1);
              const changed = await createPostgresProductDraftStore({
                ...productOptions,
                transactions: { run: (callback) => callback(tx) },
              }).commit({
                record: {
                  action: "ReplaceDraft",
                  operationReference: id(916),
                  operationIntentHash: sha256Hex("synthetic joined Option rollback"),
                  aggregate: parseProductAggregate({
                    ...boundProduct,
                    aggregateVersion: 3,
                    draft: {
                      ...boundProduct.draft,
                      localizedNames: { "en-CA": "Tentative Product content" },
                    },
                  }),
                },
                expectedAggregateVersion: 2,
                audit: productAudit(916, "CATALOG_PRODUCT_REPLACEDRAFT"),
              });
              assert.equal(changed.aggregate.aggregateVersion, 3);
              wrote++;
              joinedAfterWork = true;
              if (mode === "expiry") joinedClock = plus(8);
              return "written";
            });
          }),
          {
            code: mode.endsWith("deny")
              ? "CATALOG_PERMISSION_DENIED"
              : "CATALOG_DEPENDENCY_UNAVAILABLE",
          },
        );
        assert.equal(wrote, 1);
        assert.deepEqual(await productCounts(), joinedBefore);
        assert.deepEqual(await take(), optionBeforeJoined);
      }
      joinedMode = "normal";
      joinedClock = plus(3);
      joinedAfterWork = false;
      assert.deepEqual(
        await createPostgresProductLifecycleStore(productOptions).load(product),
        boundProduct,
      );
      assert.deepEqual(await productCounts(), joinedBefore);
      assert.deepEqual(await take(), optionBeforeJoined);
      const acl = await admin.query(
        "SELECT has_table_privilege($1,'rms_catalog.option_set_publication_content','SELECT') can_read,has_table_privilege($1,'rms_catalog.option_set_publication_content','UPDATE') can_write",
        [pinnedRole],
      );
      assert.deepEqual(acl.rows, [{ can_read: true, can_write: false }]);
    } finally {
      await admin.query("DROP OWNED BY " + pinnedRole);
      await admin.query("DROP ROLE " + pinnedRole);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});

it("seals full Option content through owning writer with original recovery and atomic rollback", async () => {
  await withIsolatedDatabase({ caseId: "wp2421_seal_writer" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2421_option_writer_seal_" + context.runId,
      tenant = id(7000),
      brand = id(7001),
      actor = id(7002);
    const plus = (seconds) => new Date(Date.parse(at) + seconds * 1000).toISOString();
    const request = {
      internalCode: "FULL_SEAL",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic initial choices" },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 3,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 3,
        options: ["OAT", "SOY", "DAIRY"].map((stableCode, sortOrder) => ({
          stableCode,
          sortOrder,
          lifecycle: "Draft",
          localizedNames: { "en-CA": stableCode },
          localizedDescriptions: {},
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: stableCode === "OAT" ? ["DAIRY"] : [],
        })),
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: ["OAT", "SOY", "DAIRY"].map((stableCode) => ({
          stableCode,
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: {
            mediaReference: id(6050),
            assetReference: id(6051),
            assetVersionReference: id(6052),
            altText: { "en-CA": "Synthetic image" },
          },
          pricingRule: { reference: id(6060), versionReference: id(6061) },
          consumption: {
            kind: "Inventory",
            reference: id(6070),
            versionReference: id(6071),
            quantity: "0.125",
            unitCode: "GRAM",
          },
          triggeredOptionSetVersionReference: null,
        })),
        conditionalRules: [
          { ruleReference: id(6080), whenAllSelectedCodes: ["OAT"], requiredOptionCodes: ["SOY"] },
        ],
        conflictRules: [{ ruleReference: id(6081), forbiddenTogetherCodes: ["OAT", "DAIRY"] }],
        scopeSet: [
          { level: "Brand", reference: null, channelCodes: ["POS"], orderTypeCodes: ["PICKUP"] },
        ],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
      operationReference: id(7100),
      occurredAt: at,
      reasonCode: "INITIAL_CONFIGURATION",
    };
    const tables = [
      "rms_catalog.option_set",
      "rms_catalog.option_set_version",
      "rms_catalog.option",
      "rms_catalog.option_conflict",
      "rms_catalog.option_set_operation_record",
      "rms_catalog.option_set_draft_content_snapshot",
      "rms_catalog.option_set_publication_content",
      "platform_audit.audit_record",
      "platform_audit.audit_chain_head",
      "platform_eventing.outbox_event",
    ];
    const take = async () => {
      const result = {};
      for (const table of tables)
        result[table] = (
          await admin.query(
            "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
          )
        ).rows;
      return result;
    };
    let clock = at,
      mode = "normal",
      applyHolds = 0,
      rootWrites = 0,
      allocations = 0,
      event = 0,
      next = 7200,
      set,
      originalVersion;
    const transactions = {
      async run(work) {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query(
            mode === "stale-isolation" ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
          );
          await client.query("SET LOCAL ROLE " + role);
          const result = await work({
            async query(sql, values) {
              if (
                mode === "audit-failure" &&
                sql.includes("INSERT INTO platform_audit.audit_record")
              )
                throw new Error("synthetic audit failure");
              if (
                mode === "outbox-failure" &&
                sql.includes("INSERT INTO platform_eventing.outbox_event")
              )
                throw new Error("synthetic outbox failure");
              const r = await client.query(sql, values);
              if (sql.startsWith("UPDATE rms_catalog.option_set SET")) rootWrites += r.rowCount;
              if (mode === "corrupt-recovery" && sql.startsWith("SELECT p.snapshot_json snapshot"))
                return { ...r, rows: r.rows.map((row) => ({ ...row, coherent: false })) };
              return r;
            },
          });
          if (mode === "commit-failure") {
            await client.query("SET CONSTRAINTS ALL IMMEDIATE");
            throw new Error("synthetic outer commit refusal");
          }
          await client.query("COMMIT");
          return result;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          await client.end();
        }
      },
    };
    const readAuthority = {
      async holdUntilTransactionCompletes(tx, input) {
        assert.equal(input.action, "catalog.option_set.read");
        assert.equal(input.actorKind, "User");
        assert.ok(input.requiredFields.includes("optionDetails"));
        if (mode === "read-denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return {
          observedAt: input.observedAt,
          validUntil: new Date(Date.parse(input.observedAt) + 30000).toISOString(),
        };
      },
    };
    const authoringAuthority = {
      async holdUntilTransactionCompletes(tx, input) {
        return {
          observedAt: input.observedAt,
          validUntil: new Date(Date.parse(input.observedAt) + 30000).toISOString(),
        };
      },
    };
    const auditInput = (input, actionCode) => ({
      auditId: id(9000 + ++event),
      brandId: brand,
      actor: { type: "User", reference: actor },
      actionCode,
      targetType: "CatalogOptionSet",
      targetId:
        input.result.sourceAggregate?.optionSetReference ??
        input.result.supportedContent.optionSetReference,
      reasonCode: input.reasonCode,
      correlationId: input.operationReference,
      occurredAt: input.occurredAt,
      sourceChannel: "API",
      dataClassification: "Internal",
      retentionPolicyCode: "OPERATIONAL",
      retentionPolicyVersion: 1,
    });
    const writer = createPostgresFullOptionSetDraftStore({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => clock },
      transactions,
      authority: authoringAuthority,
      creation: { authority: authoringAuthority, references: { generate: () => id(++next) } },
      audit: {
        create: (input) =>
          auditInput(
            input,
            input.result.sourceAggregate.aggregateVersion === 1
              ? "CATALOG_OPTION_SET_CREATE"
              : "CATALOG_OPTION_SET_REPLACEDRAFT",
          ),
      },
      events: { generateReference: () => id(10000 + ++event) },
    });
    const authority = {
      async holdUntilTransactionCompletes(tx, input) {
        assert.equal(input.tenantReference, tenant);
        assert.equal(input.brandReference, brand);
        assert.equal(input.actorReference, actor);
        assert.equal(input.actorKind, "User");
        assert.equal(input.action, "catalog.option_set.publish");
        assert.equal(input.permission, "catalog.manage");
        assert.equal(input.purposeCode, "CATALOG_OPTION_SET_PUBLICATION");
        assert.ok(input.requiredFields.includes("effectivePeriod"));
        if (mode === "deny-initial" && input.phase === "Intent")
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (input.phase === "Apply") {
          applyHolds++;
          assert.deepEqual(input.requiredChecks, fullOptionSealChecks);
          assert.equal(input.content.sourceAggregate.optionSetReference, set);
          input.content.sourceAggregate.draft.localizedNames["en-CA"] =
            "Detached synthetic admission copy";
          if (mode === "missing-current-admission" || (mode === "deny-final" && applyHolds === 2))
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          if (applyHolds === 2) {
            const actual = await tx.query(
              "SELECT aggregate_version FROM rms_catalog.option_set WHERE option_set_id=$1",
              [set],
            );
            assert.ok(
              actual.rows[0].aggregate_version >= 2,
              "actual owning tentative successor before late checks",
            );
            if (mode === "expiry-final") clock = plus(6);
            if (mode === "backward-final") clock = at;
            if (mode === "changed-successor")
              await tx.query(
                "UPDATE rms_catalog.option_set_version SET localized_names_json=$2::jsonb WHERE option_set_id=$1 AND status='Draft'",
                [set, JSON.stringify({ "en-CA": "Unlogged synthetic drift" })],
              );
            if (mode === "held-root") {
              const other = new Client(context.clientConfig);
              await other.connect();
              try {
                await other.query("SET lock_timeout='100ms'");
                await assert.rejects(
                  other.query(
                    "UPDATE rms_catalog.option_set SET aggregate_version=aggregate_version+1 WHERE option_set_id=$1",
                    [set],
                  ),
                  { code: "55P03" },
                );
              } finally {
                await other.end();
              }
            }
          }
        } else {
          assert.deepEqual(input.requiredChecks, []);
          if (input.phase === "Replay" && mode === "deny-replay")
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
        }
        return {
          observedAt: input.observedAt,
          validUntil:
            input.phase === "Intent"
              ? new Date(Date.parse(input.observedAt) + 5000).toISOString()
              : new Date(Date.parse(input.observedAt) + 30000).toISOString(),
        };
      },
    };
    const sealerFor = (t = tenant, b = brand) =>
      createPostgresFullOptionSetContentSealStore({
        tenantReference: t,
        brandReference: b,
        actorReference: actor,
        clock: { now: () => clock },
        transactions,
        authority: t === tenant && b === brand ? authority : authoringAuthority,
        readAuthority,
        references: {
          generateSuccessorVersion: () => {
            allocations++;
            return mode === "allocator-collision" ? originalVersion : id(++next);
          },
        },
        audit: { create: (input) => auditInput(input, "CATALOG_OPTION_SET_CONTENT_SEALED") },
        events: { generateReference: () => id(10000 + ++event) },
      });
    const reset = (m = "normal", t = plus(1)) => {
      mode = m;
      clock = t;
      applyHolds = 0;
      rootWrites = 0;
    };
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS",
    );
    try {
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON " + tables.slice(0, 7).join(",") + " TO " + role,
      );
      await admin.query("GRANT DELETE ON rms_catalog.option_conflict TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const created = await writer.create(request);
      set = created.content.sourceAggregate.optionSetReference;
      originalVersion = created.content.sourceAggregate.draft.versionReference;
      const { sourceAggregate, ...details } = created.content,
        p = parseCatalogOptionSetEditorContent(sourceAggregate, details);
      const sealRequest = {
        optionSetReference: set,
        versionReference: originalVersion,
        expectedAggregateVersion: 1,
        sourceDigest: p.sourceDigest,
        contentDigest: p.contentDigest,
        configurationDigest: p.configurationDigest,
        operationReference: id(7101),
        occurredAt: plus(1),
        reasonCode: "CONFIGURATION_EDIT",
      };
      const sealer = sealerFor(),
        before = await take();
      for (const m of [
        "deny-initial",
        "missing-current-admission",
        "read-denial",
        "stale-isolation",
        "allocator-collision",
        "deny-final",
        "expiry-final",
        "backward-final",
        "changed-successor",
        "audit-failure",
        "outbox-failure",
        "commit-failure",
      ]) {
        reset(m);
        await assert.rejects(sealer.seal(sealRequest), (e) => e instanceof CatalogError, m);
        if (
          [
            "deny-final",
            "expiry-final",
            "backward-final",
            "changed-successor",
            "audit-failure",
            "outbox-failure",
            "commit-failure",
          ].includes(m)
        )
          assert.equal(rootWrites, 1, m);
        else assert.equal(rootWrites, 0, m);
        if (["deny-final", "expiry-final", "backward-final", "changed-successor"].includes(m))
          assert.equal(applyHolds, 2, m);
        assert.deepEqual(await take(), before, m);
      }
      for (const change of [
        { expectedAggregateVersion: 2 },
        { contentDigest: "sha256:" + "b".repeat(64) },
        { versionReference: id(7901) },
      ]) {
        reset();
        await assert.rejects(sealer.seal({ ...sealRequest, ...change }), {
          code: "CATALOG_VERSION_CONFLICT",
        });
        assert.equal(rootWrites, 0);
        assert.deepEqual(await take(), before);
      }
      reset();
      await assert.rejects(
        sealerFor(id(7902), brand).seal(sealRequest),
        (e) => e instanceof CatalogError,
      );
      assert.deepEqual(await take(), before);
      reset();
      await assert.rejects(sealerFor(tenant, id(7903)).seal(sealRequest), {
        code: "CATALOG_UNAVAILABLE",
      });
      assert.deepEqual(await take(), before);
      reset("held-root");
      const sealed = await sealer.seal(sealRequest);
      assert.equal(sealed.status, "Applied");
      assert.equal(sealed.referenceEligibility, "NotEvaluated");
      assert.equal(sealed.content.eligibility, "NotEvaluated");
      assert.deepEqual(sealed.content.editorContent, created.content);
      assert.equal(rootWrites, 1);
      assert.equal(applyHolds, 2);
      const committed = await take();
      assert.equal(committed["rms_catalog.option_set_publication_content"].length, 1);
      assert.equal(committed["platform_audit.audit_record"].length, 2);
      assert.equal(committed["platform_eventing.outbox_event"].length, 2);
      const eventRows = committed["platform_eventing.outbox_event"].map((x) => x.row);
      assert.ok(eventRows.some((x) => x.event_type === "OptionSetContentSealed"));
      reset();
      const current = await createPostgresCurrentFullOptionSetDraftStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now: () => clock },
        transactions,
        authority: readAuthority,
      }).readCurrent({ optionSetReference: set, expectedAggregateVersion: 2 });
      assert.equal(
        current.content.sourceAggregate.draft.versionReference,
        sealed.successorDraftVersionReference,
      );
      assert.deepEqual(current.content.optionDetails, created.content.optionDetails);
      assert.deepEqual(await take(), committed);
      reset();
      const allocated = allocations;
      const replay = await sealer.seal(sealRequest);
      assert.equal(replay.status, "Replayed");
      assert.deepEqual(replay.content, sealed.content);
      assert.equal(allocations, allocated);
      assert.equal(rootWrites, 0);
      assert.equal(applyHolds, 0);
      assert.deepEqual(await take(), committed);
      const parallel = await Promise.all([sealer.seal(sealRequest), sealer.seal(sealRequest)]);
      assert.ok(
        parallel.every(
          (r) => r.status === "Replayed" && r.content.digest === sealed.content.digest,
        ),
      );
      assert.equal(allocations, allocated);
      assert.equal(rootWrites, 0);
      assert.deepEqual(await take(), committed);
      for (const m of ["deny-initial", "deny-replay", "corrupt-recovery"]) {
        reset(m);
        await assert.rejects(sealer.seal(sealRequest), (e) => e instanceof CatalogError);
        assert.equal(rootWrites, 0);
        assert.deepEqual(await take(), committed);
      }
      reset();
      await assert.rejects(sealer.seal({ ...sealRequest, reasonCode: "ALTERED_INTENT" }), {
        code: "CATALOG_IDEMPOTENCY_CONFLICT",
      });
      assert.deepEqual(await take(), committed);
      reset("normal", plus(61));
      const replacement = await writer.replace({
        optionSetReference: set,
        expectedAggregateVersion: 2,
        draft: {
          ...current.content.sourceAggregate.draft,
          updatedAt: plus(61),
          localizedNames: { "en-CA": "Later actual owning Draft" },
        },
        additionalContent: details,
        operationReference: id(7102),
        occurredAt: plus(61),
        reasonCode: "CONFIGURATION_EDIT",
      });
      const later = await take();
      reset("normal", plus(65));
      const original = await sealer.seal(sealRequest);
      assert.deepEqual(original.content, sealed.content);
      assert.equal(allocations, allocated);
      assert.deepEqual(await take(), later);
      const pin = await createPostgresFrozenFullOptionSetContentStore({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        clock: { now: () => clock },
        transactions,
        authority: authoringAuthority,
      }).readPinned({
        optionSetReference: set,
        versionReference: originalVersion,
        expectedRecordDigest: sealed.content.digest,
      });
      assert.deepEqual(pin.content, sealed.content);
      assert.deepEqual(await take(), later);
      const full = parseCatalogOptionSetEditorContent(replacement.content.sourceAggregate, details);
      reset("normal", plus(66));
      const second = await sealer.seal({
        ...sealRequest,
        versionReference: replacement.content.sourceAggregate.draft.versionReference,
        expectedAggregateVersion: 3,
        sourceDigest: full.sourceDigest,
        contentDigest: full.contentDigest,
        configurationDigest: full.configurationDigest,
        operationReference: id(7103),
        occurredAt: plus(66),
      });
      assert.equal(second.status, "Applied");
      const final = await take();
      assert.equal(final["rms_catalog.option_set_publication_content"].length, 2);
      reset("normal", plus(100));
      assert.deepEqual((await sealer.seal(sealRequest)).content, sealed.content);
      assert.deepEqual(await take(), final);
    } finally {
      await admin.query("ROLLBACK");
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
});
