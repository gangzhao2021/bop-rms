import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: a milk tea shop's drink with many toppings has more choice
 * combinations than one menu review checks. "List it" found that out only at Submit, after the
 * new prices and choice prices had gone live, and showed the owner a code. Through the Owner's real
 * commands under the restricted role with the rendered pilot ACL: the listing is refused before
 * anything of it goes live, with the drink named, and nothing was published.
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
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      // Fourteen toppings, any of them: 16,384 distinct choices, over the 10,000 one review checks.
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
      // topping gets its "no change" recipe from the drink's).
      const drink = await owner.saveDish("Milk tea (TEST)", "奶茶", "550");
      await owner.saveDish(
        "Milk tea (TEST)",
        "奶茶",
        "550",
        drink.productReference,
        "NoIngredients",
        toppings,
      );

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
