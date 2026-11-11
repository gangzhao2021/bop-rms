import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createOneStoreMenuFixture } from "../test-support/one-store-menu-fixture.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

/**
 * WP-2423 (v15 batch 5, menu-authoring-prices): what "List it" puts live is what its review shows.
 * Under the restricted NOBYPASSRLS role with the rendered pilot API grants, through the real
 * one-page menu composition at one Store:
 * 1. an extra (choice) price changed on a listed dish is in the review — the dish, the choice, from
 *    → to — and a new extra shows as new; once listed, nothing is waiting;
 * 2. saving a listed dish unchanged opens no menu draft (nothing "not listed yet" with nothing to
 *    list), while a changed name does;
 * 3. one Store: nothing is said about other Stores.
 * Fails at 0cf1e7a5: the menu read has no extra prices, and an unchanged save opens a draft.
 */
it("the review names each extra price waiting, and an unchanged save leaves the menu listed", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_review_extras" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_rx");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const set = await f.makeGroup("Add-ons (TEST)", "Any", ["Garlic (TEST)", "Egg (TEST)"]);
      const [garlic, egg] = set.options.map((option) => option.optionReference);
      const group = (amounts) => ({
        optionSetReference: set.optionSetReference,
        options: Object.entries(amounts).map(([optionReference, amountMinor]) => ({
          optionReference,
          amountMinor,
        })),
      });
      const noodles = await f.saveDish({
        name: "Dan dan noodles (TEST)",
        choiceGroups: [group({ [garlic]: "50" })],
      });
      await f.listAll();
      const view = () => f.menus.query({ ...f.session, menuReference: f.menuReference });
      const listed = async () => (await view()).listingStep === "Listed";
      assert.equal(await listed(), true);
      assert.deepEqual((await view()).choicePriceChanges, []);
      assert.equal((await view()).otherStores, null);

      // 2. The same dish saved again, nothing changed: the menu stays listed.
      const edit = (overrides) =>
        f.saveDish({
          productReference: noodles.productReference,
          name: "Dan dan noodles (TEST)",
          priceMinor: null,
          sectionCode: null,
          choiceGroups: [group({ [garlic]: "50" })],
          ...overrides,
        });
      const unchanged = await edit({});
      assert.equal(unchanged.listingNeeded, false);
      assert.equal(await listed(), true);

      // 1. Garlic +0.50 → +0.80 and a new Egg +1.20: the review names both.
      const changed = await edit({ choiceGroups: [group({ [garlic]: "80", [egg]: "120" })] });
      assert.equal(changed.listingNeeded, true);
      assert.equal(await listed(), false);
      const waiting = (await view()).choicePriceChanges;
      const sorted = [...waiting].sort((a, b) => a.optionName.localeCompare(b.optionName));
      assert.deepEqual(sorted, [
        {
          productReference: noodles.productReference,
          optionReference: egg,
          optionName: "Egg (TEST)",
          fromMinor: null,
          toMinor: "120",
        },
        {
          productReference: noodles.productReference,
          optionReference: garlic,
          optionName: "Garlic (TEST)",
          fromMinor: "50",
          toMinor: "80",
        },
      ]);
      await f.listAll();
      assert.equal(await listed(), true);
      assert.deepEqual((await view()).choicePriceChanges, []);

      // A new name waits for "List it" again.
      const renamed = await edit({
        name: "Dan dan noodles, spicy (TEST)",
        choiceGroups: [group({ [garlic]: "80", [egg]: "120" })],
      });
      assert.equal(renamed.listingNeeded, true);
      assert.equal(await listed(), false);
    } finally {
      await f.close();
      await admin.end();
    }
  });
}, 300_000);
