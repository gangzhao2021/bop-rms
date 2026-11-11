import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createMerchantOneStoreDishes } from "../../../apps/api/src/merchant-one-store-dishes.ts";
import { createMerchantPrices } from "../../../apps/api/src/merchant-prices.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createMerchantStorePrices } from "../../../apps/api/src/merchant-store-prices.ts";
import { brandRoleTemplateActions } from "../../bop/permission/src/index.ts";
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
const id = (n) => "01909a7f-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 (v15 batch 5, menu-authoring-prices): at a Brand with two Stores, under the restricted
 * NOBYPASSRLS role with the rendered pilot API grants, through the real one-page menu, Store price
 * and availability commands and the guests' real Store facts:
 * 1. a new dish the Brand Owner lists for every Store is on sale at the menu's other Store too
 *    (before: still "Hidden" there until someone pressed "Show to guests" at that Store);
 * 2. a dish the other Store hid stays hidden there when the menu is listed again;
 * 3. "Only at this Store" is live at once and opens no menu draft; the same save sent again after
 *    its answer was lost (same operation, the price it was sent against) is the same change, never
 *    a second one; a store price saved with a new name leaves the name to be listed.
 * Fails at 0cf1e7a5: step 1 (Store 2 does not offer the dish) and step 3 (the menu draft opens).
 */
it("two Stores: a listed dish is on sale at both, a Store's hide stays, a Store price opens no draft", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_other_stores" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      store1 = id(3),
      owner = id(4),
      manager = id(5),
      store2 = id(6),
      staff = id(8),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0004-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_mos");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      // TEST-ONLY Store 1 tax configuration covering the product's tax class (13 %).
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,'2026-01-01T00:00:00Z',$4,'2026-01-01T00:00:00Z')",
        [id(200), brandReference, store1, owner],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
         VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,'2026-01-01T00:00:00Z',NULL,'America/Toronto',$7,$8,$9,'2027-01-01T00:00:00Z',$10,$11,$12,$5,'2027-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
        [
          id(201),
          id(200),
          brandReference,
          store1,
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
          [id(n), id(201), id(200), brandReference, store1, taxClass, orderType],
        );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
        [id(201), id(200)],
      );

      // Two Active Stores. The Brand Owner holds Brand Owner authority; the manager runs Store 2.
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      for (const [store, code] of [
        [store1, "STORE_ONE"],
        [store2, "STORE_TWO"],
      ])
        await admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD','Active',1,$5,$5)",
          [store, brandReference, code, "Synthetic " + code, from],
        );
      const brandOwner = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        // The real Brand Owner template (catalog v21).
        actions: brandRoleTemplateActions("brand-owner"),
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference: store1,
        actorReference: owner,
        name: "Sam",
        roles: [brandOwner],
        from,
        enrolledAt: new Date(start - 2 * 3600_000).toISOString(),
      });

      // The command's transaction. `intercept` (tests only) sees each statement first.
      let intercept = null;
      const tx = {
        query: async (sql, values) => {
          const seen = intercept === null ? undefined : await intercept(sql, values);
          if (seen !== undefined && typeof seen === "object") return seen;
          return admin.query(sql, values);
        },
      };
      const persistence = {
        now: () => new Date().toISOString(),
        transactions: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              await admin.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
              const value = await work(tx);
              await admin.query("COMMIT");
              return value;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
      };
      const brandGrants = [
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
        "pricing.price_book.read",
        "pricing.price-book.manage",
        "pricing.price-book.approve",
        "pricing.store_price.manage",
      ];
      // Store 2's manager: this Store's prices and availability, nothing of the Brand's.
      const managerGrants = [
        "pricing.store_price.manage",
        "catalog.sku.availability.manage",
        "catalog.sku.read",
      ];
      // Wei: Brand staff who prepares price changes on the Prices page (no approval).
      const staffGrants = [
        "pricing.price_book.read",
        "pricing.price-book.manage",
        "catalog.product.read",
        "catalog.sku.read",
      ];
      const scopeAt = (storeReference) =>
        syntheticMerchantBrandScope({
          tenantReference,
          brandReference,
          storeReference,
          policyReference: id(300),
          grants: { [owner]: brandGrants, [manager]: [], [staff]: staffGrants },
          storeGrants: { [manager]: managerGrants },
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
      const menu = {
        aggregateVersion: 1,
        storeReferences: [store1, store2],
        versionReference: id(500),
        name: "TEST menu",
        sections: [
          {
            sectionReference: id(501),
            code: "SOUPS",
            name: "Soups (TEST)",
            nameZh: "汤",
            items: [],
          },
        ],
      };
      let listed = false;
      const revisions = [];
      const menus = {
        query: async () => ({ menu, publication: listed ? { state: "Published" } : null }),
        command: async ({ body }) => {
          revisions.push(body.action);
          if (body.action === "SaveDraft") menu.sections = body.sections;
          if (body.action === "Revise") listed = false;
          if (body.action === "List") listed = true;
          menu.aggregateVersion += 1;
          return { status: "Listed" };
        },
      };
      const unused = {
        query: async () => assert.fail("not used without choice groups"),
        command: async () => assert.fail("not used without choice groups"),
        // "List it" carries choices to new quantities: a menu without choice groups has none.
        extendNoChangeChoices: async () => ({ extended: 0, needsPerson: 0 }),
      };
      const at = (storeReference) => {
        const scope = scopeAt(storeReference);
        const common = {
          persistence,
          authentication: { authorize: async () => ({ sessionReference: id(7) }) },
          locale: "en-CA",
          resolveScope: scope.resolveScope,
          references: { next: op },
        };
        const availability = createMerchantAvailability(common);
        const prices = createMerchantPrices({ ...common, currencyMetadata });
        return {
          as: scope.as,
          availability,
          prices,
          storePrices: createMerchantStorePrices({ ...common, currencyMetadata }),
          dishes: createMerchantOneStoreDishes({
            products: createMerchantProducts(common),
            prices,
            storePrices: createMerchantStorePrices({ ...common, currencyMetadata }),
            optionPrices: { waiting: async () => [], command: unused.command },
            menus,
            dishAllergens: unused,
            optionRecipes: unused,
            availability,
            now: () => new Date().toISOString(),
          }),
        };
      };
      const one = at(store1);
      const two = at(store2);
      one.as(owner);
      two.as(manager);
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const reader = (storeReference) => ({
        async run(work) {
          await admin.query("BEGIN");
          try {
            await admin.query("SET LOCAL ROLE " + role);
            await admin.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
              [tenantReference, brandReference, storeReference],
            );
            return await work(admin);
          } finally {
            await admin.query("ROLLBACK");
          }
        },
      });
      // Guests' Store facts, as the guest menu reads them at that Store (dine-in, TEST guest).
      const guest = (storeReference, skuReference) =>
        createCustomerMenuStoreFacts({
          transactions: reader(storeReference),
          currencyMetadata,
          priceChannelCode: "CUSTOMER_WEB",
        })
          .load({
            brandReference,
            storeReference,
            channelCode: "CUSTOMER_PWA",
            orderTypeCode: "DINE_IN",
            requestedAt: new Date().toISOString(),
            sellableReferences: [skuReference],
          })
          .then((facts) => facts.get(skuReference));
      const price = async (storeReference, sku) =>
        (await guest(storeReference, sku))?.price?.amount ?? null;
      const dish = (productReference, name, priceMinor, priceScope, expectedPriceMinor) => ({
        action: "SaveDish",
        operationReference: op(),
        menuReference: id(499),
        productReference,
        sectionCode: "SOUPS",
        name,
        nameZh: "",
        description: "",
        descriptionZh: "",
        taxClassificationReference: taxClass,
        priceMinor,
        priceScope,
        expectedPriceMinor,
        choiceGroups: [],
        allergens: null,
      });
      // The menu's own price draft, as the "List it" review reads it.
      const menuDraft = async (at = one) =>
        (await at.prices.query({ ...session, priceBookReference: null })).books.find(
          (b) => b.lifecycle === "Draft" && b.purpose === "MenuListing",
        ) ?? null;
      const listAll = async (confirmed) => {
        const draft = confirmed === undefined ? await menuDraft() : confirmed;
        return one.dishes.command({
          ...session,
          body: {
            action: "ListAll",
            operationReference: op(),
            menuReference: id(499),
            confirmedPriceBook:
              draft === null
                ? null
                : {
                    priceBookReference: draft.priceBookReference,
                    aggregateVersion: draft.aggregateVersion,
                  },
          },
        });
      };
      const owned = async (sql, values) => {
        await admin.query("BEGIN");
        try {
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenantReference, brandReference, store2],
          );
          return (await admin.query(sql, values)).rows;
        } finally {
          await admin.query("ROLLBACK");
        }
      };

      const status = async (at, sku) =>
        (await at.availability.query(session)).items.find((item) => item.skuReference === sku)
          ?.status;

      // 1. The Brand Owner adds a soup at Store 1 and lists it: both Stores sell it.
      const soup = await one.dishes.command({
        ...session,
        body: dish(null, "Hot and sour soup (TEST)", "650", "AllStores", null),
      });
      await listAll();
      assert.equal(await status(one, soup.skuReference), "Available");
      assert.equal(await status(two, soup.skuReference), "Available");
      assert.equal(await price(store2, soup.skuReference), "6.50");
      const offers = await owned(
        "SELECT store_id::text store,reason_code FROM rms_catalog.availability_rule WHERE brand_id=$1 AND sku_id=$2 ORDER BY store_id",
        [brandReference, soup.skuReference],
      );
      assert.deepEqual(
        offers.map((row) => row.store),
        [store1, store2].sort(),
      );

      // 2. Tea: listed, then Store 2's manager hides it there; listing again leaves it hidden.
      const tea = await one.dishes.command({
        ...session,
        body: dish(null, "Jasmine tea (TEST)", "300", "AllStores", null),
      });
      await listAll();
      assert.equal(await status(two, tea.skuReference), "Available");
      await two.availability.command({
        ...session,
        body: { action: "StopOffering", operationReference: op(), skuReference: tea.skuReference },
      });
      await one.dishes.command({
        ...session,
        body: dish(tea.productReference, "Jasmine tea, pot (TEST)", null, null, null),
      });
      await listAll();
      assert.notEqual(await status(two, tea.skuReference), "Available");
      assert.equal(await status(one, tea.skuReference), "Available");

      // 3. At Store 2, "Only at this Store": 6.50 → 7.00, live at once, the menu stays listed.
      two.as(owner);
      assert.equal(listed, true);
      revisions.length = 0;
      const storeOnly = dish(
        soup.productReference,
        "Hot and sour soup (TEST)",
        "700",
        "ThisStore",
        "650",
      );
      const saved = await two.dishes.command({ ...session, body: storeOnly });
      assert.equal(saved.listingNeeded, false);
      assert.deepEqual(revisions, []);
      assert.equal(listed, true);
      assert.equal(await price(store2, soup.skuReference), "7.00");
      assert.equal(await price(store1, soup.skuReference), "6.50");
      // Its answer was lost: the same save again is the same change, recorded once.
      const again = await two.dishes.command({ ...session, body: storeOnly });
      assert.equal(again.price.storePriceMinor, "700");
      const changes = await owned(
        "SELECT previous_amount_minor::text p,amount_minor::text a FROM rms_pricing.store_price_change WHERE brand_id=$1 AND store_id=$2 AND change_kind='StorePrice'",
        [brandReference, store2],
      );
      assert.deepEqual(changes, [{ p: "650", a: "700" }]);
      assert.equal(listed, true);
      // A Store price with a new name: the price is live now, the name waits for "List it".
      const renamed = await two.dishes.command({
        ...session,
        body: dish(
          soup.productReference,
          "Hot and sour soup, large (TEST)",
          "750",
          "ThisStore",
          "700",
        ),
      });
      assert.equal(renamed.listingNeeded, true);
      assert.equal(listed, false);
      assert.equal(await price(store2, soup.skuReference), "7.50");
    } finally {
      await admin.end();
    }
  });
}, 300_000);
