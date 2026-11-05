import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createOneStoreMenuFixture } from "../test-support/one-store-menu-fixture.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

/**
 * WP-2423 item 3: what an owner setting up many drinks relies on, under the restricted NOBYPASSRLS
 * role with the rendered pilot API grants and a Store selected. A choice starts from the extra it
 * usually costs on this Brand's dishes; a choice group reaches another dish with no price and no
 * section sent; a choice with an allergen adds it to each dish's declaration.
 */
const groupOf = (set, amounts) => ({
  optionSetReference: set.optionSetReference,
  options: Object.entries(amounts).map(([optionReference, amountMinor]) => ({
    optionReference,
    amountMinor,
  })),
});
/** Every place in a published menu that describes this size. */
const sellablesOf = (value, sku, found = []) => {
  if (Array.isArray(value)) for (const item of value) sellablesOf(item, sku, found);
  else if (value !== null && typeof value === "object") {
    if (value.sellableReference === sku && value.allergenDisclosure !== undefined)
      found.push(value);
    for (const item of Object.values(value)) sellablesOf(item, sku, found);
  }
  return found;
};
const usualOf = async (f) =>
  (await f.optionPrices.query({ ...f.session, productReference: null, usual: true })).usual;

it("a choice's usual extra is what its current dishes charge, on this Brand only", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_setup_usual" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_su");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    const other = await createOneStoreMenuFixture(admin, context, { role, base: 1 });
    try {
      const set = await f.makeGroup("Toppings (TEST)", "Any", ["Pearls", "Pudding", "Foam"]);
      const [pearls, pudding, foam] = set.options.map((option) => option.optionReference);
      const save = (name, amounts) => f.saveDish({ name, choiceGroups: [groupOf(set, amounts)] });
      const a = await save("A (TEST)", { [pearls]: "80", [pudding]: "120" });
      const b = await save("B (TEST)", { [pearls]: "80", [pudding]: "130" });
      const c = await save("C (TEST)", { [pearls]: "90" });

      // The most used amount wins; a tie goes to the latest; a choice no dish has has none.
      let usual = await usualOf(f);
      assert.equal(usual[pearls], "80");
      assert.equal(usual[pudding], "130");
      assert.equal(usual[foam], undefined);

      // A waiting draft counts over the published price.
      await f.listAll();
      const edit = (dish, amounts) =>
        f.saveDish({
          productReference: dish.productReference,
          priceMinor: null,
          sectionCode: null,
          allergens: null,
          choiceGroups: [groupOf(set, amounts)],
        });
      await edit(a, { [pearls]: "100", [pudding]: "120" });
      await edit(b, { [pearls]: "100", [pudding]: "130" });
      assert.equal((await usualOf(f))[pearls], "100");

      // Another Store's own rule is no vote, however new and however many.
      const bindings = (
        await admin.query(
          "SELECT binding_id::text binding FROM rms_pricing.option_price_rule WHERE brand_id=$1 AND option_id=$2",
          [f.brandReference, pearls],
        )
      ).rows.map((row) => row.binding);
      assert.equal(bindings.length, 3);
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const [index, binding] of bindings.entries()) {
        const rule = f.id(0xb000 + index),
          version = f.id(0xb100 + index);
        await admin.query(
          "CREATE TEMP TABLE store_rule ON COMMIT DROP AS SELECT * FROM rms_pricing.option_price_rule WHERE brand_id=$1 AND binding_id=$2 AND option_id=$3",
          [f.brandReference, binding, pearls],
        );
        await admin.query(
          "CREATE TEMP TABLE store_version ON COMMIT DROP AS SELECT v.* FROM rms_pricing.option_price_rule_version v JOIN store_rule r ON v.option_price_rule_version_id=r.current_version_id",
        );
        await admin.query(
          "UPDATE store_version SET option_price_rule_version_id=$1,option_price_rule_id=$2,scope_kind='Store',scope_id=$3,unit_amount_minor=999,version_number=1",
          [version, rule, f.storeReference],
        );
        await admin.query(
          "UPDATE store_rule SET option_price_rule_id=$1,current_version_id=$2,draft_version_id=NULL,draft_author_actor_id=NULL,updated_at=now()",
          [rule, version],
        );
        await admin.query("INSERT INTO rms_pricing.option_price_rule SELECT * FROM store_rule");
        await admin.query(
          "INSERT INTO rms_pricing.option_price_rule_version SELECT * FROM store_version",
        );
        await admin.query("DROP TABLE store_rule,store_version");
      }
      await admin.query("COMMIT");
      assert.equal((await usualOf(f))[pearls], "100");
      // Seeded only for this question (Store-scoped option prices have no page yet).
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        "DELETE FROM rms_pricing.option_price_rule_version WHERE scope_kind='Store' AND brand_id=$1",
        [f.brandReference],
      );
      await admin.query(
        "DELETE FROM rms_pricing.option_price_rule WHERE option_price_rule_id=ANY($1::uuid[])",
        [bindings.map((_, index) => f.id(0xb000 + index))],
      );
      await admin.query("COMMIT");

      // A dish that stopped using the group no longer votes: without the two dishes at 100 ...
      await f.saveDish({
        productReference: a.productReference,
        priceMinor: null,
        sectionCode: null,
        allergens: null,
        choiceGroups: [],
      });
      await f.saveDish({
        productReference: b.productReference,
        priceMinor: null,
        sectionCode: null,
        allergens: null,
        choiceGroups: [],
      });
      usual = await usualOf(f);
      assert.equal(usual[pearls], "90", "a removed binding does not vote");
      assert.equal(usual[pudding], undefined);
      // ... and a dish that is archived does not either.
      await f.saveDish({
        productReference: c.productReference,
        priceMinor: null,
        sectionCode: null,
        allergens: null,
        choiceGroups: [groupOf(set, { [pearls]: "95" })],
      });
      assert.equal((await usualOf(f))[pearls], "95");
      await admin.query(
        "UPDATE rms_catalog.product SET lifecycle='Archived' WHERE brand_id=$1 AND product_id=$2",
        [f.brandReference, c.productReference],
      );
      assert.equal((await usualOf(f))[pearls], undefined, "an archived product does not vote");

      // Another Brand sees none of it.
      assert.deepEqual(await usualOf(other), {});
    } finally {
      await other.close();
      await f.close();
      await admin.end();
    }
  });
});

it("cheese foam with milk applied to three drinks: each declares milk, its price and place stay, and guests see it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_setup_apply" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_sa");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const set = await f.makeGroup("Toppings (TEST)", "Any", ["Pearls", "Cheese foam"]);
      const [pearls, foam] = set.options.map((option) => option.optionReference);
      const { wheat, milk } = f.allergenList;
      const wheatOnly = [{ allergenReference: wheat, classification: "Contains" }];
      const drinks = [];
      for (const name of ["One", "Two", "Three"])
        drinks.push(
          await f.saveDish({
            name: name + " (TEST)",
            priceMinor: "550",
            choiceGroups: [groupOf(set, { [pearls]: "80" })],
            allergens: wheatOnly,
          }),
        );
      await f.listAll();
      const readPrices = () =>
        admin.query(
          "SELECT sellable_id::text sku,amount_minor::text amount FROM rms_pricing.price_entry WHERE brand_id=$1 ORDER BY 1,2",
          [f.brandReference],
        );
      const pricesBefore = (await readPrices()).rows;
      const placedBefore = (await f.menus.query({ ...f.session, menuReference: f.menuReference }))
        .menu.sections;

      // As "Use on other dishes" sends each one: no price, no section, its own names and extras.
      for (const [index, drink] of drinks.entries())
        await f.saveDish({
          productReference: drink.productReference,
          name: ["One", "Two", "Three"][index] + " (TEST)",
          priceMinor: null,
          sectionCode: null,
          choiceGroups: [groupOf(set, { [pearls]: "80", [foam]: "150" })],
          allergens: [...wheatOnly, { allergenReference: milk, classification: "Contains" }],
        });
      assert.deepEqual((await readPrices()).rows, pricesBefore, "no price is written");
      const placedAfter = (await f.menus.query({ ...f.session, menuReference: f.menuReference }))
        .menu.sections;
      assert.deepEqual(
        placedAfter.map((section) => section.items.map((item) => item.skuReference)),
        placedBefore.map((section) => section.items.map((item) => item.skuReference)),
        "no dish moves",
      );
      await f.listAll();

      // What the guest menu is read from names milk on each drink now.
      const published = (
        await admin.query(
          "SELECT snapshot_json snapshot FROM rms_catalog.menu_review_content WHERE brand_id=$1",
          [f.brandReference],
        )
      ).rows
        .map((row) => row.snapshot)
        .find((snapshot) => JSON.stringify(snapshot).includes(foam));
      assert.notEqual(published, undefined);
      for (const drink of drinks) {
        const [entry] = sellablesOf(published, drink.skuReference);
        assert.notEqual(entry, undefined, "the drink is in the listed menu");
        const named = JSON.stringify(entry);
        assert.ok(named.includes(milk), "its allergens name milk");
        assert.ok(named.includes(wheat), "and what it declared before");
      }
    } finally {
      await f.close();
      await admin.end();
    }
  });
});
