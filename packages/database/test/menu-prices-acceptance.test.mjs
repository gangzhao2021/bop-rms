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
 * WP-2423 menu-authoring-and-prices (M70, M71, M124, M150): at a Brand with two Stores, under the
 * restricted NOBYPASSRLS role with the rendered pilot API grants, through the real one-page menu,
 * price and Store price commands and the guests' real Store facts:
 * 1. a dish's first price is for every Store, in the menu's own price draft (server-named with the
 *    Store's own date), listed as reviewed;
 * 2. a Prices-page change is server-named and never listed by the menu's "List it";
 * 3. "List it" lists exactly the version the review showed;
 * 4. a price change copied before another went live is refused, and is applied to the prices in use
 *    (Rebase) before it is published;
 * 5. a change that went live after the menu's price draft was started survives "List it";
 * 6. at the Store with its own price, "only this Store" changes it at once (recorded), "every Store"
 *    changes the Brand price and the Store keeps its own, no price sent writes nothing, and a
 *    Brand price for every Store needs Brand Owner authority;
 * 7. the purpose record is append-only.
 * Fails at bc7e2965: there the dish save and "List it" bodies have no price scope or confirmation
 * (refused as Invalid), price drafts carry no purpose, and "List it" publishes Wei's draft (step 3).
 */
it("two Stores: menu prices list as reviewed, Prices-page changes stay, nothing is undone", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_menu_prices" }, async (context) => {
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
      const role = await createPilotApiRole(admin, context, "wp2423_mpr");
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

      const prices = (at) => at.prices.query({ ...session, priceBookReference: null });
      const priceCommand = (at, body) => at.prices.command({ ...session, body });
      const purposes = () =>
        owned(
          "SELECT b.stable_code code,p.purpose,p.actor_id::text actor FROM rms_pricing.price_book_draft_purpose p JOIN rms_pricing.price_book b USING (price_book_id) WHERE p.brand_id=$1 ORDER BY p.recorded_at",
          [brandReference],
        );
      const torontoDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .format(new Date())
        .replaceAll("-", "");

      // 1. The Brand Owner adds two dishes (their first prices are for every Store) and lists
      // them as reviewed; both Stores charge them.
      const soup = await one.dishes.command({
        ...session,
        body: dish(null, "Hot and sour soup (TEST)", "650", "AllStores", null),
      });
      const tea = await one.dishes.command({
        ...session,
        body: dish(null, "Jasmine tea (TEST)", "300", "AllStores", null),
      });
      assert.deepEqual(soup.price, {
        brandPriceMinor: null,
        pendingBrandPriceMinor: "650",
        storePriceMinor: null,
      });
      // One menu price draft, named by the server with Toronto's date (M150/M124).
      const first = await purposes();
      assert.equal(first.length, 1);
      assert.equal(first[0].purpose, "MenuListing");
      assert.match(first[0].code, new RegExp("^MENU-" + torontoDate + "-[0-9A-F]{6}$", "u"));
      await listAll();
      for (const store of [store1, store2])
        for (const sku of [soup.skuReference, tea.skuReference])
          await two.availability.command({
            ...session,
            body: { action: "Offer", operationReference: op(), skuReference: sku },
          });
      assert.equal(await price(store1, soup.skuReference), "6.50");
      assert.equal(await price(store2, soup.skuReference), "6.50");

      // 2. Wei starts a price change on the Prices page (server-named; a typed code is refused).
      two.as(staff);
      one.as(staff);
      await assert.rejects(
        priceCommand(one, {
          action: "CreateDraft",
          operationReference: op(),
          stableCode: "TYPED",
          copyFrom: null,
        }),
        (error) => error.code === "Invalid",
      );
      const assigned = (await prices(one)).storeAssignment.priceBookReference;
      const wei = await priceCommand(one, {
        action: "CreateDraft",
        operationReference: op(),
        copyFrom: assigned,
        purpose: "PriceChange",
      });
      const weiBook = (
        await one.prices.query({ ...session, priceBookReference: wei.priceBookReference })
      ).book;
      assert.match(weiBook.stableCode, new RegExp("^PRICES-" + torontoDate + "-", "u"));
      await priceCommand(one, {
        action: "SaveDraft",
        operationReference: op(),
        priceBookReference: wei.priceBookReference,
        expectedAggregateVersion: weiBook.aggregateVersion,
        prices: [
          { sellableReference: soup.skuReference, amountMinor: "900" },
          { sellableReference: tea.skuReference, amountMinor: "300" },
        ],
      });
      one.as(owner);
      two.as(manager);

      // 3. The Owner changes the soup on the menu page (every Store) and lists it. The review is
      // confirmed for the version shown: a stale one lists nothing. Wei's change is not listed (M71;
      // before, "List it" published every draft of the Brand).
      await one.dishes.command({
        ...session,
        body: dish(soup.productReference, "Hot and sour soup (TEST)", "700", "AllStores", "650"),
      });
      // Only one menu price draft at a time.
      await assert.rejects(
        priceCommand(one, {
          action: "CreateDraft",
          operationReference: op(),
          copyFrom: null,
          purpose: "MenuListing",
        }),
        (error) => error.code === "DraftOpen",
      );
      const shown = await menuDraft();
      await assert.rejects(
        listAll({ ...shown, aggregateVersion: shown.aggregateVersion - 1 }),
        (error) => error.code === "PricesChangedSinceShown",
      );
      assert.equal(await price(store1, soup.skuReference), "6.50");
      await listAll(shown);
      assert.equal(await price(store1, soup.skuReference), "7.00");
      assert.equal(await price(store2, soup.skuReference), "7.00");
      const weiNow = (await prices(one)).books.find(
        (b) => b.priceBookReference === wei.priceBookReference,
      );
      assert.equal(weiNow.lifecycle, "Draft");

      // 4. Wei's change was copied before the Owner's went live: publishing it as it is would put
      // the soup back to 6.50 → 9.00 over 7.00 silently. Refused; Wei applies it to the prices in
      // use, and the Owner reviews and publishes that.
      assert.equal(weiNow.movedSinceStart, true);
      await assert.rejects(
        priceCommand(one, {
          action: "Publish",
          operationReference: op(),
          priceBookReference: wei.priceBookReference,
          expectedAggregateVersion: weiNow.aggregateVersion,
        }),
        (error) => error.code === "PricesMoved",
      );
      assert.equal(await price(store1, soup.skuReference), "7.00");
      one.as(staff);
      const rebased = await priceCommand(one, {
        action: "Rebase",
        operationReference: op(),
        priceBookReference: wei.priceBookReference,
        expectedAggregateVersion: weiNow.aggregateVersion,
      });
      const weiAgain = await one.prices.query({
        ...session,
        priceBookReference: rebased.priceBookReference,
      });
      one.as(owner);
      assert.equal(weiAgain.movedSinceStart, false);
      assert.deepEqual(
        Object.fromEntries(weiAgain.book.prices.map((p) => [p.sellableReference, p.amountMinor])),
        { [soup.skuReference]: "900", [tea.skuReference]: "300" },
      );
      assert.equal(
        (await prices(one)).books.find((b) => b.priceBookReference === wei.priceBookReference)
          .lifecycle,
        "Archived",
      );
      await priceCommand(one, {
        action: "Publish",
        operationReference: op(),
        priceBookReference: rebased.priceBookReference,
        expectedAggregateVersion: weiAgain.book.aggregateVersion,
      });
      await priceCommand(one, {
        action: "AssignToStore",
        operationReference: op(),
        priceBookReference: rebased.priceBookReference,
      });
      assert.equal(await price(store1, soup.skuReference), "9.00");
      assert.equal(await price(store2, soup.skuReference), "9.00");

      // 5. A price change that goes live after the menu's price draft was started survives
      // "List it": the menu's draft is refused until it is started again from the prices in use.
      await one.dishes.command({
        ...session,
        body: dish(soup.productReference, "Hot and sour soup (TEST)", "950", "AllStores", "900"),
      });
      const waiting = await menuDraft();
      one.as(staff);
      const teaChange = await priceCommand(one, {
        action: "CreateDraft",
        operationReference: op(),
        copyFrom: (await prices(one)).storeAssignment.priceBookReference,
        purpose: "PriceChange",
      });
      const teaBook = (
        await one.prices.query({ ...session, priceBookReference: teaChange.priceBookReference })
      ).book;
      await priceCommand(one, {
        action: "SaveDraft",
        operationReference: op(),
        priceBookReference: teaChange.priceBookReference,
        expectedAggregateVersion: teaBook.aggregateVersion,
        prices: [
          { sellableReference: soup.skuReference, amountMinor: "900" },
          { sellableReference: tea.skuReference, amountMinor: "350" },
        ],
      });
      one.as(owner);
      const teaReady = (await prices(one)).books.find(
        (b) => b.priceBookReference === teaChange.priceBookReference,
      );
      await priceCommand(one, {
        action: "Publish",
        operationReference: op(),
        priceBookReference: teaChange.priceBookReference,
        expectedAggregateVersion: teaReady.aggregateVersion,
      });
      await priceCommand(one, {
        action: "AssignToStore",
        operationReference: op(),
        priceBookReference: teaChange.priceBookReference,
      });
      assert.equal(await price(store1, tea.skuReference), "3.50");
      await assert.rejects(listAll(waiting), (error) => error.code === "PricesMoved");
      assert.equal(await price(store1, tea.skuReference), "3.50");
      assert.equal(await price(store1, soup.skuReference), "9.00");
      const restarted = await priceCommand(one, {
        action: "Rebase",
        operationReference: op(),
        priceBookReference: waiting.priceBookReference,
        expectedAggregateVersion: waiting.aggregateVersion,
      });
      const again = await menuDraft();
      assert.equal(again.priceBookReference, restarted.priceBookReference);
      await listAll(again);
      assert.equal(await price(store1, soup.skuReference), "9.50");
      assert.equal(await price(store1, tea.skuReference), "3.50");
      assert.equal(await price(store2, tea.skuReference), "3.50");

      // 6. M70 at Store 2: "only this Store" changes the soup there, live at once and recorded; a
      // Brand price change needs Brand Owner authority; a price that moved since it was shown is
      // refused.
      two.as(owner);
      const ownHere = await two.dishes.command({
        ...session,
        body: dish(soup.productReference, "Hot and sour soup (TEST)", "1000", "ThisStore", "950"),
      });
      assert.deepEqual(ownHere.price, {
        brandPriceMinor: "950",
        pendingBrandPriceMinor: null,
        storePriceMinor: "1000",
      });
      assert.equal(await price(store2, soup.skuReference), "10.00");
      assert.equal(await price(store1, soup.skuReference), "9.50");
      assert.equal(await menuDraft(), null);
      const recorded = await owned(
        "SELECT change_kind,previous_amount_minor::text p,amount_minor::text a,actor_id::text actor FROM rms_pricing.store_price_change WHERE brand_id=$1 AND store_id=$2 AND change_kind='StorePrice'",
        [brandReference, store2],
      );
      assert.deepEqual(recorded, [
        { change_kind: "StorePrice", p: "950", a: "1000", actor: owner },
      ]);
      await assert.rejects(
        two.dishes.command({
          ...session,
          body: dish(soup.productReference, "Hot and sour soup (TEST)", "1100", "ThisStore", "950"),
        }),
        (error) => error.code === "Changed",
      );
      // At Store 2 (its own price 10.00) the Owner changes the Brand price: Store 1 follows when
      // listed, Store 2 keeps its own (before, the edit there wrote 10.00 as every Store's price).
      await two.dishes.command({
        ...session,
        body: dish(soup.productReference, "Hot and sour soup (TEST)", "980", "AllStores", "950"),
      });
      await listAll();
      assert.equal(await price(store1, soup.skuReference), "9.80");
      assert.equal(await price(store2, soup.skuReference), "10.00");
      // An options-only save (no price) at Store 2 writes no price anywhere.
      const before = await owned(
        "SELECT count(*)::int n FROM rms_pricing.price_book WHERE brand_id=$1",
        [brandReference],
      );
      await two.dishes.command({
        ...session,
        body: {
          ...dish(soup.productReference, "Hot and sour soup (TEST)", null, null, null),
          nameZh: "酸辣汤",
        },
      });
      assert.deepEqual(
        await owned("SELECT count(*)::int n FROM rms_pricing.price_book WHERE brand_id=$1", [
          brandReference,
        ]),
        before,
      );
      // Without Brand Owner authority, a dish's price for every Store is refused at once.
      two.as(staff);
      await assert.rejects(
        two.dishes.command({
          ...session,
          body: {
            ...dish(soup.productReference, "Hot and sour soup (TEST)", "990", "AllStores", "980"),
            nameZh: "酸辣汤",
          },
        }),
        (error) => error.code === "NeedsBrandOwner",
      );
      two.as(owner);

      // 7. Why a draft was started is append-only.
      await assert.rejects(
        admin.query("UPDATE rms_pricing.price_book_draft_purpose SET purpose='PriceChange'"),
        (error) => error.code === "55000",
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_pricing.price_book_draft_purpose"),
        (error) => error.code === "55000",
      );
    } finally {
      await admin.end();
    }
  });
}, 300_000);
