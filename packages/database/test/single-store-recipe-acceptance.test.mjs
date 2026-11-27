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
} from "../test-support/sole-operator-brand-gate.mjs";
import { requireMerchantBrandSingleStore } from "../../../apps/api/src/merchant-sole-operator.ts";

const { Client } = pg;
const id = (n) => "01909a4f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7; coordinator condition 4):
 * at a Brand with one store, the author of a recipe gives its Cost and FoodSafety reviews alone
 * when they list the dish, each marked SingleStoreListing with the store; publishing re-reads that
 * the Brand still has that one store. Restricted pilot API role; setup facts as in the recipe
 * authoring acceptance:
 * 1. one store: the author reviews alone (both kinds, marked) and publishes;
 * 2. the mark is only for the author's own recipe;
 * 3. someone without recipe approval cannot;
 * 4. a second store (a draft one) refuses new marked reviews and the publication of marked
 *    reviews given before, and the database refuses the mark itself; archived, it is back;
 * 5. the database requires the store on the mark and the same mark on both kinds.
 */
it("recipe review: a single store's author reviews and publishes alone; no approval or a second store refuses", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_recipe" }, async (context) => {
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
    const role = "wp2423_ssr_" + context.runId;
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

      // ── Organization, Membership and Permission facts: one store; the owner holds recipe
      // approval, Kai (front of house) only edits recipes.
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrand(admin, {
        brandReference: scope.brandReference,
        policyReference: id(300),
        from,
      });
      const store = (reference, code, lifecycle) =>
        admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD',$5,1,$6,$6)",
          [reference, scope.brandReference, code, "Synthetic " + code, lifecycle, from],
        );
      await store(scope.storeReference, "STORE_ONE", "Active");
      const reviewerRole = await seedBrandRole(admin, {
        id,
        brandReference: scope.brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: ["recipe.approve", "recipe.publish", "recipe.update"],
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
      const kai = id(0x500);
      const editorRole = await seedBrandRole(admin, {
        id,
        brandReference: scope.brandReference,
        roleId: id(320),
        code: "front_of_house",
        actions: ["recipe.update"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 0x900,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        actorReference: kai,
        name: "Kai",
        roles: [editorRole],
        from,
        enrolledAt,
      });
      const singleStore = (t, actor, at) =>
        requireMerchantBrandSingleStore(t, {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          actorReference: actor,
          permissionCode: "recipe.approve",
          observedAt: at,
          allowed: async () => true,
        });
      /** A review as the composition makes it: `single` reads the store gate in the same transaction. */
      const review = (recipeReference, versionReference, actor, kind, single) =>
        tx(async (t) => {
          const at = clock();
          if (single) await singleStore(t, actor, at);
          return recordRecipeReview(t, scope, {
            actorReference: actor,
            at,
            nextReference: next,
            reviewReference: next(),
            recipeReference,
            versionReference,
            subject: "Recipe",
            kind,
            decision: "Approved",
            comment: null,
            auditReference: next(),
            ...(single ? { singleStoreListing: { storeReference: scope.storeReference } } : {}),
          });
        });
      const publish = (recipeReference, aggregateVersion) =>
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
            singleStoreListingEffective: async (actor) =>
              singleStore(t, actor, at).then(
                () => true,
                (error) => {
                  if (error?.name === "MerchantSingleStoreListingError") return false;
                  throw error;
                },
              ),
            auditReference: next(),
          });
        });
      const refused = (code) => (error) => {
        assert.equal(error.code, code);
        return true;
      };
      const draftOf = async (actor, recipeReference, code) => {
        await save({ actorReference: actor, recipeReference, draft: draft({ code }) });
        return tx((t) => loadRecipe(t, scope, recipeReference, clock()));
      };

      // 1. One store: the owner's own recipe; unmarked self-review is refused, both marked reviews
      // are recorded with the store, and the owner publishes.
      const ownRecipe = id(0x600);
      const own = await draftOf(owner, ownRecipe, "DISH-ONE");
      await assert.rejects(
        review(ownRecipe, own.versionReference, owner, "Cost", false),
        refused("RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT"),
      );
      assert.equal(
        (await review(ownRecipe, own.versionReference, owner, "Cost", true)).status,
        "Applied",
      );
      await assert.rejects(
        review(ownRecipe, own.versionReference, owner, "FoodSafety", false),
        refused("RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT"),
      );
      assert.equal(
        (await review(ownRecipe, own.versionReference, owner, "FoodSafety", true)).status,
        "Applied",
      );
      const marked = (
        await admin.query(
          "SELECT review_kind,reviewer_actor_id::text r,author_actor_id::text a,review_mode,listing_store_id::text store,audit_id::text audit FROM rms_recipe.recipe_authoring_review WHERE recipe_version_id=$1 ORDER BY review_kind",
          [own.versionReference],
        )
      ).rows;
      assert.deepEqual(
        marked.map((row) => [row.review_kind, row.r, row.a, row.review_mode, row.store]),
        [
          ["Cost", owner, owner, "SingleStoreListing", scope.storeReference],
          ["FoodSafety", owner, owner, "SingleStoreListing", scope.storeReference],
        ],
      );
      assert.equal(
        (
          await admin.query(
            "SELECT after_summary_json->>'approvalMode' mode FROM platform_audit.audit_record WHERE audit_id=$1",
            [marked[0].audit],
          )
        ).rows[0].mode,
        "SingleStoreListing",
      );
      assert.equal((await publish(ownRecipe, own.aggregateVersion)).status, "Applied");
      assert.equal(
        (await tx((t) => loadRecipe(t, scope, ownRecipe, clock()))).lifecycle,
        "Published",
      );

      // 2. The mark is only for one's own recipe: the owner reviewing another's alone is refused.
      const others = id(0x700);
      const other = await draftOf(author, others, "DISH-OTHER");
      await assert.rejects(
        review(others, other.versionReference, owner, "Cost", true),
        refused("RECIPE_AUTHORING_INVALID"),
      );

      // 3. Kai holds no recipe approval: cannot review even their own recipe alone.
      const kaiRecipe = id(0x800);
      const kais = await draftOf(kai, kaiRecipe, "DISH-KAI");
      await assert.rejects(
        review(kaiRecipe, kais.versionReference, kai, "Cost", true),
        refused("NotPermitted"),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_recipe.recipe_authoring_review WHERE recipe_version_id=$1",
            [kais.versionReference],
          )
        ).rows[0].n,
        0,
      );

      // 4. Both reviews given at one store; then a second (draft) store is added.
      const laterRecipe = id(0xa00);
      const later = await draftOf(owner, laterRecipe, "DISH-LATER");
      for (const kind of ["Cost", "FoodSafety"])
        await review(laterRecipe, later.versionReference, owner, kind, true);
      const nextRecipe = id(0xb00);
      const nextDraft = await draftOf(owner, nextRecipe, "DISH-NEXT");
      await store(id(6), "STORE_TWO", "Draft");
      // New marked reviews are refused by the command; reviews given before no longer publish.
      await assert.rejects(
        review(nextRecipe, nextDraft.versionReference, owner, "Cost", true),
        refused("NotSingleStore"),
      );
      await assert.rejects(
        publish(laterRecipe, later.aggregateVersion),
        refused("RECIPE_AUTHORING_NOT_SINGLE_STORE"),
      );
      // Even without the command's check, the database refuses the marked review itself.
      await assert.rejects(
        tx((t) =>
          recordRecipeReview(t, scope, {
            actorReference: owner,
            at: clock(),
            nextReference: next,
            reviewReference: next(),
            recipeReference: nextRecipe,
            versionReference: nextDraft.versionReference,
            subject: "Recipe",
            kind: "Cost",
            decision: "Approved",
            comment: null,
            auditReference: next(),
            singleStoreListing: { storeReference: scope.storeReference },
          }),
        ),
        /recipe single store review needs a brand with one store/u,
      );
      // Archived, the second store no longer counts: the owner's recipe publishes again.
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=2 WHERE store_id=$1",
        [id(6)],
      );
      assert.equal((await publish(laterRecipe, later.aggregateVersion)).status, "Applied");

      // 5. The database requires the store on the mark, and the same mark on both kinds.
      const insert = (kind, mode, listingStore) =>
        admin.query(
          "INSERT INTO rms_recipe.recipe_authoring_review (review_id,recipe_version_id,recipe_id,brand_id,subject,subject_digest,review_kind,decision,reviewer_actor_id,author_actor_id,comment,reviewed_at,audit_id,review_mode,reviewer_mfa_at,listing_store_id) VALUES ($1,$2,$3,$4,'Recipe',$5,$6,'Approved',$7,$7,NULL,now(),$8,$9,NULL,$10)",
          [
            next(),
            nextDraft.versionReference,
            nextRecipe,
            scope.brandReference,
            "sha256:" + "a".repeat(64),
            kind,
            owner,
            next(),
            mode,
            listingStore,
          ],
        );
      await assert.rejects(
        insert("Cost", "SingleStoreListing", null),
        /recipe_authoring_review_single_store/u,
      );
      await assert.rejects(
        insert("Cost", "Independent", scope.storeReference),
        /recipe_authoring_review_single_store|recipe_authoring_review_independent/u,
      );
      await insert("Cost", "SingleStoreListing", scope.storeReference);
      await assert.rejects(
        insert("FoodSafety", "SoleOperator", null),
        /need two reviewers|recipe_authoring_review_sole_operator_mfa/u,
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_recipe.recipe_authoring_review SET review_mode='Independent' WHERE review_mode='SingleStoreListing'",
        ),
        /append-only/u,
      );
    } finally {
      await admin.end();
    }
  });
});
