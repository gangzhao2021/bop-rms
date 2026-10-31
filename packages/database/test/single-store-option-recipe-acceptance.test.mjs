import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresRecipeModifierSource,
  parseOptionRecipeChangeContent,
  publishOptionRecipeChange,
  reviewOptionRecipeChange,
  saveOptionRecipeChange,
} from "../../rms/recipe/src/index.ts";
import { requireMerchantBrandSingleStore } from "../../../apps/api/src/merchant-sole-operator.ts";
import { publishEntryCartRecipe } from "../test-support/entry-cart-recipe-publication.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a5f-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7; coordinator condition 4),
 * as for recipes: at a Brand with one store, the author of an option-recipe change gives both
 * reviews alone when they list the dish, each marked SingleStoreListing with the store; publishing
 * re-reads that the Brand still has that one store. Restricted pilot API role; setup as the option
 * recipes acceptance:
 * 1. one store: both reviews alone, marked; published, and orders resolve the rule;
 * 2. someone without recipe approval cannot, even their own change;
 * 3. a second store (a draft one) refuses new marked reviews and the publication of marked
 *    reviews given before, and the database refuses the mark itself; archived, it is back.
 */
it("option recipe review: a single store's author reviews and publishes alone; no approval or a second store refuses", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_optrecipe" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_ssor_" + context.runId;
    const brand = id(2),
      store = id(3),
      author = id(4),
      costReviewer = id(5),
      safetyReviewer = id(6),
      publisher = id(7),
      sku = id(10),
      binding = id(20),
      oatOption = id(21),
      shotOption = id(22),
      wholeMilk = id(30),
      oatMilk = id(31),
      beans = id(32),
      undeclared = id(33),
      sugar = id(34),
      tree = id(40);
    const scope = { brandReference: brand, storeReference: store };
    let second = 0;
    // Real time: sole-operator second factors are compared with the database clock.
    const now = () => new Date(Date.now() + ++second).toISOString();
    let operation = 0x7000;
    const op = () => "019a0000-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    const tx = async (work) => {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        const value = await work(admin);
        await admin.query("COMMIT");
        return value;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    };
    const rejects = async (promise, code) =>
      assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));
    try {
      // TEST-ONLY published Flat White recipe: 200 ml whole milk and 18 g espresso beans.
      const at = "2026-10-08T09:00:00.000Z";
      const requirement = (n, item, quantity, dimension, evidence) => ({
        requirementReference: id(n),
        sourceKind: "InventoryItem",
        sourceReference: item,
        sourceVersionReference: id(n + 1000),
        quantityMicrounits: quantity,
        unitDimension: dimension,
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "1",
        unitCostDenominator: "1",
        allergens: [],
        allergenDeclarationReference: evidence,
      });
      const snapshot = {
        recipeReference: id(50),
        versionReference: id(51),
        brandReference: brand,
        stableCode: "FLAT_WHITE",
        aggregateVersion: 2,
        versionNumber: 2,
        snapshotDigest: "sha256:" + "b".repeat(64),
        lifecycle: "Published",
        displayNameCode: "FLAT_WHITE",
        yieldQuantityMicrounits: "1000000",
        yieldUnitCode: "EACH",
        yieldDimension: "Count",
        ingredients: [
          requirement(60, wholeMilk, "200000000", "Volume", id(70)),
          requirement(61, beans, "18000000", "Mass", id(71)),
        ],
        preparationVersionReference: id(52),
        steps: [
          {
            stepReference: id(53),
            sequenceGroup: 0,
            instructionCode: "STEP-1",
            durationSeconds: 60,
            capabilityCode: "BAR",
          },
        ],
        substitutionPolicyReference: null,
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
        invalidationReasonCode: null,
        createdAt: at,
      };
      await createPilotApiRole(admin, context, "unused", role);
      // Published through the Recipe service with synthetic independent reviews (fixture authority).
      await publishEntryCartRecipe({ admin, role, runner: { run: tx }, snapshot, id, at });
      await admin.query(
        "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,$6)",
        [id(55), snapshot.versionReference, snapshot.recipeReference, brand, sku, at],
      );

      // TEST-ONLY ingredient facts: oat milk declares a (synthetic) allergen; one item is undeclared.
      const item = (n, dimension, unitCode, allergens) => [
        n,
        {
          configurationOperationReference: id(Number.parseInt(n.slice(-4), 16) + 2000),
          dimension,
          unitCode,
          active: true,
          allergenDeclaration:
            allergens === null
              ? null
              : {
                  evidenceReference: id(Number.parseInt(n.slice(-4), 16) + 3000),
                  allergenReferences: allergens,
                },
        },
      ];
      const items = new Map([
        item(wholeMilk, "Volume", "ML", []),
        item(oatMilk, "Volume", "ML", [tree]),
        item(beans, "Mass", "G", []),
        item(undeclared, "Volume", "ML", null),
        item(sugar, "Mass", "G", []),
      ]);
      const content = (change) =>
        parseOptionRecipeChangeContent({
          kind: "NoChange",
          fromItemReference: null,
          toItemReference: null,
          quantity: null,
          unitCostCents: null,
          lossPercent: "0",
          ...change,
        });
      const oatTarget = {
        bindingReference: binding,
        optionReference: oatOption,
        skuReferences: [sku],
        quantities: [1],
      };
      const save = (target, change, expectedVersion, operationReference = op(), actor = author) =>
        tx((t) =>
          saveOptionRecipeChange(t, scope, {
            operationReference,
            actorReference: actor,
            at: now(),
            target,
            content: change,
            items,
            expectedVersion,
          }),
        );

      // ── Organization, Membership and Permission facts: one store; the owner holds recipe
      // approval, Kai (front of house) only edits recipes.
      const owner = author,
        kai = costReviewer;
      void safetyReviewer;
      void publisher;
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference: brand, policyReference: id(300), from });
      const storeRow = (reference, code, lifecycle) =>
        admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD',$5,1,$6,$6)",
          [reference, brand, code, "Synthetic " + code, lifecycle, from],
        );
      await storeRow(store, "STORE_ONE", "Active");
      const reviewerRole = await seedBrandRole(admin, {
        id,
        brandReference: brand,
        roleId: id(310),
        code: "brand_owner",
        actions: ["recipe.approve", "recipe.publish"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 0x400,
        brandReference: brand,
        storeReference: store,
        actorReference: owner,
        name: "Sam",
        roles: [reviewerRole],
        from,
        enrolledAt,
      });
      const editorRole = await seedBrandRole(admin, {
        id,
        brandReference: brand,
        roleId: id(320),
        code: "front_of_house",
        actions: ["recipe.update"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 0x900,
        brandReference: brand,
        storeReference: store,
        actorReference: kai,
        name: "Kai",
        roles: [editorRole],
        from,
        enrolledAt,
      });
      const singleStore = (t, actor, at) =>
        requireMerchantBrandSingleStore(t, {
          brandReference: brand,
          storeReference: store,
          actorReference: actor,
          permissionCode: "recipe.approve",
          observedAt: at,
          allowed: async () => true,
        });
      const review = (changeVersionReference, actor, kind, single) =>
        tx(async (t) => {
          const at = now();
          if (single) await singleStore(t, actor, at);
          return reviewOptionRecipeChange(t, scope, {
            operationReference: op(),
            actorReference: actor,
            at,
            changeVersionReference,
            kind,
            decision: "Approved",
            comment: null,
            ...(single ? { singleStoreListing: { storeReference: store } } : {}),
          });
        });
      const publish = (changeVersionReference) =>
        tx(async (t) => {
          const at = now();
          return publishOptionRecipeChange(t, scope, {
            operationReference: op(),
            actorReference: owner,
            at,
            changeVersionReference,
            reviewersAuthorized: async () => true,
            singleStoreListingEffective: async (actor) =>
              singleStore(t, actor, at).then(
                () => true,
                (error) => {
                  if (error?.name === "MerchantSingleStoreListingError") return false;
                  throw error;
                },
              ),
          });
        });
      const replace = content({
        kind: "Replace",
        fromItemReference: wholeMilk,
        toItemReference: oatMilk,
        unitCostCents: "0.45",
      });
      const oatChange = (await save(oatTarget, replace, null)).changeVersionReference;

      // 1. One store: unmarked self-review is refused; both marked reviews, then published.
      await rejects(
        review(oatChange, owner, "Cost", false),
        "OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT",
      );
      assert.equal((await review(oatChange, owner, "Cost", true)).status, "Applied");
      await rejects(
        review(oatChange, owner, "FoodSafety", false),
        "OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT",
      );
      assert.equal((await review(oatChange, owner, "FoodSafety", true)).status, "Applied");
      const marked = (
        await admin.query(
          "SELECT review_kind,reviewer_actor_id::text r,author_actor_id::text a,review_mode,listing_store_id::text s FROM rms_recipe.option_recipe_change_review WHERE change_version_id=$1 ORDER BY review_kind",
          [oatChange],
        )
      ).rows;
      assert.deepEqual(
        marked.map((row) => [row.review_kind, row.r, row.a, row.review_mode, row.s]),
        [
          ["Cost", owner, owner, "SingleStoreListing", store],
          ["FoodSafety", owner, owner, "SingleStoreListing", store],
        ],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code='RECIPE_OPTION_CHANGE_REVIEWED' AND after_summary_json->>'approvalMode'='SingleStoreListing'",
          )
        ).rows[0].n,
        2,
      );
      assert.equal((await publish(oatChange)).status, "Applied");
      const source = createPostgresRecipeModifierSource({ run: (work) => tx(work) });
      const [rule] = await source.resolve(
        snapshot,
        [{ bindingReference: binding, optionReference: oatOption, quantity: 1 }],
        now(),
      );
      assert.equal(rule.changes[0].ingredient.sourceReference, oatMilk);

      // 2. Kai holds no recipe approval: cannot review their own change alone.
      const shotTarget = {
        bindingReference: binding,
        optionReference: shotOption,
        skuReferences: [sku],
        quantities: [1],
      };
      const add = content({
        kind: "Add",
        toItemReference: beans,
        quantity: "18",
        unitCostCents: "2.45",
      });
      const kaiChange = (await save(shotTarget, add, null, op(), kai)).changeVersionReference;
      await rejects(review(kaiChange, kai, "Cost", true), "NotPermitted");

      // 3. Both reviews of the owner's next change at one store; then a second (draft) store.
      const shotChange = (await save(shotTarget, add, 1)).changeVersionReference;
      for (const kind of ["Cost", "FoodSafety"]) await review(shotChange, owner, kind, true);
      await storeRow(id(8), "STORE_TWO", "Draft");
      await rejects(publish(shotChange), "OPTION_RECIPE_NOT_SINGLE_STORE");
      // New marked reviews: refused by the command, and by the database without it.
      const nextChange = (
        await save(
          shotTarget,
          content({ kind: "Add", toItemReference: sugar, quantity: "5", unitCostCents: "0.1" }),
          2,
        )
      ).changeVersionReference;
      await rejects(review(nextChange, owner, "Cost", true), "NotSingleStore");
      await assert.rejects(
        tx((t) =>
          reviewOptionRecipeChange(t, scope, {
            operationReference: op(),
            actorReference: owner,
            at: now(),
            changeVersionReference: nextChange,
            kind: "Cost",
            decision: "Approved",
            comment: null,
            singleStoreListing: { storeReference: store },
          }),
        ),
        /recipe single store review needs a brand with one store/u,
      );
      // Archived, the second store no longer counts.
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=2 WHERE store_id=$1",
        [id(8)],
      );
      for (const kind of ["Cost", "FoodSafety"])
        assert.equal((await review(nextChange, owner, kind, true)).status, "Applied");
      assert.equal((await publish(nextChange)).status, "Applied");
      await assert.rejects(
        admin.query(
          "UPDATE rms_recipe.option_recipe_change_review SET review_mode='Independent' WHERE review_mode='SingleStoreListing'",
        ),
        /append-only|immutable/u,
      );
    } finally {
      await admin.end();
    }
  });
});
