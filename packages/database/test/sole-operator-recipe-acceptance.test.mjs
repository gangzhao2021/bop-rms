import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createStoreReceipt,
  listInventoryRecipeIngredientFacts,
  parseStoreReceiptLines,
  postStoreReceipt,
  voidStoreReceipt,
} from "../../rms/inventory/src/index.ts";
import {
  createPostgresKitchenRoutingConfigurationStore,
  listKitchenStationCapabilities,
  rebindKitchenRoutingEvidence,
} from "../../rms/kitchen/src/index.ts";
import {
  listPublishedSubRecipes,
  loadRecipe,
  parseRecipeDraft,
  publishRecipe,
  publishRecipePreparation,
  recordRecipeReview,
  saveRecipeDraft,
} from "../../rms/recipe/src/index.ts";
import {
  createAllergenRegistryVersion,
  listCurrentIngredientDeclarations,
  recordIngredientAllergenDeclaration,
} from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { kilogram, litre, syntheticInventoryItems } from "../test-support/inventory-items.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";
import {
  merchantBrandSoleOperatorGate,
  requireMerchantBrandSoleOperator,
} from "../../../apps/api/src/merchant-sole-operator.ts";

const { Client } = pg;
const id = (n) => "01909a1f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 Q19 step 2 (DEC-SOLE-OPERATOR-APPROVAL, supplementary decision 1): while sole operator is
 * in effect for the owner, they may review their own recipe and give both the Cost and FoodSafety
 * reviews, each after a second-factor check at most 15 minutes old and marked SoleOperator. A
 * second reviewer ends it at once, also for sole reviews given before publication. Restricted
 * pilot API role; setup facts as in the recipe authoring acceptance.
 */
it("recipe review: the sole operator reviews their own recipe alone, with MFA and marks", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_so_recipe" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000,
      minute = 0;
    const next = () => id(++sequence);
    // Real time: sole-operator second factors are compared with the database clock.
    const clock = () => new Date(Date.now() + minute++).toISOString();
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const [author, owner] = [id(4), id(7)];
    const transaction = (role) => async (work) => {
      await admin.query("BEGIN");
      try {
        if (role) await admin.query("SET LOCAL ROLE " + role);
        const value = await work(admin);
        await admin.query("COMMIT");
        return value;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    };
    // Setup writes run as the owner; recipe authoring runs as a restricted, non-bypass role with the
    // pilot API grants, so row-level security applies exactly as in the runtime.
    const setupTx = transaction(null);
    const role = "wp2423_sor_" + context.runId;
    const tx = transaction(role);
    try {
      await ensureSyntheticStockPlace(admin, {
        tenantId: scope.tenantReference,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        stockSiteId: id(10),
        locationId: id(11),
        at: "2026-10-07T09:00:00.000Z",
      });
      const items = syntheticInventoryItems({ tx: setupTx, scope, actor: owner, next, clock });
      const milk = await items.create("MILK", litre, "NoLot");
      const beans = await items.create("BEANS", kilogram, "NoLot");
      // The Store's latest received cost becomes the suggested standard cost.
      const receivedAt = clock();
      await setupTx((t) =>
        postStoreReceipt(t, scope, {
          operationReference: next(),
          receipt: createStoreReceipt({
            receiptReference: next(),
            ...scope,
            supplierName: "Roaster",
            supplierDocument: null,
            lines: parseStoreReceiptLines([
              {
                lineReference: next(),
                itemReference: beans,
                locationReference: id(11),
                lotCode: null,
                expiryDate: null,
                acceptedQuantity: "5",
                rejectedQuantity: "0",
                damagedQuantity: "0",
                discrepancyReason: null,
                unitCostMinor: 2450,
                temperatureCelsius: null,
              },
            ]),
            receivedBy: owner,
            receivedAt,
          }),
          auditReference: next(),
          nextReference: next,
        }),
      );
      // A later receipt that was voided does not set the suggested cost.
      const voided = next();
      await setupTx((t) =>
        postStoreReceipt(t, scope, {
          operationReference: next(),
          receipt: createStoreReceipt({
            receiptReference: voided,
            ...scope,
            supplierName: "Roaster",
            supplierDocument: null,
            lines: parseStoreReceiptLines([
              {
                lineReference: next(),
                itemReference: beans,
                locationReference: id(11),
                lotCode: null,
                expiryDate: null,
                acceptedQuantity: "1",
                rejectedQuantity: "0",
                damagedQuantity: "0",
                discrepancyReason: null,
                unitCostMinor: 2600,
                temperatureCelsius: null,
              },
            ]),
            receivedBy: owner,
            receivedAt: clock(),
          }),
          auditReference: next(),
          nextReference: next,
        }),
      );
      await setupTx((t) =>
        voidStoreReceipt(t, scope, {
          operationReference: next(),
          receiptReference: voided,
          reasonCode: "ENTERED_IN_ERROR",
          actorReference: owner,
          occurredAt: clock(),
          auditReference: next(),
          nextReference: next,
        }),
      );
      // Kitchen station of the Store (owner write path, synthetic operator authority).
      const routing = createPostgresKitchenRoutingConfigurationStore({
        ...scope,
        sha256,
        authorizeRead: async () => true,
        authorizeWrite: async () => true,
        validateConfiguration: async () => true,
        audit: async (record) => ({
          auditId: next(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: record.actorReference },
          actionCode: "KITCHEN_ROUTING_CONFIGURATION_RECORDED",
          targetType: "KitchenRoutingConfiguration",
          targetId: record.configuration.evidenceReference,
          correlationId: record.operationReference,
          reasonCode: record.reasonCode,
          occurredAt: record.recordedAt,
          sourceChannel: "MERCHANT_WEB",
          afterSummary: { version: record.configuration.evidenceVersion },
          dataClassification: "Restricted",
          retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
          retentionPolicyVersion: 1,
        }),
      });
      const stationAt = clock();
      const capability = id(12);
      await setupTx((t) =>
        routing.commit({
          transaction: t,
          record: {
            operationReference: next(),
            actorReference: owner,
            purposeCode: "SyntheticConfiguration",
            permissionCode: "synthetic.configure",
            reasonCode: "SYNTHETIC_SETUP",
            recordedAt: stationAt,
            expectedVersion: 0,
            configuration: rebindKitchenRoutingEvidence(
              {
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                evidenceReference: next(),
                evidenceVersion: 1,
                effectiveAt: stationAt,
                evidenceDigest: sha256("placeholder"),
                candidates: [
                  {
                    stationReference: id(13),
                    stationVersion: 1,
                    stationStatus: "Active",
                    stationCapabilityReferences: [capability],
                    routingRuleReference: id(14),
                    routingRuleVersion: 1,
                    routingRuleStatus: "Active",
                    selector: { kind: "AllPreparedItems" },
                    targetStationReference: id(13),
                    routingRuleDigest: sha256("placeholder"),
                  },
                ],
              },
              stationAt,
              sha256,
            ),
          },
        }),
      );

      await createPilotApiRole(admin, context, "unused", role);
      // DEC-ALLERGEN-DECLARATIONS: the Brand allergen list and both ingredients' declarations
      // (milk contains milk; the beans contain none) exist before recipes are written.
      const registryAt = clock();
      const milkAllergen = id(60);
      const registry = id(61);
      await setupTx((t) =>
        createAllergenRegistryVersion(t, scope, {
          registryVersionReference: registry,
          jurisdictionCode: "CA",
          policyDocument: "TEST-ONLY synthetic allergen list",
          entries: [
            { allergenReference: milkAllergen, code: "MILK", localizedNames: { "en-CA": "Milk" } },
            { allergenReference: id(62), code: "SOY", localizedNames: { "en-CA": "Soy" } },
          ],
          actorReference: owner,
          at: registryAt,
          auditReference: next(),
        }),
      );
      const itemVersions = new Map(
        (await setupTx((t) => listInventoryRecipeIngredientFacts(t, scope))).map((item) => [
          item.itemReference,
          item.configurationOperationReference,
        ]),
      );
      for (const [item, contains] of [
        [milk, [milkAllergen]],
        [beans, []],
      ])
        await setupTx((t) =>
          recordIngredientAllergenDeclaration(t, scope, {
            evidenceReference: next(),
            itemReference: item,
            itemVersionReference: itemVersions.get(item),
            registryVersionReference: registry,
            allergens: contains.map((allergenReference) => ({
              allergenReference,
              classification: "Contains",
            })),
            sourceKind: "SupplierSpecification",
            documentReference: "TEST-ONLY synthetic specification",
            note: null,
            validUntil: "2027-10-07T00:00:00.000Z",
            actorReference: owner,
            at: clock(),
            auditReference: next(),
          }),
        );
      const facts = async () => {
        const inventory = await tx((t) => listInventoryRecipeIngredientFacts(t, scope));
        const declarations = await setupTx((t) =>
          listCurrentIngredientDeclarations(t, scope, new Date(Date.now() + 60_000).toISOString()),
        );
        const stations = await tx((t) => listKitchenStationCapabilities(t, scope));
        const subRecipes = await tx((t) => listPublishedSubRecipes(t, scope));
        return {
          inventory,
          recipeFacts: {
            items: new Map(
              inventory.map((item) => [
                item.itemReference,
                {
                  configurationOperationReference: item.configurationOperationReference,
                  dimension: item.dimension,
                  unitCode: item.unitCode,
                  active: item.active,
                  allergenDeclaration: (() => {
                    const d = declarations.find(
                      (x) =>
                        x.itemReference === item.itemReference &&
                        x.itemVersionReference === item.configurationOperationReference,
                    );
                    return d === undefined
                      ? null
                      : {
                          evidenceReference: d.evidenceReference,
                          allergenReferences: d.allergens.map((a) => a.allergenReference),
                        };
                  })(),
                },
              ]),
            ),
            subRecipes: new Map(subRecipes.map((recipe) => [recipe.recipeReference, recipe])),
            capabilityReferences: new Set(
              stations.flatMap((station) => station.capabilityReferences),
            ),
          },
        };
      };
      const initial = await facts();
      assert.deepEqual(
        initial.inventory.map((item) => [
          item.internalCode,
          item.unitCode,
          item.latestUnitCostMinor,
        ]),
        [
          ["BEANS", "KG", 2450],
          ["MILK", "L", null],
        ],
      );
      const draft = (overrides = {}) =>
        parseRecipeDraft({
          name: "Latte 12 oz",
          code: "LATTE-12",
          yieldQuantity: "1",
          yieldUnit: "EACH",
          ingredients: [
            {
              kind: "InventoryItem",
              sourceReference: milk,
              quantity: "0.25",
              lossPercent: "0",
              unitCostCents: "289",
            },
            {
              kind: "InventoryItem",
              sourceReference: beans,
              quantity: "0.018",
              lossPercent: "5",
              unitCostCents: "2450",
            },
          ],
          steps: [
            {
              sequence: 0,
              instruction: "Pull a double shot.",
              durationSeconds: 30,
              capabilityReference: capability,
            },
            {
              sequence: 1,
              instruction: "Steam 250 ml milk and pour.",
              durationSeconds: 60,
              capabilityReference: capability,
            },
          ],
          ...overrides,
        });
      const recipe = id(100);
      const save = (input) =>
        tx((t) =>
          saveRecipeDraft(t, scope, {
            actorReference: author,
            at: clock(),
            nextReference: next,
            operationReference: next(),
            recipeReference: recipe,
            expectedAggregateVersion: null,
            revisionOf: null,
            draft: draft(),
            facts: initial.recipeFacts,
            auditReference: next(),
            ...input,
          }),
        );
      // Facts the Brand does not have are refused with the line.
      await assert.rejects(
        save({
          draft: draft({
            ingredients: [
              {
                kind: "InventoryItem",
                sourceReference: id(99),
                quantity: "1",
                lossPercent: "0",
                unitCostCents: null,
              },
            ],
          }),
        }),
        { code: "RECIPE_AUTHORING_LINE_INVALID", line: 1 },
      );
      assert.throws(() => draft({ code: "latte" }), { code: "RECIPE_AUTHORING_INVALID" });
      const createOperation = next();
      assert.equal((await save({ operationReference: createOperation })).status, "Applied");
      assert.equal((await save({ operationReference: createOperation })).status, "AlreadyApplied");
      await assert.rejects(save({ recipeReference: id(101) }), {
        code: "RECIPE_AUTHORING_CODE_TAKEN",
      });
      const detail = () => tx((t) => loadRecipe(t, scope, recipe, clock()));
      let current = await detail();
      assert.equal(current.lifecycle, "Draft");
      assert.equal(current.name, "Latte 12 oz");
      // 0.25 L × 289 + 0.018 kg × 1.05 × 2450 = 72.25 + 46.305 → 118.555 → 119 cents (half-even on the total).
      assert.equal(current.standardCostCents, "119");
      assert.deepEqual(current.draft.ingredients[1], {
        kind: "InventoryItem",
        sourceReference: beans,
        quantity: "0.018",
        lossPercent: "5",
        unitCostCents: "2450",
      });

      // ── WP-2423 Q19: Organization, Membership and Permission facts — the owner alone holds
      // recipe review permission at Brand level (the other reviewers above hold none here).
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrand(admin, {
        brandReference: scope.brandReference,
        policyReference: id(300),
        from,
      });
      const reviewerRole = await seedBrandRole(admin, {
        id,
        brandReference: scope.brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: ["recipe.approve", "recipe.publish"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 0x400,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [reviewerRole],
        from,
        enrolledAt,
      });
      const noah = id(0x500);
      const gate = (t, actor, at) =>
        requireMerchantBrandSoleOperator(t, {
          ...scope,
          actorReference: actor,
          permissionCode: "recipe.approve",
          observedAt: at,
          allowed: async () => true,
        });
      /** A review as the composition makes it: `sole` reads the gate in the same transaction. */
      const ownReview = (
        recipeReference,
        versionReference,
        actor,
        kind,
        sole,
        subject = "Recipe",
      ) =>
        tx(async (t) => {
          const at = clock();
          const soleOperator = sole
            ? { reviewerMfaAt: (await gate(t, actor, at)).actorMfaAt }
            : undefined;
          return recordRecipeReview(t, scope, {
            actorReference: actor,
            at,
            nextReference: next,
            reviewReference: next(),
            recipeReference,
            versionReference,
            subject,
            kind,
            decision: "Approved",
            comment: null,
            auditReference: next(),
            ...(soleOperator === undefined ? {} : { soleOperator }),
          });
        });
      const effective = (t, at) => async (actor) =>
        (
          await merchantBrandSoleOperatorGate(t, {
            ...scope,
            actorReference: actor,
            permissionCode: "recipe.approve",
            observedAt: at,
            allowed: async () => true,
          })
        ).status === "Effective";
      const ownPublish = (recipeReference, aggregateVersion) =>
        tx(async (t) => {
          const at = clock();
          return publishRecipe(t, scope, {
            actorReference: owner,
            at,
            nextReference: next,
            operationReference: next(),
            recipeReference,
            expectedAggregateVersion: aggregateVersion,
            facts: initial.recipeFacts,
            reviewersAuthorized: async () => true,
            soleOperatorEffective: effective(t, at),
            auditReference: next(),
          });
        });
      const ownRecipe = id(0x600);
      await save({
        actorReference: owner,
        recipeReference: ownRecipe,
        draft: draft({ code: "LATTE-SOLE" }),
      });
      const own = await tx((t) => loadRecipe(t, scope, ownRecipe, clock()));
      const refused = (code) => (error) => {
        assert.equal(error.code, code);
        return true;
      };

      // 1. The author cannot review their own recipe; asking as sole operator: not set.
      await assert.rejects(
        ownReview(ownRecipe, own.versionReference, owner, "Cost", false),
        refused("RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT"),
      );
      await assert.rejects(
        ownReview(ownRecipe, own.versionReference, owner, "Cost", true),
        refused("NotInEffect"),
      );
      // 2. On and in effect, but the second factor is two hours old.
      await seedSoleOperatorSetting(admin, {
        id,
        n: 0x700,
        ...scope,
        actorReference: owner,
        state: "On",
        version: 1,
      });
      await assert.rejects(
        ownReview(ownRecipe, own.versionReference, owner, "Cost", true),
        refused("NeedsReverification"),
      );
      // 3. Re-verified: the owner gives both reviews alone, each marked, then publishes.
      await seedStepUp(admin, { id, n: 0x710, ...scope, actorReference: owner });
      assert.equal(
        (await ownReview(ownRecipe, own.versionReference, owner, "Cost", true)).status,
        "Applied",
      );
      // The second kind without the mark is still refused (same person).
      await assert.rejects(
        ownReview(ownRecipe, own.versionReference, owner, "FoodSafety", false),
        refused("RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT"),
      );
      assert.equal(
        (await ownReview(ownRecipe, own.versionReference, owner, "FoodSafety", true)).status,
        "Applied",
      );
      const marked = (
        await admin.query(
          "SELECT review_kind,reviewer_actor_id::text r,author_actor_id::text a,review_mode,reviewer_mfa_at IS NOT NULL mfa,audit_id::text audit FROM rms_recipe.recipe_authoring_review WHERE recipe_version_id=$1 ORDER BY review_kind",
          [own.versionReference],
        )
      ).rows;
      assert.deepEqual(
        marked.map((row) => [row.review_kind, row.r, row.a, row.review_mode, row.mfa]),
        [
          ["Cost", owner, owner, "SoleOperator", true],
          ["FoodSafety", owner, owner, "SoleOperator", true],
        ],
      );
      const audit = (
        await admin.query(
          "SELECT after_summary_json->>'approvalMode' mode FROM platform_audit.audit_record WHERE audit_id=$1",
          [marked[0].audit],
        )
      ).rows[0];
      assert.equal(audit.mode, "SoleOperator");
      assert.equal((await ownPublish(ownRecipe, own.aggregateVersion)).status, "Applied");
      assert.equal(
        (await tx((t) => loadRecipe(t, scope, ownRecipe, clock()))).lifecycle,
        "Published",
      );
      // 3b. The kitchen steps (Preparation) are reviewed the same way: unmarked self-review is
      // refused; both marked reviews let the owner publish the kitchen instructions, and the
      // published review evidence carries the SoleOperator mark.
      const kitchen = (operation = next()) =>
        tx(async (t) => {
          const at = clock();
          return publishRecipePreparation(t, scope, {
            actorReference: owner,
            at,
            nextReference: next,
            operationReference: operation,
            recipeReference: ownRecipe,
            reviewersAuthorized: async () => true,
            soleOperatorEffective: effective(t, at),
            auditReference: next(),
          });
        });
      await assert.rejects(kitchen(), refused("RECIPE_AUTHORING_REVIEW_REQUIRED"));
      const published = await tx((t) => loadRecipe(t, scope, ownRecipe, clock()));
      await assert.rejects(
        ownReview(ownRecipe, published.versionReference, owner, "Cost", false, "Preparation"),
        refused("RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT"),
      );
      for (const kind of ["Cost", "FoodSafety"])
        assert.equal(
          (await ownReview(ownRecipe, published.versionReference, owner, kind, true, "Preparation"))
            .status,
          "Applied",
        );
      const kitchenOperation = next();
      assert.equal((await kitchen(kitchenOperation)).status, "Applied");
      assert.equal((await kitchen(kitchenOperation)).status, "AlreadyApplied");
      const preparation = (
        await admin.query(
          "SELECT record_json #> '{reviewEvidence,reviews}' reviews FROM rms_recipe.recipe_preparation_content WHERE recipe_version_id=$1 AND modifier_rule_version_id IS NULL",
          [published.versionReference],
        )
      ).rows[0];
      assert.deepEqual(
        preparation.reviews.map((review) => [review.reviewerActorReference, review.reviewMode]),
        [
          [owner, "SoleOperator"],
          [owner, "SoleOperator"],
        ],
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT review_mode FROM rms_recipe.recipe_authoring_review WHERE recipe_version_id=$1 AND subject='Preparation'",
            [published.versionReference],
          )
        ).rows.map((row) => row.review_mode),
        ["SoleOperator", "SoleOperator"],
      );

      // 4. A second reviewer joins: the waiver lapses; a sole review given before no longer counts.
      const second = id(0x800);
      await save({
        actorReference: owner,
        recipeReference: second,
        draft: draft({ code: "LATTE-SOLE-2" }),
      });
      const secondDraft = await tx((t) => loadRecipe(t, scope, second, clock()));
      await ownReview(second, secondDraft.versionReference, owner, "Cost", true);
      await seedBrandMember(admin, {
        id,
        base: 0x900,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        actorReference: noah,
        name: "Noah",
        roles: [reviewerRole],
        from,
        enrolledAt,
      });
      await assert.rejects(
        ownReview(second, secondDraft.versionReference, owner, "FoodSafety", true),
        refused("NotInEffect"),
      );
      await ownReview(second, secondDraft.versionReference, noah, "FoodSafety", false);
      await assert.rejects(
        ownPublish(second, secondDraft.aggregateVersion),
        refused("RECIPE_AUTHORING_SOLE_OPERATOR_NOT_IN_EFFECT"),
      );

      // 5. The database refuses an unmarked second review by the same person, and a mark whose
      // second factor is older than 15 minutes; reviews stay append-only.
      const third = id(0xa00);
      await save({
        actorReference: author,
        recipeReference: third,
        draft: draft({ code: "LATTE-SOLE-3" }),
      });
      const thirdDraft = await tx((t) => loadRecipe(t, scope, third, clock()));
      const insert = (kind, mode, mfa) =>
        admin.query(
          "INSERT INTO rms_recipe.recipe_authoring_review (review_id,recipe_version_id,recipe_id,brand_id,subject,subject_digest,review_kind,decision,reviewer_actor_id,author_actor_id,comment,reviewed_at,audit_id,review_mode,reviewer_mfa_at) VALUES ($1,$2,$3,$4,'Recipe',$5,$6,'Approved',$7,$8,NULL,now(),$9,$10,$11)",
          [
            next(),
            thirdDraft.versionReference,
            third,
            scope.brandReference,
            "sha256:" + "a".repeat(64),
            kind,
            owner,
            author,
            next(),
            mode,
            mfa,
          ],
        );
      await insert("Cost", "Independent", null);
      await assert.rejects(insert("FoodSafety", "Independent", null), /need two reviewers/u);
      await assert.rejects(
        insert("FoodSafety", "SoleOperator", new Date(Date.now() - 16 * 60_000).toISOString()),
        /recipe_authoring_review_sole_operator_mfa|need two reviewers/u,
      );
      await assert.rejects(
        admin.query("UPDATE rms_recipe.recipe_authoring_review SET review_mode='SoleOperator'"),
        /append-only/u,
      );
    } finally {
      await admin.end();
    }
  });
});
