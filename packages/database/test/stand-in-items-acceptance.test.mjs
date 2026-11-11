import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createOneStoreMenuFixture } from "../test-support/one-store-menu-fixture.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";
import { createPostgresInventoryItemStore } from "../../rms/inventory/src/index.ts";
import { listSkusUsingItemsAt } from "../../rms/recipe/src/index.ts";

const { Client } = pg;

/**
 * WP-2423 (M169): the item standing for a dish's staff-declared allergens (DECL-, never stock) is
 * the Menu page's, not a supply item: it is not listed under Supply items, nor under Allergens
 * while its answer is current. The dishes a wasted item leaves short are named from the recipes in
 * effect here. Under the restricted NOBYPASSRLS role with the rendered pilot API grants.
 */
it("WP-2423 (M169): stand-in items stay off staff lists, and the dishes using an item are found", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_stand_in" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_si");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const { milk } = f.allergenList;
      const tart = await f.saveDish({
        name: "Custard tart (TEST)",
        nameZh: "蛋挞",
        allergens: [{ allergenReference: milk, classification: "Contains" }],
      });
      const standIn = (
        await admin.query(
          "SELECT item_id::text item,internal_code code FROM rms_inventory.inventory_item WHERE internal_code LIKE 'DECL-%'",
        )
      ).rows;
      assert.equal(standIn.length, 1, "saving the dish made its stand-in");
      // Supply items: the stand-in is not one (it was listed before).
      const supply = await f.asApi((tx) =>
        createPostgresInventoryItemStore(
          { run: (work) => work(tx) },
          { tenantReference: f.tenantReference, brandReference: f.brandReference },
        ).list({ search: null, lifecycle: null, afterInternalCode: null, limit: 50 }),
      );
      assert.equal(
        supply.items.some((item) => item.internalCode.startsWith("DECL-")),
        false,
      );
      // The dish whose recipe here uses the item is found (waste names it).
      assert.deepEqual(
        await f.asApi((tx) =>
          listSkusUsingItemsAt(
            tx,
            { brandReference: f.brandReference, storeReference: f.storeReference },
            [standIn[0].item],
          ),
        ),
        [tart.skuReference],
      );
    } finally {
      await f.close();
      await admin.end();
    }
  });
});
