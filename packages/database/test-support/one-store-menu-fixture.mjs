import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createMerchantCombos } from "../../../apps/api/src/merchant-combos.ts";
import { createMerchantDishAllergens } from "../../../apps/api/src/merchant-dish-allergens.ts";
import { createMerchantMenus } from "../../../apps/api/src/merchant-menus.ts";
import { createMerchantOneStoreDishes } from "../../../apps/api/src/merchant-one-store-dishes.ts";
import { createMerchantOptionPrices } from "../../../apps/api/src/merchant-option-prices.ts";
import { createMerchantOptionRecipes } from "../../../apps/api/src/merchant-option-recipes.ts";
import { createMerchantOptionSets } from "../../../apps/api/src/merchant-option-sets.ts";
import { createMerchantPrices } from "../../../apps/api/src/merchant-prices.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createAllergenRegistryVersion } from "../../rms/catalog/src/index.ts";
import {
  createPostgresKitchenRoutingConfigurationStore,
  rebindKitchenRoutingEvidence,
} from "../../rms/kitchen/src/index.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { syntheticMerchantBrandScope } from "./merchant-brand-scope.mjs";
import { dbNow, seedBrandMember, seedBrandRole } from "./sole-operator-brand-gate.mjs";

/**
 * WP-2423 item 3: one Brand with one Store and the whole one-page menu composition, as the pilot
 * runs it: every command under test goes through the real tenant transaction runner (its limits,
 * statement memo and conflict mapping) as the restricted pilot API role; only this setup is written
 * as owner. A database can hold several of these Brands (`base`), each with its own `id`.
 */
/**
 * DEC-MERCHANT-LOCK-SCOPE: an option recipe write takes its Brand's recipe fence exclusive (first a
 * try, takeRecipeReferenceFenceBounded); a Recipe save takes the same key the same way.
 */
export const recipeFenceTry = "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) taken";
export const isRecipeFenceTake = (sql, values, brandReference) =>
  sql === recipeFenceTry && values?.[0] === "RecipeCatalogReferenceV1:" + brandReference;
export const menuOwnerActions = Object.freeze([
  "recipe.read",
  "recipe.update",
  "recipe.approve",
  "recipe.publish",
  "catalog.allergen.declare",
  "inventory.item.create",
  "inventory.item.activate",
  "catalog.menu.read",
  "catalog.menu.update",
  "catalog.menu.submit",
  "catalog.menu.approve",
  "catalog.menu.publish",
  // The legacy code the Menu service still checks (pilot roles hold its equivalents).
  "catalog.menu.manage",
  "publishing.draft.create",
  "publishing.review.submit",
  "publishing.review.approve",
]);
export const menuOwnerGrants = Object.freeze([
  "catalog.product.read",
  "catalog.product.create",
  "catalog.product.update",
  "catalog.product.manage",
  "catalog.product.publish",
  "catalog.sku.create",
  "catalog.sku.activate",
  "catalog.sku.availability.manage",
  "catalog.sku.read",
  "catalog.option_set.read",
  "catalog.option_set.manage",
  "pricing.price_book.read",
  "pricing.price-book.manage",
  "pricing.price-book.approve",
  "pricing.price_book.approve",
  ...menuOwnerActions,
]);

export async function createOneStoreMenuFixture(
  admin,
  context,
  { role, base = 0, orderTypes = ["DINE_IN"], otherActors = {} },
) {
  const id = (n) =>
    "01909b00-0000-7000-8000-" + (base * 0x1000000 + n).toString(16).padStart(12, "0");
  const tenantReference = id(1),
    brandReference = id(2),
    storeReference = id(3),
    owner = id(4),
    taxClass = id(100);
  let operation = 0x7000 + base * 0x1000000;
  const op = () => "019b0006-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
  const start = Date.parse(await dbNow(admin));
  const from = new Date(start - 3 * 3600_000).toISOString();

  await admin.query(
    "INSERT INTO bop_tenant.brand (brand_id,code,display_name,default_locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'Synthetic Brand','en-CA','CAD','Active',1,$3,$3)",
    [brandReference, "SYNTHETIC_MENU_" + base, from],
  );
  await admin.query(
    "INSERT INTO bop_permission.policy_state (brand_id,snapshot_id,version,updated_at) VALUES ($1,$2,1,$3)",
    [brandReference, id(300), from],
  );
  await admin.query(
    "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'STORE_ONE','Synthetic STORE_ONE','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
    [storeReference, brandReference, from],
  );
  // TEST-ONLY Store tax configuration covering the tax class the products use (13 %).
  await admin.query(
    "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,'2026-01-01T00:00:00Z',$4,'2026-01-01T00:00:00Z')",
    [id(200), brandReference, storeReference, owner],
  );
  await admin.query(
    `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
     VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,'2026-01-01T00:00:00Z',NULL,'America/Toronto',$7,$8,$9,'2027-01-01T00:00:00Z',$10,$11,$12,$5,'2027-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
    [
      id(201),
      id(200),
      brandReference,
      storeReference,
      "sha256:" + "a".repeat(64),
      id(202),
      id(203),
      id(204),
      id(205),
      id(206),
      id(207),
      id(208),
    ],
  );
  for (const [n, orderType] of [
    [210, "Pickup"],
    [211, "DineIn"],
  ])
    await admin.query(
      "INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,$7,'Sellable','TEST_TAX','Taxable',0.13,'Exclusive','HalfUp',1,false,NULL,'TEST_TAX_LINE')",
      [id(n), id(201), id(200), brandReference, storeReference, taxClass, orderType],
    );
  await admin.query(
    "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
    [id(201), id(200)],
  );

  // One store; the owner holds everything the one-page menu's saves use.
  const ownerRole = await seedBrandRole(admin, {
    id: (n) => id(n),
    brandReference,
    roleId: id(310),
    code: "brand_owner",
    actions: ["pricing.price-book.approve", "pricing.price-book.manage", ...menuOwnerActions],
    from,
  });
  await seedBrandMember(admin, {
    id,
    base: 400,
    brandReference,
    storeReference,
    actorReference: owner,
    name: "Sam",
    roles: [ownerRole],
    from,
    enrolledAt: new Date(start - 2 * 3600_000).toISOString(),
  });

  const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const scope = { tenantReference, brandReference, storeReference };
  const setup = async (work) => {
    await admin.query("BEGIN");
    try {
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenantReference, brandReference, storeReference],
      );
      const value = await work(admin);
      await admin.query("COMMIT");
      return value;
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  };
  // TEST-ONLY kitchen station of the Store (owner write path, synthetic operator authority).
  const routing = createPostgresKitchenRoutingConfigurationStore({
    ...scope,
    sha256,
    authorizeRead: async () => true,
    authorizeWrite: async () => true,
    validateConfiguration: async () => true,
    audit: async (record) => ({
      auditId: op(),
      brandId: brandReference,
      storeId: storeReference,
      actor: { type: "User", reference: record.actorReference },
      actionCode: "KITCHEN_ROUTING_CONFIGURATION_RECORDED",
      targetType: "KitchenRoutingConfiguration",
      targetId: record.configuration.evidenceReference,
      correlationId: record.operationReference,
      reasonCode: record.reasonCode,
      occurredAt: record.recordedAt,
      sourceChannel: "MERCHANT_WEB",
      afterSummary: { version: record.configuration.evidenceVersion },
      dataClassification: "Restricted",
      retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
      retentionPolicyVersion: 1,
    }),
  });
  const stationAt = new Date(start - 3600_000).toISOString();
  await setup((t) =>
    routing.commit({
      transaction: t,
      record: {
        operationReference: op(),
        actorReference: owner,
        purposeCode: "SyntheticConfiguration",
        permissionCode: "synthetic.configure",
        reasonCode: "SYNTHETIC_SETUP",
        recordedAt: stationAt,
        expectedVersion: 0,
        configuration: rebindKitchenRoutingEvidence(
          {
            brandReference,
            storeReference,
            evidenceReference: op(),
            evidenceVersion: 1,
            effectiveAt: stationAt,
            evidenceDigest: sha256("placeholder"),
            candidates: [
              {
                stationReference: id(13),
                stationVersion: 1,
                stationStatus: "Active",
                stationCapabilityReferences: [id(12)],
                routingRuleReference: id(14),
                routingRuleVersion: 1,
                routingRuleStatus: "Active",
                selector: { kind: "AllPreparedItems" },
                targetStationReference: id(13),
                routingRuleDigest: sha256("placeholder"),
              },
            ],
          },
          stationAt,
          sha256,
        ),
      },
    }),
  );
  // TEST-ONLY Brand allergen list.
  const allergenList = { peanut: id(60), wheat: id(62), milk: id(64) };
  await setup((t) =>
    createAllergenRegistryVersion(t, scope, {
      registryVersionReference: id(63),
      jurisdictionCode: "CA",
      policyDocument: "TEST-ONLY synthetic allergen list",
      entries: [
        {
          allergenReference: allergenList.peanut,
          code: "PEANUT",
          localizedNames: { "en-CA": "Peanuts" },
        },
        {
          allergenReference: allergenList.wheat,
          code: "WHEAT",
          localizedNames: { "en-CA": "Wheat" },
        },
        { allergenReference: allergenList.milk, code: "MILK", localizedNames: { "en-CA": "Milk" } },
      ],
      actorReference: owner,
      at: stationAt,
      auditReference: op(),
    }),
  );

  // The real runner, connected as owner; each transaction steps down to the pilot API role.
  const pool = new pg.Pool({
    ...context.clientConfig,
    max: 6,
    connectionTimeoutMillis: 8000,
    query_timeout: 10_000,
  });
  const runner = createTenantTransactionRunner(pool, {
    brandId: brandReference,
    storeId: storeReference,
  });
  /** Each transaction's hold on the recipe tables, from the lock to its commit, in ms. */
  const counts = { transactions: 0, statements: 0, holds: [] };
  /** Test seam: called after each statement, with its text (may wait, or fail the transaction). */
  const hooks = { afterStatement: null, beforeStatement: null };
  const clock = { offsetMs: 0, nowCalls: 0 };
  const persistence = {
    now: () => {
      clock.nowCalls += 1;
      return new Date(Date.now() + clock.offsetMs).toISOString();
    },
    transactions: {
      run: async (work) => {
        counts.transactions += 1;
        let lockedAt = null;
        const value = await runner.run(async (inner) => {
          const tx = Object.freeze({
            async query(sql, values = []) {
              counts.statements += 1;
              await hooks.beforeStatement?.(sql, values);
              const result = await inner.query(sql, values);
              if (lockedAt === null && isRecipeFenceTake(sql, values, brandReference))
                lockedAt = performance.now();
              await hooks.afterStatement?.(sql, values);
              return result;
            },
          });
          await inner.query("SET LOCAL ROLE " + role, []);
          await inner.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
          return work(tx);
        });
        if (lockedAt !== null) counts.holds.push(performance.now() - lockedAt);
        return value;
      },
    },
  };
  const grants = syntheticMerchantBrandScope({
    tenantReference,
    brandReference,
    storeReference,
    policyReference: id(300),
    grants: { [owner]: [...menuOwnerGrants], ...otherActors },
  });
  const meta = {
    currencyCode: "CAD",
    minorUnitExponent: 2,
    metadataVersion: 1,
    metadataVersionReference: id(90),
  };
  const currencyMetadata = {
    ...meta,
    metadataDigest: "sha256:" + createHash("sha256").update(JSON.stringify(meta)).digest("hex"),
  };
  const common = {
    persistence,
    authentication: { authorize: async () => ({ sessionReference: id(7) }) },
    locale: "en-CA",
    // As the pilot: a transaction's decisions are remembered (merchant-brand-transaction-
    // authorization), so a repeated decision does not select the Store again mid-write.
    resolveScope: async (tx, ...rest) => {
      const resolved = await grants.resolveScope(tx, ...rest);
      const decided = new Map();
      return {
        ...resolved,
        authorizeAction: async (action) => {
          if (!decided.has(action)) decided.set(action, await resolved.authorizeAction(action));
          return decided.get(action);
        },
      };
    },
    references: { next: op },
  };
  // The store's one menu (TEST-only draft, as Brand setup leaves it), offered at this store.
  const menuReference = id(499),
    menuVersion = id(500);
  await admin.query("INSERT INTO rms_catalog.menu VALUES($1,$2,'TEST_MENU',1,$3,$4,$3)", [
    menuReference,
    brandReference,
    from,
    owner,
  ]);
  await admin.query(
    "INSERT INTO rms_catalog.menu_version(menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
    [menuVersion, menuReference, brandReference, JSON.stringify({ "en-CA": "TEST menu" }), from],
  );
  await admin.query("INSERT INTO rms_catalog.menu_version_store VALUES($1,$2,$3,$4)", [
    menuVersion,
    menuReference,
    brandReference,
    storeReference,
  ]);
  await admin.query("INSERT INTO rms_catalog.menu_version_channel VALUES($1,$2,$3,$4)", [
    menuVersion,
    menuReference,
    brandReference,
    "CUSTOMER_PWA",
  ]);
  for (const orderType of orderTypes)
    await admin.query("INSERT INTO rms_catalog.menu_version_order_type VALUES($1,$2,$3,$4)", [
      menuVersion,
      menuReference,
      brandReference,
      orderType,
    ]);
  for (const [n, code, name, nameZh] of [
    [501, "DRINKS", "Drinks (TEST)", "饮品"],
    [502, "COMBOS", "Combos (TEST)", "套餐"],
  ])
    await admin.query("INSERT INTO rms_catalog.menu_section VALUES($1,$2,$3,$4,$5,$6,$7)", [
      id(n),
      menuVersion,
      menuReference,
      brandReference,
      code,
      JSON.stringify({ "en-CA": name, "zh-Hans": nameZh }),
      n - 501,
    ]);

  const menus = createMerchantMenus({ ...common, currencyMetadata });
  const dishAllergens = createMerchantDishAllergens(common);
  const availability = createMerchantAvailability(common);
  const products = createMerchantProducts(common);
  const prices = createMerchantPrices({ ...common, currencyMetadata });
  const optionPrices = createMerchantOptionPrices({ ...common, currencyMetadata });
  const optionRecipes = createMerchantOptionRecipes(common);
  const optionSets = createMerchantOptionSets(common);
  const combos = createMerchantCombos(common);
  const dishes = createMerchantOneStoreDishes({
    products,
    prices,
    optionPrices,
    menus,
    dishAllergens,
    optionRecipes,
    availability,
    combos,
    optionSets,
    now: () => new Date().toISOString(),
  });
  const session = { sessionCookie: "cookie", csrf: "csrf" };
  grants.as(owner);
  const asApi = (work) =>
    persistence.transactions.run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brandReference, storeReference],
      );
      return work(tx);
    });
  /** A choice group through the real command. */
  const makeGroup = async (name, kind, choices, limits = {}) =>
    (
      await optionSets.command({
        ...session,
        body: {
          action: "Create",
          operationReference: op(),
          name,
          nameZh: "",
          kind,
          minimum: limits.minimum ?? 0,
          maximum: limits.maximum === undefined ? (kind === "One" ? 1 : null) : limits.maximum,
          perOptionMaximum: limits.perOptionMaximum ?? 1,
          options: choices.map((choice, index) => ({
            optionReference: null,
            name: choice,
            nameZh: "",
            offered: true,
            defaultChoice: kind === "One" && (limits.minimum ?? 0) > 0 && index === 0,
          })),
        },
      })
    ).optionSet;
  const saveDish = (overrides) =>
    dishes.command({
      ...session,
      body: {
        action: "SaveDish",
        operationReference: op(),
        menuReference,
        productReference: null,
        sectionCode: "DRINKS",
        name: "Milk tea (TEST)",
        nameZh: "奶茶",
        description: "",
        descriptionZh: "",
        taxClassificationReference: taxClass,
        priceMinor: "550",
        choiceGroups: [],
        allergens: [],
        ...overrides,
      },
    });
  const listAll = () =>
    dishes.command({
      ...session,
      body: { action: "ListAll", operationReference: op(), menuReference },
    });
  return {
    id,
    op,
    tenantReference,
    brandReference,
    storeReference,
    owner,
    taxClass,
    menuReference,
    allergenList,
    scope,
    pool,
    persistence,
    counts,
    hooks,
    clock,
    grants,
    common,
    currencyMetadata,
    menus,
    dishAllergens,
    availability,
    products,
    prices,
    optionPrices,
    optionRecipes,
    optionSets,
    combos,
    dishes,
    session,
    asApi,
    setup,
    makeGroup,
    saveDish,
    listAll,
    from,
    start,
    close: () => pool.end(),
  };
}
