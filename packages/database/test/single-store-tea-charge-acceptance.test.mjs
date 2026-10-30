import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { guestMenuWithoutTea } from "../../../apps/api/src/customer-cart-tea-guard.ts";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
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
import { listedTeaChoices, teaItemRefusal } from "../../../apps/api/src/merchant-store-features.ts";
import {
  createAllergenRegistryVersion,
  createPostgresCatalogSelectionService,
} from "../../rms/catalog/src/index.ts";
import {
  changeDiningTeaChargeSetting,
  loadDiningTeaChargeSetting,
} from "../../rms/dining/src/index.ts";
import {
  changeKitchenNotPreparedProduct,
  createPostgresKitchenRoutingConfigurationStore,
  loadKitchenNotPreparedProducts,
  rebindKitchenRoutingEvidence,
} from "../../rms/kitchen/src/index.ts";
import { listInventoryRecipeIngredientFacts } from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a8f-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * v15 2026-10-29 (coordinator): the owner could not make a usable tea charge. Listing needs every
 * dish to have a recipe, and the tea setting refused a dish with one; the tea list offered a dish
 * not yet listed. The two rules had never run together. Under the restricted NOBYPASSRLS role with
 * the rendered pilot API grants, through the real one-page menu, menu listing (its review reads
 * each dish's recipe) and dish declaration commands:
 *  1. a new tea dish ("Tea charge (TEST) 茶位", $1.50) cannot be listed while it has no recipe,
 *     and cannot be the tea: it is not on the listed menu;
 *  2. the owner declares it a charge with no stock ingredients (recorded: who, when, labelled
 *     NoIngredientsDeclaredByStaff; its stand-in item is not stock-tracked) and marks it not
 *     prepared by the kitchen; "List it" now lists it;
 *  3. it is a tea choice (named once), the tea check accepts it and the Store's tea is set to it;
 *  4. a round can sell it: the Catalog selection a staff round validates accepts it at the store
 *     for dine-in, priced $1.50; guests never see it on their menu;
 *  5. hidden from the store on the menu ("Hide"), it could not be sold, so it can't be the tea;
 *  6. a dish with a real (stock) recipe stays refused as the tea.
 * (Placing the tea round itself is the staff-round acceptance's and the v15 live check's.)
 */
it("tea charge: a new dish declared with no stock ingredients is listed, chosen as tea and sellable", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_tea" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0006-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_sst");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
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

      // One store; the owner holds the product, choice group, price, availability, recipe,
      // allergen and inventory permissions (everything the one-page menu's saves use).
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
        // The legacy code the Menu service still checks (pilot roles hold its equivalents).
        "catalog.menu.manage",
        "publishing.draft.create",
        "publishing.review.submit",
        "publishing.review.approve",
      ];
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'STORE_ONE','Synthetic STORE_ONE','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [storeReference, brandReference, from],
      );
      const approver = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: ["pricing.price-book.approve", "pricing.price-book.manage", ...recipeActions],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [approver],
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
      const [peanut, wheat] = [id(60), id(62)];
      await setup((t) =>
        createAllergenRegistryVersion(t, scope, {
          registryVersionReference: id(63),
          jurisdictionCode: "CA",
          policyDocument: "TEST-ONLY synthetic allergen list",
          entries: [
            { allergenReference: peanut, code: "PEANUT", localizedNames: { "en-CA": "Peanuts" } },
            { allergenReference: wheat, code: "WHEAT", localizedNames: { "en-CA": "Wheat" } },
          ],
          actorReference: owner,
          at: stationAt,
          auditReference: op(),
        }),
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
            ...recipeActions,
          ],
        },
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
      // The store's one menu (TEST-only draft, as Brand setup leaves it): two sections, offered at
      // this store for dine-in guests. Everything after runs through the real menu command.
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
      await admin.query("INSERT INTO rms_catalog.menu_version_order_type VALUES($1,$2,$3,$4)", [
        menuVersion,
        menuReference,
        brandReference,
        "DINE_IN",
      ]);
      for (const [n, code, name, nameZh] of [
        [501, "SOUPS", "Soups (TEST)", "汤"],
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
      const allergens = createMerchantDishAllergens({ ...common, references: { next: op } });
      const availability = createMerchantAvailability(common);
      const dishes = createMerchantOneStoreDishes({
        products: createMerchantProducts(common),
        prices: createMerchantPrices({ ...common, currencyMetadata }),
        optionPrices: createMerchantOptionPrices({ ...common, currencyMetadata }),
        menus,
        dishAllergens: allergens,
        optionRecipes: createMerchantOptionRecipes(common),
        availability,
        combos: createMerchantCombos(common),
        optionSets: createMerchantOptionSets(common),
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
      const listAll = () =>
        dishes.command({
          ...session,
          body: { action: "ListAll", operationReference: op(), menuReference },
        });
      const choices = () =>
        asApi((tx) =>
          listedTeaChoices(
            tx,
            { brandReference, storeReference },
            new Date().toISOString(),
            currencyMetadata,
          ),
        );
      const refusal = (sku) =>
        asApi(async (tx) =>
          teaItemRefusal(tx, { brandReference, storeReference }, await choices(), sku),
        );
      const saveDish = (name, nameZh, priceMinor) =>
        dishes.command({
          ...session,
          body: {
            action: "SaveDish",
            operationReference: op(),
            menuReference,
            productReference: null,
            sectionCode: "SOUPS",
            name,
            nameZh,
            description: "",
            descriptionZh: "",
            taxClassificationReference: taxClass,
            priceMinor,
            choiceGroups: [],
            allergens: null,
          },
        });

      // 1. A new tea dish, $1.50. Without a recipe the listing review stops at it, and it is not a
      // tea choice (not on the listed menu).
      const teaDish = await saveDish("Tea charge (TEST)", "茶位", "150");
      const tea = teaDish.skuReference;
      const blocked = await listAll().then(
        () => null,
        (error) => error,
      );
      assert.equal(blocked?.code, "ReviewBlocked", String(blocked));
      assert.equal(blocked?.problem?.missing, "Recipe");
      assert.equal(await refusal(tea), "STORE_FEATURES_TEA_NOT_LISTED");

      // 2. Declared a charge with no stock ingredients (who and when, labelled), not prepared by
      // the kitchen; "List it" now lists it.
      const declared = await allergens.command({
        ...session,
        body: { action: "DeclareNoIngredients", operationReference: op(), skuReference: tea },
      });
      assert.equal(declared.status, "Applied");
      const [label] = (
        await admin.query(
          "SELECT label,inventory_item_id::text item,actor_id::text actor,recorded_at IS NOT NULL recorded FROM rms_recipe.staff_declared_allergen_source WHERE brand_id=$1 AND sku_id=$2",
          [brandReference, tea],
        )
      ).rows;
      assert.deepEqual(
        [label?.label, label?.actor, label?.recorded],
        ["NoIngredientsDeclaredByStaff", owner, true],
      );
      const standIn = (
        await asApi((tx) =>
          listInventoryRecipeIngredientFacts(tx, { tenantReference, brandReference }),
        )
      ).find((candidate) => candidate.itemReference === label?.item);
      assert.equal(standIn?.stockTracked, false);
      // Declaring its allergens afterwards is refused: the size stays declared one way.
      await assert.rejects(
        allergens.command({
          ...session,
          body: {
            action: "DeclareDish",
            operationReference: op(),
            skuReference: tea,
            allergens: [],
          },
        }),
        { code: "DeclaredOtherwise" },
      );
      const tenantScope = { tenantReference, brandReference, storeReference };
      await asApi((tx) =>
        changeKitchenNotPreparedProduct(tx, tenantScope, {
          productReference: teaDish.productReference,
          operationReference: op(),
          expectedVersion: 0,
          notPrepared: true,
          actorReference: owner,
          observedAt: new Date().toISOString(),
        }),
      );
      assert.equal(
        (
          await asApi((tx) =>
            loadKitchenNotPreparedProducts(tx, tenantScope, [teaDish.productReference]),
          )
        ).get(teaDish.productReference)?.notPrepared,
        true,
      );
      await listAll();

      // 3. A tea choice, named once; the tea check accepts it; the Store's tea is set to it.
      assert.deepEqual(
        (await choices()).filter((item) => item.sellableReference === tea),
        [{ sellableReference: tea, name: "Tea charge (TEST) 茶位", unavailable: null }],
      );
      assert.equal(await refusal(tea), null);
      const teaSetting = await asApi(async (tx) => {
        const before = await loadDiningTeaChargeSetting(tx, tenantScope);
        return changeDiningTeaChargeSetting(tx, tenantScope, {
          operationReference: op(),
          expectedVersion: before.version,
          teaSellableReference: tea,
          actorReference: owner,
          observedAt: new Date().toISOString(),
        });
      });
      assert.equal(teaSetting.teaSellableReference, tea);

      // 4. A staff round can sell it: the Catalog selection it validates accepts the tea at the
      // store for dine-in (TEST-only safety evidence: not killed, in stock), and the store prices
      // it $1.50. Guests never see it on their menu.
      const at = new Date().toISOString();
      const evidence = (request, kind) => ({
        kind,
        brandReference: request.brandReference,
        storeReference: request.storeReference,
        sellableReference: request.sellableReference,
        status: kind === "KillSwitch" ? "Clear" : "Available",
        observedAt: request.observedAt,
        expiresAt: new Date(Date.parse(at) + 3600_000).toISOString(),
        reasonCode: "SYNTHETIC_SAFETY",
      });
      const selection = () =>
        createPostgresCatalogSelectionService(
          // As a round reads Catalog: one coherent read-only transaction, as the pilot api role.
          {
            async run(work) {
              await admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
              try {
                await admin.query("SET LOCAL ROLE " + role);
                await admin.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
                return await work(admin);
              } finally {
                await admin.query("ROLLBACK");
              }
            },
          },
          {
            brandReference,
            storeReference,
            menuReference,
            sourceChannel: "Pos",
            orderType: "DineIn",
            channelCode: "CUSTOMER_PWA",
            orderTypeCode: "DINE_IN",
          },
          {
            clock: { now: () => at },
            killSwitch: { loadEvidence: async (request) => evidence(request, "KillSwitch") },
            inventory: { loadEvidence: async (request) => evidence(request, "Inventory") },
          },
        ).validateSelection({
          brandReference,
          storeReference,
          sourceChannel: "Pos",
          orderType: "DineIn",
          sellableReference: tea,
          optionSelections: [],
          observedAt: at,
        });
      assert.equal((await selection()).status, "Accepted");
      const storeFacts = createCustomerMenuStoreFacts({
        transactions: { run: (work) => asApi(work) },
        currencyMetadata,
        priceChannelCode: "CUSTOMER_WEB",
      });
      const facts = (reader) =>
        reader
          .load({
            brandReference,
            storeReference,
            channelCode: "CUSTOMER_PWA",
            orderTypeCode: "DINE_IN",
            requestedAt: new Date().toISOString(),
            sellableReferences: [tea],
          })
          .then((loaded) => loaded.get(tea));
      assert.deepEqual(await facts(storeFacts), {
        availability: "Available",
        price: { amount: "1.50", currency: "CAD" },
        optionPrices: new Map(),
      });
      assert.equal(
        (await facts(guestMenuWithoutTea(storeFacts, async () => tea))).availability,
        "NotOffered",
      );

      // 5. Hidden from the store on the menu ("Hide"), a round could not sell it: no tea choice.
      await availability.command({
        ...session,
        body: { action: "StopOffering", operationReference: op(), skuReference: tea },
      });
      assert.equal((await selection()).status, "Rejected");
      assert.equal(
        (await choices()).find((item) => item.sellableReference === tea)?.unavailable,
        "NotOffered",
      );
      assert.equal(await refusal(tea), "STORE_FEATURES_TEA_NOT_LISTED");

      // 6. A dish with a real recipe (it uses stock) stays refused as the tea.
      const soup = await saveDish("Hot and sour soup (TEST)", "酸辣汤", "650");
      await admin.query("SET session_replication_role = replica");
      try {
        await admin.query(
          "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,now()-interval '1 minute')",
          [id(0x900), id(0x901), id(0x902), brandReference, soup.skuReference],
        );
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      assert.equal(
        await asApi((tx) =>
          teaItemRefusal(
            tx,
            { brandReference, storeReference },
            [{ sellableReference: soup.skuReference, name: "", unavailable: null }],
            soup.skuReference,
          ),
        ),
        "STORE_FEATURES_TEA_USES_STOCK",
      );
    } finally {
      await admin.end();
    }
  });
}, 300_000);
