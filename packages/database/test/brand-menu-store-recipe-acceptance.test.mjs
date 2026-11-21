import assert from "node:assert/strict";
import { confirmedMenuPrices } from "../test-support/menu-price-confirmation.mjs";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
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
import { bindRecipeToSku } from "../../rms/recipe/src/index.ts";
import {
  createPostgresKitchenRoutingConfigurationStore,
  rebindKitchenRoutingEvidence,
} from "../../rms/kitchen/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

// WP-2423 M71: the price list "List it" confirms (read as the review reads it).
let menuPrices;

const { Client } = pg;
const id = (n) => "01909a9f-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-10-31): on v15 "List it" at
 * store 2 was refused (OptionRecipeMissing, generic text) while every option recipe was
 * Published: the coffee dishes' recipes were assigned to store 1 only (Oct 7–8), so at store 2
 * they had no recipe, and the listing gates read the session's Store alone — listing from store 1
 * would have put them live at store 2 without one. Under the restricted NOBYPASSRLS role with the
 * rendered pilot API grants, through the real one-page menu (dish, choice group, allergens,
 * option recipes, "List it") and Recipes commands, a menu served at two Stores:
 * 1. a dish with a choice group, its recipe and option recipes published, then (as on v15) its
 *    recipe assigned to Store 1 only;
 * 2. "List it" is refused from Store 2 and from Store 1 alike, naming Store 2, the dish and size;
 * 3. the dish's recipe assigned for the whole Brand (the Recipe owner's function the Recipes
 *    page's assignment calls); "List it" then lists it.
 */
it("a menu served at two Stores is listed only when each Store has the dish's recipe", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_menu_recipe" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      store1 = id(3),
      owner = id(4),
      store2 = id(5),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0009-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_msr");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      // TEST-ONLY tax configuration at each Store, covering the product's tax class (13 %).
      for (const [store, base] of [
        [store1, 0x200],
        [store2, 0x220],
      ]) {
        await admin.query(
          "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,'2026-01-01T00:00:00Z',$4,'2026-01-01T00:00:00Z')",
          [id(base), brandReference, store, owner],
        );
        await admin.query(
          `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
           VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,'2026-01-01T00:00:00Z',NULL,'America/Toronto',$7,$8,$9,'2027-01-01T00:00:00Z',$10,$11,$12,$5,'2027-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
          [
            id(base + 1),
            id(base),
            brandReference,
            store,
            "sha256:" + "a".repeat(64),
            id(base + 2),
            id(base + 3),
            id(base + 4),
            id(base + 5),
            id(base + 6),
            id(base + 7),
            id(base + 8),
          ],
        );
        for (const [n, orderType] of [
          [base + 0x10, "Pickup"],
          [base + 0x11, "DineIn"],
        ])
          await admin.query(
            "INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,$7,'Sellable','TEST_TAX','Taxable',0.13,'Exclusive','HalfUp',1,false,NULL,'TEST_TAX_LINE')",
            [id(n), id(base + 1), id(base), brandReference, store, taxClass, orderType],
          );
        await admin.query(
          "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
          [id(base + 1), id(base)],
        );
      }

      // Two Active Stores; the owner holds Brand Owner authority and everything the one-page
      // menu's saves use.
      const recipeActions = [
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
        "catalog.menu.manage",
        "publishing.draft.create",
        "publishing.review.submit",
        "publishing.review.approve",
      ];
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      for (const [store, code] of [
        [store1, "STORE_ONE"],
        [store2, "STORE_TWO"],
      ])
        await admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD','Active',1,$5,$5)",
          [store, brandReference, code, "Synthetic " + code, from],
        );
      const approver = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: [
          "organization.brand.manage",
          "pricing.price-book.approve",
          "pricing.price-book.manage",
          ...recipeActions,
        ],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference: store1,
        actorReference: owner,
        name: "Sam",
        roles: [approver],
        from,
        enrolledAt: new Date(start - 2 * 3600_000).toISOString(),
      });

      const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
      const setup = async (store, work) => {
        await admin.query("BEGIN");
        try {
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenantReference, brandReference, store],
          );
          const value = await work(admin);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      // TEST-ONLY kitchen station at each Store (owner write path, synthetic operator authority).
      const stationAt = new Date(start - 3600_000).toISOString();
      for (const [store, station] of [
        [store1, 13],
        [store2, 23],
      ]) {
        const scope = { tenantReference, brandReference, storeReference: store };
        const routing = createPostgresKitchenRoutingConfigurationStore({
          ...scope,
          sha256,
          authorizeRead: async () => true,
          authorizeWrite: async () => true,
          validateConfiguration: async () => true,
          audit: async (record) => ({
            auditId: op(),
            brandId: brandReference,
            storeId: store,
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
        await setup(store, (t) =>
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
                  storeReference: store,
                  evidenceReference: op(),
                  evidenceVersion: 1,
                  effectiveAt: stationAt,
                  evidenceDigest: sha256("placeholder"),
                  candidates: [
                    {
                      stationReference: id(station),
                      stationVersion: 1,
                      stationStatus: "Active",
                      stationCapabilityReferences: [id(12)],
                      routingRuleReference: id(station + 1),
                      routingRuleVersion: 1,
                      routingRuleStatus: "Active",
                      selector: { kind: "AllPreparedItems" },
                      targetStationReference: id(station),
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
      }
      // TEST-ONLY Brand allergen list.
      const milk = id(60);
      await setup(store1, (t) =>
        createAllergenRegistryVersion(
          t,
          { tenantReference, brandReference, storeReference: store1 },
          {
            registryVersionReference: id(63),
            jurisdictionCode: "CA",
            policyDocument: "TEST-ONLY synthetic allergen list",
            entries: [
              { allergenReference: milk, code: "MILK", localizedNames: { "en-CA": "Milk" } },
            ],
            actorReference: owner,
            at: stationAt,
            auditReference: op(),
          },
        ),
      );
      const persistence = {
        now: () => new Date().toISOString(),
        transactions: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              await admin.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
              const value = await work(admin);
              await admin.query("COMMIT");
              return value;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
      };
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
      // The Brand's menu (TEST-only draft): one section, served at both Stores for dine-in.
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
        [
          menuVersion,
          menuReference,
          brandReference,
          JSON.stringify({ "en-CA": "TEST menu" }),
          from,
        ],
      );
      for (const store of [store1, store2])
        await admin.query("INSERT INTO rms_catalog.menu_version_store VALUES($1,$2,$3,$4)", [
          menuVersion,
          menuReference,
          brandReference,
          store,
        ]);
      await admin.query("INSERT INTO rms_catalog.menu_version_channel VALUES($1,$2,$3,$4)", [
        menuVersion,
        menuReference,
        brandReference,
        "CUSTOMER_PWA",
      ]);
      await admin.query("INSERT INTO rms_catalog.menu_version_order_type VALUES($1,$2,$3,$4)", [
        menuVersion,
        menuReference,
        brandReference,
        "DINE_IN",
      ]);
      await admin.query("INSERT INTO rms_catalog.menu_section VALUES($1,$2,$3,$4,$5,$6,$7)", [
        id(501),
        menuVersion,
        menuReference,
        brandReference,
        "COFFEE",
        JSON.stringify({ "en-CA": "Coffee (TEST)", "zh-Hans": "咖啡" }),
        0,
      ]);

      // The real compositions, at each Store.
      const at = (storeReference) => {
        const grants = syntheticMerchantBrandScope({
          tenantReference,
          brandReference,
          storeReference,
          policyReference: id(300),
          grants: {
            [owner]: [
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
              "organization.brand.manage",
              ...recipeActions,
            ],
          },
        });
        const common = {
          persistence,
          authentication: { authorize: async () => ({ sessionReference: id(7) }) },
          locale: "en-CA",
          resolveScope: async (tx, ...rest) => {
            const scope = await grants.resolveScope(tx, ...rest);
            const decided = new Map();
            return {
              ...scope,
              authorizeAction: async (action) => {
                if (!decided.has(action)) decided.set(action, await scope.authorizeAction(action));
                return decided.get(action);
              },
            };
          },
          references: { next: op },
        };
        const menus = createMerchantMenus({ ...common, currencyMetadata });
        const products = createMerchantProducts(common);
        const optionSets = createMerchantOptionSets(common);
        const availability = createMerchantAvailability(common);
        grants.as(owner);
        return {
          optionSets,
          products,
          dishes: createMerchantOneStoreDishes({
            products,
            prices: (menuPrices = createMerchantPrices({ ...common, currencyMetadata })),
            optionPrices: createMerchantOptionPrices({ ...common, currencyMetadata }),
            menus,
            dishAllergens: createMerchantDishAllergens({ ...common, references: { next: op } }),
            optionRecipes: createMerchantOptionRecipes(common),
            availability,
            combos: createMerchantCombos(common),
            optionSets,
            now: () => new Date().toISOString(),
          }),
        };
      };
      const one = at(store1),
        two = at(store2);
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const listAll = async (where) =>
        where.dishes
          .command({
            ...session,
            body: {
              action: "ListAll",
              operationReference: op(),
              menuReference,
              confirmedPriceBook: await confirmedMenuPrices(menuPrices),
            },
          })
          .then(
            () => null,
            (error) => error,
          );

      // 1. A dish with a choice group, its recipe and option recipes published (at Store 1).
      const milkChoice = await one.optionSets.command({
        ...session,
        body: {
          action: "Create",
          operationReference: op(),
          name: "Milk (TEST)",
          kind: "One",
          minimum: 0,
          maximum: 1,
          perOptionMaximum: 1,
          options: [
            { optionReference: null, name: "Whole milk", offered: true, defaultChoice: true },
            { optionReference: null, name: "Oat milk", offered: true, defaultChoice: false },
          ],
        },
      });
      const set = milkChoice.optionSet;
      const dish = await one.dishes.command({
        ...session,
        body: {
          action: "SaveDish",
          operationReference: op(),
          menuReference,
          productReference: null,
          sectionCode: "COFFEE",
          name: "Flat white (TEST)",
          nameZh: "馥芮白",
          description: "",
          descriptionZh: "",
          taxClassificationReference: taxClass,
          priceMinor: "450",
          // WP-2423 M70: the Brand price, for every Store (the one-Store menu has one).
          priceScope: "AllStores",
          expectedPriceMinor: null,
          choiceGroups: [
            {
              optionSetReference: set.optionSetReference,
              options: set.options.map((option) => ({
                optionReference: option.optionReference,
                amountMinor: option.name === "Oat milk" ? "75" : "0",
              })),
            },
          ],
          allergens: [{ allergenReference: milk, classification: "Contains" }],
        },
      });
      const sku = dish.skuReference;
      // Owner 2026-11-04: the product list says which menu section each dish is in, read here with
      // the restricted role and a Store selected, as a live request does.
      const productList = await one.products.query({ ...session, productReference: null });
      const listedDish = productList.products.find(
        (product) => product.productReference === dish.productReference,
      );
      assert.equal(listedDish.sections.length, 1);
      assert.match(listedDish.sections[0], /\S/u);
      const bindings = () =>
        admin.query(
          "SELECT recipe_scope_binding_id::text id,recipe_id::text recipe,recipe_version_id::text version,store_id::text store FROM rms_recipe.recipe_scope_binding b WHERE sku_id=$1 AND option_binding_id IS NULL AND NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_scope_binding_end e WHERE e.recipe_scope_binding_id=b.recipe_scope_binding_id)",
          [sku],
        );
      const [brandWide] = (await bindings()).rows;
      assert.equal(brandWide?.store, null, "the one-page menu assigns the recipe Brand-wide");
      // As on v15 (Recipes, Oct 7–8, "this store only"): the dish's recipe is Store 1's alone.
      // TEST-ONLY fixture of that history, on the owner client: the Brand-wide assignment ends and
      // the same published recipe version is assigned to Store 1 only.
      await setup(store1, async (t) => {
        await t.query(
          "INSERT INTO rms_recipe.recipe_scope_binding_end(recipe_scope_binding_id,brand_id,store_id,ended_at,reason_code,operation_id,actor_id,audit_id) VALUES($1,$2,NULL,now(),'REMOVED',$3,$4,$5)",
          [brandWide.id, brandReference, op(), owner, op()],
        );
        await t.query(
          "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,$6,NULL,now(),NULL)",
          [op(), brandWide.version, brandWide.recipe, brandReference, sku, store1],
        );
      });

      // 2. Refused from either Store, naming Store 2, the dish and its size.
      const expected = {
        code: "OptionRecipeMissing",
        problem: {
          missing: "Recipe",
          productName: "Flat white (TEST)",
          optionName: null,
          storeName: "Synthetic STORE_TWO",
        },
      };
      const fromTwo = await listAll(two);
      assert.ok(fromTwo, "listing from Store 2 is refused");
      assert.equal(fromTwo.code, expected.code, String(fromTwo));
      assert.deepEqual(
        {
          missing: fromTwo.problem?.missing,
          productName: fromTwo.problem?.productName,
          optionName: fromTwo.problem?.optionName,
          storeName: fromTwo.problem?.storeName,
        },
        expected.problem,
      );
      const fromOne = await listAll(one);
      assert.ok(fromOne, "listing from Store 1 is refused the same way");
      assert.equal(fromOne.code, expected.code, String(fromOne));
      assert.equal(fromOne.problem?.storeName, "Synthetic STORE_TWO");
      assert.equal(fromOne.problem?.productName, "Flat white (TEST)");
      const published = await admin.query(
        "SELECT count(*)::int n FROM rms_catalog.menu_publication_release WHERE menu_id=$1",
        [menuReference],
      );
      assert.equal(published.rows[0].n, 0, "nothing was listed");

      // 3. Under Recipes: its recipe assigned for the whole Brand. "List it" now lists it.
      // The Recipe owner's function the Recipes page's "assign to this size" (BindSku, not this
      // store only) calls, as the services' role.
      const unitOfSale = (
        await admin.query("SELECT unit_of_sale FROM rms_catalog.sku WHERE sku_id=$1", [sku])
      ).rows[0].unit_of_sale;
      const bound = await persistence.transactions.run(async (tx) =>
        bindRecipeToSku(
          tx,
          { brandReference, storeReference: store1 },
          {
            actorReference: owner,
            at: new Date().toISOString(),
            nextReference: op,
            operationReference: op(),
            recipeReference: brandWide.recipe,
            skuReference: sku,
            storeReference: null,
            skuUnitOfSale: unitOfSale,
            auditReference: op(),
          },
        ),
      );
      assert.equal(bound.status, "Applied");
      assert.equal(await listAll(two), null);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_catalog.menu_publication_release WHERE menu_id=$1",
            [menuReference],
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await admin.end();
    }
  });
}, 300_000);
