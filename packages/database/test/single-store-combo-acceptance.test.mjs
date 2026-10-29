import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { createMerchantCombos } from "../../../apps/api/src/merchant-combos.ts";
import {
  comboPartsByOrderItem,
  markDiningComboPartServed,
  markKitchenComboPartDone,
} from "../../../apps/api/src/merchant-combo-parts.ts";
import { createDiningTable, parseDiningSession } from "../../rms/dining/src/index.ts";
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
      // Stand-ins for the allergen steps (each has its own acceptance), recording what was sent:
      // the combo declares no allergens of its own; each choice's recipe adds its dish's item.
      const declarations = [];
      const declaredAllergens = {
        command: async ({ body }) => {
          declarations.push(body);
          return { status: "Applied" };
        },
      };
      const recipes = new Map();
      const optionRecipes = {
        query: async () => ({
          options: (
            await admin.query(
              `SELECT b.binding_id::text binding,o.option_id::text option,s.sku_id::text sku
                 FROM rms_catalog.bundle_combo_choice c
                 JOIN rms_catalog.product_option_binding b ON b.brand_id=c.brand_id AND b.option_set_id=c.option_set_id
                 JOIN rms_catalog.option o ON o.option_id=c.option_id AND o.brand_id=c.brand_id
                 JOIN rms_catalog.sku s ON s.product_id=b.product_id AND s.brand_id=b.brand_id
                WHERE c.brand_id=$1`,
              [brandReference],
            )
          ).rows.map((row) => {
            const recipe = recipes.get(row.option);
            return {
              bindingReference: row.binding,
              optionReference: row.option,
              sizes: [{ skuReference: row.sku }],
              covered: recipe?.published === true,
              change:
                recipe === undefined
                  ? null
                  : {
                      changeVersionReference: recipe.reference,
                      version: 1,
                      published: recipe.published,
                      reviews: recipe.reviews.map((kind) => ({ kind, decision: "Approved" })),
                    },
            };
          }),
        }),
        command: async ({ body }) => {
          if (body.action === "Save")
            recipes.set(body.optionReference, {
              reference: op(),
              change: body.change,
              published: false,
              reviews: [],
            });
          for (const recipe of recipes.values())
            if (recipe.reference === body.changeVersionReference) {
              if (body.action === "Review") recipe.reviews.push(body.kind);
              if (body.action === "Publish") recipe.published = recipe.reviews.length === 2;
            }
          return {};
        },
      };
      const availability = createMerchantAvailability(common);
      const combos = createMerchantCombos(common);
      const dishes = createMerchantOneStoreDishes({
        products: createMerchantProducts(common),
        prices: createMerchantPrices({ ...common, currencyMetadata }),
        optionPrices: createMerchantOptionPrices({ ...common, currencyMetadata }),
        menus,
        dishAllergens: declaredAllergens,
        optionRecipes,
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
        // Staff declared the dish's allergens (its own acceptance); a combo choice adds the item.
        sellables.push({
          skuReference: saved.skuReference,
          productName: name,
          productNameZh: nameZh,
          sizeName: name,
          active: true,
          allergens: { source: "StaffDeclared", itemReference: op() },
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
      // The combo declares no allergens of its own; each choice adds its dish's declared item.
      // (The retried save sends the same operation again: a replay for the real command.)
      assert.deepEqual(
        [
          ...new Map(
            declarations.map((d) => [
              d.operationReference,
              [d.action, d.skuReference, d.allergens],
            ]),
          ).values(),
        ],
        [["DeclareDish", saved.skuReference, []]],
      );
      const itemOf = new Map(sellables.map((x) => [x.skuReference, x.allergens.itemReference]));
      for (const choice of choices)
        assert.deepEqual(recipes.get(choice.option)?.change, {
          kind: "Add",
          fromItemReference: null,
          toItemReference: itemOf.get(choice.dish),
          quantity: "1",
          unitCostCents: null,
          lossPercent: "0",
        });
      assert.equal(
        [...recipes.values()].every((r) => r.published),
        true,
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
      // Guests are told which choices stand for a combo's dishes (each part starts unchosen).
      assert.deepEqual([...offered.comboChoices].sort(), choices.map((c) => c.option).sort());
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

      // 6. Ordered at a table: the kitchen makes each chosen dish on its own and staff serve each
      // (decision 3). The order line, its kitchen ticket and the table are the owners' records
      // (seeded as the dine-in journey seeds them); what the combo adds runs as the API role.
      const sessionReference = op(),
        tableReference = op(),
        orderReference = op(),
        orderItemReference = op(),
        ticket = op(),
        workItem = op();
      const startedAt = new Date(Date.now() - 600_000).toISOString();
      const diningScope = { tenantReference, brandReference, storeReference };
      const table = createDiningTable({
        ...diningScope,
        tableReference,
        stableLabel: "TEST-T1",
        areaReference: op(),
        areaCode: "ROOM",
        capacity: 4,
        accessibilityAttributes: [],
        lifecycle: "Published",
        qrStatus: "Active",
        qrVersion: 1,
        operationalState: "Available",
        blockReasonCode: null,
        activeDiningSessionReference: sessionReference,
        aggregateVersion: 1,
        createdAt: startedAt,
        observedAt: startedAt,
      });
      const diningSession = parseDiningSession({
        diningSessionReference: sessionReference,
        brandReference,
        storeReference,
        tableReference,
        tableAssignmentVersion: 1,
        phase: "Active",
        version: 2,
        startedByActorReference: owner,
        startedAt,
        hostParticipantReference: op(),
      });
      await admin.query(
        "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
        [
          tableReference,
          tenantReference,
          brandReference,
          storeReference,
          JSON.stringify(table),
          startedAt,
        ],
      );
      await admin.query(
        "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
        [
          sessionReference,
          tenantReference,
          brandReference,
          storeReference,
          tableReference,
          JSON.stringify(diningSession),
          startedAt,
        ],
      );
      // The guest chose 馄饨汤 and 炒饭; the kitchen ticket has one work item for the combo.
      const chosen = [wonton, rice].map((dish) => choices.find((c) => c.dish === dish).option);
      const h = (...parts) =>
        "sha256:" + createHash("sha256").update(parts.join(":")).digest("hex");
      await admin.query(
        "INSERT INTO rms_kitchen.kitchen_ticket (kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,consumer_name,consumer_version,source_event_id,source_aggregate_version,source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,source_evidence_id,source_evidence_version,source_evidence_digest,source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,work_plan_generated_at,aggregate_version,status,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,2,$8,$9,$10,$11,$12,1,$13,$9,$14,1,$15,$9,1,'Open','System','System',$9,$9)",
        [
          ticket,
          brandReference,
          storeReference,
          orderReference,
          op(),
          op(),
          op(),
          h("snapshot"),
          startedAt,
          op(),
          h("binding"),
          op(),
          h("evidence"),
          op(),
          h("plan"),
        ],
      );
      const optionsJson = JSON.stringify(
        chosen.map((optionReference) => ({
          optionReference,
          quantity: 1,
          localizedNames: { "en-CA": "TEST choice" },
        })),
      );
      const ticketRow = (
        await admin.query(
          "SELECT order_batch_id::text batch,source_evidence_id::text evidence,work_plan_id::text plan FROM rms_kitchen.kitchen_ticket WHERE kitchen_ticket_id=$1",
          [ticket],
        )
      ).rows[0];
      await admin.query(
        "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,1,2,'In Progress',1,0,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,1,$19,$20,1,$21,$22::jsonb,$23,'System','System',$24,$24)",
        [
          workItem,
          brandReference,
          storeReference,
          ticket,
          orderReference,
          ticketRow.batch,
          orderItemReference,
          ticketRow.evidence,
          ticketRow.plan,
          saved.productReference,
          op(),
          saved.skuReference,
          op(),
          JSON.stringify({ "zh-Hans": "二人套餐", "en-CA": "Combo for two (TEST)" }),
          optionsJson,
          h("line"),
          op(),
          op(),
          h("routing"),
          op(),
          h("preparation"),
          JSON.stringify(["TEST step"]),
          h("execution"),
          startedAt,
        ],
      );
      // Store-scoped API role work (the kitchen board and the serving page run here).
      const asStore = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
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
      const line = { orderItemReference, optionReferences: chosen };
      const parts = async () =>
        (await asStore((tx) => comboPartsByOrderItem(tx, { ...diningScope }, "en-CA", [line]))).get(
          orderItemReference,
        );
      // The kitchen sees each chosen dish under the combo, Chinese name first.
      assert.deepEqual(
        (await parts()).map((p) => [p.nameZh, p.name, p.done, p.served]),
        [
          ["馄饨汤", "Wonton soup (TEST)", false, false],
          ["炒饭", "Fried rice (TEST)", false, false],
        ],
      );
      const done = (optionReference, operationReference = op()) =>
        asStore((tx) =>
          markKitchenComboPartDone(tx, diningScope, {
            workItemReference: workItem,
            ...line,
            optionReference,
            operationReference,
            actorReference: owner,
            at: new Date().toISOString(),
            locale: "en-CA",
          }),
        );
      const served = (optionReference) =>
        asStore((tx) =>
          markDiningComboPartServed(tx, diningScope, {
            diningSessionReference: sessionReference,
            ...line,
            optionReference,
            operationReference: op(),
            actorReference: owner,
            at: new Date().toISOString(),
            locale: "en-CA",
          }),
        );
      // A dish is served only once the kitchen made it.
      await assert.rejects(served(chosen[0]), /DINING_COMBO_PART_NOT_READY/u);
      const firstDone = op();
      assert.deepEqual(await done(chosen[0], firstDone), { allDone: false });
      // A retry of the same step records nothing again.
      assert.deepEqual(await done(chosen[0], firstDone), { allDone: false });
      assert.deepEqual(await served(chosen[0]), { allServed: false });
      assert.deepEqual(await done(chosen[1]), { allDone: true });
      assert.deepEqual(await served(chosen[1]), { allServed: true });
      assert.deepEqual(
        (await parts()).map((p) => [p.nameZh, p.done, p.served]),
        [
          ["馄饨汤", true, true],
          ["炒饭", true, true],
        ],
      );
      // The database refuses a dish the work item does not have, and keeps each record.
      await assert.rejects(
        asStore((tx) =>
          tx.query(
            "INSERT INTO rms_kitchen.kitchen_combo_part_done(brand_id,store_id,kitchen_work_item_id,option_id,operation_id,actor_id,done_at) VALUES($1,$2,$3,$4,$5,$6,now())",
            [brandReference, storeReference, workItem, sourChoice, op(), owner],
          ),
        ),
        /kitchen combo part needs a chosen dish of a live work item/u,
      );
      await assert.rejects(
        asStore((tx) =>
          tx.query(
            "UPDATE rms_dining.dining_combo_part_served SET actor_id=$1 WHERE order_item_id=$2",
            [op(), orderItemReference],
          ),
        ),
        /append-only dining combo part record|permission denied/u,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_kitchen.kitchen_combo_part_done WHERE kitchen_work_item_id=$1",
            [workItem],
          )
        ).rows[0].n,
        2,
      );
    } finally {
      await admin.end();
    }
  });
}, 300_000);
