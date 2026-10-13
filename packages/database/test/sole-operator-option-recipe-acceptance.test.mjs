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
import {
  merchantBrandSoleOperatorGate,
  requireMerchantBrandSoleOperator,
} from "../../../apps/api/src/merchant-sole-operator.ts";
import { publishEntryCartRecipe } from "../test-support/entry-cart-recipe-publication.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a24-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL, as for recipes): option-recipe change reviews. While sole
 * operator is in effect for the owner, they may review their own change and give both reviews,
 * each after a second factor at most 15 minutes old and marked SoleOperator; the published rule
 * carries the marked evidence and orders resolve it. A second reviewer ends the waiver, also for a
 * review given alone before publication. Restricted pilot API role; setup as the option recipes
 * acceptance.
 */
it("option recipe review: the sole operator reviews their own change alone, with MFA and marks", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_so_optrecipe" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_soor_" + context.runId;
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
      const save = (target, change, expectedVersion, operationReference = op()) =>
        tx((t) =>
          saveOptionRecipeChange(t, scope, {
            operationReference,
            actorReference: author,
            at: now(),
            target,
            content: change,
            items,
            expectedVersion,
          }),
        );

      // ── Organization, Membership and Permission: the owner alone holds recipe review.
      const owner = author,
        noah = costReviewer,
        tenantReference = id(1);
      void safetyReviewer;
      void publisher;
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrand(admin, { brandReference: brand, policyReference: id(300), from });
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
      const gateInput = (actor, at) => ({
        tenantReference,
        brandReference: brand,
        storeReference: store,
        actorReference: actor,
        permissionCode: "recipe.approve",
        observedAt: at,
        allowed: async () => true,
      });
      const review = (changeVersionReference, actor, kind, sole) =>
        tx(async (t) => {
          const at = now();
          const soleOperator = sole
            ? {
                reviewerMfaAt: (await requireMerchantBrandSoleOperator(t, gateInput(actor, at)))
                  .actorMfaAt,
              }
            : undefined;
          return reviewOptionRecipeChange(t, scope, {
            operationReference: op(),
            actorReference: actor,
            at,
            changeVersionReference,
            kind,
            decision: "Approved",
            comment: null,
            ...(soleOperator === undefined ? {} : { soleOperator }),
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
            soleOperatorEffective: async (actor) =>
              (await merchantBrandSoleOperatorGate(t, gateInput(actor, at))).status === "Effective",
          });
        });
      const replace = content({
        kind: "Replace",
        fromItemReference: wholeMilk,
        toItemReference: oatMilk,
        unitCostCents: "0.45",
      });
      const oatChange = (await save(oatTarget, replace, null)).changeVersionReference;

      // 1. The author cannot review their own change; asking as sole operator: not set.
      await rejects(
        review(oatChange, owner, "Cost", false),
        "OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT",
      );
      await rejects(review(oatChange, owner, "Cost", true), "NotInEffect");
      // 2. On and in effect, but the second factor is two hours old.
      await seedSoleOperatorSetting(admin, {
        id,
        n: 0x700,
        tenantReference,
        brandReference: brand,
        actorReference: owner,
        state: "On",
        version: 1,
      });
      await rejects(review(oatChange, owner, "Cost", true), "NeedsReverification");
      // 3. Re-verified: both reviews alone, each marked; the second unmarked is refused.
      await seedStepUp(admin, {
        id,
        n: 0x710,
        brandReference: brand,
        storeReference: store,
        actorReference: owner,
      });
      assert.equal((await review(oatChange, owner, "Cost", true)).status, "Applied");
      await rejects(
        review(oatChange, owner, "FoodSafety", false),
        "OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT",
      );
      assert.equal((await review(oatChange, owner, "FoodSafety", true)).status, "Applied");
      const marked = (
        await admin.query(
          "SELECT review_kind,reviewer_actor_id::text r,author_actor_id::text a,review_mode,reviewer_mfa_at IS NOT NULL mfa FROM rms_recipe.option_recipe_change_review WHERE change_version_id=$1 ORDER BY review_kind",
          [oatChange],
        )
      ).rows;
      assert.deepEqual(
        marked.map((row) => [row.review_kind, row.r, row.a, row.review_mode, row.mfa]),
        [
          ["Cost", owner, owner, "SoleOperator", true],
          ["FoodSafety", owner, owner, "SoleOperator", true],
        ],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code='RECIPE_OPTION_CHANGE_REVIEWED' AND after_summary_json->>'approvalMode'='SoleOperator'",
          )
        ).rows[0].n,
        2,
      );
      // Published with the marked evidence; orders resolve the rule and its kitchen content.
      assert.equal((await publish(oatChange)).status, "Applied");
      const source = createPostgresRecipeModifierSource({ run: (work) => tx(work) });
      const [rule] = await source.resolve(
        snapshot,
        [{ bindingReference: binding, optionReference: oatOption, quantity: 1 }],
        now(),
      );
      assert.equal(rule.changes[0].ingredient.sourceReference, oatMilk);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_recipe.recipe_preparation_content WHERE modifier_rule_version_id=$1",
            [rule.ruleVersionReference],
          )
        ).rows[0].n,
        1,
      );

      // 4. Noah gains recipe review: the waiver lapses; a review given alone before no longer counts.
      const shotTarget = {
        bindingReference: binding,
        optionReference: shotOption,
        skuReferences: [sku],
        quantities: [1],
      };
      const shotChange = (
        await save(
          shotTarget,
          content({ kind: "Add", toItemReference: beans, quantity: "18", unitCostCents: "2.45" }),
          null,
        )
      ).changeVersionReference;
      await review(shotChange, owner, "Cost", true);
      await seedBrandMember(admin, {
        id,
        base: 0x900,
        brandReference: brand,
        storeReference: store,
        actorReference: noah,
        name: "Noah",
        roles: [reviewerRole],
        from,
        enrolledAt,
      });
      await rejects(review(shotChange, owner, "FoodSafety", true), "NotInEffect");
      await review(shotChange, noah, "FoodSafety", false);
      await rejects(publish(shotChange), "OPTION_RECIPE_SOLE_OPERATOR_NOT_IN_EFFECT");

      // 5. The database refuses an unmarked second review by one person and a stale mark; reviews
      // stay append-only.
      const later = (await save(oatTarget, content({ kind: "NoChange" }), 1))
        .changeVersionReference;
      const insert = (actor, kind, mode, mfa) =>
        admin.query(
          "INSERT INTO rms_recipe.option_recipe_change_review (review_id,change_version_id,brand_id,change_digest,review_kind,decision,reviewer_actor_id,author_actor_id,comment,reviewed_at,operation_id,audit_id,review_mode,reviewer_mfa_at) SELECT $1,change_version_id,brand_id,change_digest,$2,'Approved',$3,author_actor_id,NULL,now(),$4,$5,$6,$7 FROM rms_recipe.option_recipe_change WHERE change_version_id=$8",
          [
            id(0xb00 + ++second),
            kind,
            actor,
            id(0xc00 + second),
            id(0xd00 + second),
            mode,
            mfa,
            later,
          ],
        );
      await insert(noah, "Cost", "Independent", null);
      await assert.rejects(insert(noah, "FoodSafety", "Independent", null), /need two reviewers/u);
      await assert.rejects(
        insert(
          owner,
          "FoodSafety",
          "SoleOperator",
          new Date(Date.now() - 16 * 60_000).toISOString(),
        ),
        /option_recipe_change_review_sole_operator_mfa/u,
      );
      await assert.rejects(
        admin.query("UPDATE rms_recipe.option_recipe_change_review SET review_mode='Independent'"),
        /append-only|Recipe/u,
      );
    } finally {
      await admin.end();
    }
  });
});
