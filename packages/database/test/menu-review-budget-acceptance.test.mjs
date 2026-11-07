import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

const session = { sessionCookie: "cookie", csrf: "csrf" };
/** As the page does it: a milk tea with fourteen toppings, any of them, its allergens declared. */
async function milkTeaWithFourteenToppings({ owner, reference }) {
  // Fourteen toppings, any of them: 16,384 distinct sets of choices, over the 10,000 one review
  // checks when each set is reviewed.
  const created = await owner.optionSets.command({
    ...session,
    body: {
      action: "Create",
      operationReference: reference(),
      name: "Toppings (TEST)",
      kind: "Any",
      minimum: 0,
      maximum: null,
      perOptionMaximum: 1,
      options: Array.from({ length: 14 }, (_, n) => ({
        optionReference: null,
        name: "Topping " + String(n + 1) + " (TEST)",
        offered: true,
        defaultChoice: false,
      })),
    },
  });
  const set = created.optionSet;
  const toppings = [
    {
      optionSetReference: set.optionSetReference,
      options: set.options.map((option) => ({
        optionReference: option.optionReference,
        amountMinor: "50",
      })),
    },
  ];
  // As the page does it: the drink first, then its toppings with its allergens declared (each
  // topping gets its "no change" recipe from the drink's). WP-2423 (M76, Owner decision 16): a
  // new dish is saved answered, here as declared (a charge with no stock ingredients).
  const drink = await owner.saveDish("Milk tea (TEST)", "奶茶", "550", null, "NoIngredients");
  await owner.saveDish(
    "Milk tea (TEST)",
    "奶茶",
    "550",
    drink.productReference,
    "NoIngredients",
    toppings,
  );
}

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: a drink whose many toppings each change its recipe has more
 * choice combinations than one menu review checks (each set of toppings is reviewed for what it
 * contains). "List it" found that out only at Submit, after the new prices and choice prices had
 * gone live, and showed the owner a code. Through the Owner's real commands under the restricted
 * role with the rendered pilot ACL: the listing is refused before anything of it goes live, with
 * the drink named, and nothing was published. The same drink whose toppings change nothing (the
 * one-page menu's "no change" recipes) is reviewed per option (WP-2423 item 3) and is listed.
 */
it("a menu over the review's budget is refused before any price goes live, the dish named", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_review_budget" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_rb");
      store = await prepareRealStaffRoundStore({ admin, context, api });
      const { owner, ownerScope, reference } = store;
      await milkTeaWithFourteenToppings(store);
      // Each topping adds a stock ingredient to the drink, as the Option recipes page saves it
      // (TEST-ONLY: every topping adds the Store's one synthetic stock item).
      const view = await owner.optionRecipes.query(session);
      const rows = view.options.filter((row) => row.productName === "Milk tea (TEST)");
      assert.equal(rows.length, 14);
      for (const row of rows) {
        const saved = await owner.optionRecipes.command({
          ...session,
          body: {
            action: "Save",
            operationReference: reference(),
            bindingReference: row.bindingReference,
            optionReference: row.optionReference,
            expectedVersion: row.change?.version ?? null,
            change: {
              kind: "Add",
              fromItemReference: null,
              toItemReference: owner.stockItemReference,
              quantity: "0.02",
              unitCostCents: null,
              lossPercent: "0",
            },
          },
        });
        for (const kind of ["Cost", "FoodSafety"])
          await owner.optionRecipes.command({
            ...session,
            body: {
              action: "Review",
              operationReference: reference(),
              changeVersionReference: saved.changeVersionReference,
              kind,
              decision: "Approved",
              comment: null,
              approvalMode: "SingleStoreListing",
            },
          });
        await owner.optionRecipes.command({
          ...session,
          body: {
            action: "Publish",
            operationReference: reference(),
            changeVersionReference: saved.changeVersionReference,
          },
        });
      }

      /** What has gone live for this Brand: price books, choice prices and Publishing records. */
      const live = async () =>
        (
          await admin.query(
            `SELECT
               (SELECT count(*) FROM rms_pricing.price_book_version WHERE brand_id=$1 AND lifecycle='Published')::int AS books,
               (SELECT count(*) FROM rms_pricing.option_price_rule_version WHERE brand_id=$1 AND lifecycle='Published')::int AS choices,
               (SELECT count(*) FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1)::int AS records`,
            [ownerScope.brandReference],
          )
        ).rows[0];
      const before = await live();
      const refused = await owner.listAll().then(
        () => null,
        (error) => error,
      );
      assert.ok(refused !== null, "the listing is refused");
      assert.equal(refused.code, "ReviewBlocked", String(refused));
      // One comparison, so a failure shows every difference at once.
      assert.deepEqual(
        {
          missing: refused.problem?.missing,
          productName: refused.problem?.productName,
          // A code for staff to pass on is what it said before.
          reason: refused.problem?.reason,
          // No price book, choice price or listing step went live.
          live: await live(),
        },
        {
          missing: "TooManyChoices",
          productName: "Milk tea (TEST)",
          reason: undefined,
          live: before,
        },
        "the drink is named and why, and nothing of the listing went live",
      );
      // Pressing again changes nothing either: the same answer, nothing published.
      const again = await owner.listAll().then(
        () => null,
        (error) => error,
      );
      assert.equal(again?.problem?.missing, "TooManyChoices");
      assert.deepEqual(await live(), before);
    } finally {
      await store?.close().catch(() => undefined);
      await admin.end();
    }
  });
});

it("the same milk tea whose fourteen toppings change nothing is listed: each option is reviewed once", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_budget_listed" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let store = null;
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_rl");
      store = await prepareRealStaffRoundStore({ admin, context, api });
      await milkTeaWithFourteenToppings(store);
      assert.equal((await store.owner.listAll()).status, "Listed");
    } finally {
      await store?.close().catch(() => undefined);
      await admin.end();
    }
  });
});
