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
  archiveRecipe,
  bindRecipeToSku,
  createPostgresConfiguredRecipePreparationSource,
  createPostgresRecipePreparationContentStore,
  createPostgresSubmissionRecipeDemandSource,
  endStoreRecipeBinding,
  listPublishedSubRecipes,
  listRecipes,
  loadRecipe,
  parseRecipeDraft,
  publishRecipe,
  publishRecipePreparation,
  recordRecipeReview,
  saveRecipeDraft,
} from "../../rms/recipe/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { kilogram, litre, syntheticInventoryItems } from "../test-support/inventory-items.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";

const { Client } = pg;
const id = (n) => "01909a18-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/** WP-2423 / DEC-RECIPE-AUTHORING: drafts, independent reviews, publication, SKUs and revisions. */
it("authors, reviews, publishes and binds recipes that orders and kitchen tickets resolve", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_recipe_author" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    let sequence = 1000,
      minute = 0;
    const next = () => id(++sequence);
    const clock = () => {
      minute += 1;
      return `2026-10-07T${String(10 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
    };
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const [author, costReviewer, safetyReviewer, owner] = [id(4), id(5), id(6), id(7)];
    const sku = id(8),
      otherSku = id(9);
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
    const role = "wp2423_recipe_" + context.runId;
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

      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [
        "GRANT USAGE ON SCHEMA rms_recipe,rms_inventory,rms_kitchen,platform_audit,platform_eventing,platform_helpers TO ROLE_",
        "GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ROLE_",
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe,rms_recipe.recipe_scope_binding TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe_reference_generation TO ROLE_",
        "GRANT SELECT,UPDATE ON rms_recipe.recipe_modifier_version TO ROLE_",
        "GRANT SELECT,INSERT ON rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement,rms_recipe.recipe_allergen_evidence,rms_recipe.recipe_preparation_step,rms_recipe.recipe_operation_record,rms_recipe.recipe_review_record,rms_recipe.recipe_preparation_content,rms_recipe.recipe_version_presentation,rms_recipe.recipe_authoring_review,rms_recipe.recipe_scope_binding_end,rms_recipe.recipe_reference_binding TO ROLE_",
        "GRANT SELECT ON rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,rms_inventory.stock_movement,rms_kitchen.kitchen_routing_configuration TO ROLE_",
        "GRANT SELECT,INSERT ON platform_audit.audit_record TO ROLE_",
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ROLE_",
        "GRANT INSERT ON platform_eventing.outbox_event TO ROLE_",
      ])
        await admin.query(sql.replaceAll("ROLE_", role));
      const facts = async () => {
        const inventory = await tx((t) => listInventoryRecipeIngredientFacts(t, scope));
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

      const review = (
        actor,
        kind,
        decision,
        subject = "Recipe",
        version = current.versionReference,
      ) =>
        tx((t) =>
          recordRecipeReview(t, scope, {
            actorReference: actor,
            at: clock(),
            nextReference: next,
            reviewReference: next(),
            recipeReference: recipe,
            versionReference: version,
            subject,
            kind,
            decision,
            comment: decision === "Rejected" ? "Too much milk for 12 oz" : null,
            auditReference: next(),
          }),
        );
      const publish = (authorized = true, operation = next()) =>
        tx((t) =>
          publishRecipe(t, scope, {
            actorReference: owner,
            at: clock(),
            nextReference: next,
            operationReference: operation,
            recipeReference: recipe,
            expectedAggregateVersion: current.aggregateVersion,
            facts: initial.recipeFacts,
            reviewersAuthorized: async () => authorized,
            auditReference: next(),
          }),
        );
      await assert.rejects(review(author, "Cost", "Approved"), {
        code: "RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT",
      });
      await review(costReviewer, "Cost", "Approved");
      await assert.rejects(review(costReviewer, "FoodSafety", "Approved"), {
        code: "RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT",
      });
      await assert.rejects(review(safetyReviewer, "Cost", "Approved"), {
        code: "RECIPE_AUTHORING_CONFLICT",
      });
      await review(safetyReviewer, "FoodSafety", "Rejected");
      await assert.rejects(publish(), { code: "RECIPE_AUTHORING_REVIEW_REQUIRED" });
      // A new version starts the reviews over; the database refuses a self-review written around the code.
      await save({
        expectedAggregateVersion: 1,
        draft: draft({
          ingredients: [
            {
              kind: "InventoryItem",
              sourceReference: milk,
              quantity: "0.22",
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
        }),
      });
      await assert.rejects(save({ expectedAggregateVersion: 1 }), {
        code: "RECIPE_AUTHORING_CONFLICT",
      });
      current = await detail();
      assert.equal(current.aggregateVersion, 2);
      assert.equal(current.reviews.length, 0);
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_recipe.recipe_authoring_review VALUES($1,$2,$3,$4,'Recipe',$5,'Cost','Approved',$6,$6,NULL,$7,$8)",
          [
            next(),
            current.versionReference,
            recipe,
            scope.brandReference,
            "sha256:" + "a".repeat(64),
            author,
            clock(),
            next(),
          ],
        ),
        /recipe_authoring_review_independent/u,
      );
      await review(costReviewer, "Cost", "Approved");
      await review(safetyReviewer, "FoodSafety", "Approved");
      // Reviewers who no longer hold reviewer permission cannot carry a publication.
      await assert.rejects(publish(false), { code: "RECIPE_AUTHORING_REVIEW_REQUIRED" });
      const publishOperation = next();
      assert.equal((await publish(true, publishOperation)).status, "Applied");
      current = await detail();
      assert.equal(current.lifecycle, "Published");
      assert.equal(current.kitchenInstructions, "NotPublished");
      const evidence = await admin.query(
        "SELECT review_kind,reviewer_actor_id::text r FROM rms_recipe.recipe_review_record WHERE recipe_version_id=$1 ORDER BY review_kind",
        [current.versionReference],
      );
      assert.deepEqual(evidence.rows, [
        { review_kind: "Cost", r: costReviewer },
        { review_kind: "FoodSafety", r: safetyReviewer },
      ]);

      const bind = (input) =>
        tx((t) =>
          bindRecipeToSku(t, scope, {
            actorReference: owner,
            at: clock(),
            nextReference: next,
            operationReference: next(),
            recipeReference: recipe,
            skuReference: sku,
            storeReference: null,
            skuUnitOfSale: "EACH",
            auditReference: next(),
            ...input,
          }),
        );
      // Kitchen instructions are reviewed and published before a SKU can use the recipe.
      await assert.rejects(bind({}), { code: "RECIPE_AUTHORING_LIFECYCLE" });
      const kitchen = (operation = next()) =>
        tx((t) =>
          publishRecipePreparation(t, scope, {
            actorReference: owner,
            at: clock(),
            nextReference: next,
            operationReference: operation,
            recipeReference: recipe,
            reviewersAuthorized: async () => true,
            auditReference: next(),
          }),
        );
      await assert.rejects(kitchen(), { code: "RECIPE_AUTHORING_REVIEW_REQUIRED" });
      await review(costReviewer, "Cost", "Approved", "Preparation");
      await review(safetyReviewer, "FoodSafety", "Approved", "Preparation");
      const kitchenOperation = next();
      assert.equal((await kitchen(kitchenOperation)).status, "Applied");
      assert.equal((await kitchen(kitchenOperation)).status, "AlreadyApplied");
      await assert.rejects(bind({ skuUnitOfSale: "KG" }), { code: "RECIPE_AUTHORING_INVALID" });
      assert.equal((await bind({})).status, "Applied");

      // Orders and kitchen tickets resolve the bound recipe.
      const demand = (at) =>
        tx((t) =>
          createPostgresSubmissionRecipeDemandSource(
            { run: (work) => work(t) },
            scope.brandReference,
          ).resolve({
            storeReference: scope.storeReference,
            skuReference: sku,
            occurredAt: at,
            saleUnitCode: "EACH",
            unitQuantity: "1",
            saleQuantity: 2,
            selections: [],
          }),
        );
      const firstDemand = await demand(clock());
      assert.equal(firstDemand.snapshot.recipeReference, recipe);
      const byItem = new Map(
        firstDemand.requirements.map((requirement) => [
          requirement.itemReference,
          // Base-unit microunits.
          Number(requirement.quantityNumerator) / Number(requirement.quantityDenominator) / 1e6,
        ]),
      );
      assert.equal(byItem.get(milk), 0.44);
      assert.equal(byItem.get(beans), 0.0378);
      const contentStore = createPostgresRecipePreparationContentStore({
        brandReference: scope.brandReference,
        sha256,
        authorizeRead: async () => true,
        authorizeWrite: async () => false,
        validatePublication: async () => false,
        audit: async () => null,
      });
      const kitchenSource = createPostgresConfiguredRecipePreparationSource({
        brandReference: scope.brandReference,
        sha256,
        content: contentStore,
        authorize: async () => true,
      });
      const ticket = await tx((t) =>
        kitchenSource.resolve(t, {
          actorType: "System",
          actorReference: null,
          action: "ResolveConfiguredRecipePreparation",
          purpose: "CreateKitchenWork",
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          skuReference: sku,
          effectiveAt: clock(),
          selectedOptions: [],
        }),
      );
      assert.deepEqual(ticket.display.requiredStationCapabilityReferences, [capability]);
      assert.match(ticket.display.instructions[1], /Steam 250 ml milk and pour\.$/u);

      // A revision: drafted beside the published recipe, which stays in use until re-bound.
      const revision = id(200);
      await assert.rejects(
        tx((t) =>
          saveRecipeDraft(t, scope, {
            actorReference: author,
            at: clock(),
            nextReference: next,
            operationReference: next(),
            recipeReference: id(201),
            expectedAggregateVersion: null,
            revisionOf: id(299),
            draft: draft({ code: "LATTE-12-R2" }),
            facts: initial.recipeFacts,
            auditReference: next(),
          }),
        ),
        { code: "RECIPE_AUTHORING_NOT_FOUND" },
      );
      await save({
        recipeReference: revision,
        revisionOf: recipe,
        draft: draft({ code: "LATTE-12-R2", name: "Latte 12 oz" }),
      });
      await assert.rejects(
        save({
          recipeReference: id(202),
          revisionOf: recipe,
          draft: draft({ code: "LATTE-12-R3" }),
        }),
        { code: "RECIPE_AUTHORING_CONFLICT" },
      );
      const revised = await tx((t) => loadRecipe(t, scope, revision, clock()));
      assert.deepEqual(
        revised.family.map((member) => [member.revision, member.lifecycle]),
        [
          [1, "Published"],
          [2, "Draft"],
        ],
      );
      assert.equal((await demand(clock())).snapshot.recipeReference, recipe);
      const reviewRevision = (actor, kind, subject) =>
        tx(async (t) => {
          const now = await loadRecipe(t, scope, revision, clock());
          return recordRecipeReview(t, scope, {
            actorReference: actor,
            at: clock(),
            nextReference: next,
            reviewReference: next(),
            recipeReference: revision,
            versionReference: now.versionReference,
            subject,
            kind,
            decision: "Approved",
            comment: null,
            auditReference: next(),
          });
        });
      await reviewRevision(costReviewer, "Cost", "Recipe");
      await reviewRevision(safetyReviewer, "FoodSafety", "Recipe");
      await tx((t) =>
        publishRecipe(t, scope, {
          actorReference: owner,
          at: clock(),
          nextReference: next,
          operationReference: next(),
          recipeReference: revision,
          expectedAggregateVersion: 1,
          facts: initial.recipeFacts,
          reviewersAuthorized: async () => true,
          auditReference: next(),
        }),
      );
      await reviewRevision(costReviewer, "Cost", "Preparation");
      await reviewRevision(safetyReviewer, "FoodSafety", "Preparation");
      await tx((t) =>
        publishRecipePreparation(t, scope, {
          actorReference: owner,
          at: clock(),
          nextReference: next,
          operationReference: next(),
          recipeReference: revision,
          reviewersAuthorized: async () => true,
          auditReference: next(),
        }),
      );
      // In use: the original cannot be archived while its binding applies.
      await assert.rejects(
        tx((t) =>
          archiveRecipe(t, scope, {
            actorReference: owner,
            at: clock(),
            nextReference: next,
            operationReference: next(),
            recipeReference: recipe,
            expectedAggregateVersion: current.aggregateVersion,
            auditReference: next(),
          }),
        ),
        { code: "RECIPE_AUTHORING_IN_USE" },
      );
      const switchAt = clock();
      assert.equal((await bind({ recipeReference: revision })).status, "Applied");
      assert.equal((await demand(clock())).snapshot.recipeReference, revision);
      // An order observed before the switch still resolves the original recipe.
      assert.equal((await demand(switchAt)).snapshot.recipeReference, recipe);
      assert.equal(
        (
          await tx((t) =>
            archiveRecipe(t, scope, {
              actorReference: owner,
              at: clock(),
              nextReference: next,
              operationReference: next(),
              recipeReference: recipe,
              expectedAggregateVersion: current.aggregateVersion,
              auditReference: next(),
            }),
          )
        ).status,
        "Applied",
      );

      // A Store-specific recipe overrides the Brand one there and can be removed again.
      assert.equal(
        (
          await bind({
            recipeReference: revision,
            skuReference: otherSku,
            storeReference: scope.storeReference,
          })
        ).status,
        "Applied",
      );
      const list = await tx((t) => listRecipes(t, scope, clock()));
      const listed = list.find((item) => item.recipeReference === revision);
      assert.deepEqual(
        listed.bindings.map((binding) => [binding.skuReference, binding.storeReference]),
        [
          [sku, null],
          [otherSku, scope.storeReference],
        ],
      );
      const end = (bindingReference) =>
        tx((t) =>
          endStoreRecipeBinding(t, scope, {
            actorReference: owner,
            at: clock(),
            nextReference: next,
            operationReference: next(),
            bindingReference,
            auditReference: next(),
          }),
        );
      await assert.rejects(end(listed.bindings[0].bindingReference), {
        code: "RECIPE_AUTHORING_IN_USE",
      });
      assert.equal((await end(listed.bindings[1].bindingReference)).status, "Applied");
      await assert.rejects(
        admin.query("UPDATE rms_recipe.recipe_scope_binding_end SET reason_code='REMOVED'"),
        /append-only/u,
      );
      const audit = await admin.query(
        "SELECT action_code,count(*)::int n FROM platform_audit.audit_record WHERE action_code LIKE 'RECIPE_%' GROUP BY 1 ORDER BY 1",
      );
      assert.deepEqual(Object.fromEntries(audit.rows.map((row) => [row.action_code, row.n])), {
        RECIPE_ARCHIVE: 1,
        RECIPE_CREATEDRAFT: 2,
        RECIPE_PREPARATION_PUBLISHED: 2,
        RECIPE_PUBLISH: 2,
        RECIPE_REPLACEDRAFT: 1,
        RECIPE_REVIEW_RECORDED: 10,
        RECIPE_SKU_BOUND: 3,
        RECIPE_SKU_UNBOUND: 1,
      });
    } finally {
      await admin.end();
    }
  });
});
