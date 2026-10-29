import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createMerchantCombos } from "../../../apps/api/src/merchant-combos.ts";
import { createMerchantOneStoreDishes } from "../../../apps/api/src/merchant-one-store-dishes.ts";
import { createMerchantOptionPrices } from "../../../apps/api/src/merchant-option-prices.ts";
import { createMerchantOptionSets } from "../../../apps/api/src/merchant-option-sets.ts";
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
 * WP-2423 item 8 ⑥ part 4 DEC-SINGLE-STORE-COMBO (Owner 2026-10-28 decision 10, approach B): a
 * combo made on the one-page menu of a single store and listed with "List it", no review. Under
 * the restricted NOBYPASSRLS role with the rendered pilot API grants, through the real commands of
 * the products, prices, choice groups, choice prices, store availability and combo pages, and the
 * guests' real store facts:
 *  1. the combo is saved as a Bundle draft and compiled into one dish at the combo price with one
 *     choice group per slot, each choice recorded as standing for its dish;
 *  2. "List it" publishes it alone (a single-store listing, audited as such) and guests at the
 *     store are offered it at its price, with each choice's extra price; a second "List it" lists
 *     nothing again;
 *  3. an edit is a new version: guests keep the listed one until the next "List it";
 *  4. the database refuses a single-store listing at a Brand with two stores, a second listing of
 *     a version, a choice changing its dish, and a version changing other than by being published;
 *  5. another Brand sees none of it.
 * (The menu and option recipe steps are stand-ins: each has its own acceptance.)
 */
it("one-page menu combo: saved, compiled into a dish, listed alone at one store, offered to guests", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_combo" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0005-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_ssc");
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

      // One store; the owner holds the product, choice group, price and availability permissions.
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
      // Stand-in menu: one draft with two sections; it lists the dishes saved so far.
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
          {
            sectionReference: id(502),
            code: "COMBOS",
            name: "Combos (TEST)",
            nameZh: "套餐",
            items: [],
          },
        ],
      };
      const sellables = [];
      let listed = false;
      const menus = {
        query: async () => ({
          menu,
          publication: listed ? { state: "Published" } : null,
          sellables,
        }),
        command: async ({ body }) => {
          if (body.action === "SaveDraft") menu.sections = body.sections;
          if (body.action === "Revise") listed = false;
          if (body.action === "List") listed = true;
          menu.aggregateVersion += 1;
          return { status: "Listed" };
        },
      };
      const unused = {
        query: async () => assert.fail("allergens are not declared in this journey"),
        command: async () => assert.fail("allergens are not declared in this journey"),
      };
      const availability = createMerchantAvailability(common);
      const combos = createMerchantCombos(common);
      const dishes = createMerchantOneStoreDishes({
        products: createMerchantProducts(common),
        prices: createMerchantPrices({ ...common, currencyMetadata }),
        optionPrices: createMerchantOptionPrices({ ...common, currencyMetadata }),
        menus,
        dishAllergens: unused,
        // Option recipes have their own acceptance; none are needed for a listing.
        optionRecipes: { query: async () => ({ options: [] }), command: unused.command },
        availability,
        combos,
        optionSets: createMerchantOptionSets(common),
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
      const guest = (skuReference, options = []) =>
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
            options: options.map((o) => ({ sellableReference: skuReference, ...o })),
          })
          .then((facts) => facts.get(skuReference));
      const asApi = async (sql, values) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenantReference, brandReference],
          );
          return await admin.query(sql, values);
        } finally {
          await admin.query("ROLLBACK");
        }
      };

      // The dishes the combo offers, saved on the one-page menu.
      const dish = async (name, nameZh, priceMinor) => {
        const saved = await dishes.command({
          ...session,
          body: {
            action: "SaveDish",
            operationReference: op(),
            menuReference: id(499),
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
        sellables.push({
          skuReference: saved.skuReference,
          productName: name,
          productNameZh: nameZh,
          sizeName: name,
          active: true,
        });
        return saved.skuReference;
      };
      const sour = await dish("Hot and sour soup (TEST)", "酸辣汤", "650");
      const wonton = await dish("Wonton soup (TEST)", "馄饨汤", "700");
      const rice = await dish("Fried rice (TEST)", "炒饭", "1200");
      const noodles = await dish("Chow mein (TEST)", "炒面", "1300");

      // 1. A combo for two: 汤 choose 1 (wonton +1.00), 主食 choose 1.
      const comboBody = (overrides = {}) => ({
        action: "SaveCombo",
        operationReference: op(),
        menuReference: id(499),
        bundleReference: null,
        expectedAggregateVersion: null,
        sectionCode: "COMBOS",
        name: "Combo for two (TEST)",
        nameZh: "二人套餐",
        description: "",
        descriptionZh: "",
        taxClassificationReference: taxClass,
        priceMinor: "2880",
        slots: [
          {
            code: null,
            name: "Soup",
            nameZh: "汤",
            minimum: 1,
            maximum: 1,
            dishes: [
              { skuReference: sour, upgradeMinor: "0" },
              { skuReference: wonton, upgradeMinor: "100" },
            ],
          },
          {
            code: null,
            name: "Main",
            nameZh: "主食",
            minimum: 1,
            maximum: 1,
            dishes: [{ skuReference: rice, upgradeMinor: "0" }],
          },
        ],
        ...overrides,
      });
      const first = comboBody();
      const saved = await dishes.command({ ...session, body: first });
      // Retrying the same save continues (nothing is made twice).
      assert.deepEqual(await dishes.command({ ...session, body: first }), saved);
      const choices = (
        await admin.query(
          "SELECT group_code,option_set_id::text set,option_id::text option,dish_sku_id::text dish FROM rms_catalog.bundle_combo_choice WHERE brand_id=$1 ORDER BY group_code,dish_sku_id",
          [brandReference],
        )
      ).rows;
      assert.deepEqual(
        choices.map((c) => [c.group_code, c.dish]),
        [
          ["SLOT-1", sour < wonton ? sour : wonton],
          ["SLOT-1", sour < wonton ? wonton : sour],
          ["SLOT-2", rice],
        ],
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT product_id::text product,sku_id::text sku FROM rms_catalog.bundle_combo_dish WHERE brand_id=$1",
            [brandReference],
          )
        ).rows,
        [{ product: saved.productReference, sku: saved.skuReference }],
      );
      // The combo dish sits in its section and offers the two choice groups.
      assert.deepEqual(menu.sections[1].items, [
        { skuReference: saved.skuReference, featured: false },
      ]);
      const view = (await combos.query(session)).combos;
      assert.equal(view.length, 1);
      assert.equal(view[0].state, "Waiting");
      assert.equal(view[0].nameZh, "二人套餐");
      assert.deepEqual(
        view[0].slots.map((s) => [s.code, s.nameZh, s.minimum, s.maximum, s.dishes.length]),
        [
          ["SLOT-1", "汤", 1, 1, 2],
          ["SLOT-2", "主食", 1, 1, 1],
        ],
      );
      // Nothing is priced for guests until "List it".
      assert.equal((await guest(saved.skuReference)).price, null);

      // 2. "List it": the combo is published alone at the one store, and guests are offered it.
      await dishes.command({
        ...session,
        body: { action: "ListAll", operationReference: op(), menuReference: id(499) },
      });
      const listings = async () =>
        (
          await admin.query(
            "SELECT bundle_version_id::text version,listing_store_id::text store,actor_id::text actor,audit_id::text audit FROM rms_catalog.bundle_single_store_listing WHERE brand_id=$1 ORDER BY listed_at",
            [brandReference],
          )
        ).rows;
      const [firstListing] = await listings();
      assert.equal(firstListing.store, storeReference);
      assert.equal(firstListing.actor, owner);
      assert.deepEqual(
        (
          await admin.query(
            "SELECT action_code,after_summary_json FROM platform_audit.audit_record WHERE audit_id=$1",
            [firstListing.audit],
          )
        ).rows.map((r) => [r.action_code, r.after_summary_json]),
        [["CATALOG_BUNDLE_PUBLISH", { approvalMode: "SingleStoreListing" }]],
      );
      assert.equal((await combos.query(session)).combos[0].state, "Listed");
      const wontonChoice = choices.find((c) => c.dish === wonton).option;
      const sourChoice = choices.find((c) => c.dish === sour).option;
      const binding = (
        await admin.query(
          "SELECT b.binding_id::text binding FROM rms_catalog.product_option_binding b WHERE b.brand_id=$1 AND b.product_id=$2 AND b.option_set_id=$3 LIMIT 1",
          [brandReference, saved.productReference, choices.find((c) => c.dish === wonton).set],
        )
      ).rows[0].binding;
      const offered = await guest(saved.skuReference, [
        { bindingReference: binding, optionReference: wontonChoice },
        { bindingReference: binding, optionReference: sourChoice },
      ]);
      assert.equal(offered.availability, "Available");
      assert.deepEqual(offered.price, { amount: "28.80", currency: "CAD" });
      // Each choice's extra price: wonton +1.00, hot and sour included.
      assert.deepEqual(offered.optionPrices.get(binding + ":" + wontonChoice), {
        amount: "1.00",
        currency: "CAD",
      });
      assert.deepEqual(offered.optionPrices.get(binding + ":" + sourChoice), {
        amount: "0.00",
        currency: "CAD",
      });
      // A second "List it" lists nothing again.
      await dishes.command({
        ...session,
        body: { action: "ListAll", operationReference: op(), menuReference: id(499) },
      });
      assert.equal((await listings()).length, 1);

      // 3. An edit is a new version (29.80, chow mein added); guests keep 28.80 until "List it".
      const current = (await combos.query(session)).combos[0];
      await dishes.command({
        ...session,
        body: comboBody({
          bundleReference: current.bundleReference,
          expectedAggregateVersion: current.aggregateVersion,
          priceMinor: "2980",
          slots: [
            { ...first.slots[0], code: "SLOT-1" },
            {
              ...first.slots[1],
              code: "SLOT-2",
              dishes: [
                { skuReference: rice, upgradeMinor: "0" },
                { skuReference: noodles, upgradeMinor: "0" },
              ],
            },
          ],
        }),
      });
      const edited = (await combos.query(session)).combos[0];
      assert.equal(edited.state, "Waiting");
      assert.equal(edited.priceMinor, "2980");
      assert.deepEqual((await guest(saved.skuReference)).price, {
        amount: "28.80",
        currency: "CAD",
      });
      // The listed version is kept as it was.
      assert.deepEqual(
        (
          await admin.query(
            "SELECT status,fixed_amount_minor::text price FROM rms_catalog.bundle_version WHERE brand_id=$1 ORDER BY created_at",
            [brandReference],
          )
        ).rows,
        [
          { status: "Published", price: "2880" },
          { status: "Draft", price: "2980" },
        ],
      );

      // 4. At a Brand with two stores the database refuses a single-store listing …
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'STORE_TWO','Synthetic STORE_TWO','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [id(4000), brandReference, from],
      );
      const draftVersion = (
        await admin.query(
          "SELECT current_version_id::text v FROM rms_catalog.bundle WHERE brand_id=$1",
          [brandReference],
        )
      ).rows[0].v;
      const listing = (versionReference, operationReference) =>
        asApi(
          `INSERT INTO rms_catalog.bundle_single_store_listing(brand_id,operation_id,bundle_id,bundle_version_id,approval_mode,listing_store_id,actor_id,listed_at,audit_id)
           VALUES($1,$2,$3,$4,'SingleStoreListing',$5,$6,date_trunc('milliseconds',now()),$7)`,
          [
            brandReference,
            operationReference,
            current.bundleReference,
            versionReference,
            storeReference,
            owner,
            op(),
          ],
        );
      await assert.rejects(
        listing(draftVersion, op()),
        /bundle single store listing needs a brand with one store/u,
      );
      // … and so does "List it" itself, before anything is published.
      await assert.rejects(
        dishes.command({
          ...session,
          body: { action: "ListAll", operationReference: op(), menuReference: id(499) },
        }),
        (error) => error.name === "MerchantComboError" && error.code === "NotSingleStore",
      );
      assert.equal((await combos.query(session)).combos[0].state, "Waiting");
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=2,updated_at=$2 WHERE store_id=$1",
        [id(4000), new Date().toISOString()],
      );
      // A version is listed once.
      await assert.rejects(
        listing(firstListing.version, op()),
        /bundle_single_store_listing_version_once/u,
      );
      // A choice never changes the dish it stands for; a version changes only by being published.
      await assert.rejects(
        asApi("UPDATE rms_catalog.bundle_combo_choice SET dish_sku_id=$2 WHERE option_id=$1", [
          wontonChoice,
          rice,
        ]),
        /append-only bundle combo record|permission denied/u,
      );
      await assert.rejects(
        asApi(
          "UPDATE rms_catalog.bundle_version SET fixed_amount_minor=1 WHERE bundle_version_id=$1",
          [firstListing.version],
        ),
        /a bundle version only changes by being published/u,
      );

      // The edit is listed at one store again; guests now get 29.80.
      await dishes.command({
        ...session,
        body: { action: "ListAll", operationReference: op(), menuReference: id(499) },
      });
      assert.equal((await listings()).length, 2);
      assert.deepEqual((await guest(saved.skuReference)).price, {
        amount: "29.80",
        currency: "CAD",
      });

      // 5. Another Brand sees none of it.
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
          [tenantReference, id(9999)],
        );
        for (const table of [
          "bundle",
          "bundle_combo_dish",
          "bundle_combo_choice",
          "bundle_single_store_listing",
        ])
          assert.equal(
            (await admin.query(`SELECT count(*)::int n FROM rms_catalog.${table}`)).rows[0].n,
            0,
            table,
          );
      } finally {
        await admin.query("ROLLBACK");
      }
    } finally {
      await admin.end();
    }
  });
}, 300_000);
