import assert from "node:assert/strict";
import pg from "pg";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  parseProductAggregate,
  deriveCatalogProductPublicationContentIdentity,
  parseProductPublicationCommandV2,
  bindCatalogProductPublicationValidationContextV2,
  buildCatalogProductPublicationReferenceRequestV2,
  buildCatalogProductWarningAcknowledgementReferenceRequest,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  catalogProductPublicationAuditAction,
  createPostgresProductPublicationQualificationHistorySource,
  createPostgresProductWarningAcknowledgementQualificationHistorySource,
  createPostgresProductPublicationSourceStoreV2,
} from "../../rms/catalog/src/index.ts";
import { createPostgresProductPublicationStoreV2 } from "../../rms/catalog/src/infrastructure/persistence/product-publication-store.ts";
import { createPostgresProductCreationStore } from "../../rms/catalog/src/infrastructure/persistence/product-lifecycle-store.ts";
import {
  RecipeWorkflowError,
  createPostgresRecipeProductPublicationReferenceSourceV2,
  createPostgresRecipeInventoryProductPublicationReferenceSourceV2,
} from "../../rms/recipe/src/index.ts";
import {
  InventoryItemError,
  createInventoryItem,
  createPostgresInventoryProductPublicationSkuMappingReferenceSourceV2,
} from "../../rms/inventory/src/index.ts";
import { createPostgresProductPublicationConfigurationReferenceSourceV2 } from "../../rms/pricing/src/index.ts";
import {
  createMerchantProductPublicationReferenceSourceV2,
  bindMerchantProductPublicationReferenceRequestsV2,
  createMerchantProductWarningAcknowledgementReferenceSource,
  bindMerchantProductWarningAcknowledgementReferenceRequests,
} from "../../../apps/api/src/merchant-product-publication-reference-source-v2.ts";
import { input as priceInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { seedPriceBook } from "./price-book-seed.mjs";
import { withIsolatedDatabase } from "./isolated-database.mjs";
const id = (n) => "01902465-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const countsSql = `SELECT
 (SELECT count(*)::int FROM rms_catalog.product) products,
 (SELECT count(*)::int FROM rms_catalog.product_version) versions,
 (SELECT count(*)::int FROM rms_catalog.product_operation_record) operations,
 (SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,
 (SELECT count(*)::int FROM rms_catalog.product_source_commit) commits,
 (SELECT count(*)::int FROM rms_catalog.product_publication_revision) publication_revisions,
 (SELECT count(*)::int FROM rms_catalog.product_scope_retirement_header) retirement_headers,
 (SELECT count(*)::int FROM rms_catalog.product_publication_validation_report) validation_reports,
 (SELECT count(*)::int FROM platform_audit.audit_record) audit,
 (SELECT count(*)::int FROM platform_eventing.outbox_event) outbox,
 (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id),'[]'::jsonb) FROM rms_catalog.product_source_head h) heads,
 (SELECT COALESCE(jsonb_agg(to_jsonb(h) ORDER BY h.brand_id,h.scope_store_key),'[]'::jsonb) FROM platform_audit.audit_chain_head h) chains`;

/** Actual owning SQL, barriers and Product write/rollback. Recipe/Inventory/Pricing
 * reference fixtures and authority are explicitly synthetic, never real publication,
 * stock, price approval or IAM evidence. */
export async function exerciseProductPublicationCrossDomainReferencesV2() {
  await withIsolatedDatabase({ caseId: "wp2421_cross_refs" }, async (context) => {
    const admin = new pg.Client(context.clientConfig),
      competitor = new pg.Client(context.clientConfig),
      role = "wp2421_crossrefs_" + context.runId,
      tenant = id(1),
      brand = id(2),
      actor = id(3),
      past = new Date(Date.now() - 3600000).toISOString(),
      guardStates = new WeakMap();
    assert.match(role, /^wp2421_crossrefs_[a-f0-9]+$/u);
    await Promise.all([admin.connect(), competitor.connect()]);
    let createdRole = false,
      forcedClock = null,
      sequence = 10000,
      publicationHead = null;
    const now = () => forcedClock ?? new Date().toISOString(),
      counts = async (tx = admin) => (await tx.query(countsSql, [])).rows[0];
    const registerBeforeCommit = async (tx, guard, finalAssert) => {
      const state = guardStates.get(tx);
      assert(state, "Registration belongs to the actual caller transaction");
      assert.equal(state.phase, "work");
      assert.equal(typeof guard, "function");
      assert.equal(typeof finalAssert, "function");
      const evidence = {
        asyncEntered: 0,
        asyncReturned: 0,
        finalEntered: 0,
        finalReturned: 0,
        finalError: null,
      };
      state.guards.push({
        evidence,
        async guard() {
          evidence.asyncEntered++;
          const result = await guard();
          evidence.asyncReturned++;
          return result;
        },
        finalAssert() {
          evidence.finalEntered++;
          try {
            const result = finalAssert();
            evidence.finalReturned++;
            return result;
          } catch (error) {
            evidence.finalError = error;
            throw error;
          }
        },
      });
    };
    const transactions = {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        const tx = { query: (sql, values = []) => client.query(sql, [...values]) },
          state = { phase: "work", guards: [], constraintsCompleted: false };
        guardStates.set(tx, state);
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          const result = await work(tx);
          state.phase = "async";
          for (const entry of state.guards) assert.equal(await entry.guard(), undefined);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          state.constraintsCompleted = true;
          state.phase = "final";
          for (const entry of state.guards) assert.equal(entry.finalAssert(), undefined);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          guardStates.delete(tx);
          await client.end();
        }
      },
    };
    const audit = (operation, actionCode, targetType, targetId, occurredAt) => ({
      auditId: id(operation + 500000),
      brandId: brand,
      actor: { type: "User", reference: actor },
      actionCode,
      targetType,
      targetId,
      reasonCode: "SYNTHETIC_PUBLICATION_REFERENCES",
      correlationId: id(operation),
      occurredAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "CATALOG_CONFIGURATION",
      retentionPolicyVersion: 1,
    });
    const productOptions = (runner = transactions) => ({
      brandReference: brand,
      transactions: runner,
      authorize: async () => true,
      editorContentAuthority: {
        async holdUntilTransactionCompletes(_tx, input) {
          assert.equal(input.aggregate.brandReference, brand);
        },
      },
    });
    const aggregate = (base, sku = true) =>
      parseProductAggregate({
        productReference: id(base),
        brandReference: brand,
        internalCode: "SYNTH_REFS_" + base,
        productType: "PreparedFood",
        lifecycle: "Draft",
        aggregateVersion: 1,
        createdAt: past,
        createdByActorReference: actor,
        updatedAt: past,
        draft: {
          versionReference: id(base + 1),
          baseVersionReference: null,
          status: "Draft",
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic stored reference content" },
          taxClassificationReference: null,
          createdAt: past,
          updatedAt: past,
          skus: sku
            ? [
                {
                  skuReference: id(base + 2),
                  productReference: id(base),
                  brandReference: brand,
                  skuCode: "SYNTH_REFS_SKU_" + base,
                  lifecycle: "Draft",
                  localizedNames: { "en-CA": "Synthetic SKU" },
                  variantSelections: [],
                  unitOfSale: "EA",
                  unitQuantity: "1",
                  createdAt: past,
                  createdByActorReference: actor,
                },
              ]
            : [],
          optionBindings: [],
          editorContent: {
            profile: "CatalogProductEditorContentV1",
            localizedShortDescriptions: {},
            localizedDescriptions: {},
            preparationNotes: {},
            tagReferences: [],
            attributeValues: [],
            media: [],
            variantDimensions: [],
            variantCombinations: [],
            optionRules: [],
            allergenReferences: [],
            nutritionProfile: null,
          },
        },
      });
    const createProduct = async (value, operation, runner = transactions) =>
      createPostgresProductCreationStore(productOptions(runner)).create({
        record: {
          action: "Create",
          operationReference: id(operation),
          operationIntentHash: sha256Hex(canonicalizeRfc8785(value)),
          aggregate: value,
        },
        audit: audit(
          operation,
          "CATALOG_PRODUCT_CREATE",
          "CatalogProduct",
          value.productReference,
          value.createdAt,
        ),
      });
    const makeInput = (value, duration = 5000) => {
      const observedAt = now(),
        identity = deriveCatalogProductPublicationContentIdentity(value),
        intentBody = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
        replacementIntent = { ...intentBody, digest: hash(intentBody) },
        command = parseProductPublicationCommandV2({
          profile: "CatalogProductPublicationCommandV2",
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          operationReference: id(++sequence),
          productReference: value.productReference,
          versionReference: value.draft.versionReference,
          expectedProductAggregateVersion: value.aggregateVersion,
          expectedPublicationVersion: publicationHead?.publicationVersion ?? 0,
          action: "Validate",
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
          scopeSet: [
            {
              level: "Store",
              reference: id(40),
              channelCodes: ["WEB"],
              orderTypeCodes: ["PICKUP"],
            },
          ],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: past, localDateTime: past.slice(0, -1), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
          scheduleReference: null,
          replacementVersionReference: null,
          successorDraftVersionReference: null,
          occurredAt: observedAt,
          reasonCode: "SYNTHETIC_REFERENCE_READ",
          replacementIntent,
          replacementIntentDigest: replacementIntent.digest,
        });
      const context = bindCatalogProductPublicationValidationContextV2({
        command,
        aggregate: value,
        current: publicationHead,
        content: null,
        observedAt,
      });
      return {
        context,
        request: buildCatalogProductPublicationReferenceRequestV2(
          context,
          new Date(Date.parse(observedAt) + duration).toISOString(),
        ),
      };
    };
    let deniedOwner = null;
    const authority = (owner, tx, expected) => ({
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, tx);
        assert.deepEqual(input.request, expected);
        assert.equal(input.requiredScope, "FullBrandScope");
        assert.equal(input.request.actorKind ?? input.request.command?.actorKind, "User");
        assert.equal(input.tenantReference, tenant);
        assert(input.requiredFields.length > 0);
        if (!expected.command)
          for (const key of Object.keys(expected)) assert(input.requiredFields.includes(key));
        if (deniedOwner === owner) {
          if (owner.startsWith("Recipe")) throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
          if (owner === "Inventory")
            throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        }
      },
    });
    const compose = (tx, input) => {
      const bound = bindMerchantProductPublicationReferenceRequestsV2(input);
      return createMerchantProductPublicationReferenceSourceV2({
        ...input,
        transaction: tx,
        clock: { now },
        registerBeforeCommit,
        historyAuthority: authority("History", tx, input.request),
        availabilityAuthority: authority("Availability", tx, input.request),
        bundleAuthority: authority("Bundle", tx, input.request),
        menuAuthority: authority("Menu", tx, input.request),
        recipeAuthority: authority("Recipe", tx, bound.recipe),
        recipeInventoryAuthority: authority("RecipeInventory", tx, bound.recipeInventory),
        inventoryAuthority: authority("Inventory", tx, bound.inventory),
        pricingAuthority: authority("Pricing", tx, bound.pricing),
        priceBookAuthority: authority("PriceBook", tx, bound.pricing),
        optionPriceAuthority: authority("OptionPrice", tx, bound.pricing),
        promotionAuthority: authority("Promotion", tx, bound.pricing),
      });
    };
    const read = (input, work) =>
      transactions.run((tx) =>
        compose(tx, input).withCurrentMatches(async (matches, actual) => {
          assert.equal(actual, tx);
          return work(matches, tx);
        }),
      );
    // Reuse actual owning operation history and coverage inside the very same
    // held reference transaction. This fixture supplies identities/authorities;
    // no impact severity or completed publication qualification is asserted.
    const withImpactHistory = (tx, input, work) => {
      const c = input.request.command,
        common = {
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "User",
          clock: { now },
          transactions: { run: (callback) => callback(tx) },
        },
        historyOptions = {
          ...common,
          registerBeforeCommit,
          authority: authority("QualificationHistory", tx, input.request),
        },
        history =
          input.request.profile === "CatalogProductPublicationReferenceRequestV2"
            ? createPostgresProductPublicationQualificationHistorySource(historyOptions)
            : createPostgresProductWarningAcknowledgementQualificationHistorySource(historyOptions),
        coverage = createPostgresProductPublicationSourceStoreV2({
          ...common,
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              assert.equal(actual, tx);
              assert.equal(packet.tenantReference, tenant);
              assert.equal(packet.brandReference, brand);
              assert.equal(packet.actorReference, actor);
              assert.equal(packet.productReference, c.productReference);
              assert(packet.requiredFields.includes("scopeRetirements"));
            },
          },
        });
      return history.withCurrentQualificationHistory(input.request, (provenance, actual) => {
        assert.equal(actual, tx);
        return coverage.withCurrentCoverage(
          {
            productReference: c.productReference,
            expectedAggregateVersion: c.expectedProductAggregateVersion,
          },
          (snapshot, actual) => {
            assert.equal(actual, tx);
            return work(provenance, snapshot);
          },
        );
      });
    };
    const readImpact = (input, work) =>
      transactions.run((tx) =>
        withImpactHistory(tx, input, (provenance, coverage) =>
          compose(tx, input).withCurrentImpactReferences(provenance, coverage, (result, actual) => {
            assert.equal(actual, tx);
            return work(result, tx);
          }),
        ),
      );
    try {
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      createdRole = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_publication_operation_abandonment TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product,rms_catalog.product_source_head,platform_audit.audit_chain_head TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel,rms_catalog.product_version_category_assignment TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.menu_review_content,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_publication_revision,rms_catalog.menu_reference_generation,rms_catalog.menu_publication_revision,rms_catalog.menu_publication_release,rms_catalog.menu_release_effective_period,rms_catalog.menu_release_effective_end,rms_catalog.bundle_reference_generation,rms_catalog.bundle,rms_catalog.bundle_version,rms_catalog.bundle_component_group,rms_catalog.bundle_component_sellable,rms_catalog.availability_rule,rms_catalog.availability_reference_generation TO " +
          role,
      );
      await admin.query("GRANT INSERT ON rms_catalog.product_publication_revision TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.product_scope_retirement_header,rms_catalog.product_publication_validation_report TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT ON rms_catalog.product_scope_retirement,rms_catalog.product_scope_journal,rms_catalog.product_publication_content,rms_catalog.product_approval_receipt TO " +
          role,
      );

      await admin.query("GRANT USAGE ON SCHEMA rms_recipe,rms_inventory,rms_pricing TO " + role);
      const recipeColumns = {
        recipe: "recipe_id,brand_id,aggregate_version,current_version_id,updated_at",
        recipe_version:
          "recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,effective_from,effective_until,effective_time_zone,created_at",
        recipe_reference_generation: "brand_id,generation,binding_count",
        recipe_reference_binding:
          "recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from,effective_until",
        recipe_ingredient_requirement:
          "requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id",
        recipe_modifier_version:
          "rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,effective_until,occurred_at",
      };
      for (const [table, columns] of Object.entries(recipeColumns)) {
        assert.match(table, /^[a-z_]+$/);
        assert.match(columns, /^[a-z_,]+$/);
        await admin.query(`GRANT SELECT(${columns}) ON rms_recipe.${table} TO ${role}`);
      }
      const tables = [
        "rms_inventory.configuration_reference_generation",
        "rms_inventory.inventory_item",
        "rms_inventory.inventory_item_version",
        "rms_inventory.inventory_item_operation",
        "rms_inventory.item_sku_mapping_version",
        ...[
          "configuration_reference_generation",
          "price_book",
          "price_book_version",
          "price_entry",
          "option_price_rule",
          "option_price_rule_version",
          "promotion",
          "promotion_version",
          "promotion_eligibility_reference",
        ].map((t) => "rms_pricing." + t),
      ];
      await admin.query("GRANT SELECT ON " + tables.join(",") + " TO " + role);
      const product = aggregate(100);
      await createProduct(product, 110);
      // Actual empty sources retain their original request; no registry initialization is invented.
      await read(makeInput(product), async (matches) => {
        assert.deepEqual(matches.current.recipe.references, []);
        assert.deepEqual(matches.current.inventory.references, []);
        assert.deepEqual(matches.current.pricing.priceEntries, []);
        assert.equal(matches.generations.recipe, "0");
        assert.equal(matches.generations.inventory, "0");
        assert.equal(matches.generations.pricing, "0");
        assert.equal(matches.publishValidation, "Incomplete");
      });
      // Complete synthetic owning Item history: operation UUID 601 pins version1,
      // while current version2 is operation602. No stock/balance fact is seeded.
      for (const number of [6, 20]) {
        const snapshot = createInventoryItem({
          tenantReference: tenant,
          brandReference: brand,
          itemReference: id(number),
          internalCode: "SYNTHETIC_" + number,
          itemType: "FinishedGood",
          localizedNames: { en: "Synthetic Item" },
          baseUnit: {
            unitCode: "EA",
            dimension: "Count",
            displayPrecision: 0,
            ledgerPrecision: 0,
            roundingMode: "HalfEven",
          },
          trackingPolicy: {
            stockTrackingEnabled: true,
            lotTrackingMode: "NoLot",
            defaultShelfLifeDays: null,
            expiryWarningDays: null,
            issuePolicy: "FIFO",
            negativeStockPolicy: "Block",
          },
          occurredAt: past,
          actorReference: actor,
        });
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item(tenant_id,brand_id,item_id,internal_code,item_type,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [tenant, brand, id(number), snapshot.internalCode, "FinishedGood", past, actor],
        );
        for (const version of number === 6 ? [1, 2] : [1]) {
          const recordedAt = new Date(Date.parse(past) + (version - 1)).toISOString(),
            value = { ...snapshot, aggregateVersion: version, updatedAt: recordedAt };
          await admin.query(
            "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,$4,$5,$6)",
            [tenant, brand, id(number), version, JSON.stringify(value), recordedAt],
          );
          await admin.query(
            "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              tenant,
              brand,
              id(number * 100 + version),
              id(number),
              version,
              hash("item"),
              version === 1 ? "Create" : "Update",
              id(number * 100 + 50 + version),
            ],
          );
        }
      }
      const future = new Date(Date.now() + 3600000).toISOString();
      for (const n of [900, 910])
        await admin.query(
          "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)",
          [id(n), brand, "SYNTHETIC_RECURSIVE_" + n, past, actor],
        );
      for (const [version, parent, number, lifecycle] of [
        [901, 900, 1, "Draft"],
        [911, 910, 1, "Archived"],
        [912, 910, 2, "Draft"],
      ])
        await admin.query(
          "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,$4,$5,$6,'SYNTHETIC_NAME',1,'PORTION','Count',$7,$8,'UTC',$9)",
          [
            id(version),
            id(parent),
            brand,
            number,
            hash("recipe"),
            lifecycle,
            id(920),
            future,
            past,
          ],
        );
      for (const [parent, version, root] of [
        [900, 901, 2],
        [910, 912, 3],
      ])
        await admin.query(
          "UPDATE rms_recipe.recipe SET current_version_id=$2,aggregate_version=$3 WHERE recipe_id=$1",
          [id(parent), id(version), root],
        );
      await admin.query(
        "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,effective_from) VALUES($1,$2,$3,$4,$5,$6)",
        [id(930), id(901), id(900), brand, id(102), future],
      );
      const ingredientSql =
        "INSERT INTO rms_recipe.recipe_ingredient_requirement(requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id,quantity_microunits,unit_dimension,conversion_numerator,conversion_denominator,loss_basis_points,unit_cost_minor_numerator,unit_cost_denominator) VALUES($1,$2,$3,$4,$5,$6,$7,1,'Count',1,1,0,0,1)";
      await admin.query(ingredientSql, [
        id(950),
        id(901),
        id(900),
        brand,
        "SubRecipe",
        id(910),
        id(911),
      ]);
      await admin.query(ingredientSql, [
        id(951),
        id(911),
        id(910),
        brand,
        "InventoryItem",
        id(6),
        id(601),
      ]);
      const rawBook = priceInput().priceBook,
        book = {
          ...rawBook,
          priceBookReference: id(300),
          versionReference: id(301),
          brandReference: brand,
          stableCode: "SYNTHETIC_PUBLICATION_REFERENCE",
          entries: [{ ...rawBook.entries[0], entryReference: id(302), sellableReference: id(102) }],
        };
      await seedPriceBook(admin, book, actor);
      // A stored option-price root outside the candidate remains explicitly unresolved.
      await admin.query(
        "INSERT INTO rms_pricing.option_price_rule(option_price_rule_id,brand_id,binding_id,option_id,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$5)",
        [id(320), brand, id(321), id(322), past, actor],
      );
      // Writer fences are the real owner locks used by their source/write SQL.
      const fences = [
        "RecipeCatalogReferenceV1:" + brand,
        "InventoryCatalogReferenceV1:" + tenant + ":" + brand,
        "PricingConfigurationReferenceV1:" + brand,
      ];
      const available = async (key) => {
        await competitor.query("BEGIN");
        try {
          return (
            await competitor.query(
              "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) available",
              [key],
            )
          ).rows[0].available;
        } finally {
          await competitor.query("ROLLBACK");
        }
      };
      await read(makeInput(product), async (matches, tx) => {
        const pinned = matches.current.recipeInventory.inventoryReferences.find(
          (r) => r.requirement.reference.sourceReference === id(6),
        );
        assert.equal(pinned.resolution.state, "ResolvedStoredConfiguration");
        assert.equal(pinned.resolution.operation.operationReference, id(601));
        assert.equal(pinned.resolution.version.itemVersion, 1);
        assert.equal(pinned.resolution.isCurrentItemConfiguration, false);
        assert(
          matches.current.inventory.unresolvedItemCoverage.some(
            (r) => r.itemReference === id(20) && r.currentLink === "Unknown",
          ),
        );
        assert.equal(matches.current.pricing.priceEntries[0].sellableReference, id(102));
        assert.equal(
          matches.current.pricing.unresolvedOptionRoots[0].reason,
          "BindingNotInCurrentDraft",
        );
        for (const key of fences) assert.equal(await available(key), false);
        const other = aggregate(200);
        await createProduct(other, 210, { run: (work) => work(tx) });
        return matches.digest;
      });
      for (const key of fences) assert.equal(await available(key), true);
      await readImpact(makeInput(product), async (impact) => {
        assert.equal(impact.profile, "MerchantProductPublicationImpactReferencesV2");
        assert.equal(
          impact.current.operationProvenance.resultAggregateVersion,
          product.aggregateVersion,
        );
        assert.equal(
          impact.current.referenceConfigurationDigest,
          hash(deriveCatalogProductPublicationContentIdentity(product).referenceConfiguration),
        );
        assert.notEqual(
          impact.current.referenceConfigurationDigest,
          deriveCatalogProductPublicationContentIdentity(product).configurationDigest,
        );
        assert.equal(impact.publications.length, 0);
        assert.equal(impact.current.pricing.priceEntries[0].sellableReference, id(102));
        assert(impact.current.recipeInventory.inventoryReferences.length > 0);
        assert.equal(impact.changeImpact, "NotEvaluated");
        assert.equal(impact.eligibility, "NotEvaluated");
      });
      const baseline = await counts();
      // Full original request changes are rejected before any business consumer.
      const wrong = makeInput(product);
      wrong.request = { ...wrong.request, aggregateSnapshotDigest: hash("wrong") };
      await assert.rejects(
        read(wrong, async () => assert.fail("unbound consumer")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await counts(), baseline);
      // Late owner authorization refusal rolls actual Product/Audit/Outbox changes back.
      for (const owner of ["Recipe", "Inventory"]) {
        await assert.rejects(
          read(makeInput(product), async (_matches, tx) => {
            await createProduct(aggregate(++sequence), ++sequence, { run: (work) => work(tx) });
            deniedOwner = owner;
          }),
          { code: "CATALOG_PERMISSION_DENIED" },
        );
        deniedOwner = null;
        assert.deepEqual(await counts(), baseline);
      }
      // Each independent owner retains its original exclusive deadline until outer COMMIT.
      // Acquire Catalog's earlier writer barrier first; consumer then uses the actual owning writer.
      for (const owner of ["Recipe", "RecipeInventory", "Inventory", "Pricing"]) {
        const input = makeInput(product, 1000),
          bound = bindMerchantProductPublicationReferenceRequestsV2(input);
        let evidence, state;
        await assert.rejects(
          transactions.run(async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              "CatalogProductSource:" + brand,
            ]);
            const request =
              owner === "Recipe"
                ? bound.recipe
                : owner === "RecipeInventory"
                  ? bound.recipeInventory
                  : owner === "Inventory"
                    ? bound.inventory
                    : bound.pricing;
            const common = {
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              actorKind: "User",
              clock: { now },
              transactions: { run: (work) => work(tx) },
              registerBeforeCommit: async (...args) => {
                await registerBeforeCommit(...args);
                state = guardStates.get(tx);
                evidence ??= state.guards[0].evidence;
              },
              authority: authority(owner, tx, request),
            };
            const source =
              owner === "Recipe"
                ? createPostgresRecipeProductPublicationReferenceSourceV2(common)
                : owner === "RecipeInventory"
                  ? createPostgresRecipeInventoryProductPublicationReferenceSourceV2(common)
                  : owner === "Inventory"
                    ? createPostgresInventoryProductPublicationSkuMappingReferenceSourceV2(common)
                    : createPostgresProductPublicationConfigurationReferenceSourceV2({
                        ...common,
                        priceBookAuthority: authority("PriceBook", tx, request),
                        optionPriceAuthority: authority("OptionPrice", tx, request),
                        promotionAuthority: authority("Promotion", tx, request),
                      });
            await source.withCurrentSnapshot(request, async (_snapshot, actual) => {
              assert.equal(actual, tx);
              await createProduct(aggregate(++sequence), ++sequence, { run: (work) => work(tx) });
            });
            await registerBeforeCommit(
              tx,
              async () => {
                forcedClock = request.validUntil;
              },
              () => undefined,
            );
          }),
        );
        forcedClock = null;
        assert.equal(state.constraintsCompleted, true);
        assert.equal(evidence.asyncEntered, 1);
        assert.equal(evidence.asyncReturned, 1);
        assert.equal(evidence.finalEntered, 1);
        assert.equal(evidence.finalReturned, 0);
        assert(evidence.finalError);
        assert.equal(
          evidence.finalError.code,
          owner.startsWith("Recipe")
            ? "RECIPE_DEPENDENCY_UNAVAILABLE"
            : owner === "Inventory"
              ? "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE"
              : "CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE",
        );
        assert.deepEqual(await counts(), baseline);
      }
      // A real owning V2 Validate creates the current head and immutable report.
      // These technical facts/policy/finding are explicitly controlled fixtures:
      // they do not claim that the complete ordinary validation producer ran.
      const warningCommand = makeInput(product).request.command;
      const warningResult = await createPostgresProductPublicationStoreV2({
        tenantReference: tenant,
        brandReference: brand,
        actorReference: actor,
        actorKind: "User",
        transactions,
        registerBeforeCommit,
        clock: { now },
        maximumApprovalValiditySeconds: 3600,
        authority: {
          async holdUntilTransactionCompletes(_tx, input) {
            assert.equal(input.command.operationReference, warningCommand.operationReference);
            assert(input.requiredPermissions.includes("catalog.product.history.read"));
          },
        },
        editorContentAuthority: productOptions().editorContentAuthority,
        audit: {
          create(publication, action) {
            const operation = Number.parseInt(publication.operationReference.slice(-12), 16);
            return {
              ...audit(
                operation,
                catalogProductPublicationAuditAction(action),
                "Product",
                publication.productReference,
                publication.occurredAt,
              ),
              reasonCode: publication.reasonCode,
            };
          },
        },
        sources: {
          async withCurrentPolicy(_tx, input, work) {
            return work({
              content: {
                profile: "PublishingProductPublicationPolicyV1",
                tenantReference: tenant,
                brandReference: brand,
                familyReference: id(650),
                policyReference: id(651),
                policyVersion: 1,
                scopeOrder: productPublicationScopeLevels,
                approvalPolicy: "Required",
                warningOverrideAllowed: false,
                requiredLocales: ["en-CA"],
                mediaRequirement: "Optional",
                effectiveFrom: past,
                effectiveUntil: null,
              },
              currentPublicationReference: id(652),
              observedAt: input.observedAt,
              validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
            });
          },
          async withHeldCurrentFacts(_tx, input, work) {
            const command = input.command,
              validUntil = new Date(Date.parse(input.observedAt) + 5000).toISOString(),
              bindings = {
                productAggregateVersion: command.expectedProductAggregateVersion,
                contentDigest: command.contentDigest,
                configurationDigest: command.configurationDigest,
                scopeDigest: hash(command.scopeSet),
                periodDigest: hash(command.effectivePeriod),
              };
            return work(
              {
                now: input.observedAt,
                ...bindings,
                validation: {
                  profile: "CatalogProductPublicationValidationV2",
                  replacementIntentDigest: command.replacementIntentDigest,
                  evidenceReference: id(653),
                  ...bindings,
                  policyReference: id(651),
                  policyVersion: 1,
                  approvalPolicy: "Required",
                  checks: productPublicationCheckCodes.map((code) => ({
                    code,
                    outcome:
                      code === "ApprovalPolicy"
                        ? "Pending"
                        : code === "ChangeImpact"
                          ? "Warning"
                          : "Pass",
                  })),
                  warningAcknowledgement: null,
                  checkedAt: input.observedAt,
                  validUntil,
                },
                approval: null,
                reviewReference: null,
                replacement: null,
              },
              {
                coverage: "Complete",
                impact: "Recorded",
                findings: [
                  {
                    checkCode: "ChangeImpact",
                    ruleCode: "SYNTHETIC_REFERENCE_WARNING",
                    outcome: "Warning",
                    subjectReference: product.productReference,
                    reasonCode: "SYNTHETIC_WARNING",
                    references: [],
                  },
                ],
                sources: [
                  {
                    sourceCode: "SYNTHETIC_REFERENCE_REPORT",
                    sourceDigest: hash("controlled source"),
                    generation: "1",
                    relevantReferenceDigest: hash("controlled relevant references"),
                    observedAt: input.observedAt,
                    validUntil,
                  },
                ],
              },
            );
          },
        },
      }).execute(warningCommand);
      assert.equal(warningResult.status, "Applied");
      assert.equal(warningResult.publication.state, "Draft");
      assert.equal(warningResult.publication.validationDecision, "WarningAcknowledgementRequired");
      assert.equal(warningResult.validationReport.status, "Recorded");
      assert.equal(warningResult.validationReport.report.details.coverage, "Complete");
      assert.equal(warningResult.aggregate.aggregateVersion, product.aggregateVersion + 1);
      publicationHead = warningResult.publication;
      const report = warningResult.validationReport.report;
      const makeAckInput = () => {
        const observedAt = now(),
          command = parseCatalogProductPublicationWarningAcknowledgementCommand({
            profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
            action: "AcknowledgeProductPublicationWarnings",
            tenantReference: tenant,
            brandReference: brand,
            actorReference: actor,
            actorKind: "User",
            operationReference: id(++sequence),
            productReference: product.productReference,
            versionReference: product.draft.versionReference,
            expectedProductAggregateVersion: warningResult.aggregate.aggregateVersion,
            reportOperationReference: report.operationReference,
            reportDigest: report.digest,
            warningBindingDigest: report.warningBindingDigest,
            warningCodes: ["ChangeImpact"],
            reasonCode: "EXPLICIT_SYNTHETIC_REVIEW",
            occurredAt: observedAt,
          });
        // The delivered report retains its old validation lease; only this new
        // current observation has a fresh original five-second deadline.
        const context = {
          command,
          aggregate: warningResult.aggregate,
          current: warningResult.publication,
          report,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 5000).toISOString(),
        };
        return {
          context,
          request: buildCatalogProductWarningAcknowledgementReferenceRequest(context),
        };
      };
      const readAck = (
        input,
        work,
        owners = new Set(),
        afterSource = () => undefined,
        impact = false,
      ) =>
        transactions.run(async (tx) => {
          const bound = bindMerchantProductWarningAcknowledgementReferenceRequests(input);
          const held = (owner, expected) => {
            const base = authority(owner, tx, expected);
            return {
              async holdUntilTransactionCompletes(actual, packet) {
                assert.equal(actual, tx);
                assert.equal(expected.originalIntentDigest, hash(input.context.command));
                assert.equal(expected.aggregateSnapshotDigest, hash(warningResult.aggregate));
                assert.equal(expected.currentPublicationDigest, hash(warningResult.publication));
                assert.equal(expected.command?.actorReference ?? expected.actorReference, actor);
                assert.equal(expected.command?.actorKind ?? expected.actorKind, "User");
                if (expected.command) {
                  assert.equal(expected.command.action, "AcknowledgeProductPublicationWarnings");
                  assert.equal(
                    expected.command.purposeCode,
                    "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
                  );
                  assert.match(packet.purposeCode, /WARNING_ACKNOWLEDGEMENT/);
                }
                owners.add(owner);
                return base.holdUntilTransactionCompletes(actual, packet);
              },
            };
          };
          const source = createMerchantProductWarningAcknowledgementReferenceSource({
            ...input,
            transaction: tx,
            clock: { now },
            registerBeforeCommit,
            historyAuthority: held("History", input.request),
            availabilityAuthority: held("Availability", input.request),
            bundleAuthority: held("Bundle", input.request),
            menuAuthority: held("Menu", input.request),
            recipeAuthority: held("Recipe", bound.recipe),
            recipeInventoryAuthority: held("RecipeInventory", bound.recipeInventory),
            inventoryAuthority: held("Inventory", bound.inventory),
            pricingAuthority: held("Pricing", bound.pricing),
            priceBookAuthority: held("PriceBook", bound.pricing),
            optionPriceAuthority: held("OptionPrice", bound.pricing),
            promotionAuthority: held("Promotion", bound.pricing),
          });
          const consume = async (matches, actual) => {
            assert.equal(actual, tx);
            return work(matches, tx);
          };
          const result = await (impact
            ? withImpactHistory(tx, input, (provenance, coverage) =>
                source.withCurrentImpactReferences(provenance, coverage, consume),
              )
            : source.withCurrentMatches(consume));
          afterSource();
          return result;
        });
      const owners = new Set(),
        ackInput = makeAckInput();
      const ackMatches = await readAck(
        ackInput,
        async (matches, tx) => {
          assert.equal(matches.request.originalIntentDigest, hash(ackInput.context.command));
          assert.deepEqual(
            Object.keys(matches.sourceDigests).sort(),
            [
              "availability",
              "bundle",
              "history",
              "inventory",
              "menu",
              "pricing",
              "recipe",
              "recipeInventory",
            ].sort(),
          );
          assert.equal(matches.publicationCoverage, "Unavailable");
          assert.equal(matches.futureScheduleCoverage, "Unavailable");
          assert.equal(matches.publishValidation, "Incomplete");
          assert(matches.current.recipeInventory.inventoryReferences.length > 0);
          assert.equal(matches.current.pricing.priceEntries[0].sellableReference, id(102));
          await createProduct(aggregate(++sequence), ++sequence, { run: (work) => work(tx) });
          return matches;
        },
        owners,
      );
      assert.equal(ackMatches.request.command.action, "AcknowledgeProductPublicationWarnings");
      for (const owner of [
        "History",
        "Availability",
        "Bundle",
        "Menu",
        "Recipe",
        "RecipeInventory",
        "Inventory",
        "Pricing",
      ])
        assert(owners.has(owner), "Actual Ack acquisition: " + owner);
      const impactAckInput = makeAckInput();
      await readAck(
        impactAckInput,
        async (impact) => {
          assert.equal(impact.profile, "MerchantProductWarningAcknowledgementImpactReferencesV1");
          assert.deepEqual(impact.request, impactAckInput.request);
          assert.equal(
            impact.current.operationProvenance.resultAggregateVersion,
            warningResult.aggregate.aggregateVersion,
          );
          assert.equal(impact.publications.length, 0);
          assert.equal(impact.current.pricing.priceEntries[0].sellableReference, id(102));
          assert(impact.current.recipeInventory.inventoryReferences.length > 0);
          assert.equal(impact.changeImpact, "NotEvaluated");
        },
        new Set(),
        () => undefined,
        true,
      );
      const ackBaseline = await counts();
      for (const owner of ["History", "Recipe"]) {
        let tentative,
          denialState,
          consumers = 0;
        await assert.rejects(
          readAck(
            makeAckInput(),
            async (_matches, tx) => {
              await createProduct(aggregate(++sequence), ++sequence, { run: (work) => work(tx) });
              consumers++;
              tentative = await counts(tx);
              denialState = guardStates.get(tx);
            },
            new Set(),
            () => {
              deniedOwner = owner;
            },
            true,
          ),
          { code: owner === "Recipe" ? "RECIPE_PERMISSION_DENIED" : "CATALOG_PERMISSION_DENIED" },
        );
        deniedOwner = null;
        assert.equal(consumers, 1);
        assert.equal(denialState.phase, "async");
        assert(
          denialState.guards.some(
            (entry) => entry.evidence.asyncEntered === 1 && entry.evidence.asyncReturned === 0,
          ),
        );
        for (const key of [
          "products",
          "versions",
          "operations",
          "snapshots",
          "commits",
          "audit",
          "outbox",
        ])
          assert(tentative[key] > ackBaseline[key], key + " changed tentatively");
        assert.notDeepEqual(tentative.heads, ackBaseline.heads);
        assert.notDeepEqual(tentative.chains, ackBaseline.chains);
        assert.deepEqual(await counts(), ackBaseline);
      }
      let tentative,
        state,
        consumers = 0,
        laterCalls = 0;
      const expiring = makeAckInput();
      await assert.rejects(
        readAck(
          expiring,
          async (_matches, tx) => {
            await createProduct(aggregate(++sequence), ++sequence, { run: (work) => work(tx) });
            consumers++;
            tentative = await counts(tx);
            state = guardStates.get(tx);
            await registerBeforeCommit(
              tx,
              async () => {
                laterCalls++;
                forcedClock = expiring.request.validUntil;
              },
              () => undefined,
            );
          },
          new Set(),
          () => undefined,
          true,
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      forcedClock = null;
      assert.equal(consumers, 1);
      assert.equal(laterCalls, 1);
      assert.equal(state.constraintsCompleted, true);
      assert(
        state.guards.length >= 10,
        "History, eight reference sources and a later host guard remain held",
      );
      for (const entry of state.guards) {
        assert.equal(entry.evidence.asyncEntered, 1);
        assert.equal(entry.evidence.asyncReturned, 1);
      }
      assert.equal(state.guards[0].evidence.finalEntered, 1);
      assert.equal(state.guards[0].evidence.finalReturned, 0);
      assert.equal(state.guards[0].evidence.finalError.code, "CATALOG_DEPENDENCY_UNAVAILABLE");
      for (const key of [
        "products",
        "versions",
        "operations",
        "snapshots",
        "commits",
        "audit",
        "outbox",
      ])
        assert(tentative[key] > ackBaseline[key], key + " changed before final phase");
      assert.notDeepEqual(tentative.heads, ackBaseline.heads);
      assert.notDeepEqual(tentative.chains, ackBaseline.chains);
      assert.deepEqual(await counts(), ackBaseline);
    } finally {
      if (createdRole) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await Promise.all([admin.end(), competitor.end()]);
    }
  });
}
