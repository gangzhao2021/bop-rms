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
 * WP-2423 DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 9 (coordinator 2026-10-31 rule 1): at a
 * Brand with two Stores, under the restricted NOBYPASSRLS role with the rendered pilot API grants,
 * through the real one-page menu, price, Store price and availability commands and the guests'
 * real Store facts:
 * 1. the Brand Owner lists a new dish directly (BrandOwnerListing) and both Stores charge it;
 * 2. Store 2's manager shows it there, then changes Store 2's price (old → new, recorded with who
 *    changed it): Store 2's guests see the new price, Store 1's the Brand price;
 * 3. a change built on a price that has since changed is refused ("Changed");
 * 4. a Store book that changes a Brand price is refused by the database;
 * 5. the Owner's next Brand price reaches Store 1 while Store 2 keeps its own;
 * 6. Store 2's manager returns the item to the Brand price;
 * 7. hiding and sold out at Store 2 leave Store 1 selling;
 * 8. Store 2's manager cannot change the Brand price.
 * (The menu, allergen and option recipe steps are stand-ins: each has its own acceptance.)
 */
it("two Stores: Brand Owner lists, each Store keeps its own price, sold out and hidden", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_store_prices" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      store1 = id(3),
      owner = id(4),
      manager = id(5),
      store2 = id(6),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0004-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_stp");
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
        actions: [
          "pricing.price-book.approve",
          "pricing.price-book.manage",
          "organization.brand.manage",
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
      const scopeAt = (storeReference) =>
        syntheticMerchantBrandScope({
          tenantReference,
          brandReference,
          storeReference,
          policyReference: id(300),
          grants: { [owner]: brandGrants, [manager]: [] },
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
      const menus = {
        query: async () => ({ menu, publication: listed ? { state: "Published" } : null }),
        command: async ({ body }) => {
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
            optionPrices: { query: async () => ({ products: [] }), command: unused.command },
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
      const dish = (productReference, priceMinor) => ({
        action: "SaveDish",
        operationReference: op(),
        menuReference: id(499),
        productReference,
        sectionCode: "SOUPS",
        name: "Hot and sour soup (TEST)",
        nameZh: "酸辣汤",
        description: "",
        descriptionZh: "",
        taxClassificationReference: taxClass,
        priceMinor,
        choiceGroups: [],
        allergens: null,
      });
      const listAll = () =>
        one.dishes.command({
          ...session,
          body: { action: "ListAll", operationReference: op(), menuReference: id(499) },
        });
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

      // 1. The Brand Owner lists a new dish directly; both Stores charge it.
      const saved = await one.dishes.command({ ...session, body: dish(null, "650") });
      const sku = saved.skuReference;
      await listAll();
      assert.equal(listed, true);
      const mode = await owned(
        "SELECT approval_mode FROM rms_pricing.price_book_single_store_listing WHERE brand_id=$1",
        [brandReference],
      );
      assert.deepEqual(
        mode.map((row) => row.approval_mode),
        ["BrandOwnerListing"],
      );
      assert.equal(await price(store1, sku), "6.50");
      // Not offered at Store 2 until someone there shows it; then at the Brand price.
      assert.equal((await guest(store2, sku))?.availability, "NotOffered");
      await two.availability.command({
        ...session,
        body: { action: "Offer", operationReference: op(), skuReference: sku },
      });
      assert.equal((await guest(store2, sku))?.availability, "Available");
      assert.equal(await price(store2, sku), "6.50");

      // 2. Store 2's manager changes Store 2's price, confirming 6.50 → 7.25.
      const shown = await two.storePrices.query(session);
      assert.equal(shown.multiStore, true);
      assert.equal(shown.permissions.mayChange, true);
      assert.deepEqual(
        shown.prices.find((p) => p.sellableReference === sku),
        { sellableReference: sku, brandPriceMinor: "650", storePriceMinor: null },
      );
      const change = (expectedAmountMinor, amountMinor) =>
        two.storePrices.command({
          ...session,
          body: {
            action: "ChangeStorePrice",
            operationReference: op(),
            sellableReference: sku,
            expectedAmountMinor,
            amountMinor,
          },
        });
      const changed = await change("650", "725");
      assert.equal(changed.status, "Applied");
      assert.equal(await price(store2, sku), "7.25");
      assert.equal(await price(store1, sku), "6.50");
      const records = await owned(
        "SELECT change_kind,previous_amount_minor::text p,amount_minor::text a,actor_id::text actor FROM rms_pricing.store_price_change WHERE brand_id=$1 AND store_id=$2",
        [brandReference, store2],
      );
      assert.deepEqual(records, [
        { change_kind: "StorePrice", p: "650", a: "725", actor: manager },
      ]);
      const audits = await owned(
        "SELECT after_summary_json->>'previousAmountMinor' p,after_summary_json->>'amountMinor' a,actor_reference::text actor FROM platform_audit.audit_record WHERE action_code='PRICING_STORE_PRICE_CHANGE'",
        [],
      );
      assert.deepEqual(audits, [{ p: "650", a: "725", actor: manager }]);
      const history = await two.storePrices.query(session);
      assert.deepEqual(
        history.changes.map((c) => [c.previousAmountMinor, c.amountMinor, c.changedBy]),
        [["650", "725", manager]],
      );

      // 3. Built on a price that has since changed: refused, nothing changes.
      await assert.rejects(change("650", "800"), (error) => error.code === "Changed");
      assert.equal(await price(store2, sku), "7.25");

      // 4. A Store book that changes a Brand price is refused by the database.
      intercept = async (sql, values) => {
        if (sql.startsWith("INSERT INTO rms_pricing.price_entry") && values[5] === "Brand")
          return admin.query(
            sql,
            values.map((v, i) => (i === 9 ? "1" : v)),
          );
        return undefined;
      };
      await assert.rejects(
        change("725", "750"),
        /store price change may change only this Store's prices/u,
      );
      intercept = null;
      assert.equal(await price(store2, sku), "7.25");
      assert.equal(await price(store1, sku), "6.50");

      // 5. The Owner's next Brand price reaches Store 1; Store 2 keeps its own.
      await one.dishes.command({ ...session, body: dish(saved.productReference, "680") });
      await listAll();
      assert.equal(await price(store1, sku), "6.80");
      assert.equal(await price(store2, sku), "7.25");
      const carried = await owned(
        "SELECT change_kind FROM rms_pricing.store_price_change WHERE brand_id=$1 AND store_id=$2 ORDER BY changed_at",
        [brandReference, store2],
      );
      assert.deepEqual(
        carried.map((row) => row.change_kind),
        ["StorePrice", "BrandListing"],
      );

      // 6. Store 2's manager returns it to the Brand price.
      assert.equal((await change("725", "680")).status, "Applied");
      assert.equal(await price(store2, sku), "6.80");
      assert.equal(
        (await two.storePrices.query(session)).prices.find((p) => p.sellableReference === sku)
          ?.storePriceMinor,
        null,
      );

      // 7. Hidden, then sold out, at Store 2 only.
      await two.availability.command({
        ...session,
        body: { action: "StopOffering", operationReference: op(), skuReference: sku },
      });
      assert.equal((await guest(store2, sku))?.availability, "NotOffered");
      assert.equal((await guest(store1, sku))?.availability, "Available");
      await two.availability.command({
        ...session,
        body: { action: "Offer", operationReference: op(), skuReference: sku },
      });
      await two.availability.command({
        ...session,
        body: {
          action: "SoldOut",
          operationReference: op(),
          skuReference: sku,
          until: "UntilBack",
        },
      });
      assert.equal((await guest(store2, sku))?.availability, "SoldOut");
      assert.equal((await guest(store1, sku))?.availability, "Available");

      // 8. Store 2's manager cannot change the Brand price.
      await assert.rejects(
        two.prices.command({
          ...session,
          body: {
            action: "CreateDraft",
            operationReference: op(),
            stableCode: "MANAGER",
            copyFrom: null,
          },
        }),
        (error) => error.code === "PermissionDenied",
      );
      assert.equal(await price(store1, sku), "6.80");
    } finally {
      await admin.end();
    }
  });
}, 240_000);
