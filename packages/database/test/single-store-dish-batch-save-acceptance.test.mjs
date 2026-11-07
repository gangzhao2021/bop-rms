import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout } from "node:timers";
import pg from "pg";
import { it } from "vitest";
import { menuOptionsWithoutRecipes } from "../../../apps/api/src/menu-option-gates.ts";
import { MerchantOneStoreDishError } from "../../../apps/api/src/merchant-one-store-dishes.ts";
import {
  createPostgresRecipeModifierSource,
  createPostgresSubmissionRecipeDemandSource,
  listOptionRecipeChanges,
  optionRecipeCovered,
  optionRecipesCovered,
} from "../../rms/recipe/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createOneStoreMenuFixture,
  menuOwnerGrants,
  isRecipeFenceTake,
} from "../test-support/one-store-menu-fixture.mjs";
import {
  createPilotApiRole,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
/** What each run measured, printed at the end of its case (a passing case's output is not shown). */
const measured = [];
const printMeasured = () => process.stdout.write(measured.splice(0).join("\n") + "\n");

/**
 * WP-2423 item 3 (speed): saving a drink with 4 choice groups and 19 choices took 15-20 s, 81 % of it
 * one full command per step per choice for its "no change" option recipes. Under the restricted
 * NOBYPASSRLS role with the rendered pilot API grants, through the real one-page menu commands and
 * the real tenant transaction runner: the same records in a few transactions; a retry and a failure
 * part-way continue without duplicates; a dish whose allergens are not declared yet saves and is
 * covered later; a second store still refuses; one merchant's save mid-write holds neither another
 * merchant's save nor its guests, its own guests wait for the whole change (DEC-MERCHANT-LOCK-SCOPE),
 * and a page's Publish beside a batch queues instead of deadlocking.
 */
const toppingNames = [
  "Pearls",
  "Pudding",
  "Coconut jelly",
  "Grass jelly",
  "Red bean",
  "Aloe",
  "Oat",
  "Foam",
];
const drinkGroups = async (f) => ({
  size: await f.makeGroup("Size (TEST)", "One", ["Medium", "Large"], { minimum: 1 }),
  sugar: await f.makeGroup("Sugar (TEST)", "One", ["0%", "30%", "50%", "70%", "100%"], {
    minimum: 1,
  }),
  ice: await f.makeGroup("Ice (TEST)", "One", ["No ice", "Less", "Regular", "Extra"], {
    minimum: 1,
  }),
  // A Quantity group: 2 rules per choice.
  toppings: await f.makeGroup("Toppings (TEST)", "Quantity", toppingNames, {
    maximum: 6,
    perOptionMaximum: 2,
  }),
});
const choiceGroups = (groups) =>
  Object.values(groups).map((set) => ({
    optionSetReference: set.optionSetReference,
    options: set.options.map((option) => ({
      optionReference: option.optionReference,
      amountMinor: "80",
    })),
  }));
const recordsOf = async (admin, brand) => {
  const n = async (sql) => (await admin.query(sql, [brand])).rows[0].n;
  return {
    changes: await n(
      "SELECT count(*)::int n FROM rms_recipe.option_recipe_change WHERE brand_id=$1",
    ),
    reviews: await n(
      "SELECT count(*)::int n FROM rms_recipe.option_recipe_change_review WHERE brand_id=$1",
    ),
    publications: await n(
      "SELECT count(*)::int n FROM rms_recipe.option_recipe_change_publication WHERE brand_id=$1",
    ),
    drafts: await n(
      "SELECT count(*)::int n FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND lifecycle='Draft'",
    ),
    rules: await n(
      "SELECT count(*)::int n FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND lifecycle='Published'",
    ),
    products: await n("SELECT count(*)::int n FROM rms_catalog.product WHERE brand_id=$1"),
  };
};
const auditCounts = async (admin, brand) =>
  Object.fromEntries(
    (
      await admin.query(
        "SELECT action_code,count(*)::int n FROM platform_audit.audit_record WHERE brand_id=$1 AND action_code LIKE 'RECIPE_%' GROUP BY 1",
        [brand],
      )
    ).rows.map((row) => [row.action_code, row.n]),
  );
const deadlocks = async (admin) => {
  // The counter is flushed when a backend goes idle.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return (
    await admin.query(
      "SELECT deadlocks::int n FROM pg_stat_database WHERE datname=current_database()",
    )
  ).rows[0].n;
};

it("a 19-choice drink saves in a few transactions with the same records; retries, failures and late allergens continue", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_batch_main" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_bs");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const groups = await drinkGroups(f);
      const allGroups = choiceGroups(groups);

      // 1. One save: at most 20 transactions (one command per step per choice took at least 111).
      f.counts.transactions = 0;
      f.counts.statements = 0;
      f.counts.holds.length = 0;
      const operation = f.op();
      const started = performance.now();
      const saved = await f.saveDish({ operationReference: operation, choiceGroups: allGroups });
      const elapsed = Math.round(performance.now() - started);
      measured.push(
        `19 choices (27 rules): ${elapsed} ms, ${f.counts.transactions} transactions, ${f.counts.statements} statements, holds ${f.counts.holds
          .map((ms) => Math.round(ms))
          .join("/")} ms`,
      );
      assert.ok(
        f.counts.transactions <= 20,
        "transactions " + f.counts.transactions + " (at most 20)",
      );
      assert.equal(saved.status, "Saved");
      assert.equal(saved.choicesWaiting, false);

      // 2. The same records as the commands one at a time, marked and audited the same.
      const first = await recordsOf(admin, f.brandReference);
      assert.deepEqual(first, {
        changes: 19,
        reviews: 38,
        publications: 19,
        drafts: 27,
        rules: 27,
        products: 1,
      });
      assert.deepEqual(
        (
          await admin.query(
            "SELECT DISTINCT review_mode,listing_store_id::text store,reviewer_actor_id::text reviewer FROM rms_recipe.option_recipe_change_review WHERE brand_id=$1",
            [f.brandReference],
          )
        ).rows,
        [{ review_mode: "SingleStoreListing", store: f.storeReference, reviewer: f.owner }],
      );
      const audit = await auditCounts(admin, f.brandReference);
      assert.equal(audit.RECIPE_OPTION_CHANGE_SAVED, 19);
      assert.equal(audit.RECIPE_OPTION_CHANGE_REVIEWED, 38);
      assert.equal(audit.RECIPE_OPTION_CHANGE_PUBLISHED, 19);
      assert.equal(audit.RECIPE_MODIFIER_DRAFT, 27);
      assert.equal(audit.RECIPE_MODIFIER_PUBLISHED, 27);
      assert.equal(f.counts.holds.length, 3, "11 single choices, then 12 rules, then the rest");

      // 3. The same operation again writes nothing new.
      await f.saveDish({ operationReference: operation, choiceGroups: allGroups });
      assert.deepEqual(await recordsOf(admin, f.brandReference), first);
      assert.deepEqual(await auditCounts(admin, f.brandReference), audit);

      // 4. A failure in the second round: what was saved stays, the failure says which dish, and
      // the form's save again (that dish, a fresh operation) finishes it with no duplicates.
      let inserted = 0;
      f.hooks.beforeStatement = async (sql) => {
        if (sql.startsWith("INSERT INTO rms_recipe.option_recipe_change(")) {
          inserted += 1;
          if (inserted === 13) throw new Error("TEST injected failure");
        }
      };
      const interrupted = await f
        .saveDish({ name: "Taro milk tea (TEST)", nameZh: "芋头奶茶", choiceGroups: allGroups })
        .catch((error) => error);
      f.hooks.beforeStatement = null;
      assert.ok(interrupted instanceof MerchantOneStoreDishError, String(interrupted));
      assert.equal(interrupted.code, "StoppedPartWay");
      assert.ok(interrupted.productReference, "the failure names the dish");
      const stopped = await recordsOf(admin, f.brandReference);
      assert.equal(stopped.products, 2);
      assert.ok(stopped.changes > 19 && stopped.changes < 38, "round one stands");
      const finished = await f.saveDish({
        productReference: interrupted.productReference,
        name: "Taro milk tea (TEST)",
        nameZh: "芋头奶茶",
        choiceGroups: allGroups,
      });
      assert.equal(finished.productReference, interrupted.productReference);
      assert.deepEqual(await recordsOf(admin, f.brandReference), {
        changes: 38,
        reviews: 76,
        publications: 38,
        drafts: 54,
        rules: 54,
        products: 2,
      });

      // 5. WP-2423 (M76, Owner decision 16): a new dish with its allergens unanswered is not
      // saved, and nothing is written. Answered, it saves and its choices are covered at once.
      const before = await recordsOf(admin, f.brandReference);
      await assert.rejects(
        f.saveDish({
          name: "Mango slush (TEST)",
          nameZh: "芒果冰沙",
          allergens: null,
          choiceGroups: allGroups,
        }),
        (error) => error.code === "AllergensUnanswered" || assert.fail(String(error.code)),
      );
      assert.deepEqual(await recordsOf(admin, f.brandReference), before);
      const declared = await f.saveDish({
        name: "Mango slush (TEST)",
        nameZh: "芒果冰沙",
        allergens: [{ allergenReference: f.allergenList.milk, classification: "Contains" }],
        choiceGroups: allGroups,
      });
      assert.equal(declared.choicesWaiting, false);
      assert.equal((await recordsOf(admin, f.brandReference)).changes, 57);

      // 8. Nothing waits at the menu's gate, List it passes, and orders resolve the rules.
      const view = await f.menus.query({ ...f.session, menuReference: f.menuReference });
      const missing = await f.asApi((tx) =>
        menuOptionsWithoutRecipes(tx, {
          owner: { brandReference: f.brandReference, storeReference: f.storeReference },
          observedAt: new Date().toISOString(),
          menu: {
            sections: view.menu.sections.map((section) => ({
              placements: section.items.map((item) => ({ sellableReference: item.skuReference })),
            })),
          },
        }),
      );
      assert.deepEqual(missing, []);
      assert.equal((await f.listAll()).status, "Listed");
      const snapshot = (
        await admin.query(
          "SELECT v.snapshot_json snapshot FROM rms_recipe.recipe_scope_binding b JOIN rms_recipe.recipe_version v ON v.recipe_version_id=b.recipe_version_id WHERE b.brand_id=$1 AND b.sku_id=$2",
          [f.brandReference, saved.skuReference],
        )
      ).rows[0].snapshot;
      const binding = (await f.optionRecipes.query(f.session)).options.find(
        (row) =>
          row.optionReference === groups.toppings.options[0].optionReference &&
          row.sizes.some((size) => size.skuReference === saved.skuReference),
      ).bindingReference;
      const [rule] = await createPostgresRecipeModifierSource({
        run: (work) => f.asApi(work),
      }).resolve(
        snapshot,
        [
          {
            bindingReference: binding,
            optionReference: groups.toppings.options[0].optionReference,
            quantity: 2,
          },
        ],
        new Date().toISOString(),
      );
      assert.deepEqual(rule.changes, []);
    } finally {
      printMeasured();
      await f.close();
      await admin.end();
    }
  });
});

it("one merchant's choice recipe save holds neither another merchant's save nor its guests; its own guests wait for the whole change; a page's Publish does not deadlock with a batch", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_batch_locks" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_bl");
    const a = await createOneStoreMenuFixture(admin, context, { role, base: 0 });
    const b = await createOneStoreMenuFixture(admin, context, { role, base: 1 });
    // Whatever goes wrong, no paused transaction outlives the test.
    let release = () => undefined;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    let unblock = () => undefined;
    const unblocked = new Promise((resolve) => {
      unblock = resolve;
    });
    /** A guest's order or kitchen intake of one merchant's recipe, as the restricted API role. */
    const guestRead = (f) =>
      f.asApi(async (tx) => {
        await createPostgresSubmissionRecipeDemandSource(
          { run: (work) => work(tx) },
          f.brandReference,
        )
          .resolve({
            storeReference: f.storeReference,
            skuReference: f.id(900),
            occurredAt: new Date().toISOString(),
            saleUnitCode: "EACH",
            unitQuantity: "1",
            saleQuantity: 1,
            selections: [],
          })
          .catch(() => undefined);
        // What the guest then reads of the merchant's option recipes, under the fence it holds.
        return (
          await tx.query(
            "SELECT count(*)::int n FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1",
            [f.brandReference],
          )
        ).rows[0].n;
      });
    const rulesOf = async (f) =>
      (
        await admin.query(
          "SELECT count(*)::int n FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1",
          [f.brandReference],
        )
      ).rows[0].n;
    const fenceWaiters = async () =>
      (
        await admin.query(
          "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
        )
      ).rows[0].n;
    const untilFenceWaiter = async () => {
      for (let i = 0; i < 400; i += 1) {
        if ((await fenceWaiters()) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.fail("no one came to wait for the recipe fence");
    };
    try {
      // Both dishes exist with their allergens declared, so the next save only covers choices
      // (declaring allergens takes the recipe fence too, and would wait at the same place).
      const sugarOf = async (f) => ({
        sugar: await f.makeGroup("Sugar (TEST)", "One", ["0%", "30%", "50%", "70%", "100%"], {
          minimum: 1,
        }),
      });
      const aGroups = choiceGroups(await sugarOf(a));
      const bGroups = choiceGroups(await sugarOf(b));
      const aDish = await a.saveDish({ name: "Oolong (TEST)" });
      const bDish = await b.saveDish({ name: "Pu-erh (TEST)" });
      const deadlocksBefore = await deadlocks(admin);
      const aRulesBefore = await rulesOf(a);

      // A stops half-way through writing its choices' recipe rules, holding what it took.
      let paused = false;
      a.hooks.afterStatement = async (sql) => {
        if (!paused && sql.startsWith("INSERT INTO rms_recipe.recipe_modifier_version")) {
          paused = true;
          await released;
        }
      };
      const first = a.saveDish({
        productReference: aDish.productReference,
        name: "Oolong (TEST)",
        allergens: null,
        choiceGroups: aGroups,
      });
      let aSettled = false;
      first.then(
        () => (aSettled = true),
        () => (aSettled = true),
      );
      while (!paused) await new Promise((resolve) => setTimeout(resolve, 5));

      // (a) Another merchant's save and its guests go straight through while A is still writing.
      const bStarted = performance.now();
      const second = b.saveDish({
        productReference: bDish.productReference,
        name: "Pu-erh (TEST)",
        allergens: null,
        choiceGroups: bGroups,
      });
      const bOutcome = await Promise.race([
        second.then(
          (saved) => saved.status,
          (error) => "failed " + (error?.code ?? error),
        ),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 4000)),
      ]);
      const bWaited = Math.round(performance.now() - bStarted);
      measured.push(
        "another merchant's save beside a held one: " + bOutcome + " in " + bWaited + " ms",
      );
      assert.equal(bOutcome, "Saved", "another merchant's save waited for A's");
      // A's transaction is still open mid-write (its runner's limits would end it after a few s).
      assert.equal(aSettled, false, "another merchant's save finished only after A's ended");
      const bGuestAsked = performance.now();
      const bGuestRules = await guestRead(b);
      const bGuestWaited = Math.round(performance.now() - bGuestAsked);
      measured.push("another merchant's guest read beside a held save: " + bGuestWaited + " ms");
      assert.ok(bGuestWaited < 500, "the other merchant's guest waited " + bGuestWaited + " ms");
      assert.equal(bGuestRules, await rulesOf(b));

      // (b) A's own guest waits for A's change and then reads all of it, never a part.
      assert.equal(await fenceWaiters(), 0);
      const aGuestAsked = performance.now();
      const aGuest = guestRead(a);
      await untilFenceWaiter();
      release();
      const aGuestRules = await aGuest;
      const aGuestWaited = Math.round(performance.now() - aGuestAsked);
      measured.push("the merchant's own guest behind its held save waited " + aGuestWaited + " ms");
      a.hooks.afterStatement = null;
      const one = await first;
      assert.equal(one.status, "Saved");
      const aRulesAfter = await rulesOf(a);
      assert.ok(aRulesAfter > aRulesBefore, "A's save wrote its rules");
      // The guest asked while A had written part of its rules: it waited for A's commit and read
      // A's change, not the rules from before it beside a change still being written.
      assert.ok(
        aGuestRules > aRulesBefore && aGuestRules <= aRulesAfter,
        "the guest read " + aGuestRules + " rules of " + aRulesBefore + "→" + aRulesAfter,
      );
      assert.equal((await recordsOf(admin, a.brandReference)).publications, 5);
      assert.equal((await recordsOf(admin, b.brandReference)).publications, 5);

      // A page's single Publish, against a batch of the same merchant (each takes the fence first).
      const made = await a.makeGroup("Spice (TEST)", "One", ["Mild", "Hot"], { minimum: 1 });
      const spice = {
        optionSetReference: made.optionSetReference,
        options: made.options.map((option) => ({
          optionReference: option.optionReference,
          amountMinor: "0",
        })),
      };
      // A dish whose first save stops at its choices, so the page can do the steps by hand.
      a.hooks.beforeStatement = async (sql) => {
        if (sql.startsWith("INSERT INTO rms_recipe.option_recipe_change("))
          throw new Error("TEST stop before the choices");
      };
      const stopped = await a
        .saveDish({ name: "Soup (TEST)", nameZh: "汤", choiceGroups: [spice] })
        .catch((error) => error);
      a.hooks.beforeStatement = null;
      assert.ok(stopped.productReference);
      const row = (await a.optionRecipes.query(a.session)).options.find(
        (candidate) => candidate.optionReference === made.options[0].optionReference,
      );
      const noChange = {
        kind: "NoChange",
        fromItemReference: null,
        toItemReference: null,
        quantity: null,
        unitCostCents: null,
        lossPercent: "0",
      };
      const change = await a.optionRecipes.command({
        ...a.session,
        body: {
          action: "Save",
          operationReference: a.op(),
          bindingReference: row.bindingReference,
          optionReference: row.optionReference,
          expectedVersion: null,
          change: noChange,
        },
      });
      for (const kind of ["Cost", "FoodSafety"])
        await a.optionRecipes.command({
          ...a.session,
          body: {
            action: "Review",
            operationReference: a.op(),
            changeVersionReference: change.changeVersionReference,
            kind,
            decision: "Approved",
            comment: null,
            approvalMode: "SingleStoreListing",
          },
        });
      const aIce = choiceGroups({
        ice: await a.makeGroup("Ice (TEST)", "One", ["No ice", "Less", "Regular"], { minimum: 1 }),
      });
      let holding = false;
      a.hooks.afterStatement = async (sql, values) => {
        if (!holding && isRecipeFenceTake(sql, values, a.brandReference)) {
          holding = true;
          await unblocked;
        }
      };
      const batch = a.saveDish({
        name: "Plum tea (TEST)",
        nameZh: "梅子茶",
        choiceGroups: aIce,
      });
      while (!holding) await new Promise((resolve) => setTimeout(resolve, 5));
      a.hooks.afterStatement = null;
      const page = a.optionRecipes.command({
        ...a.session,
        body: {
          action: "Publish",
          operationReference: a.op(),
          changeVersionReference: change.changeVersionReference,
        },
      });
      await untilFenceWaiter();
      unblock();
      const [published, batched] = await Promise.all([page, batch]);
      assert.equal(published.status, "Applied");
      assert.equal(batched.status, "Saved");
      assert.equal(await deadlocks(admin), deadlocksBefore, "no deadlock on the way");
    } finally {
      printMeasured();
      release();
      unblock();
      await a.close();
      await b.close();
      await admin.end();
    }
  });
});

it("permissions, a second store, a sole operator's reviews, 20 of each, the clock and many bound sizes", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_batch_rules" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_br");
    const manager = "01909b00-0000-7000-8000-000000000005";
    const f = await createOneStoreMenuFixture(admin, context, {
      role,
      otherActors: {
        [manager]: menuOwnerGrants.filter(
          (action) => !["recipe.update", "recipe.approve", "recipe.publish"].includes(action),
        ),
      },
    });
    try {
      const made = await f.makeGroup("Spice (TEST)", "One", ["Mild", "Hot"], { minimum: 1 });
      const spice = {
        optionSetReference: made.optionSetReference,
        options: made.options.map((option) => ({
          optionReference: option.optionReference,
          amountMinor: "0",
        })),
      };
      const dish = await f.saveDish({ name: "Noodles (TEST)", choiceGroups: [spice] });

      // A menu manager holds recipe.read only. Re-saving a dish whose choices are covered needs no
      // more than that; a choice that needs work is refused, with nothing written.
      f.grants.as(manager);
      const asEdited = {
        productReference: dish.productReference,
        name: "Dan dan noodles (TEST)",
        priceMinor: null,
        sectionCode: null,
        allergens: null,
      };
      const renamed = await f.saveDish({ ...asEdited, choiceGroups: [spice] });
      assert.equal(renamed.status, "Saved");
      const records = await recordsOf(admin, f.brandReference);
      const other = await f.makeGroup("Rice (TEST)", "One", ["Steamed", "Fried"]);
      const rice = {
        optionSetReference: other.optionSetReference,
        options: other.options.map((option) => ({
          optionReference: option.optionReference,
          amountMinor: "150",
        })),
      };
      await assert.rejects(f.saveDish({ ...asEdited, choiceGroups: [spice, rice] }), {
        code: "PermissionDenied",
        productReference: dish.productReference,
      });
      assert.deepEqual(await recordsOf(admin, f.brandReference), records);
      f.grants.as(f.owner);

      // Reviews given alone as sole operator, not published yet: a dish save publishes them.
      await seedSoleOperatorSetting(admin, {
        id: f.id,
        n: 900,
        tenantReference: f.tenantReference,
        brandReference: f.brandReference,
        actorReference: f.owner,
        state: "On",
        version: 1,
      });
      await seedStepUp(admin, {
        id: f.id,
        n: 910,
        brandReference: f.brandReference,
        storeReference: f.storeReference,
        actorReference: f.owner,
      });
      const row = (await f.optionRecipes.query(f.session)).options.find(
        (candidate) => candidate.optionReference === other.options[0].optionReference,
      );
      const change = await f.optionRecipes.command({
        ...f.session,
        body: {
          action: "Save",
          operationReference: f.op(),
          bindingReference: row.bindingReference,
          optionReference: row.optionReference,
          expectedVersion: null,
          change: {
            kind: "NoChange",
            fromItemReference: null,
            toItemReference: null,
            quantity: null,
            unitCostCents: null,
            lossPercent: "0",
          },
        },
      });
      for (const kind of ["Cost", "FoodSafety"])
        await f.optionRecipes.command({
          ...f.session,
          body: {
            action: "Review",
            operationReference: f.op(),
            changeVersionReference: change.changeVersionReference,
            kind,
            decision: "Approved",
            comment: null,
            approvalMode: "SoleOperator",
          },
        });
      await f.saveDish({ ...asEdited, choiceGroups: [spice, rice] });
      const covered = (await f.optionRecipes.query(f.session)).options
        .filter((candidate) => candidate.bindingReference === row.bindingReference)
        .map((candidate) => candidate.covered);
      assert.deepEqual(covered, [true, true]);

      // A choice with 20 rules goes alone, whatever the limit. Its hold is measured against the
      // guest's 2 s lock timeout (it is the longest a save holds; this host's round trips are slower
      // than the pilot's, so only a hold close to the statement limit fails here).
      const twenty = await f.makeGroup("Shots (TEST)", "Quantity", ["Espresso", "Honey"], {
        maximum: null,
        perOptionMaximum: 20,
      });
      f.counts.holds.length = 0;
      await f.saveDish({
        name: "Coffee (TEST)",
        choiceGroups: [
          {
            optionSetReference: twenty.optionSetReference,
            options: twenty.options.map((option) => ({
              optionReference: option.optionReference,
              amountMinor: "100",
            })),
          },
        ],
      });
      assert.equal(f.counts.holds.length, 2, "one transaction per choice of 20 rules");
      measured.push(
        "20 rules: " + f.counts.holds.map((ms) => Math.round(ms)).join("/") + " ms hold",
      );
      assert.ok(
        f.counts.holds.every((ms) => ms < 5000),
        "holds " + f.counts.holds.join(","),
      );

      // One instant per round, read before the lock: the database's clock_timestamp of each audit
      // record stays after it even when the API's clock runs 20 ms ahead (occurred_at<=recorded_at).
      f.clock.offsetMs = 20;
      f.hooks.beforeStatement = async (sql, values) => {
        if (isRecipeFenceTake(sql, values, f.brandReference))
          await new Promise((resolve) => setTimeout(resolve, 30));
      };
      const beforeRound = f.clock.nowCalls;
      f.counts.transactions = 0;
      const clockDish = await f.saveDish({ name: "Soy milk (TEST)", choiceGroups: [spice] });
      f.hooks.beforeStatement = null;
      f.clock.offsetMs = 0;
      assert.equal(clockDish.status, "Saved");
      assert.ok(f.clock.nowCalls > beforeRound);
      const stamps = await admin.query(
        `SELECT DISTINCT c.recorded_at,p.published_at,r.reviewed_at FROM rms_recipe.option_recipe_change c
         JOIN rms_recipe.option_recipe_change_review r USING (change_version_id,brand_id)
         JOIN rms_recipe.option_recipe_change_publication p USING (change_version_id,brand_id)
         JOIN rms_catalog.product_option_binding b ON b.binding_id=c.binding_id AND b.brand_id=c.brand_id
         WHERE c.brand_id=$1 AND b.product_id=$2`,
        [f.brandReference, clockDish.productReference],
      );
      assert.equal(stamps.rows.length, 1, "one instant for the round");
      const stamp = stamps.rows[0];
      assert.equal(stamp.recorded_at.getTime(), stamp.published_at.getTime());
      assert.equal(stamp.recorded_at.getTime(), stamp.reviewed_at.getTime());

      // Coverage of many sizes at once has the same answer as one at a time: more than 500 bound
      // sizes, half of them with their rules.
      const brand = f.brandReference;
      const { recipe, version } = (
        await admin.query(
          "SELECT recipe_id::text recipe,recipe_version_id::text version FROM rms_recipe.recipe_scope_binding WHERE brand_id=$1 AND sku_id=$2",
          [brand, dish.skuReference],
        )
      ).rows[0];
      const count = 520;
      await admin.query("SET session_replication_role = replica");
      const targets = [];
      try {
        for (let n = 0; n < count; n += 1) {
          const sku = f.id(0xb000 + n),
            binding = f.id(0xc000 + n),
            option = f.id(0xd000 + n);
          targets.push({
            bindingReference: binding,
            optionReference: option,
            skuReferences: [sku],
            quantities: [1],
          });
          await admin.query(
            "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,now()-interval '1 minute')",
            [f.id(0xe0000 + n), version, recipe, brand, sku],
          );
          if (n % 2 === 0)
            await admin.query(
              "INSERT INTO rms_recipe.recipe_modifier_version(rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,review_evidence_json,effective_from,operation_id,actor_id,audit_id,occurred_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,1,'Published',$8,$9::jsonb,'{}'::jsonb,now()-interval '1 minute',$10,$11,$12,now()-interval '1 minute')",
              [
                f.id(0xf0000 + n),
                f.id(0x100000 + n),
                brand,
                recipe,
                version,
                binding,
                option,
                "sha256:" + "b".repeat(64),
                JSON.stringify({
                  ruleReference: f.id(0x100000 + n),
                  ruleVersionReference: f.id(0xf0000 + n),
                  brandReference: brand,
                  recipeVersionReference: version,
                  ruleDigest: "sha256:" + "b".repeat(64),
                  selection: { bindingReference: binding, optionReference: option, quantity: 1 },
                  changes: [],
                }),
                f.id(0x110000 + n),
                f.owner,
                f.id(0x120000 + n),
              ],
            );
        }
      } finally {
        await admin.query("SET session_replication_role = origin");
      }
      const at = new Date().toISOString();
      const coverage = await f.asApi((tx) =>
        optionRecipesCovered(
          tx,
          { brandReference: brand, storeReference: f.storeReference },
          targets,
          at,
        ),
      );
      assert.equal(coverage.size, count);
      assert.equal(
        [...coverage.values()].filter((value) => value.covered).length,
        count / 2,
        "no size lost to a row limit",
      );
      for (const n of [0, 1, 500, 501, 518, 519]) {
        const one = await f.asApi((tx) =>
          optionRecipeCovered(
            tx,
            { brandReference: brand, storeReference: f.storeReference },
            targets[n],
            at,
          ),
        );
        assert.equal(coverage.get(targets[n]).covered, one, "target " + n);
      }
      // A target with no recipe bound is not covered and says so.
      const unbound = {
        bindingReference: f.id(0xdd00),
        optionReference: f.id(0xdd01),
        skuReferences: [f.id(0xdd02)],
        quantities: [1, 2],
      };
      const none = await f.asApi((tx) =>
        optionRecipesCovered(
          tx,
          { brandReference: brand, storeReference: f.storeReference },
          [unbound],
          at,
        ),
      );
      assert.deepEqual(none.get(unbound), {
        bound: false,
        covered: false,
        rules: 0,
      });
      assert.equal(
        (
          await f.asApi((tx) =>
            listOptionRecipeChanges(
              tx,
              { brandReference: brand, storeReference: f.storeReference },
              [unbound],
            ),
          )
        ).size,
        0,
      );

      // 6. A second store: a person who is not the Brand Owner gets NotSingleStore.
      await admin.query(
        "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'STORE_TWO','Synthetic STORE_TWO','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [f.id(0xdd10), f.brandReference, f.from],
      );
      await assert.rejects(f.saveDish({ name: "Plum tea (TEST)", choiceGroups: [spice] }), {
        code: "NotSingleStore",
      });
    } finally {
      printMeasured();
      await f.close();
      await admin.end();
    }
  });
});

it("one save reads about the same however long the menu is", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_batch_growth" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_bg");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      const size = await f.makeGroup("Size (TEST)", "One", ["Medium", "Large"], { minimum: 1 });
      const sugar = await f.makeGroup("Sugar (TEST)", "One", ["Half", "Full"], { minimum: 1 });
      const groups = choiceGroups({ size, sugar });
      const measure = async (name) => {
        f.counts.transactions = 0;
        f.counts.statements = 0;
        const started = performance.now();
        await f.saveDish({ name, choiceGroups: groups });
        return {
          ms: Math.round(performance.now() - started),
          transactions: f.counts.transactions,
          statements: f.counts.statements,
        };
      };
      const firstDrink = await measure("Drink 1 (TEST)");
      for (let n = 2; n <= 60; n += 1)
        await f.saveDish({ name: `Drink ${n} (TEST)`, choiceGroups: groups });
      const later = await measure("Drink 61 (TEST)");
      measured.push(
        "one save at 1 drink " +
          JSON.stringify(firstDrink) +
          ", at 61 drinks " +
          JSON.stringify(later),
      );
      assert.ok(later.transactions <= firstDrink.transactions, JSON.stringify(later));
      // What still grows: the whole price book and every section are rewritten by their commands.
      assert.ok(
        later.statements <= firstDrink.statements * 1.25,
        JSON.stringify({ firstDrink, later }),
      );
    } finally {
      printMeasured();
      await f.close();
      await admin.end();
    }
  });
});

it("thirty drinks of 19 choices can be listed: no choice changes them, so no set of choices uses the review budget", async () => {
  await withIsolatedDatabase(
    { caseId: "wp2423_batch_thirty", timeoutMs: 600_000 },
    async (context) => {
      const admin = new Client(context.clientConfig);
      await admin.connect();
      const role = await createPilotApiRole(admin, context, "wp2423_bt");
      const f = await createOneStoreMenuFixture(admin, context, { role });
      try {
        const groups = await drinkGroups(f);
        const all = choiceGroups(groups);
        const started = performance.now();
        for (let n = 1; n <= 30; n += 1)
          await f.saveDish({ name: `Drink ${n} (TEST)`, choiceGroups: all });
        const saving = Math.round(performance.now() - started);
        const listingStarted = performance.now();
        f.counts.transactions = 0;
        f.counts.statements = 0;
        assert.equal((await f.listAll()).status, "Listed");
        measured.push(
          `30 drinks of 19 choices: saved in ${saving} ms, listed in ${Math.round(
            performance.now() - listingStarted,
          )} ms, ${f.counts.transactions} transactions, ${f.counts.statements} statements`,
        );
        // No per-set disclosure is stored or served for a dish its choices do not change: guests get
        // the dish's own allergens, whatever they choose.
        const reviewed = await admin.query(
          "SELECT length(snapshot_json::text) size,snapshot_json::text LIKE '%choiceEvidence%' per_set FROM rms_catalog.menu_review_content WHERE brand_id=$1 ORDER BY size DESC LIMIT 1",
          [f.brandReference],
        );
        measured.push("the reviewed menu is " + reviewed.rows[0]?.size + " characters");
        assert.equal(reviewed.rows[0]?.per_set, false);
      } finally {
        printMeasured();
        await f.close();
        await admin.end();
      }
    },
  );
});

it("List it publishes 1,200 waiting choice prices, and the Option prices page reads them, each in its window", async () => {
  await withIsolatedDatabase(
    { caseId: "wp2423_batch_prices", timeoutMs: 600_000 },
    async (context) => {
      const admin = new Client(context.clientConfig);
      await admin.connect();
      const role = await createPilotApiRole(admin, context, "wp2423_bp");
      const f = await createOneStoreMenuFixture(admin, context, { role });
      try {
        const names = Array.from({ length: 20 }, (_, n) => "Choice " + (n + 1));
        const set = await f.makeGroup("Extras (TEST)", "Any", names);
        const groups = [
          {
            optionSetReference: set.optionSetReference,
            enabledOptionReferences: set.options.map((option) => option.optionReference),
          },
        ];
        for (let n = 1; n <= 60; n += 1) {
          const created = await f.products.command({
            ...f.session,
            body: {
              action: "Create",
              operationReference: f.op(),
              internalCode: "BULK-" + n,
              productType: "PreparedFood",
              name: "Bulk " + n + " (TEST)",
              taxClassificationReference: f.taxClass,
              sizes: [
                { skuReference: null, skuCode: "BULK-" + n + "-1", name: "Bulk " + n + " (TEST)" },
              ],
            },
          });
          const product = created.product;
          await f.products.command({
            ...f.session,
            body: {
              action: "SaveDraft",
              operationReference: f.op(),
              productReference: product.productReference,
              expectedAggregateVersion: product.aggregateVersion,
              name: product.name,
              nameZh: "",
              taxClassificationReference: f.taxClass,
              sizes: product.sizes.map((size) => ({
                skuReference: size.skuReference,
                skuCode: size.skuCode,
                name: size.name,
                nameZh: "",
              })),
              optionSets: groups,
              presentation: { description: "", descriptionZh: "", photo: null },
            },
          });
          const view = await f.optionPrices.query({
            ...f.session,
            productReference: product.productReference,
          });
          await f.optionPrices.command({
            ...f.session,
            productReference: product.productReference,
            body: {
              action: "SetPrices",
              operationReference: f.op(),
              prices: view.products[0].optionSets[0].options.map((option) => ({
                bindingReference: view.products[0].optionSets[0].bindingReference,
                optionReference: option.optionReference,
                amountMinor: "80",
                expectedAggregateVersion: null,
                replacesPending: false,
              })),
            },
          });
        }
        const waiting = await f.optionPrices.waiting(f.session);
        assert.equal(waiting.length, 1200);
        assert.ok(waiting.every((rule) => rule.byViewer));
        // The menu itself has to be listable.
        const started = performance.now();
        const beforeList = await f.saveDish({ name: "Plain tea (TEST)" });
        assert.equal(beforeList.status, "Saved");
        assert.equal((await f.listAll()).status, "Listed");
        measured.push(
          "1,200 choice prices listed in " + Math.round(performance.now() - started) + " ms",
        );
        assert.equal((await f.optionPrices.waiting(f.session)).length, 0);
        const read = performance.now();
        const page = await f.optionPrices.query(f.session);
        measured.push(
          "the Option prices page read them in " + Math.round(performance.now() - read) + " ms",
        );
        const rows = page.products.flatMap((product) =>
          product.optionSets.flatMap((optionSet) => optionSet.options),
        );
        assert.equal(rows.length, 1200);
        assert.ok(rows.every((row) => row.priceMinor === "80" && row.pending === null));
      } finally {
        printMeasured();
        await f.close();
        await admin.end();
      }
    },
  );
});

/** The group as Option sets saves it: each choice offered or not, its default as it was. */
const saveGroup = async (f, group, kind, limits, offered = () => true) =>
  (
    await f.optionSets.command({
      ...f.session,
      body: {
        action: "Save",
        operationReference: f.op(),
        optionSetReference: group.optionSetReference,
        expectedAggregateVersion: group.aggregateVersion,
        name: group.name,
        nameZh: "",
        kind,
        minimum: limits.minimum ?? 0,
        maximum: limits.maximum === undefined ? (kind === "One" ? 1 : null) : limits.maximum,
        perOptionMaximum: limits.perOptionMaximum ?? 1,
        options: group.options.map((option) => ({
          optionReference: option.optionReference,
          name: option.name,
          nameZh: "",
          offered: offered(option),
          defaultChoice: option.defaultChoice,
        })),
      },
    })
  ).optionSet;
const listingRecords = async (admin, brand) =>
  (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM rms_catalog.menu_publication_operation_record WHERE brand_id=$1) AS menus,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1) AS audits",
      [brand],
    )
  ).rows[0];

it("a default no longer offered is kept on Save dish and named on List it; offering it again lists", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_bdefault", timeoutMs: 600_000 }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = await createPilotApiRole(admin, context, "wp2423_bd");
    const f = await createOneStoreMenuFixture(admin, context, { role });
    try {
      // 1. "Serve": one of Hot or Iced, guests start with Hot; Iced is never the default.
      const serve = await f.makeGroup("Serve (TEST)", "One", ["Hot", "Iced"], { minimum: 1 });
      const groups = choiceGroups({ serve });
      const dish = await f.saveDish({ name: "Soy milk (TEST)", nameZh: "", choiceGroups: groups });
      assert.equal((await f.listAll()).status, "Listed");
      // 2. The hot machine is down: Option sets, "Offer Hot" unticked, saved.
      const hotOff = await saveGroup(f, serve, "One", { minimum: 1 }, (o) => o.name !== "Hot");
      // 3. WP-2423 (cart-unsellable-dishes): Save dish (a new description) is saved while Hot is
      // off, and the dish still starts with Hot (it is back tomorrow); it is never lost.
      const again = {
        productReference: dish.productReference,
        name: "Soy milk (TEST)",
        nameZh: "",
        description: "Fresh soy milk (TEST)",
      };
      await f.saveDish({ ...again, choiceGroups: groups });
      assert.deepEqual(
        (
          await admin.query(
            "SELECT o.stable_code FROM rms_catalog.product_option_binding b JOIN rms_catalog.product_option_binding_option x USING (binding_id) JOIN rms_catalog.option o ON o.option_id=x.option_id WHERE b.product_id=$1 AND x.default_quantity IS NOT NULL",
            [dish.productReference],
          )
        ).rows.map((row) => row.stable_code),
        ["HOT"],
      );
      // 4. List it says the same, and lists nothing: no publication, no record at all.
      // Something new to list: another dish.
      await f.saveDish({ name: "Warm water (TEST)", nameZh: "", priceMinor: "100" });
      const before = await listingRecords(admin, f.brandReference);
      await assert.rejects(f.listAll(), (error) => {
        assert.equal(error.name, "MerchantMenuError", String(error.name) + ":" + error.code);
        assert.equal(error.code, "ReviewBlocked");
        assert.equal(error.problem.reason, "ChoiceGroupDefault");
        assert.equal(error.problem.productName, "Soy milk (TEST)");
        assert.equal(error.problem.optionName, "Serve (TEST)");
        assert.equal(error.stoppedBy, null);
        return true;
      });
      assert.deepEqual(await listingRecords(admin, f.brandReference), before);
      // 5. Hot offered again: the dish saves and the menu lists.
      await saveGroup(f, hotOff, "One", { minimum: 1 });
      await f.saveDish({ ...again, choiceGroups: groups });
      assert.equal((await f.listAll()).status, "Listed");
    } finally {
      await f.close();
      await admin.end();
    }
  });
});

const publishedAt = async (admin, brand, quantity) =>
  (
    await admin.query(
      "SELECT count(*)::int n FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND lifecycle='Published' AND selected_quantity=$2",
      [brand, quantity],
    )
  ).rows[0].n;
/** The Option recipes page's row for a dish's choice. */
const choiceRow = async (f, productName, optionName) =>
  (await f.optionRecipes.query(f.session)).options.find(
    (row) => row.productName === productName && row.optionName === optionName,
  );
/** A person sets a real change under Option recipes, reviews it alone and publishes it. */
const setRealChange = async (f, row, itemReference) => {
  const saved = await f.optionRecipes.command({
    ...f.session,
    body: {
      action: "Save",
      operationReference: f.op(),
      bindingReference: row.bindingReference,
      optionReference: row.optionReference,
      expectedVersion: row.change?.version ?? null,
      change: {
        kind: "Add",
        fromItemReference: null,
        toItemReference: itemReference,
        quantity: "1",
        unitCostCents: null,
        lossPercent: "0",
      },
    },
  });
  for (const kind of ["Cost", "FoodSafety"])
    await f.optionRecipes.command({
      ...f.session,
      body: {
        action: "Review",
        operationReference: f.op(),
        changeVersionReference: saved.changeVersionReference,
        kind,
        decision: "Approved",
        comment: null,
        approvalMode: "SingleStoreListing",
      },
    });
  await f.optionRecipes.command({
    ...f.session,
    body: {
      action: "Publish",
      operationReference: f.op(),
      changeVersionReference: saved.changeVersionReference,
    },
  });
};

it("a choice group turned into a quantity of each: List it carries its no-change recipes over, never a real change", async () => {
  await withIsolatedDatabase(
    { caseId: "wp2423_bquantity", timeoutMs: 600_000 },
    async (context) => {
      const admin = new Client(context.clientConfig);
      await admin.connect();
      const role = await createPilotApiRole(admin, context, "wp2423_bq");
      const f = await createOneStoreMenuFixture(admin, context, { role });
      try {
        // 1. Half Sugar Tea: 36 drinks with Toppings ("choose several", one of each), and one
        // whose Pearls really adds something (set by a person under Option recipes).
        const toppings = await f.makeGroup("Toppings (TEST)", "Any", toppingNames);
        // Free toppings: this case is about recipes, not about publishing choice prices.
        const groups = choiceGroups({ toppings }).map((group) => ({
          ...group,
          options: group.options.map((option) => ({ ...option, amountMinor: "0" })),
        }));
        const drinks = 36;
        for (let n = 1; n <= drinks; n += 1)
          await f.saveDish({ name: `Drink ${n} (TEST)`, nameZh: "", choiceGroups: groups });
        const special = await f.saveDish({
          name: "Pearl special (TEST)",
          nameZh: "",
          choiceGroups: groups,
        });
        const firstSku = (
          await admin.query(
            "SELECT s.sku_id::text sku FROM rms_catalog.sku s JOIN rms_catalog.product_version v ON v.product_version_id=s.product_version_id WHERE s.brand_id=$1 AND v.localized_names_json->>'en-CA'='Drink 1 (TEST)'",
            [f.brandReference],
          )
        ).rows[0]?.sku;
        const item = (
          await admin.query(
            "SELECT inventory_item_id::text item FROM rms_recipe.staff_declared_allergen_source WHERE brand_id=$1 AND sku_id=$2",
            [f.brandReference, firstSku],
          )
        ).rows[0]?.item;
        assert.ok(item, "Drink 1 declared its allergens");
        await setRealChange(f, await choiceRow(f, "Pearl special (TEST)", "Pearls"), item);
        assert.equal((await f.listAll()).status, "Listed");
        assert.equal(await publishedAt(admin, f.brandReference, 2), 0);

        // 2. Option sets: Toppings becomes "a quantity of each", 2 of one, 3 in all.
        await saveGroup(f, toppings, "Quantity", { maximum: 3, perOptionMaximum: 2 });

        // 3. Saving the special again covers its "no change" toppings at 2, and leaves its real
        // Pearls change as it is (it was overwritten with "no change" before).
        await f.saveDish({
          productReference: special.productReference,
          name: "Pearl special (TEST)",
          nameZh: "",
          description: "With extra pearls (TEST)",
          choiceGroups: groups,
        });
        assert.equal(
          (await choiceRow(f, "Pearl special (TEST)", "Pearls")).change.content.kind,
          "Add",
        );
        assert.equal(await publishedAt(admin, f.brandReference, 2), 7);

        // 4. List it carries every "no change" topping of the 36 drinks to 2, then names the one
        // real change a person sets. Nothing is listed.
        const audit = await auditCounts(admin, f.brandReference);
        const menusBefore = await listingRecords(admin, f.brandReference);
        const started = performance.now();
        await assert.rejects(f.listAll(), (error) => {
          assert.equal(error.name, "MerchantMenuError", String(error.name) + ":" + error.code);
          assert.equal(error.code, "OptionRecipeMissing");
          assert.equal(error.problem.productName, "Pearl special (TEST)");
          assert.equal(error.problem.optionName, "Pearls");
          return true;
        });
        measured.push(
          `${drinks} drinks x 8 toppings carried to quantity 2 in ${Math.round(
            performance.now() - started,
          )} ms`,
        );
        assert.equal(await publishedAt(admin, f.brandReference, 2), drinks * 8 + 7);
        const grown = await auditCounts(admin, f.brandReference);
        for (const [code, n] of Object.entries(grown)) assert.ok(n >= (audit[code] ?? 0), code);
        assert.ok(
          Object.values(grown).reduce((a, b) => a + b, 0) >
            Object.values(audit).reduce((a, b) => a + b, 0) + drinks * 8,
          "each extension is audited",
        );
        assert.equal(
          (await listingRecords(admin, f.brandReference)).menus,
          menusBefore.menus,
          "nothing listed",
        );
        assert.equal(
          (await choiceRow(f, "Pearl special (TEST)", "Pearls")).change.content.kind,
          "Add",
        );

        // 5. The owner sets Pearls for 2 under Option recipes; List it lists.
        await setRealChange(f, await choiceRow(f, "Pearl special (TEST)", "Pearls"), item);
        assert.equal((await f.listAll()).status, "Listed");
        // 6. Listing again carries nothing over: everything is covered.
        const settled = await recordsOf(admin, f.brandReference);
        await f.listAll();
        assert.deepEqual(await recordsOf(admin, f.brandReference), settled);
      } finally {
        printMeasured();
        await f.close();
        await admin.end();
      }
    },
  );
});
