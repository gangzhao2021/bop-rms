import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createOneStoreMenuFixture } from "../test-support/one-store-menu-fixture.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
import { createMerchantRecipes } from "../../../apps/api/src/merchant-recipes.ts";

const { Client } = pg;

/**
 * WP-2423 (M77, M167): a recipe bound to a listed dish changes what it contains at once (Inventory
 * uses the new recipe), so guests and the kitchen read the dish's allergens from it together with
 * the listed ones, and the owner is told to list again. Under the restricted NOBYPASSRLS role with
 * the rendered pilot API grants and the Store selected, through the real Recipes command.
 */
it("WP-2423 (M77, M167): a recipe bound after listing reaches guests at once, and listing again makes it the reviewed list", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_allergen_chg" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_ac");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const { milk } = f.allergenList;
      // A dish with no allergens and one with milk, both declared by staff, listed.
      const rice = await f.saveDish({ name: "Plain congee (TEST)", nameZh: "白粥", allergens: [] });
      const tart = await f.saveDish({
        name: "Custard tart (TEST)",
        nameZh: "蛋挞",
        allergens: [{ allergenReference: milk, classification: "Contains" }],
      });
      assert.equal((await f.listAll()).status, "Listed");
      const listedVersion = async () =>
        (
          await admin.query(
            "SELECT menu_version_id::text version FROM rms_catalog.menu_publication_release WHERE menu_id=$1 ORDER BY release_sequence DESC LIMIT 1",
            [f.menuReference],
          )
        ).rows[0].version;
      const guestSees = async () =>
        (
          await createCustomerMenuStoreFacts({
            transactions: { run: (work) => f.asApi(work) },
            currencyMetadata: f.currencyMetadata,
            priceChannelCode: "CUSTOMER_WEB",
          }).load({
            brandReference: f.brandReference,
            storeReference: f.storeReference,
            channelCode: "CUSTOMER_PWA",
            orderTypeCode: "DINE_IN",
            requestedAt: new Date().toISOString(),
            sellableReferences: [rice.skuReference],
            menuVersionReference: await listedVersion(),
          })
        ).get(rice.skuReference)?.allergenChange;
      const ownerSees = async () =>
        (await f.menus.query({ ...f.session, menuReference: f.menuReference })).sellables.find(
          (sku) => sku.skuReference === rice.skuReference,
        ).allergens.changedByRecipe;
      assert.equal(await guestSees(), undefined);
      assert.equal(await ownerSees(), undefined);

      // Under Recipes, the congee is given the tart's recipe (milk) for the whole Brand.
      const recipes = createMerchantRecipes({
        persistence: f.persistence,
        authentication: f.common.authentication,
        references: { next: f.op },
        locale: "en-CA",
        resolveScope: f.grants.resolveScope,
      });
      const tartRecipe = (
        await admin.query(
          "SELECT recipe_id::text recipe FROM rms_recipe.recipe_scope_binding b WHERE sku_id=$1 AND option_binding_id IS NULL AND NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_scope_binding_end e WHERE e.recipe_scope_binding_id=b.recipe_scope_binding_id)",
          [tart.skuReference],
        )
      ).rows[0].recipe;
      const bind = {
        action: "BindSku",
        operationReference: f.op(),
        recipeReference: tartRecipe,
        skuReference: rice.skuReference,
        storeOnly: false,
      };
      const bound = await recipes.command({ ...f.session, body: bind });
      assert.equal(bound.status, "Applied");
      assert.deepEqual(bound.allergensNow, { resolved: true, codes: ["MILK"] });
      // A retry of the same operation records nothing more.
      assert.equal((await recipes.command({ ...f.session, body: bind })).status, "AlreadyApplied");
      assert.equal(
        (await admin.query("SELECT count(*)::int n FROM rms_catalog.sellable_allergen_change"))
          .rows[0].n,
        1,
      );

      // Before, guests kept reading "no allergens" until someone listed the menu again.
      const change = await guestSees();
      assert.equal(change?.cause, "RecipeBound");
      assert.equal(change?.storeReference, null);
      assert.deepEqual(
        change?.allergens?.map((a) => [a.allergenReference, a.code, a.classification]),
        [[milk, "MILK", "Contains"]],
      );
      assert.equal(await ownerSees(), true);

      // The record is append-only.
      await assert.rejects(
        admin.query("UPDATE rms_catalog.sellable_allergen_change SET cause='RecipeEnded'"),
        /append-only sellable allergen change/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_catalog.sellable_allergen_change"),
        /append-only sellable allergen change/u,
      );

      // Listed again, the reviewed list names milk and the change no longer applies to it.
      const before = await listedVersion();
      assert.equal((await f.listAll()).status, "Listed");
      assert.notEqual(await listedVersion(), before, "a new menu version was listed");
      assert.equal(await guestSees(), undefined);
      assert.equal(await ownerSees(), undefined);
    } finally {
      await f.close();
      await admin.end();
    }
  });
});
