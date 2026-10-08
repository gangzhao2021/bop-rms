import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresRecipeModifierSource,
  listOptionRecipeChanges,
  optionRecipeCovered,
  parseOptionRecipeChangeContent,
  publishOptionRecipeChange,
  reviewOptionRecipeChange,
  saveOptionRecipeChange,
} from "../../rms/recipe/src/index.ts";
import { publishEntryCartRecipe } from "../test-support/entry-cart-recipe-publication.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01909a23-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for option recipe changes (docs/spec/pilot-acl-additions.json). */
export const optionRecipeApiGrants = [
  "GRANT USAGE ON SCHEMA rms_recipe,platform_audit,platform_eventing,platform_helpers TO ROLE_",
  "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ROLE_",
  "GRANT SELECT ON rms_recipe.recipe_version,rms_recipe.recipe_scope_binding,rms_recipe.recipe_scope_binding_end TO ROLE_",
  // Modifier writes hold the recipe row (FOR SHARE needs UPDATE; the pilot API role has it).
  "GRANT SELECT,UPDATE ON rms_recipe.recipe TO ROLE_",
  "GRANT SELECT,INSERT ON rms_recipe.option_recipe_change,rms_recipe.option_recipe_change_review,rms_recipe.option_recipe_change_publication,rms_recipe.recipe_preparation_content TO ROLE_",
  // Kitchen content publication takes a SHARE lock on modifier rules (UPDATE; as the pilot API role).
  "GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe_modifier_version TO ROLE_",
  "GRANT SELECT,INSERT ON platform_audit.audit_record TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ROLE_",
];

/** WP-2423 slice 4.4: option recipe changes expanded, reviewed independently and published. */
it("expands option recipe changes into reviewed, published modifier rules", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_optrecipes" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_optrecipe_" + context.runId;
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
    const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, ++second)).toISOString();
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
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of optionRecipeApiGrants) await admin.query(sql.replaceAll("ROLE_", role));
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

      // Oat milk replaces whole milk in the same amount; a retried save returns what it did.
      const replace = content({
        kind: "Replace",
        fromItemReference: wholeMilk,
        toItemReference: oatMilk,
        unitCostCents: "0.45",
      });
      const saveOperation = op();
      const saved = await save(oatTarget, replace, null, saveOperation);
      assert.equal(saved.status, "Applied");
      assert.deepEqual(await save(oatTarget, replace, null, saveOperation), {
        status: "AlreadyApplied",
        changeVersionReference: saved.changeVersionReference,
      });
      // Changes that do not fit the recipe or lack an allergen declaration are refused.
      await rejects(
        save(oatTarget, content({ kind: "Remove", fromItemReference: oatMilk }), 1),
        "OPTION_RECIPE_INGREDIENT_MISSING",
      );
      await rejects(
        save(
          oatTarget,
          content({ kind: "Replace", fromItemReference: wholeMilk, toItemReference: undeclared }),
          1,
        ),
        "OPTION_RECIPE_ALLERGEN_UNDECLARED",
      );
      await rejects(
        save(
          oatTarget,
          content({ kind: "Replace", fromItemReference: wholeMilk, toItemReference: sugar }),
          1,
        ),
        "OPTION_RECIPE_UNIT_MISMATCH",
      );
      // Replacing with an ingredient the recipe already has would double it.
      await rejects(
        save(
          oatTarget,
          content({ kind: "Replace", fromItemReference: wholeMilk, toItemReference: beans }),
          1,
        ),
        "OPTION_RECIPE_INGREDIENT_PRESENT",
      );
      await rejects(save(oatTarget, replace, null), "OPTION_RECIPE_CONFLICT");

      const listed = async (target) =>
        (await tx((t) => listOptionRecipeChanges(t, scope, [target]))).get(
          target.bindingReference + ":" + target.optionReference,
        );
      const oat = await listed(oatTarget);
      assert.deepEqual(oat.expansion[0].lines, [
        {
          fromItemReference: wholeMilk,
          fromQuantityMicrounits: "200000000",
          toItemReference: oatMilk,
          toQuantityMicrounits: "200000000",
        },
      ]);
      assert.equal(await tx((t) => optionRecipeCovered(t, scope, oatTarget, now())), false);

      // Two independent reviewers (not the author) before a publisher may publish.
      const review = (actor, kind, decision = "Approved", comment = null) =>
        tx((t) =>
          reviewOptionRecipeChange(t, scope, {
            operationReference: op(),
            actorReference: actor,
            at: now(),
            changeVersionReference: saved.changeVersionReference,
            kind,
            decision,
            comment,
          }),
        );
      const publish = (operationReference = op()) =>
        tx((t) =>
          publishOptionRecipeChange(t, scope, {
            operationReference,
            actorReference: publisher,
            at: now(),
            changeVersionReference: saved.changeVersionReference,
            reviewersAuthorized: async () => true,
          }),
        );
      await rejects(publish(), "OPTION_RECIPE_REVIEW_REQUIRED");
      await rejects(review(author, "Cost"), "OPTION_RECIPE_REVIEWER_NOT_INDEPENDENT");
      await review(costReviewer, "Cost");
      await rejects(review(safetyReviewer, "Cost"), "OPTION_RECIPE_CONFLICT");
      await rejects(publish(), "OPTION_RECIPE_REVIEW_REQUIRED");
      await review(safetyReviewer, "FoodSafety");
      const publishOperation = op();
      assert.equal((await publish(publishOperation)).status, "Applied");
      assert.equal((await publish(publishOperation)).status, "AlreadyApplied");
      assert.equal(await tx((t) => optionRecipeCovered(t, scope, oatTarget, now())), true);

      // Orders resolve the published rule (with its review evidence) and its kitchen content.
      const source = createPostgresRecipeModifierSource({ run: (work) => tx(work) });
      const [rule] = await source.resolve(
        snapshot,
        [{ bindingReference: binding, optionReference: oatOption, quantity: 1 }],
        now(),
      );
      assert.equal(rule.changes[0].action, "Replace");
      assert.equal(rule.changes[0].ingredient.sourceReference, oatMilk);
      assert.deepEqual(
        rule.changes[0].ingredient.allergens.map((a) => a.allergenReference),
        [tree],
      );
      const kitchen = await admin.query(
        "SELECT count(*)::int n FROM rms_recipe.recipe_preparation_content WHERE modifier_rule_version_id=$1",
        [rule.ruleVersionReference],
      );
      assert.equal(kitchen.rows[0].n, 1);

      // An extra shot: 18 g more beans per shot, up to three.
      const shotTarget = {
        bindingReference: binding,
        optionReference: shotOption,
        skuReferences: [sku],
        quantities: [1, 2, 3],
      };
      await save(
        shotTarget,
        content({ kind: "Add", toItemReference: beans, quantity: "18", unitCostCents: "2.45" }),
        null,
      );
      const shots = await listed(shotTarget);
      assert.deepEqual(
        shots.expansion.map((entry) => [entry.quantity, entry.lines[0].toQuantityMicrounits]),
        [
          [1, "36000000"],
          [2, "54000000"],
          [3, "72000000"],
        ],
      );

      // A later change starts a new version; customers keep the published rule until it is published.
      const again = await save(oatTarget, content({ kind: "NoChange" }), 1);
      assert.notEqual(again.changeVersionReference, saved.changeVersionReference);
      const [still] = await source.resolve(
        snapshot,
        [{ bindingReference: binding, optionReference: oatOption, quantity: 1 }],
        now(),
      );
      assert.equal(still.ruleVersionReference, rule.ruleVersionReference);
      const audits = (
        await admin.query(
          "SELECT action_code, count(*)::int n FROM platform_audit.audit_record WHERE action_code LIKE 'RECIPE_%' AND action_code NOT IN ('RECIPE_CREATEDRAFT','RECIPE_PUBLISH') GROUP BY 1 ORDER BY 1",
        )
      ).rows.map((r) => [r.action_code, r.n]);
      assert.deepEqual(audits, [
        ["RECIPE_MODIFIER_DRAFT", 5],
        ["RECIPE_MODIFIER_PUBLISHED", 1],
        ["RECIPE_OPTION_CHANGE_PUBLISHED", 1],
        ["RECIPE_OPTION_CHANGE_REVIEWED", 2],
        ["RECIPE_OPTION_CHANGE_SAVED", 3],
        ["RECIPE_PREPARATION_PUBLISHED", 1],
      ]);
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
