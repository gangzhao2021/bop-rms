import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createOneStoreMenuFixture } from "../test-support/one-store-menu-fixture.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";
import {
  createCustomerMenuQueryService,
  createPostgresPublishedMenuQueryStore,
} from "../../rms/catalog/src/index.ts";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
import { publicFound } from "../../../apps/api/src/customer-menu.ts";

const { Client } = pg;

/**
 * WP-2423 (M166): a choice declares its own allergens on the Menu page (egg fried rice as the
 * rice choice adds egg). The listed menu then names egg for that choice, guests and the kitchen
 * read it when it is chosen, and the dish's own allergens are unchanged. Under the restricted
 * NOBYPASSRLS role with the rendered pilot API grants, through the real dish save and listing.
 */
it("WP-2423 (M166): a choice's own allergens reach the listed menu for that choice", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_choice_alg" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_ca");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const { milk, wheat } = f.allergenList;
      const set = await f.makeGroup("Rice (TEST)", "One", ["Plain rice", "Egg fried rice"], {
        minimum: 1,
      });
      const [plain, fried] = set.options.map((option) => option.optionReference);
      const choiceGroups = [
        {
          optionSetReference: set.optionSetReference,
          options: [
            { optionReference: plain, amountMinor: "0" },
            { optionReference: fried, amountMinor: "150" },
          ],
        },
      ];
      // The fixture's list has no egg: milk stands in for what egg fried rice adds.
      const dish = await f.saveDish({
        name: "Curry chicken (TEST)",
        nameZh: "咖喱鸡",
        choiceGroups,
        allergens: [{ allergenReference: wheat, classification: "Contains" }],
        choiceAllergens: [
          { optionReference: plain, name: "Plain rice", declared: [] },
          {
            optionReference: fried,
            name: "Egg fried rice",
            declared: [{ allergenReference: milk, classification: "Contains" }],
          },
        ],
      });
      assert.equal(dish.status, "Saved");
      // The choice's stand-in is never stock.
      const standIns = (
        await admin.query(
          "SELECT i.internal_code code,(v.snapshot_json->'trackingPolicy'->>'stockTrackingEnabled') tracked FROM rms_inventory.inventory_item i JOIN LATERAL (SELECT snapshot_json FROM rms_inventory.inventory_item_version x WHERE x.item_id=i.item_id ORDER BY version DESC LIMIT 1) v ON true WHERE i.internal_code LIKE 'DECL-OPT-%'",
        )
      ).rows;
      assert.deepEqual(
        standIns.map((row) => row.tracked),
        ["false", "false"],
      );
      assert.equal((await f.listAll()).status, "Listed");
      // The guest menu as the server sends it (the real projection and store facts, public form).
      const guestSees = async () => {
        const reader = { run: (work) => f.asApi(work) };
        const scope = { brandReference: f.brandReference, storeReference: f.storeReference };
        const result = await createCustomerMenuQueryService({
          stores: { resolvePublic: async () => ({ ...scope, status: "Active" }) },
          projections: createPostgresPublishedMenuQueryStore(reader, scope),
          storeFacts: createCustomerMenuStoreFacts({
            transactions: reader,
            currencyMetadata: f.currencyMetadata,
            priceChannelCode: "CUSTOMER_WEB",
          }),
        }).getPublishedMenu({
          publicStoreReference: "01a3ff00-0000-7000-8000-00000000eeee",
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "DINE_IN",
          locale: "en-CA",
          sectionReference: null,
          searchTerm: null,
          requestedAt: new Date().toISOString(),
        });
        assert.equal(result.status, "Found");
        const menu = JSON.parse(JSON.stringify(publicFound(result)));
        return menu.menu.sections
          .flatMap((section) => section.sellables)
          .find((sellable) => sellable.sellableReference === dish.skuReference)?.allergenDisclosure;
      };
      const disclosure = await guestSees();
      assert.ok(disclosure, "guests see the dish");
      const codes = (items) => (items ?? []).map((item) => item.code).sort();
      // Egg fried rice adds milk (standing in for egg); plain rice adds nothing; the dish keeps wheat.
      assert.deepEqual(codes(disclosure.byOption?.[fried]), ["MILK"]);
      // Plain rice adds nothing, so guests are not sent a list for it.
      assert.equal(disclosure.byOption?.[plain], undefined);
      assert.ok(codes(disclosure.items).includes("WHEAT"));
      // The dish's list names every allergen a choice can add (guests' menus name each one).
      assert.ok(codes(disclosure.items).includes("MILK"));

      // Staff later answer that egg fried rice adds nothing: listed again, it no longer does.
      await f.saveDish({
        productReference: dish.productReference,
        name: "Curry chicken (TEST)",
        nameZh: "咖喱鸡",
        priceMinor: null,
        sectionCode: null,
        allergens: null,
        choiceGroups,
        choiceAllergens: [{ optionReference: fried, name: "Egg fried rice", declared: [] }],
      });
      assert.equal((await f.listAll()).status, "Listed");
      const after = await guestSees();
      assert.equal(after.byOption?.[fried], undefined);
      assert.ok(!codes(after.items).includes("MILK"));

      // On the listed menu, staff now answer that egg fried rice adds milk (standing in for egg)
      // and nobody lists the menu again. Inventory uses the new choice recipe at once, so guests
      // read milk on the dish now, and the Menu page knows the allergens changed since listing.
      await f.saveDish({
        productReference: dish.productReference,
        name: "Curry chicken (TEST)",
        nameZh: "咖喱鸡",
        priceMinor: null,
        sectionCode: null,
        allergens: null,
        choiceGroups,
        choiceAllergens: [
          {
            optionReference: fried,
            name: "Egg fried rice",
            declared: [{ allergenReference: milk, classification: "Contains" }],
          },
        ],
      });
      const changes = (
        await admin.query(
          "SELECT cause,allergens_json allergens,choices_json choices FROM rms_catalog.sellable_allergen_change WHERE sku_id=$1 ORDER BY recorded_at DESC,change_id DESC",
          [dish.skuReference],
        )
      ).rows;
      assert.equal(changes[0]?.cause, "StaffDeclared");
      assert.deepEqual(codes(changes[0]?.allergens), ["MILK", "WHEAT"]);
      // b7: the change says which are the dish's own and what the choice adds.
      assert.deepEqual(codes(changes[0]?.choices?.dish), ["WHEAT"]);
      assert.deepEqual(Object.keys(changes[0]?.choices?.options ?? {}), [fried.slice(-12)]);
      const now = await guestSees();
      assert.ok(codes(now.items).includes("MILK"));
      // b7: guests read it under Egg fried rice at once, and with plain rice the dish is wheat only.
      assert.deepEqual(codes(now.byOption?.[fried]), ["MILK"]);
      assert.equal(now.byOption?.[plain], undefined);
      assert.equal(now.justUpdated, true);
      if (now.byChoice !== undefined) {
        const outcomeFor = (option) => {
          const at = now.byChoice.options.indexOf(option);
          const entry = now.byChoice.sets.find((set) => set.length === 2 && set[1] === at);
          return entry === undefined ? undefined : codes(now.byChoice.outcomes[entry[0]]);
        };
        assert.deepEqual(outcomeFor(plain), ["WHEAT"]);
        assert.deepEqual(outcomeFor(fried), ["MILK", "WHEAT"]);
      }
      // The record stays append-only for the api role.
      await assert.rejects(
        f.asApi((tx) =>
          tx.query("UPDATE rms_catalog.sellable_allergen_change SET choices_json=NULL", []),
        ),
      );
    } finally {
      await f.close();
      await admin.end();
    }
  });
});
