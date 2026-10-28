import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createMerchantOneStoreDishes } from "../../../apps/api/src/merchant-one-store-dishes.ts";
import { createMerchantPrices } from "../../../apps/api/src/merchant-prices.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
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
 * WP-2423 item 8 ⑥ (v15 2026-10-28 finding d): 22 dishes added on the one-page menu were listed
 * but guests at the store saw none of them. A size reaches guests only when it is offered at the
 * store (an availability rule); a new product has none, and guests' store facts read "NotOffered".
 * The journey under the restricted NOBYPASSRLS role with the rendered pilot API grants, through
 * the real commands of the products, prices and store availability pages and the guests' real
 * store facts: a new dish saved on the one-page menu → "List it" → guests at the store are offered
 * it at its listed price; a dish staff hid stays hidden. (The menu, allergen and option recipe
 * steps are stand-ins here: each has its own acceptance, and their listing passed on v15.)
 */
it("one-page menu journey: a new dish, listed, is offered to guests at the store at its price", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_journey" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0004-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_ssj");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      // TEST-ONLY Store tax configuration covering the tax class the product uses (13 %).
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

      // One store; the owner holds the product, price and availability permissions.
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
        actions: ["pricing.price-book.approve", "pricing.price-book.manage"],
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

      // The command's transaction. `intercept` (tests only) sees each statement first.
      let intercept = null;
      const tx = {
        query: async (sql, values) => {
          const seen = intercept === null ? undefined : await intercept(sql, values);
          if (seen === "skip") return { rows: [], rowCount: 1 };
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
            "pricing.price_book.read",
            "pricing.price-book.manage",
            "pricing.price-book.approve",
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
        resolveScope: grants.resolveScope,
        references: { next: op },
      };
      // Stand-ins for the steps proven elsewhere: one menu with one section (records placements),
      // no choice groups, allergens not declared in this journey.
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
      const availability = createMerchantAvailability(common);
      const dishes = createMerchantOneStoreDishes({
        products: createMerchantProducts(common),
        prices: createMerchantPrices({ ...common, currencyMetadata }),
        // No choice prices waiting (a listing reads them).
        optionPrices: { query: async () => ({ products: [] }), command: unused.command },
        menus,
        dishAllergens: unused,
        optionRecipes: unused,
        availability,
        now: () => new Date().toISOString(),
      });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      grants.as(owner);

      // Guests' store facts, as the guest menu reads them at this store (dine-in, TEST guest).
      const reader = {
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
      };
      const guest = (skuReference) =>
        createCustomerMenuStoreFacts({
          transactions: reader,
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

      // 1. A new dish on the one-page menu, then "List it".
      const saved = await dishes.command({
        ...session,
        body: {
          action: "SaveDish",
          operationReference: op(),
          menuReference: id(499),
          productReference: null,
          sectionCode: "SOUPS",
          name: "Hot and sour soup (TEST)",
          nameZh: "酸辣汤",
          description: "",
          descriptionZh: "",
          taxClassificationReference: taxClass,
          priceMinor: "650",
          choiceGroups: [],
          allergens: null,
        },
      });
      assert.deepEqual(menu.sections[0].items, [
        { skuReference: saved.skuReference, featured: false },
      ]);
      await dishes.command({
        ...session,
        body: { action: "ListAll", operationReference: op(), menuReference: id(499) },
      });
      assert.equal(listed, true);
      // 2. Guests at the store are offered it, at its listed price.
      assert.deepEqual(await guest(saved.skuReference), {
        availability: "Available",
        price: { amount: "6.50", currency: "CAD" },
        optionPrices: new Map(),
      });

      // 3. A dish staff hid stays hidden through the next listing.
      await availability.command({
        ...session,
        body: {
          action: "StopOffering",
          operationReference: op(),
          skuReference: saved.skuReference,
        },
      });
      await dishes.command({
        ...session,
        body: { action: "ListAll", operationReference: op(), menuReference: id(499) },
      });
      assert.equal((await guest(saved.skuReference))?.availability, "NotOffered");
    } finally {
      await admin.end();
    }
  });
}, 240_000);
