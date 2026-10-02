import { createMerchantProductRecipeReferenceSource } from "../../../apps/api/src/merchant-product-recipe-reference-source.ts";
import { recipeReferenceSourceFields, RecipeWorkflowError } from "../../rms/recipe/src/index.ts";
import { createMerchantProductMenuReferenceSource } from "../../../apps/api/src/merchant-product-menu-reference-source.ts";
import { createMerchantProductBundleReferenceSource } from "../../../apps/api/src/merchant-product-bundle-reference-source.ts";
import { createMerchantProductAvailabilityReferenceSource } from "../../../apps/api/src/merchant-product-availability-reference-source.ts";
import { createMerchantProductPricingReferenceSource } from "../../../apps/api/src/merchant-product-pricing-reference-source.ts";
import { seedTaxConfiguration } from "./tax-configuration-seed.mjs";
import {
  composeMerchantProductTaxReferenceMatches,
  composeMerchantProductBrandTaxReferenceMatches,
} from "../../../apps/api/src/merchant-product-tax-reference-matches.ts";
import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  availabilityReferenceSourceFields,
  bundleReferenceSourceFields,
  menuReferenceSourceFields,
  createPostgresProductPricingBindingSourceStore,
  createPostgresProductReferenceHistorySourceStore,
} from "../../rms/catalog/src/index.ts";
import {
  createPostgresPriceBookReferenceSourceStore,
  createPostgresTaxConfigurationReferenceSourceStore,
  createPostgresBrandTaxReferenceSourceStore,
  createTaxConfigurationSnapshot,
  createPostgresOptionPriceReferenceSourceStore,
  createPostgresPromotionReferenceSourceStore,
} from "../../rms/pricing/src/index.ts";
import {
  composeMerchantProductPricingReferenceMatches,
  composeMerchantProductRecordedPricingReferenceMatches,
} from "../../../apps/api/src/merchant-product-pricing-reference-matches.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { fixture } from "../../rms/ordering/src/tests/configured-cart-quote.fixture.ts";
import { seedPriceBook } from "./price-book-seed.mjs";
import { seedOptionPriceRule } from "./option-price-seed.mjs";
/** Actual public owner SQL and API composition; fixture policy/authority is synthetic, never full review readiness. */
export async function exerciseProductPricingReferenceMatches({
  admin,
  role,
  transactions,
  catalog: previousCatalog,
  tenantReference,
  id,
}) {
  assert.match(role, /^wp2402_prod_create_[a-f0-9]+$/u);
  await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_pricing.configuration_reference_generation,rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.option_price_rule,rms_pricing.option_price_rule_version,rms_pricing.promotion,rms_pricing.promotion_version,rms_pricing.promotion_eligibility_reference,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON rms_catalog.availability_reference_generation,rms_catalog.availability_rule TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON rms_catalog.bundle_reference_generation,rms_catalog.bundle,rms_catalog.bundle_version,rms_catalog.bundle_component_group,rms_catalog.bundle_component_sellable TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON rms_catalog.menu_reference_generation,rms_catalog.menu_review_content,rms_catalog.menu_publication_revision,rms_catalog.menu_publication_release,rms_catalog.menu_release_effective_period TO " +
      role,
  );
  await admin.query("GRANT USAGE ON SCHEMA rms_recipe TO " + role);
  const recipeColumns = {
    recipe: ["recipe_id", "brand_id", "aggregate_version", "current_version_id", "updated_at"],
    recipe_version: [
      "recipe_version_id",
      "recipe_id",
      "brand_id",
      "version_number",
      "snapshot_digest",
      "lifecycle",
      "effective_from",
      "effective_until",
      "effective_time_zone",
      "created_at",
    ],
    recipe_modifier_version: [
      "rule_version_id",
      "rule_id",
      "brand_id",
      "version",
      "recipe_id",
      "recipe_version_id",
      "binding_id",
      "option_id",
      "selected_quantity",
      "lifecycle",
      "rule_digest",
      "effective_from",
      "effective_until",
      "occurred_at",
    ],
    recipe_reference_generation: ["brand_id", "generation", "binding_count"],
    recipe_reference_binding: [
      "recipe_scope_binding_id",
      "recipe_version_id",
      "recipe_id",
      "brand_id",
      "sku_id",
      "store_id",
      "option_binding_id",
      "effective_from",
      "effective_until",
    ],
  };
  for (const [table, fields] of Object.entries(recipeColumns))
    await admin.query(`GRANT SELECT(${fields.join(",")}) ON rms_recipe.${table} TO ${role}`);
  const request = previousCatalog.request,
    brandReference = request.brandReference,
    actorReference = request.actorReference,
    binding = previousCatalog.bindings[0];
  assert.ok(binding);
  const selected = binding.includedSkuReferences[0];
  assert.ok(selected);
  const original = input().priceBook;
  await seedPriceBook(
    admin,
    {
      ...original,
      priceBookReference: id(91000),
      versionReference: id(91001),
      brandReference,
      stableCode: "SYNTHETIC_MATCH_BOOK",
      entries: [{ ...original.entries[0], entryReference: id(91002), sellableReference: selected }],
    },
    actorReference,
  );
  const originalOption = fixture().quote.lines[0].optionPrices[0].rule;
  await seedOptionPriceRule(
    admin,
    {
      ...originalOption,
      ruleReference: id(91100),
      versionReference: id(91101),
      brandReference,
      bindingReference: binding.bindingReference,
      optionReference: binding.enabledOptionReferences[0],
      skuReference: selected,
      scopeKind: "Brand",
      scopeReference: null,
    },
    actorReference,
  );
  await admin.query(
    "INSERT INTO rms_pricing.promotion(promotion_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_MATCH_PROMO',1,$3,$4,$3)",
    [id(91200), brandReference, original.createdAt, actorReference],
  );
  await admin.query(
    "INSERT INTO rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id,version_number,snapshot_digest,lifecycle,promotion_type,currency_code,benefit_scope,benefit_calculation,benefit_rate,stacking,priority,budget_minor,usage_minor,usage_count,redemption_limit,effective_from,effective_time_zone,customer_copy_code,created_at) VALUES($1,$2,$3,1,$4,'Paused','OrderPercentage','CAD','Order','Percentage',0.10,'Stackable',1,100000,0,0,100,$5,'America/Toronto','SYNTHETIC_COPY',$5)",
    [id(91201), id(91200), brandReference, "sha256:" + "e".repeat(64), original.createdAt],
  );
  await admin.query(
    "INSERT INTO rms_pricing.promotion_eligibility_reference(promotion_eligibility_reference_id,promotion_version_id,promotion_id,brand_id,reference_kind,public_reference_id) VALUES($1,$2,$3,$4,'Segment',$5)",
    [id(91202), id(91201), id(91200), brandReference, id(91203)],
  );
  await admin.query(
    "UPDATE rms_pricing.promotion SET current_version_id=$1 WHERE promotion_id=$2",
    [id(91201), id(91200)],
  );
  const pricingRequest = {
    purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
    brandReference,
    actorReference,
    operationReference: request.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
  };
  const common = {
    tenantReference,
    brandReference,
    actorReference,
    transactions,
    clock: { now: () => new Date().toISOString() },
  };
  let catalogHolds = 0,
    pricingHolds = 0;
  const catalogSource = createPostgresProductPricingBindingSourceStore({
    ...common,
    authority: {
      async holdUntilTransactionCompletes(tx, input) {
        void tx;
        assert.deepEqual(input.request, request);
        catalogHolds++;
      },
    },
  });
  const authority = {
    async holdUntilTransactionCompletes(tx, input) {
      void tx;
      assert.deepEqual(input.request, pricingRequest);
      assert.ok(
        ["pricing.price-book.manage", "pricing.promotion.manage"].includes(input.permission),
      );
      pricingHolds++;
    },
  };
  const [catalog, priceBooks, optionPrices, promotions] = await Promise.all([
    catalogSource.loadSnapshot(request),
    createPostgresPriceBookReferenceSourceStore({ ...common, authority }).loadSnapshot(
      pricingRequest,
    ),
    createPostgresOptionPriceReferenceSourceStore({ ...common, authority }).loadSnapshot(
      pricingRequest,
    ),
    createPostgresPromotionReferenceSourceStore({ ...common, authority }).loadSnapshot(
      pricingRequest,
    ),
  ]);
  assert.equal(catalogHolds, 2);
  assert.equal(pricingHolds, 6);
  assert.equal(catalog.digest, previousCatalog.digest);
  const args = {
      request,
      catalog,
      priceBooks,
      optionPrices,
      promotions,
      now: new Date().toISOString(),
    },
    result = composeMerchantProductPricingReferenceMatches(args);
  assert.equal(result.coverage, "CurrentDraftOnly");
  assert.equal(result.historicalMembershipCoverage, "Unavailable");
  assert.equal(result.priceEntries.length, 1);
  assert.equal(result.priceEntries[0].sellableReference, selected);
  assert.equal(result.optionRoots.length, 1);
  assert.equal(result.optionVersions.length, 1);
  assert.deepEqual(result.optionVersions[0].matchedSkuReferences, [selected]);
  assert.deepEqual(result.optionVersions[0].bindingChannelCodes, binding.channelCodes);
  assert.equal(result.promotions.length, 1);
  assert.deepEqual(result.promotions[0].matchedBy, ["OrderSubtotal"]);
  assert.equal(result.promotions[0].reference.eligibility[0].referenceKind, "Segment");
  assert.equal(result.promotions[0].reference.lifecycle, "Paused");
  assert.equal(JSON.stringify(result).includes("Allowed"), false);
  assert.equal(JSON.stringify(result).includes("amountMinor"), false);
  assert.throws(
    () =>
      composeMerchantProductPricingReferenceMatches({
        ...args,
        request: { ...request, reasonCode: "CHANGED" },
      }),
    { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
  );
  assert.throws(
    () =>
      composeMerchantProductPricingReferenceMatches({
        ...args,
        priceBooks: { ...priceBooks, digest: "sha256:" + "f".repeat(64) },
      }),
    { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
  );
  const originalTax = input().taxConfiguration,
    taxRule = originalTax.rules.find((r) => r.chargeType === "Sellable");
  assert.ok(taxRule);
  const storeReference = id(91300),
    taxRequest = { ...pricingRequest, storeReference };
  const syntheticTax = createTaxConfigurationSnapshot({
    ...originalTax,
    configurationReference: id(91301),
    versionReference: id(91302),
    brandReference,
    storeReference,
    stableCode: "SYNTHETIC_MATCH_TAX",
    lifecycle: "Draft",
    registrationEvidence: null,
    professionalEvidence: null,
    snapshotDigest:
      "sha256:" +
      sha256Hex(canonicalizeRfc8785({ brandReference, storeReference, classification: id(804) })),
    rules: [{ ...taxRule, ruleReference: id(91310), taxClassificationReference: id(804) }],
  });
  await seedTaxConfiguration(admin, syntheticTax, actorReference);
  let taxHolds = 0;
  const taxSource = createPostgresTaxConfigurationReferenceSourceStore({
    ...common,
    storeReference,
    authority: {
      async holdUntilTransactionCompletes(tx, input) {
        void tx;
        assert.deepEqual(input.request, taxRequest);
        assert.equal(input.permission, "pricing.tax-config.manage");
        taxHolds++;
      },
    },
  });
  // Explicit synthetic Tenant registry; Tax roots alone do not prove Store existence.
  await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
  await admin.query(
    "GRANT SELECT ON bop_tenant.brand,bop_tenant.store_reference_generation,bop_tenant.store_reference_projection,rms_pricing.tax_reference_generation,rms_pricing.tax_reference_scope TO " +
      role,
  );
  await admin.query(
    "INSERT INTO bop_tenant.brand (brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,'SYNTHETIC_MATCH_BRAND','Synthetic match Brand','en-CA','CAD','Active',1,$2,$2) ON CONFLICT (brand_id) DO NOTHING",
    [brandReference, syntheticTax.createdAt],
  );
  for (const [store, state, code] of [
    [storeReference, "Active", "SYNTHETIC_MATCH_ACTIVE"],
    [id(91320), "Archived", "SYNTHETIC_MATCH_ARCHIVED"],
  ])
    await admin.query(
      "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,'Synthetic match Store','America/Toronto','en-CA','CAD',$4,1,$5,$5) ON CONFLICT (store_id) DO NOTHING",
      [store, brandReference, code, state, syntheticTax.createdAt],
    );
  const secondTax = createTaxConfigurationSnapshot({
    ...syntheticTax,
    storeReference: id(91320),
    configurationReference: id(91321),
    versionReference: id(91322),
    stableCode: "SYNTHETIC_MATCH_ARCHIVED_TAX",
    rules: syntheticTax.rules.map((r) => ({ ...r, ruleReference: id(91323) })),
    snapshotDigest:
      "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({ brandReference, storeReference: id(91320), classification: id(804) }),
      ),
  });
  await seedTaxConfiguration(admin, secondTax, actorReference);
  for (const n of [91330, 91340])
    await admin.query(
      "INSERT INTO rms_pricing.tax_configuration (tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$5)",
      [
        id(n),
        brandReference,
        id(91320),
        "SYNTHETIC_EMPTY_" + n,
        syntheticTax.createdAt,
        actorReference,
      ],
    );
  await admin.query("DELETE FROM rms_pricing.tax_configuration WHERE tax_configuration_id=$1", [
    id(91340),
  ]);
  let tenantReadHeld = false,
    brandTaxHolds = 0;
  const storeHolds = new Map();
  const brandTaxOptions = {
    ...common,
    tenantAuthority: {
      async withCurrentBrandReferenceRead(input, work) {
        assert.equal(input.brandReference, brandReference);
        assert.equal(input.actorReference, actorReference);
        assert.equal(input.originalIntentDigest, pricingRequest.catalogIntentDigest);
        assert.equal(tenantReadHeld, false);
        tenantReadHeld = true;
        try {
          return await work();
        } finally {
          tenantReadHeld = false;
        }
      },
      async isCurrent() {
        return tenantReadHeld;
      },
    },
    brandAuthority: {
      async holdUntilTransactionCompletes(tx, input) {
        void tx;
        assert.deepEqual(input.request, pricingRequest);
        assert.equal(input.requiredScope, "Brand");
        assert(input.requiredFields.includes("present"));
        assert.equal(input.permission, "pricing.tax-config.manage");
        brandTaxHolds++;
      },
    },
    taxAuthority: {
      async holdUntilTransactionCompletes(tx, input) {
        void tx;
        assert.equal(input.tenantReference, tenantReference);
        assert.deepEqual(input.request, {
          ...pricingRequest,
          storeReference: input.request.storeReference,
        });
        assert.equal(input.permission, "pricing.tax-config.manage");
        storeHolds.set(
          input.request.storeReference,
          (storeHolds.get(input.request.storeReference) ?? 0) + 1,
        );
      },
    },
  };
  const brandTaxSource = createPostgresBrandTaxReferenceSourceStore(brandTaxOptions);
  let historyHolds = 0;
  const historySource = createPostgresProductReferenceHistorySourceStore({
    ...common,
    authority: {
      async holdUntilTransactionCompletes(tx, input) {
        void tx;
        assert.deepEqual(input.request, request);
        assert.equal(input.owningAction, "catalog.product.history.read");
        assert.equal(input.purposeCode, "CATALOG_LIFECYCLE_REFERENCE_HISTORY_READ");
        historyHolds++;
      },
    },
  });
  /** Read actual sources afresh after replacement; prior observedAt snapshots are not replayed as fresh evidence. */
  async function recheckRecordedHistory(expectedConfigurations) {
    const beforeHolds = historyHolds;
    const [catalogHistory, priceBooks, optionPrices, promotions, currentCatalog] =
      await Promise.all([
        historySource.loadSnapshot(request),
        createPostgresPriceBookReferenceSourceStore({ ...common, authority }).loadSnapshot(
          pricingRequest,
        ),
        createPostgresOptionPriceReferenceSourceStore({ ...common, authority }).loadSnapshot(
          pricingRequest,
        ),
        createPostgresPromotionReferenceSourceStore({ ...common, authority }).loadSnapshot(
          pricingRequest,
        ),
        catalogSource.loadSnapshot(request),
      ]);
    assert.equal(historyHolds - beforeHolds, 2);
    const beforeTaxHolds = taxHolds,
      taxConfigurations = await taxSource.loadSnapshot(taxRequest);
    assert.equal(taxHolds - beforeTaxHolds, 2);
    const taxArgs = { request, storeReference, taxConfigurations, now: new Date().toISOString() };
    const currentTax = composeMerchantProductTaxReferenceMatches({
      ...taxArgs,
      sourceProfile: "CurrentDraftBindings",
      catalogSource: currentCatalog,
    });
    assert.equal(currentTax.classificationCoverage, "CompleteExplicit");
    assert.equal(currentTax.configurations[0].references.length, 1);
    assert.equal(currentTax.configurations[0].references[0].rule.ruleReference, id(91310));
    const historicalTax = composeMerchantProductTaxReferenceMatches({
      ...taxArgs,
      sourceProfile: "RecordedDraftConfigurations",
      catalogSource: catalogHistory,
    });
    assert.equal(historicalTax.configurations.length, expectedConfigurations);
    assert.equal(historicalTax.classificationCoverage, "DefaultUnavailable");
    assert.ok(
      historicalTax.configurations.some(
        (c) =>
          c.taxClassificationReference === null &&
          c.classificationCoverage === "DefaultUnavailable" &&
          c.references === null,
      ),
    );
    assert.ok(
      historicalTax.configurations.some(
        (c) => c.taxClassificationReference === id(804) && c.references.length === 1,
      ),
    );
    assert.equal(historicalTax.crossStoreCoverage, "Unavailable");
    assert.equal(historicalTax.skuTaxOverrideCoverage, "Unavailable");
    assert.equal(JSON.stringify(historicalTax).includes("Allowed"), false);
    assert.throws(
      () =>
        composeMerchantProductTaxReferenceMatches({
          ...taxArgs,
          storeReference: id(91399),
          sourceProfile: "RecordedDraftConfigurations",
          catalogSource: catalogHistory,
        }),
      { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
    );

    const beforeBrandHolds = brandTaxHolds;
    await brandTaxSource.withCurrentSnapshot(pricingRequest, async (taxConfigurations) => {
      assert.equal(tenantReadHeld, true);
      const brandArgs = { request, taxConfigurations, now: new Date().toISOString() };
      const current = composeMerchantProductBrandTaxReferenceMatches({
        ...brandArgs,
        sourceProfile: "CurrentDraftBindings",
        catalogSource: currentCatalog,
      });
      assert.equal(current.crossStoreCoverage, "CompleteRegisteredReferences");
      assert.equal(current.configurations[0].references.length, 2);
      assert.deepEqual(
        new Set(current.configurations[0].references.map((r) => r.storeReference)),
        new Set([storeReference, id(91320)]),
      );
      assert.equal(
        current.retiredRootReferences.find((r) => r.configurationReference === id(91340))
          .storeReference,
        id(91320),
      );
      assert.equal(
        current.unresolvedRoots.find((r) => r.configurationReference === id(91330)).storeReference,
        id(91320),
      );
      const history = composeMerchantProductBrandTaxReferenceMatches({
        ...brandArgs,
        sourceProfile: "RecordedDraftConfigurations",
        catalogSource: catalogHistory,
      });
      assert.equal(history.configurations.length, expectedConfigurations);
      assert.equal(history.classificationCoverage, "DefaultUnavailable");
      assert(
        history.configurations.some(
          (c) => c.taxClassificationReference === null && c.references === null,
        ),
      );
      assert(
        history.configurations.some(
          (c) => c.taxClassificationReference === id(804) && c.references.length === 2,
        ),
      );
      assert.equal(history.publicationCoverage, "Unavailable");
      assert.equal(history.skuTaxOverrideCoverage, "Unavailable");
    });
    assert.equal(tenantReadHeld, false);
    assert.equal(brandTaxHolds - beforeBrandHolds, 3);
    for (const store of [storeReference, id(91320)]) assert(storeHolds.get(store) >= 2);

    const args = {
        request,
        catalogHistory,
        priceBooks,
        optionPrices,
        promotions,
        now: new Date().toISOString(),
      },
      historical = composeMerchantProductRecordedPricingReferenceMatches(args);
    assert.equal(historical.configurations.length, expectedConfigurations);
    assert.equal(historical.coverage, "RecordedDraftHistoryOnly");
    assert.equal(historical.publicationCoverage, "Unavailable");
    assert.equal(historical.futureScheduleCoverage, "Unavailable");
    assert.ok(
      historical.configurations.some((c) =>
        c.matches.optionVersions.some(
          (v) =>
            v.reference.ruleReference === id(91100) && v.matchedSkuReferences.includes(selected),
        ),
      ),
    );
    assert.ok(
      historical.configurations.some((c) =>
        c.matches.unresolvedOptionRoots.some(
          (r) =>
            r.reference.ruleReference === id(91100) &&
            r.reason === "BindingNotInRecordedConfiguration" &&
            r.versions.length === 1,
        ),
      ),
    );
    assert.ok(
      historical.configurations.every(
        (c) => c.matches.priceEntries.length === 1 && c.matches.promotions.length === 1,
      ),
    );
    assert.equal(JSON.stringify(historical).includes("Allowed"), false);
    assert.throws(
      () =>
        composeMerchantProductRecordedPricingReferenceMatches({
          ...args,
          catalogHistory: { ...catalogHistory, futureScheduleCoverage: "Complete" },
        }),
      { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
    );
    assert.throws(
      () =>
        composeMerchantProductRecordedPricingReferenceMatches({
          ...args,
          request: { ...request, reasonCode: "CHANGED" },
        }),
      { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
    );
    const current = composeMerchantProductPricingReferenceMatches({
      ...args,
      catalog: currentCatalog,
    });
    if (expectedConfigurations === 3) {
      assert.equal(current.optionVersions.length, 0);
      assert.ok(current.unresolvedOptionRoots.some((r) => r.reference.ruleReference === id(91100)));
    }
    return historical;
  }
  await recheckRecordedHistory(2);
  const availabilityRequest = {
    ...pricingRequest,
    purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ",
  };
  async function seedAvailability(ruleReference, sellableType, sellableReference) {
    await admin.query(
      "INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,product_id,bundle_id,sellable_type,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,'Inactive',$4,$5,NULL,$6,$7,'[]'::jsonb,'[]'::jsonb,$8,NULL,'Unavailable',1,'SYNTHETIC_REFERENCE',$9,$10,$9)",
      [
        ruleReference,
        brandReference,
        "SYNTHETIC_AVAIL_" + ruleReference.slice(-8).toUpperCase(),
        sellableType === "Sku" ? sellableReference : null,
        sellableType === "Product" ? sellableReference : null,
        sellableType,
        id(91320),
        "2027-01-01T00:00:00.000Z",
        original.createdAt,
        actorReference,
      ],
    );
  }
  await seedAvailability(id(91500), "Product", request.productReference);
  await seedAvailability(id(91501), "Sku", selected);
  const bundleRequest = { ...pricingRequest, purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ" };
  const names = JSON.stringify({ "en-CA": "Synthetic" });
  await admin.query("BEGIN");
  await admin.query(
    "INSERT INTO rms_catalog.bundle(bundle_id,brand_id,internal_code,lifecycle,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_MATCH_BUNDLE','Draft',1,$3,$4,$5,$4)",
    [id(91600), brandReference, id(91601), original.createdAt, actorReference],
  );
  await admin.query(
    "INSERT INTO rms_catalog.bundle_version(bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,price_mode,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$4::jsonb,'Computed',$5,$5)",
    [id(91601), id(91600), brandReference, names, original.createdAt],
  );
  await admin.query(
    "INSERT INTO rms_catalog.bundle_version(bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,price_mode,validation_digest,published_at,created_at,updated_at) VALUES($1,$2,$3,'Published','en-CA',$4::jsonb,$4::jsonb,'Computed',$5,$6,$6,$6)",
    [id(91602), id(91600), brandReference, names, "sha256:" + "b".repeat(64), original.createdAt],
  );
  for (const [group, version, type, ref] of [
    [91603, 91601, "Product", request.productReference],
    [91604, 91602, "Sku", selected],
  ]) {
    await admin.query(
      "INSERT INTO rms_catalog.bundle_component_group(group_id,bundle_version_id,bundle_id,brand_id,stable_code,localized_names_json,minimum_selection,maximum_selection,sort_order) VALUES($1,$2,$3,$4,'SYNTHETIC_MATCH_GROUP',$5::jsonb,0,1,0)",
      [id(group), id(version), id(91600), brandReference, names],
    );
    await admin.query(
      "INSERT INTO rms_catalog.bundle_component_sellable(group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type) VALUES($1,$2,$3,$4,$5,$6)",
      [id(group), id(version), id(91600), brandReference, ref, type],
    );
  }
  await admin.query("COMMIT");
  const menuRequest = { ...pricingRequest, purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ" };
  await admin.query(
    "INSERT INTO rms_catalog.menu VALUES($1,$2,'SYNTHETIC_MATCH_MENU',1,$3,$4,$3)",
    [id(91700), brandReference, original.createdAt, actorReference],
  );
  await admin.query(
    "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
    [id(91701), id(91700), brandReference, names, original.createdAt],
  );
  async function seedMenuReview(
    reviewReference,
    skuReference,
    productVersionReference,
    snapshotDigest,
  ) {
    const snapshot = {
      lifecycleReference: reviewReference,
      snapshotDigest,
      createdAt: original.createdAt,
      content: {
        brandReference,
        menuReference: id(91700),
        menuVersionReference: id(91701),
        sections: [
          {
            sectionReference: id(91712),
            sellables: [
              {
                placementReference: id(91711),
                sellableReference: skuReference,
                productVersionReference,
              },
            ],
          },
        ],
      },
    };
    await admin.query(
      "INSERT INTO rms_catalog.menu_review_content(lifecycle_id,brand_id,menu_id,menu_version_id,snapshot_digest,snapshot_json,audit_reference) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
      [
        reviewReference,
        brandReference,
        id(91700),
        id(91701),
        snapshotDigest,
        JSON.stringify(snapshot),
        id(91790),
      ],
    );
  }
  const menuDigest = "sha256:" + "a".repeat(64);
  await seedMenuReview(id(91710), selected, request.originalProductVersionReference, menuDigest);
  // Stored unknown-version reference is deliberately unresolved, never an invented Product version or approval.
  await seedMenuReview(id(91740), selected, id(91799), "sha256:" + "c".repeat(64));
  for (const [version, state] of [
    [3, "Published"],
    [4, "Superseded"],
  ])
    await admin.query(
      "INSERT INTO rms_catalog.menu_publication_revision(lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id(91710),
        version,
        id(91700),
        id(91701),
        brandReference,
        menuDigest,
        state,
        id(91780),
        id(91781),
        original.createdAt,
      ],
    );
  await admin.query(
    "INSERT INTO rms_catalog.menu_publication_release(release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,previous_release_id,release_kind,snapshot_digest,created_at) VALUES($1,$2,3,$3,$4,$5,1,NULL,'Publish',$6,$7)",
    [id(91720), id(91710), id(91700), id(91701), brandReference, menuDigest, original.createdAt],
  );
  await admin.query(
    "INSERT INTO rms_catalog.menu_release_effective_period(timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES($1,$2,$3,$4,'America/Toronto','2027-01-01T00:00:00.000Z','2027-01-02T00:00:00.000Z',$5,$6,$7)",
    [id(91721), id(91720), id(91700), brandReference, menuDigest, id(91781), original.createdAt],
  );
  const recipeRequest = { ...pricingRequest, purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" };
  await admin.query(
    "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_MATCH_RECIPE',1,$3,$4,$3)",
    [id(91800), brandReference, original.createdAt, actorReference],
  );
  for (const [version, lifecycle] of [
    [1, "Draft"],
    [2, "Archived"],
  ])
    await admin.query(
      "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,$4,$5,$6,'SYNTHETIC_NAME',1,'PORTION','Count',$7,'2027-01-01T00:00:00.000Z','America/Toronto',$8)",
      [
        id(91800 + version),
        id(91800),
        brandReference,
        version,
        menuDigest,
        lifecycle,
        id(91880),
        original.createdAt,
      ],
    );
  await admin.query(
    "UPDATE rms_recipe.recipe SET aggregate_version=3,current_version_id=$1 WHERE recipe_id=$2",
    [id(91801), id(91800)],
  );
  async function seedRecipeBinding(reference, sku, recipeVersion, optionBinding = null) {
    await admin.query(
      "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,$7,'2027-01-01T00:00:00.000Z')",
      [reference, recipeVersion, id(91800), brandReference, sku, id(91899), optionBinding],
    );
  }
  await seedRecipeBinding(id(91810), selected, id(91801));
  await seedRecipeBinding(id(91811), selected, id(91802), binding.bindingReference);
  const recipeOption = binding.enabledOptionReferences[0];
  assert.ok(recipeOption);
  for (const [reference, rule, version, option, lifecycle] of [
    [91820, 91820, 1, recipeOption, "Draft"],
    [91821, 91820, 2, recipeOption, "Archived"],
    [91822, 91822, 1, id(91898), "Draft"],
  ])
    await admin.query(
      "INSERT INTO rms_recipe.recipe_modifier_version(rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,operation_id,actor_id,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11::jsonb,'2027-01-01T00:00:00.000Z',$12,$13,$14,$15)",
      [
        id(reference),
        id(rule),
        brandReference,
        version,
        id(91800),
        id(91801),
        binding.bindingReference,
        option,
        lifecycle,
        menuDigest,
        JSON.stringify({
          ruleReference: id(rule),
          ruleVersionReference: id(reference),
          ruleDigest: menuDigest,
          brandReference,
          recipeVersionReference: id(91801),
          selection: {
            bindingReference: binding.bindingReference,
            optionReference: option,
            quantity: 1,
          },
          changes: [],
        }),
        id(reference + 10000),
        actorReference,
        id(reference + 20000),
        original.createdAt,
      ],
    );
  // Compose eight owning sources on one physical UoW in Catalog -> Tenant -> Tax -> Pricing -> Availability -> Bundle -> Menu -> Recipe order.
  // Reusing factories with independent runners here would block on Catalog's own fence.
  const probe = () =>
    transactions.run(async (peer) => {
      const result = await peer.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) catalog,pg_try_advisory_xact_lock(hashtextextended($2,0)) stores,pg_try_advisory_xact_lock(hashtextextended($3,0)) taxes,pg_try_advisory_xact_lock(hashtextextended($4,0)) pricing,pg_try_advisory_xact_lock(hashtextextended($5,0)) availability,pg_try_advisory_xact_lock(hashtextextended($6,0)) bundle,pg_try_advisory_xact_lock(hashtextextended($7,0)) menu,pg_try_advisory_xact_lock(hashtextextended($8,0)) recipe",
        [
          "CatalogProductSource:" + brandReference,
          "TenantStoreReferenceV1:" + brandReference,
          "PricingTaxReferenceV1:" + brandReference,
          "PricingConfigurationReferenceV1:" + brandReference,
          "CatalogAvailabilityReferenceV1:" + brandReference,
          "CatalogBundleReferenceV1:" + brandReference,
          "CatalogMenuReferenceV1:" + brandReference,
          "RecipeCatalogReferenceV1:" + brandReference,
        ],
      );
      return result.rows[0];
    });
  const marker = Object.freeze({ composed: true });
  const held = await transactions.run(async (tx) => {
    const bound = { ...common, transactions: { run: (work) => work(tx) } };
    const catalogHeld = createPostgresProductPricingBindingSourceStore({
      ...bound,
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.request, request);
          assert.equal(input.permission, "catalog.manage");
          for (const field of [
            "aggregateVersion",
            "productLifecycle",
            "skuLifecycle",
            "activeSkuCount",
          ])
            assert(input.requiredFields.includes(field));
        },
      },
    });
    const historyHeld = createPostgresProductReferenceHistorySourceStore({
      ...bound,
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.request, request);
          assert.equal(input.owningAction, "catalog.product.history.read");
          for (const field of [
            "aggregateVersion",
            "productLifecycle",
            "skuLifecycle",
            "activeSkuCount",
          ])
            assert(input.requiredFields.includes(field));
        },
      },
    });
    const taxHeld = createPostgresBrandTaxReferenceSourceStore({
      ...brandTaxOptions,
      transactions: bound.transactions,
    });
    const value = await catalogHeld.withCurrentSnapshot(request, (catalogSource) =>
      historyHeld.withCurrentSnapshot(request, (historySource) =>
        taxHeld.withCurrentSnapshot(pricingRequest, async (taxConfigurations) => {
          assert.equal(tenantReadHeld, true);
          const args = { request, taxConfigurations, now: new Date().toISOString() };
          const current = composeMerchantProductBrandTaxReferenceMatches({
            ...args,
            sourceProfile: "CurrentDraftBindings",
            catalogSource,
          });
          const history = composeMerchantProductBrandTaxReferenceMatches({
            ...args,
            sourceProfile: "RecordedDraftConfigurations",
            catalogSource: historySource,
          });
          assert.equal(current.configurations[0].references.length, 2);
          assert.equal(history.configurations.length, 2);
          assert.equal(history.classificationCoverage, "DefaultUnavailable");
          assert.equal(history.publicationCoverage, "Unavailable");
          let denyCurrentReference = false,
            denyPricingFields = false,
            denyAvailabilityFields = false;
          const familyAuthority = {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.deepEqual(input.request, pricingRequest);
              assert(input.requiredFields.length > 0);
              if (denyPricingFields) throw new Error("synthetic source field revoked");
            },
          };
          let pricingHeaders = 0;
          const referenceOptions = {
            transaction: tx,
            tenantReference,
            request,
            clock: common.clock,
            currentAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.deepEqual(input.request, request);
                assert(input.requiredFields.includes("aggregateVersion"));
                if (denyCurrentReference) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              },
            },
            recordedAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.equal(input.owningAction, "catalog.product.history.read");
                assert.deepEqual(input.request, request);
              },
            },
            pricing: {
              authority: {
                async holdUntilTransactionCompletes(actual, input) {
                  assert.equal(actual, tx);
                  assert.equal(input.requiredScope, "Brand");
                  assert.deepEqual(input.request, pricingRequest);
                  assert.deepEqual(input.requiredPermissions, [
                    "pricing.price-book.manage",
                    "pricing.promotion.manage",
                  ]);
                  pricingHeaders++;
                },
              },
              priceBookAuthority: familyAuthority,
              optionPriceAuthority: familyAuthority,
              promotionAuthority: familyAuthority,
            },
          };
          const references = createMerchantProductPricingReferenceSource(referenceOptions);
          const availabilityReferences = createMerchantProductAvailabilityReferenceSource({
            transaction: tx,
            tenantReference,
            request,
            clock: common.clock,
            currentAuthority: referenceOptions.currentAuthority,
            recordedAuthority: referenceOptions.recordedAuthority,
            availabilityAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.deepEqual(input.request, availabilityRequest);
                assert.equal(input.requiredScope, "FullBrandScope");
                assert.deepEqual(input.requiredFields, availabilityReferenceSourceFields);
                if (denyAvailabilityFields) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              },
            },
          });
          let denyBundleFields = false;
          const bundleReferences = createMerchantProductBundleReferenceSource({
            transaction: tx,
            tenantReference,
            request,
            clock: common.clock,
            currentAuthority: referenceOptions.currentAuthority,
            recordedAuthority: referenceOptions.recordedAuthority,
            bundleAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.deepEqual(input.request, bundleRequest);
                assert.equal(input.requiredScope, "FullBrandScope");
                assert.deepEqual(input.requiredFields, bundleReferenceSourceFields);
                if (denyBundleFields) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              },
            },
          });
          let denyMenuFields = false;
          const menuReferences = createMerchantProductMenuReferenceSource({
            transaction: tx,
            tenantReference,
            request,
            clock: common.clock,
            currentAuthority: referenceOptions.currentAuthority,
            recordedAuthority: referenceOptions.recordedAuthority,
            menuAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.deepEqual(input.request, menuRequest);
                assert.equal(input.requiredScope, "FullBrandScope");
                assert.deepEqual(input.requiredFields, menuReferenceSourceFields);
                if (denyMenuFields) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              },
            },
          });
          let denyRecipeFields = false;
          const recipeReferences = createMerchantProductRecipeReferenceSource({
            transaction: tx,
            tenantReference,
            request,
            clock: common.clock,
            currentAuthority: referenceOptions.currentAuthority,
            recordedAuthority: referenceOptions.recordedAuthority,
            recipeAuthority: {
              async holdUntilTransactionCompletes(actual, input) {
                assert.equal(actual, tx);
                assert.deepEqual(input.request, recipeRequest);
                assert.equal(input.permission, "recipe.manage");
                assert.equal(input.requiredScope, "FullBrandScope");
                assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
                if (denyRecipeFields) throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
              },
            },
          });
          const value = await references.withCurrentMatches(async (matches) => {
            assert.equal(tenantReadHeld, true);
            assert.equal(matches.current.priceEntries.length, 1);
            assert.equal(matches.current.optionVersions.length, 1);
            assert.equal(matches.recorded.configurations.length, 2);
            assert.equal(matches.recorded.publicationCoverage, "Unavailable");
            assert.equal(matches.recorded.futureScheduleCoverage, "Unavailable");
            assert.match(matches.pricingGeneration, /^[0-9]+$/);
            assert.match(matches.pricingSourceDigest, /^sha256:[0-9a-f]{64}$/);
            return availabilityReferences.withCurrentMatches(async (availability) => {
              assert.equal(availability.current.references.length, 2);
              assert.equal(availability.recorded.length, 2);
              assert.equal(availability.applicability, "Unavailable");
              assert.equal(availability.indirectBundleCoverage, "Unavailable");
              assert(availability.current.references.every((r) => r.storeReference === id(91320)));
              assert.match(availability.availabilityGeneration, /^[0-9]+$/);
              return bundleReferences.withCurrentMatches(async (bundles) => {
                assert.equal(bundles.current.references.length, 2);
                assert.equal(bundles.recorded.length, 2);
                assert.equal(bundles.bundlePublicationCoverage, "Unavailable");
                assert.equal(bundles.applicability, "Unavailable");
                assert.ok(
                  bundles.current.references.some(
                    (r) => !r.isCurrentBundleVersion && r.version.versionStatus === "Published",
                  ),
                );
                assert.ok(
                  bundles.current.references.some(
                    (r) => r.isCurrentBundleVersion && r.version.versionStatus === "Draft",
                  ),
                );
                return menuReferences.withCurrentMatches(async (menus) => {
                  assert.equal(menus.current.references.length, 1);
                  assert.equal(menus.current.references[0].placements[0].skuReference, selected);
                  assert.equal(menus.current.references[0].lifecycle.state, "Superseded");
                  assert.equal(menus.current.references[0].releases[0].lifecycleVersion, 3);
                  assert.equal(
                    menus.current.references[0].periods[0].effectiveFrom,
                    "2027-01-01T00:00:00.000Z",
                  );
                  assert.equal(menus.unresolved.length, 1);
                  assert.equal(
                    menus.unresolved[0].placements[0].productVersionReference,
                    id(91799),
                  );
                  assert.equal(menus.publicationCoverage, "Unavailable");
                  assert.equal(menus.futureScheduleCoverage, "Unavailable");
                  assert.equal(menus.applicability, "Unavailable");
                  return recipeReferences.withCurrentMatches(async (recipes) => {
                    assert.equal(recipes.current.references.length, 2);
                    assert.equal(
                      recipes.current.references.find(
                        (r) => r.version.recipeVersionReference === id(91801),
                      ).modifiers.length,
                      2,
                    );
                    assert.equal(
                      recipes.current.references[0].bindings[0].storeReference,
                      id(91899),
                    );
                    assert.equal(recipes.current.unresolved.flatMap((r) => r.modifiers).length, 1);
                    assert.equal(
                      recipes.current.unresolved.flatMap((r) => r.modifiers)[0].reason,
                      "OptionNotEnabledInConfiguration",
                    );
                    assert.equal(recipes.recorded.length, 2);
                    assert.equal(recipes.publicationCoverage, "Unavailable");
                    assert.equal(recipes.futureScheduleCoverage, "Unavailable");
                    assert.equal(recipes.applicability, "Unavailable");
                    assert.deepEqual(await probe(), {
                      catalog: false,
                      stores: false,
                      taxes: false,
                      pricing: false,
                      availability: false,
                      bundle: false,
                      menu: false,
                      recipe: false,
                    });
                    return marker;
                  });
                });
              });
            });
          });
          assert.equal(value, marker);
          assert.equal(pricingHeaders, 3);
          const unused = async () => assert.fail("denied API source consumer");
          denyAvailabilityFields = true;
          await assert.rejects(availabilityReferences.withCurrentMatches(unused), {
            code: "CATALOG_PERMISSION_DENIED",
          });
          denyAvailabilityFields = false;
          await assert.rejects(
            availabilityReferences.withCurrentMatches(async () => {
              denyAvailabilityFields = true;
              return "revoked after consumer";
            }),
            { code: "CATALOG_PERMISSION_DENIED" },
          );
          denyAvailabilityFields = false;
          denyBundleFields = true;
          await assert.rejects(bundleReferences.withCurrentMatches(unused), {
            code: "CATALOG_PERMISSION_DENIED",
          });
          denyBundleFields = false;
          await assert.rejects(
            bundleReferences.withCurrentMatches(async () => {
              denyBundleFields = true;
              return "late Bundle field revocation";
            }),
            { code: "CATALOG_PERMISSION_DENIED" },
          );
          denyBundleFields = false;
          denyMenuFields = true;
          await assert.rejects(menuReferences.withCurrentMatches(unused), {
            code: "CATALOG_PERMISSION_DENIED",
          });
          denyMenuFields = false;
          await assert.rejects(
            menuReferences.withCurrentMatches(async () => {
              denyMenuFields = true;
              return "late Menu field revocation";
            }),
            { code: "CATALOG_PERMISSION_DENIED" },
          );
          denyMenuFields = false;
          denyRecipeFields = true;
          await assert.rejects(recipeReferences.withCurrentMatches(unused), {
            code: "CATALOG_PERMISSION_DENIED",
          });
          denyRecipeFields = false;
          await assert.rejects(
            recipeReferences.withCurrentMatches(async () => {
              denyRecipeFields = true;
              return "late Recipe field revocation";
            }),
            { code: "CATALOG_PERMISSION_DENIED" },
          );
          denyRecipeFields = false;
          denyCurrentReference = true;
          await assert.rejects(references.withCurrentMatches(unused), {
            code: "CATALOG_PERMISSION_DENIED",
          });
          denyCurrentReference = false;
          denyPricingFields = true;
          await assert.rejects(references.withCurrentMatches(unused), {
            code: "CATALOG_DEPENDENCY_UNAVAILABLE",
          });
          denyPricingFields = false;
          return value;
        }),
      ),
    );
    assert.equal(value, marker);
    assert.equal(tenantReadHeld, false);
    // Source fences remain even after all callbacks return, until the outer COMMIT.
    assert.deepEqual(await probe(), {
      catalog: false,
      stores: false,
      taxes: false,
      pricing: false,
      availability: false,
      bundle: false,
      menu: false,
      recipe: false,
    });
    return value;
  });
  assert.equal(held, marker);
  assert.deepEqual(await probe(), {
    catalog: true,
    stores: true,
    taxes: true,
    pricing: true,
    availability: true,
    bundle: true,
    menu: true,
    recipe: true,
  });
  async function recheckHeldCurrentReferences(aggregate) {
    const addedSku = aggregate.draft.skus.find((s) => s.skuReference === id(810));
    assert.ok(addedSku);
    await seedAvailability(id(91502), "Sku", addedSku.skuReference);
    await admin.query(
      "INSERT INTO rms_catalog.bundle_component_sellable(group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type) VALUES($1,$2,$3,$4,$5,'Sku')",
      [id(91603), id(91601), id(91600), brandReference, addedSku.skuReference],
    );
    await seedMenuReview(
      id(91730),
      addedSku.skuReference,
      aggregate.draft.versionReference,
      "sha256:" + "b".repeat(64),
    );
    await seedRecipeBinding(id(91812), addedSku.skuReference, id(91802));
    const currentRequest = {
      ...request,
      expectedAggregateVersion: aggregate.aggregateVersion,
      originalProductVersionReference: aggregate.draft.versionReference,
      beforeLifecycle: aggregate.lifecycle,
      activeSkuCount: aggregate.draft.skus.filter((s) => s.lifecycle === "Active").length,
    };
    const currentPricingRequest = {
      ...pricingRequest,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(currentRequest)),
    };
    return transactions.run(async (tx) => {
      const authority = {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.request, currentRequest);
        },
      };
      const family = {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.request, currentPricingRequest);
        },
      };
      const sourceOptions = {
        transaction: tx,
        tenantReference,
        request: currentRequest,
        clock: common.clock,
        currentAuthority: authority,
        recordedAuthority: authority,
        pricing: {
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.equal(input.requiredScope, "Brand");
              assert.deepEqual(input.request, currentPricingRequest);
            },
          },
          priceBookAuthority: family,
          optionPriceAuthority: family,
          promotionAuthority: family,
        },
      };
      const source = createMerchantProductPricingReferenceSource(sourceOptions);
      const result = await source.withCurrentMatches(async (matches) => {
        assert.equal(matches.current.optionVersions.length, 0);
        assert.equal(matches.recorded.configurations.length, 3);
        assert.equal(matches.recorded.publicationCoverage, "Unavailable");
        assert(
          matches.recorded.configurations.some((c) =>
            c.matches.optionVersions.some((v) => v.reference.ruleReference === id(91100)),
          ),
        );
        return matches;
      });
      const availabilityOriginal = {
        ...availabilityRequest,
        catalogIntentDigest: currentPricingRequest.catalogIntentDigest,
      };
      const availabilitySource = createMerchantProductAvailabilityReferenceSource({
        transaction: tx,
        tenantReference,
        request: currentRequest,
        clock: common.clock,
        currentAuthority: authority,
        recordedAuthority: authority,
        availabilityAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, availabilityOriginal);
            assert.equal(input.requiredScope, "FullBrandScope");
          },
        },
      });
      await availabilitySource.withCurrentMatches(async (matches) => {
        assert.equal(matches.current.references.length, 3);
        assert.equal(matches.recorded.length, 3);
        assert(
          matches.recorded.some(
            (c) =>
              c.references.length === 2 &&
              !c.configuration.skuReferences.includes(addedSku.skuReference),
          ),
        );
        assert(
          matches.recorded.some(
            (c) =>
              c.references.length === 3 &&
              c.configuration.skuReferences.includes(addedSku.skuReference),
          ),
        );
      });
      await createMerchantProductBundleReferenceSource({
        transaction: tx,
        tenantReference,
        request: currentRequest,
        clock: common.clock,
        currentAuthority: authority,
        recordedAuthority: authority,
        bundleAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, {
              ...bundleRequest,
              catalogIntentDigest: currentPricingRequest.catalogIntentDigest,
            });
          },
        },
      }).withCurrentMatches(async (matches) => {
        assert.equal(matches.current.references.length, 3);
        assert.equal(matches.recorded.length, 3);
        assert(
          matches.recorded.some(
            (c) =>
              c.references.length === 2 &&
              !c.configuration.skuReferences.includes(addedSku.skuReference),
          ),
        );
        assert(
          matches.recorded.some(
            (c) =>
              c.references.length === 3 &&
              c.configuration.skuReferences.includes(addedSku.skuReference),
          ),
        );
      });
      await createMerchantProductMenuReferenceSource({
        transaction: tx,
        tenantReference,
        request: currentRequest,
        clock: common.clock,
        currentAuthority: authority,
        recordedAuthority: authority,
        menuAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, {
              ...menuRequest,
              catalogIntentDigest: currentPricingRequest.catalogIntentDigest,
            });
          },
        },
      }).withCurrentMatches(async (matches) => {
        assert.equal(aggregate.draft.versionReference, request.originalProductVersionReference);
        assert.equal(matches.current.references.length, 2);
        const newlyReviewed = matches.current.references.find(
          (r) => r.review.reviewReference === id(91730),
        );
        assert.ok(newlyReviewed);
        assert.equal(newlyReviewed.placements[0].skuReference, addedSku.skuReference);
        assert.equal(newlyReviewed.lifecycle, null);
        assert(matches.current.references.some((r) => r.review.reviewReference === id(91710)));
        assert.equal(matches.recorded.length, 3);
        assert.equal(matches.unresolved.length, 1);
        assert(
          matches.recorded.some(
            (c) =>
              c.configuration.versionReference === request.originalProductVersionReference &&
              c.references.some((r) => r.review.reviewReference === id(91710)),
          ),
        );
        assert(
          matches.recorded
            .filter((c) => !c.configuration.skuReferences.includes(addedSku.skuReference))
            .every((c) => c.references.every((r) => r.review.reviewReference !== id(91730))),
        );
      });
      await createMerchantProductRecipeReferenceSource({
        transaction: tx,
        tenantReference,
        request: currentRequest,
        clock: common.clock,
        currentAuthority: authority,
        recordedAuthority: authority,
        recipeAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, {
              ...recipeRequest,
              catalogIntentDigest: currentPricingRequest.catalogIntentDigest,
            });
            assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
          },
        },
      }).withCurrentMatches(async (matches) => {
        assert.equal(matches.current.references.length, 2);
        assert(
          matches.current.references
            .flatMap((r) => r.bindings)
            .some((b) => b.skuReference === addedSku.skuReference),
        );
        assert.equal(matches.current.references.flatMap((r) => r.modifiers).length, 0);
        assert(
          matches.current.unresolved
            .flatMap((r) => r.bindings)
            .some((b) => b.reason === "BindingNotInConfiguration"),
        );
        assert.equal(matches.recorded.length, 3);
        assert(
          matches.recorded
            .filter((r) => !r.configuration.skuReferences.includes(addedSku.skuReference))
            .every((r) =>
              r.matches.references
                .flatMap((g) => g.bindings)
                .every((b) => b.skuReference !== addedSku.skuReference),
            ),
        );
        assert(
          matches.recorded.some((r) =>
            r.matches.references
              .flatMap((g) => g.modifiers)
              .some((m) => m.reference.ruleVersionReference === id(91820)),
          ),
        );
      });
      assert.equal(addedSku.lifecycle, "Draft");
      const skuRequest = {
        ...currentRequest,
        skuReference: addedSku.skuReference,
        beforeLifecycle: addedSku.lifecycle,
        targetLifecycle: "Archived",
      };
      const skuAvailabilityRequest = {
        ...availabilityOriginal,
        catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(skuRequest)),
      };
      const skuAuthority = {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.request, skuRequest);
        },
      };
      await createMerchantProductAvailabilityReferenceSource({
        transaction: tx,
        tenantReference,
        request: skuRequest,
        clock: common.clock,
        currentAuthority: skuAuthority,
        recordedAuthority: skuAuthority,
        availabilityAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, skuAvailabilityRequest);
          },
        },
      }).withCurrentMatches(async (matches) => {
        assert.equal(matches.current.references.length, 2);
        assert.equal(matches.recorded.filter((c) => c.targetMembership === "Absent").length, 2);
        assert(
          matches.recorded
            .filter((c) => c.targetMembership === "Absent")
            .every((c) => c.references.length === 0),
        );
      });
      await createMerchantProductBundleReferenceSource({
        transaction: tx,
        tenantReference,
        request: skuRequest,
        clock: common.clock,
        currentAuthority: skuAuthority,
        recordedAuthority: skuAuthority,
        bundleAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, {
              ...bundleRequest,
              catalogIntentDigest: skuAvailabilityRequest.catalogIntentDigest,
            });
          },
        },
      }).withCurrentMatches(async (matches) => {
        assert.equal(matches.current.references.length, 2);
        assert.equal(matches.recorded.filter((c) => c.targetMembership === "Absent").length, 2);
        assert(
          matches.recorded
            .filter((c) => c.targetMembership === "Absent")
            .every((c) => c.references.length === 0),
        );
      });
      await createMerchantProductMenuReferenceSource({
        transaction: tx,
        tenantReference,
        request: skuRequest,
        clock: common.clock,
        currentAuthority: skuAuthority,
        recordedAuthority: skuAuthority,
        menuAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, {
              ...menuRequest,
              catalogIntentDigest: skuAvailabilityRequest.catalogIntentDigest,
            });
          },
        },
      }).withCurrentMatches(async (matches) => {
        assert.equal(matches.current.references.length, 1);
        assert.equal(matches.unresolved.length, 0);
        assert.equal(matches.recorded.filter((c) => c.targetMembership === "Absent").length, 2);
        assert(
          matches.recorded
            .filter((c) => c.targetMembership === "Absent")
            .every((c) => c.references.length === 0),
        );
      });
      await createMerchantProductRecipeReferenceSource({
        transaction: tx,
        tenantReference,
        request: skuRequest,
        clock: common.clock,
        currentAuthority: skuAuthority,
        recordedAuthority: skuAuthority,
        recipeAuthority: {
          async holdUntilTransactionCompletes(actual, input) {
            assert.equal(actual, tx);
            assert.deepEqual(input.request, {
              ...recipeRequest,
              catalogIntentDigest: skuAvailabilityRequest.catalogIntentDigest,
            });
          },
        },
      }).withCurrentMatches(async (matches) => {
        assert.equal(matches.current.references.length, 1);
        assert.equal(matches.current.references[0].bindings.length, 1);
        assert.equal(matches.current.references[0].bindings[0].skuReference, addedSku.skuReference);
        assert.equal(matches.current.unresolved.length, 0);
        assert.equal(
          matches.recorded.filter((r) => r.matches.targetMembership === "Absent").length,
          2,
        );
        assert(
          matches.recorded
            .filter((r) => r.matches.targetMembership === "Absent")
            .every((r) => r.matches.references.length === 0 && r.matches.unresolved.length === 0),
        );
      });
      const oldAuthority = {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.request, request);
        },
      };
      const stale = createMerchantProductPricingReferenceSource({
        ...sourceOptions,
        request,
        currentAuthority: oldAuthority,
        recordedAuthority: oldAuthority,
      });
      await assert.rejects(
        stale.withCurrentMatches(async () => assert.fail("stale original target")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      let obsoleteAvailabilityAuthorityCalls = 0;
      await assert.rejects(
        createMerchantProductAvailabilityReferenceSource({
          transaction: tx,
          tenantReference,
          request,
          clock: common.clock,
          currentAuthority: oldAuthority,
          recordedAuthority: oldAuthority,
          availabilityAuthority: {
            async holdUntilTransactionCompletes() {
              obsoleteAvailabilityAuthorityCalls++;
            },
          },
        }).withCurrentMatches(async () => assert.fail("obsolete Availability target")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(obsoleteAvailabilityAuthorityCalls, 0);
      let obsoleteBundleAuthorityCalls = 0;
      await assert.rejects(
        createMerchantProductBundleReferenceSource({
          transaction: tx,
          tenantReference,
          request,
          clock: common.clock,
          currentAuthority: oldAuthority,
          recordedAuthority: oldAuthority,
          bundleAuthority: {
            async holdUntilTransactionCompletes() {
              obsoleteBundleAuthorityCalls++;
            },
          },
        }).withCurrentMatches(async () => assert.fail("obsolete Bundle target")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(obsoleteBundleAuthorityCalls, 0);
      let obsoleteMenuAuthorityCalls = 0;
      await assert.rejects(
        createMerchantProductMenuReferenceSource({
          transaction: tx,
          tenantReference,
          request,
          clock: common.clock,
          currentAuthority: oldAuthority,
          recordedAuthority: oldAuthority,
          menuAuthority: {
            async holdUntilTransactionCompletes() {
              obsoleteMenuAuthorityCalls++;
            },
          },
        }).withCurrentMatches(async () => assert.fail("obsolete Menu target")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(obsoleteMenuAuthorityCalls, 0);

      let obsoleteRecipeAuthorityCalls = 0;
      await assert.rejects(
        createMerchantProductRecipeReferenceSource({
          transaction: tx,
          tenantReference,
          request,
          clock: common.clock,
          currentAuthority: oldAuthority,
          recordedAuthority: oldAuthority,
          recipeAuthority: {
            async holdUntilTransactionCompletes() {
              obsoleteRecipeAuthorityCalls++;
            },
          },
        }).withCurrentMatches(async () => assert.fail("obsolete Recipe target")),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(obsoleteRecipeAuthorityCalls, 0);

      return result;
    });
  }
  return { recheckRecordedHistory, recheckHeldCurrentReferences };
}
