import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { dishesNotPreparedByDefault } from "../../../apps/api/src/merchant-kitchen-not-prepared.ts";
import { listedTeaChoices } from "../../../apps/api/src/merchant-store-features.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import { pickupHandoffAuditDetails } from "../../rms/fulfillment/src/index.ts";
import {
  changeDiningTeaChargeSetting,
  loadDiningTeaChargeSetting,
} from "../../rms/dining/src/index.ts";
import {
  createFulfillmentReadinessService,
  createPickupFulfillmentService,
  createPostgresFulfillmentReadinessStore,
  createPostgresPickupFulfillmentStore,
  createPostgresPickupHandoffStore,
} from "../../rms/fulfillment/src/index.ts";
import {
  changeKitchenNotPreparedProduct,
  createConfirmedOrderIntakeReceipt,
  createKitchenNotPreparedIntakeAdapter,
  listKitchenLinesReadyWithoutWork,
  listKitchenNotPreparedOrderItems,
  loadKitchenBatchPreparationDecision,
  parseKitchenItemReadyEnvelope,
  parseKitchenOrderReadyEnvelope,
} from "../../rms/kitchen/src/index.ts";
import {
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  parseConfirmedOrderFulfillmentSourceEvidence,
  parseOrderConfirmedEnvelope,
} from "../../rms/ordering/src/index.ts";
import { listDeclaredChargeSkus, skuRecipeUsesStock } from "../../rms/recipe/src/index.ts";
import { kitchenDefaultNotPrepared } from "../../../tooling/environment/pilot-kitchen.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createOneStoreMenuFixture } from "../test-support/one-store-menu-fixture.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const derive = (prefix) => (purpose, identity) => {
  const digest = createHash("sha256")
    .update(purpose + identity)
    .digest("hex");
  return (
    prefix +
    "-" +
    digest.slice(0, 4) +
    "-7" +
    digest.slice(4, 7) +
    "-8" +
    digest.slice(7, 10) +
    "-" +
    digest.slice(10, 22)
  );
};

/**
 * WP-2423 item 8a: a dish declared a charge still reached the kitchen unless the owner also ticked
 * "Not prepared by the kitchen" (live: a sauce bar with 5 kitchen work items). A round reaching the
 * kitchen now decides: this Store's own mark wins, either way; with no mark a size declared a charge
 * and the Store's tea item are not prepared; everything else is. Pickup rounds follow the same rule:
 * the lines left out are ready when the rest is, and a round with nothing to prepare is ready at
 * once, so it can be handed over. Under the restricted NOBYPASSRLS role with the rendered pilot API
 * grants, against the real owner stores; the order itself is synthetic (test-only evidence).
 */
const scenario = async (context, caseName, work) => {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  const role = await createPilotApiRole(admin, context, caseName);
  const f = await createOneStoreMenuFixture(admin, context, {
    role,
    orderTypes: ["DINE_IN", "PICKUP"],
  });
  const scope = { brandReference: f.brandReference, storeReference: f.storeReference };
  let number = 0;
  const reference = () => "019b0007-0000-7000-8000-" + (++number).toString(16).padStart(12, "0");
  const now = () => new Date().toISOString();
  const asApi = f.asApi;
  /** A confirmed round of these dishes (synthetic Ordering evidence). */
  const round = (lines) => {
    const order = reference(),
      batch = reference(),
      confirmation = reference(),
      eventId = reference();
    const confirmedAt = new Date(Date.now() - 60_000).toISOString();
    const event = parseOrderConfirmedEnvelope({
      eventId,
      eventType: "OrderConfirmed",
      schemaVersion: 1,
      occurredAt: confirmedAt,
      producerModule: "@rms/ordering",
      tenantId: scope.brandReference,
      storeId: scope.storeReference,
      aggregateType: "Order",
      aggregateId: order,
      aggregateVersion: 2n,
      correlationId: reference(),
      causationId: reference(),
      actor: { type: "System" },
      payload: {
        confirmationReference: confirmation,
        orderReference: order,
        orderBatchReference: batch,
        sourceSnapshotDigest: sha("order" + order),
        confirmedAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
    const receipt = createConfirmedOrderIntakeReceipt({
      sourceEvent: event,
      semanticEventBindingDigest: sha("semantic:" + eventId),
    });
    return {
      order,
      batch,
      confirmation,
      eventId,
      event,
      receipt,
      confirmedAt,
      lines: lines.map((line) => ({
        orderItemReference: reference(),
        productReference: line.productReference,
        skuReference: line.skuReference,
        quantity: line.quantity ?? 1,
      })),
    };
  };
  const tickets = [];
  /** What a round reaching the kitchen does: the real adapter, as the pilot composes it. */
  const reach = (current, orderType = "DineIn") =>
    asApi((tx) =>
      createKitchenNotPreparedIntakeAdapter({
        inner: {
          resolveByIdentity: async () => ({ status: "NotFound" }),
          accept: async (input) => {
            tickets.push(String(input.receipt.orderBatchReference));
            return { status: "Created", receipt: input.receipt };
          },
        },
        scope,
        now,
        derive: derive("01a0f071"),
        allLines: async () => current.lines,
        notPreparedByDefault: kitchenDefaultNotPrepared(scope),
        orderType: async () => orderType,
      }).accept({ receipt: current.receipt, transaction: tx }),
    );
  const decisionOf = (current) =>
    asApi((tx) => loadKitchenBatchPreparationDecision(tx, scope, current.batch));
  const mark = (product, expectedVersion, notPrepared) =>
    asApi((tx) =>
      changeKitchenNotPreparedProduct(
        tx,
        { ...scope, tenantReference: f.tenantReference },
        {
          productReference: product,
          operationReference: reference(),
          expectedVersion,
          notPrepared,
          actorReference: f.owner,
          observedAt: now(),
        },
      ),
    );
  const dish = (name, overrides = {}) => f.saveDish({ name, nameZh: "", ...overrides });
  try {
    await work({
      admin,
      f,
      scope,
      reference,
      now,
      asApi,
      round,
      reach,
      tickets,
      decisionOf,
      mark,
      dish,
    });
  } finally {
    await f.close();
    await admin.end();
  }
};

it("a declared charge with no mark makes no ticket; the Store's own mark wins either way", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_charge_dflt" }, async (context) => {
    await scenario(
      context,
      "wp2423_cd",
      async ({ admin, f, scope, asApi, round, reach, tickets, decisionOf, mark, dish }) => {
        const sauce = await dish("Sauce bar (TEST)", { allergens: "NoIngredients" });
        const noodles = await dish("Noodles (TEST)");
        const onlyCharge = round([sauce]);
        assert.equal((await reach(onlyCharge)).status, "Created");
        assert.deepEqual(tickets, [], "a declared charge with no mark makes no ticket");
        const decided = await decisionOf(onlyCharge);
        assert.equal(decided.allNotPrepared, true);

        // A mixed round leaves only the charge out.
        const mixed = round([sauce, noodles]);
        await reach(mixed);
        assert.deepEqual(tickets, [mixed.batch]);
        assert.deepEqual((await decisionOf(mixed)).notPreparedOrderItemReferences, [
          mixed.lines[0].orderItemReference,
        ]);
        // The line left out counts as served and does not hold checkout (Dining's public read).
        assert.deepEqual(
          [...(await asApi((tx) => listKitchenNotPreparedOrderItems(tx, scope, mixed.order)))],
          [mixed.lines[0].orderItemReference],
        );

        // "The kitchen does prepare it" is recorded at version 1, and the next round goes there.
        assert.deepEqual(await mark(sauce.productReference, 0, false), {
          notPrepared: false,
          version: 1,
        });
        const marks = await admin.query(
          "SELECT version,not_prepared,actor_id::text actor FROM rms_kitchen.kitchen_not_prepared_product WHERE product_id=$1",
          [sauce.productReference],
        );
        assert.deepEqual(marks.rows, [{ version: 1, not_prepared: false, actor: f.owner }]);
        const prepared = round([sauce]);
        await reach(prepared);
        assert.deepEqual(tickets, [mixed.batch, prepared.batch]);
        // A round already decided does not move when the mark changes.
        assert.equal((await decisionOf(onlyCharge)).allNotPrepared, true);
        assert.deepEqual((await decisionOf(prepared)).notPreparedOrderItemReferences, []);

        // A dish the owner marks is not prepared, as before.
        await mark(noodles.productReference, 0, true);
        const marked = round([noodles]);
        await reach(marked);
        assert.equal((await decisionOf(marked)).allNotPrepared, true);

        // What the editor shows (merchant read): the effective value and whether it was decided.
        const other = await dish("Corkage (TEST)", { allergens: "NoIngredients" });
        const plain = await dish("Dumplings (TEST)");
        const defaults = await asApi((tx) =>
          dishesNotPreparedByDefault(tx, { ...scope, tenantReference: f.tenantReference }, [
            other.productReference,
            plain.productReference,
            sauce.productReference,
          ]),
        );
        assert.deepEqual(
          [...defaults].sort(),
          [other.productReference, sauce.productReference].sort(),
        );

        // A second Store of the Brand gets the default with no copying.
        const second = f.id(0xdd10);
        await admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,'STORE_TWO','Synthetic STORE_TWO','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
          [second, f.brandReference, f.from],
        );
        assert.deepEqual(
          [
            ...(await asApi((tx) =>
              kitchenDefaultNotPrepared({
                brandReference: f.brandReference,
                storeReference: second,
              })(tx, [other.skuReference, plain.skuReference]),
            )),
          ],
          [other.skuReference],
        );

        // The charge later given a real recipe (another family) goes to the kitchen; a revision of
        // its own generated recipe (same family, new recipe) is still the charge.
        const generated = (
          await admin.query(
            "SELECT b.recipe_id::text recipe,b.recipe_version_id::text version FROM rms_recipe.recipe_scope_binding b WHERE b.brand_id=$1 AND b.sku_id=$2",
            [f.brandReference, other.skuReference],
          )
        ).rows[0];
        const list = () =>
          asApi((tx) =>
            listDeclaredChargeSkus(tx, scope, [other.skuReference, plain.skuReference]),
          );
        assert.deepEqual([...(await list())], [other.skuReference]);
        assert.equal(await asApi((tx) => skuRecipeUsesStock(tx, scope, other.skuReference)), false);
        await admin.query("SET session_replication_role = replica");
        try {
          // A revision: a new recipe id whose presentation keeps the family.
          const revisionRecipe = f.id(0xee00),
            revisionVersion = f.id(0xee01);
          await admin.query(
            "INSERT INTO rms_recipe.recipe_version_presentation(recipe_version_id,recipe_id,brand_id,family_id,family_revision,display_name,presentation_json,author_actor_id,recorded_at) VALUES($1,$2,$3,$4,2,'Corkage',$5::jsonb,$6,now())",
            [revisionVersion, revisionRecipe, f.brandReference, generated.recipe, "{}", f.owner],
          );
          await admin.query(
            "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,now()-interval '1 minute')",
            [f.id(0xee02), revisionVersion, revisionRecipe, f.brandReference, other.skuReference],
          );
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
        assert.deepEqual(
          [...(await list())],
          [other.skuReference],
          "a revision is the same charge",
        );
        assert.equal(
          await asApi((tx) => skuRecipeUsesStock(tx, scope, other.skuReference)),
          false,
          "a revision of a generated recipe uses no stock",
        );
        await admin.query("SET session_replication_role = replica");
        try {
          const real = f.id(0xee10),
            realVersion = f.id(0xee11);
          await admin.query(
            "INSERT INTO rms_recipe.recipe_version_presentation(recipe_version_id,recipe_id,brand_id,family_id,family_revision,display_name,presentation_json,author_actor_id,recorded_at) VALUES($1,$2,$3,$2,1,'Real corkage',$4::jsonb,$5,now())",
            [realVersion, real, f.brandReference, "{}", f.owner],
          );
          await admin.query(
            "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,now()-interval '1 minute')",
            [f.id(0xee12), realVersion, real, f.brandReference, other.skuReference],
          );
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
        assert.deepEqual([...(await list())], [], "given a real recipe it is a dish again");
        assert.equal(await asApi((tx) => skuRecipeUsesStock(tx, scope, other.skuReference)), true);
        const nowADish = round([other]);
        const before = tickets.length;
        await reach(nowADish);
        assert.equal(tickets.length, before + 1);
      },
    );
  });
});

it("a dish chosen as tea leaves the kitchen only while it is the tea; a mark stands", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_charge_tea" }, async (context) => {
    await scenario(
      context,
      "wp2423_ct",
      async ({
        admin,
        f,
        scope,
        reference,
        now,
        asApi,
        round,
        reach,
        tickets,
        decisionOf,
        mark,
        dish,
      }) => {
        const kungPao = await dish("Kung Pao chicken (TEST)");
        const sauceBar = await dish("Sauce bar (TEST)");
        const tea = await dish("Jasmine tea (TEST)", { allergens: "NoIngredients" });
        await f.listAll();
        const tenantScope = { ...scope, tenantReference: f.tenantReference };
        const setTea = (sku) =>
          asApi(async (tx) => {
            const before = await loadDiningTeaChargeSetting(tx, tenantScope);
            return changeDiningTeaChargeSetting(tx, tenantScope, {
              operationReference: reference(),
              expectedVersion: before.version,
              teaSellableReference: sku,
              actorReference: f.owner,
              observedAt: now(),
            });
          });
        // Before it is the tea, it goes to the kitchen.
        const first = round([kungPao]);
        await reach(first);
        assert.deepEqual(tickets, [first.batch]);
        // A slip of the select: it stays a dish on the record, it just doesn't go to the kitchen.
        await setTea(kungPao.skuReference);
        const asTea = round([kungPao]);
        await reach(asTea);
        assert.equal((await decisionOf(asTea)).allNotPrepared, true);
        assert.deepEqual(tickets, [first.batch]);
        // Nothing was written that would have to be undone.
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM rms_kitchen.kitchen_not_prepared_product WHERE brand_id=$1",
              [f.brandReference],
            )
          ).rows[0].n,
          0,
        );
        // Switched away, the dish makes a ticket on the next round.
        await setTea(tea.skuReference);
        const switched = round([kungPao]);
        await reach(switched);
        assert.deepEqual(tickets, [first.batch, switched.batch]);

        // An explicit "the kitchen makes it" is not overridden by being the tea.
        await mark(sauceBar.productReference, 0, false);
        await setTea(sauceBar.skuReference);
        const plated = round([sauceBar]);
        await reach(plated);
        assert.deepEqual(tickets, [first.batch, switched.batch, plated.batch]);

        // What the Store features page offers: which items are declared charges, and the price the
        // confirmation names for a dish.
        const choices = await asApi((tx) =>
          listedTeaChoices(tx, scope, new Date().toISOString(), f.currencyMetadata),
        );
        const byName = new Map(choices.map((choice) => [choice.name, choice]));
        assert.equal(byName.get("Jasmine tea (TEST)")?.declaredCharge, true);
        assert.equal(byName.get("Kung Pao chicken (TEST)")?.declaredCharge, false);
        assert.equal(byName.get("Kung Pao chicken (TEST)")?.priceAmount, "5.50");
        // The confirmation tells the truth about a dish the Store marked as made in the kitchen.
        assert.equal(byName.get("Kung Pao chicken (TEST)")?.kitchenPrepares, false);
        assert.equal(byName.get("Sauce bar (TEST)")?.kitchenPrepares, true);
      },
    );
  });
});

it("milk tea plus bag fee: the board shows only the tea, the order is Ready when the tea is, handover completes", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_charge_pickup" }, async (context) => {
    await scenario(
      context,
      "wp2423_cp",
      async ({
        admin,
        f,
        scope,
        reference,
        now,
        asApi,
        round,
        reach,
        tickets,
        decisionOf,
        dish,
      }) => {
        const milkTea = await dish("Milk tea (TEST)");
        const bagFee = await dish("Bag fee (TEST)", { allergens: "NoIngredients" });
        const audit = {
          append: ({ record, transaction: tx }) => appendAuditRecordInTransaction(tx, record),
        };
        const pickupReadiness = (authorizeQueue = true) =>
          createPostgresFulfillmentReadinessStore({
            ...scope,
            sha256: sha,
            now,
            authorize: async () => true,
            authorizeQueue: async () => authorizeQueue,
            validateCurrentSource: async () => true,
          });
        const readinessService = () =>
          createFulfillmentReadinessService({
            authorization: { authorize: async () => true },
            repository: pickupReadiness(),
            digests: { sha256: sha },
            references: { derive: derive("01a0f072") },
            audit,
          });
        /** The pickup of a round, as the confirmed-order consumer creates it. */
        const createPickup = async (current) => {
          const lines = current.lines.map((line, index) => {
            const row = {
              orderItemReference: line.orderItemReference,
              ordinal: index + 1,
              quantity: line.quantity,
              lineDigest: sha("x"),
            };
            return { ...row, lineDigest: sha(createOrderFulfillmentSourceLineBinding(row)) };
          });
          const raw = {
            evidenceReference: reference(),
            ...scope,
            orderReference: current.order,
            orderBatchReference: current.batch,
            confirmationReference: current.confirmation,
            sourceEventReference: current.eventId,
            sourceAggregateVersion: 2n,
            sourceSnapshotDigest: sha("order" + current.order),
            orderType: "Pickup",
            capturedAt: current.confirmedAt,
            evidenceVersion: 1,
            items: lines,
            evidenceDigest: sha("x"),
          };
          raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
          const source = parseConfirmedOrderFulfillmentSourceEvidence(raw);
          const created = await asApi((tx) =>
            createPickupFulfillmentService({
              authorization: { authorize: async () => true },
              orderingSource: { resolve: async () => source },
              references: { derive: derive("01a0f073") },
              digests: { sha256: sha },
              repository: createPostgresPickupFulfillmentStore({
                ...scope,
                sha256: sha,
                authorize: async () => true,
                validateCurrentSource: async () => true,
              }),
              audit,
            }).consume(tx, current.event),
          );
          assert.equal(created.status, "Created");
          return created.effect.aggregate;
        };
        const readyEvent = (current, line) => {
          const result = reference();
          const readyAt = now();
          return parseKitchenItemReadyEnvelope({
            eventId: reference(),
            eventType: "KitchenItemReady",
            schemaVersion: 1,
            occurredAt: readyAt,
            producerModule: "@rms/kitchen",
            tenantId: scope.brandReference,
            storeId: scope.storeReference,
            aggregateType: "KitchenOrderItemReadyResult",
            aggregateId: result,
            aggregateVersion: 1n,
            correlationId: reference(),
            causationId: reference(),
            actor: { type: "System" },
            payload: {
              kitchenTicketReference: reference(),
              orderReference: current.order,
              orderBatchReference: current.batch,
              orderItemReference: line.orderItemReference,
              readyResultReference: result,
              readyQuantity: line.quantity,
              requiredQuantity: line.quantity,
              readyAt,
            },
            redactionClassification: "indirect_identifier",
            replayMetadata: { replaySafe: true },
          });
        };
        const queue = () =>
          asApi((tx) =>
            pickupReadiness().listPickupQueue({
              transaction: tx,
              afterFulfillmentReference: null,
              limit: 10,
              includeCompleted: false,
            }),
          );
        const device = reference(),
          location = reference();
        const handoffStore = () =>
          createPostgresPickupHandoffStore({
            ...scope,
            actorReference: f.owner,
            sha256: sha,
            now,
            validateCurrentSource: async () => true,
            deriveCompletionReference: (kind, identity) => derive("01a0f074")(kind, identity),
            authorize: async () => true,
            admit: async () => true,
            appendAudit: (tx, record) =>
              appendAuditRecordInTransaction(tx, {
                auditId: record.auditReference,
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "User", reference: record.actorReference },
                actionCode: record.actionCode,
                targetType: "Fulfillment",
                targetId: record.fulfillmentReference,
                ...pickupHandoffAuditDetails(record),
                correlationId: record.correlationReference,
                occurredAt: record.occurredAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Confidential",
                retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
                retentionPolicyVersion: 1,
              }),
          });
        const handOver = (current) =>
          asApi(async (tx) => {
            const store = handoffStore();
            const state = await store.lockByOrder({
              transaction: tx,
              orderReference: current.order,
            });
            return store.complete({
              transaction: tx,
              orderReference: current.order,
              command: {
                fulfillmentReference: state.source.fulfillmentReference,
                ...scope,
                expectedAggregateVersion: state.source.aggregateVersion,
                purpose: "CompletePickupHandoff",
                actorReference: f.owner,
                actorPermissions: ["fulfillment.pickup.complete"],
                verification: {
                  verificationReference: reference(),
                  correlationReference: reference(),
                  fulfillmentReference: state.source.fulfillmentReference,
                  ...scope,
                  verificationMethod: "InPerson",
                  identityCheck: "OrderNumberAndName",
                  reason: "ProofNotIssued",
                  verifiedByActorReference: f.owner,
                  verifiedAt: now(),
                },
                recipientType: "Customer",
                recipientDisplayMask: "S***",
                pickupLocationReference: location,
                deviceReference: device,
                quantities: state.source.items
                  .filter((item) => item.readyQuantity > item.handedOverQuantity)
                  .map((item) => ({
                    fulfillmentItemReference: item.fulfillmentItemReference,
                    quantity: item.readyQuantity - item.handedOverQuantity,
                  })),
                handoffReference: reference(),
                operationReference: reference(),
                auditReference: reference(),
                idempotencyReference: reference(),
                correlationReference: reference(),
                handedOverAt: now(),
              },
            });
          });

        // ── The mixed round: milk tea and a bag fee.
        const mixed = round([milkTea, bagFee]);
        const pickup = await createPickup(mixed);
        await reach(mixed, "Pickup");
        // The board's source has only the tea; the bag fee waits for nothing from the kitchen.
        assert.deepEqual(tickets, [mixed.batch]);
        assert.deepEqual((await decisionOf(mixed)).notPreparedOrderItemReferences, [
          mixed.lines[1].orderItemReference,
        ]);
        assert.deepEqual(
          [...(await asApi((tx) => listKitchenLinesReadyWithoutWork(tx, scope, mixed.order)))],
          [mixed.lines[1].orderItemReference],
        );
        // Not ready yet: the tea is still being made.
        assert.deepEqual((await queue()).items, []);
        const before = await asApi((tx) =>
          pickupReadiness().lockByOrder({
            ...scope,
            orderReference: mixed.order,
            transaction: tx,
          }),
        );
        assert.equal(before.canonicalPhase, "Pending");
        assert.deepEqual(before.items.map((item) => item.state).sort(), ["Pending", "Ready"]);
        // The tea is finished: the whole order is Ready.
        const applied = await asApi((tx) =>
          readinessService().consume(tx, readyEvent(mixed, mixed.lines[0])),
        );
        assert.equal(applied.status, "Applied");
        assert.equal(applied.effect.operation.phaseAfter, "Ready");
        const listed = await queue();
        assert.equal(listed.items.length, 1);
        assert.deepEqual(
          listed.items[0].items.map((item) => item.readyQuantity),
          [1, 1],
        );
        assert.equal(listed.items[0].fulfillmentReference, pickup.fulfillmentReference);
        // Handover: every line goes, and the pickup is completed.
        const handed = await handOver(mixed);
        assert.equal(handed.status, "Applied");
        assert.equal(handed.effect.nextPhase, "Completed");
        assert.deepEqual((await queue()).items, []);

        // ── A marked dish on a Pickup round follows the same rule (it failed before: never Ready).
        const beforeTickets = tickets.length;
        const bottled = await dish("Bottled water (TEST)");
        await asApi((tx) =>
          changeKitchenNotPreparedProduct(
            tx,
            { ...scope, tenantReference: f.tenantReference },
            {
              productReference: bottled.productReference,
              operationReference: reference(),
              expectedVersion: 0,
              notPrepared: true,
              actorReference: f.owner,
              observedAt: now(),
            },
          ),
        );

        // ── A round with nothing to prepare (one bottle, a bag): ready at once, no kitchen step.
        const nothing = round([bottled, bagFee]);
        // Its ready events can come before the pickup exists; they are delivered again.
        await reach(nothing, "Pickup");
        assert.equal(
          tickets.length,
          beforeTickets,
          "no ticket for a round with nothing to prepare",
        );
        const published = (
          await admin.query(
            "SELECT event_id::text id,event_type,aggregate_type,aggregate_id::text aggregate,aggregate_version::text version,correlation_id::text correlation,causation_id::text causation,payload_json payload,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') at FROM platform_eventing.outbox_event WHERE event_type IN ('KitchenItemReady','KitchenOrderReady') AND payload_json->>'orderBatchReference'=$1 ORDER BY occurred_at,event_type",
            [nothing.batch],
          )
        ).rows;
        assert.deepEqual(published.map((row) => row.event_type).sort(), [
          "KitchenItemReady",
          "KitchenItemReady",
          "KitchenOrderReady",
        ]);
        const envelope = (row) => ({
          eventId: row.id,
          eventType: row.event_type,
          schemaVersion: 1,
          occurredAt: row.at,
          producerModule: "@rms/kitchen",
          tenantId: scope.brandReference,
          storeId: scope.storeReference,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate,
          aggregateVersion: BigInt(row.version),
          correlationId: row.correlation,
          causationId: row.causation,
          actor: { type: "System" },
          payload: row.payload,
          redactionClassification: "indirect_identifier",
          replayMetadata: { replaySafe: true },
        });
        const items = published
          .filter((row) => row.event_type === "KitchenItemReady")
          .map((row) => parseKitchenItemReadyEnvelope(envelope(row)));
        const whole = parseKitchenOrderReadyEnvelope(
          envelope(published.find((row) => row.event_type === "KitchenOrderReady")),
        );
        assert.equal(whole.payload.itemCount, 2);
        // Before the pickup exists the delivery asks to come again, instead of being rejected.
        const early = await asApi(async (tx) => {
          await tx.query("SAVEPOINT early", []);
          const outcome = await readinessService().registration.handler({
            envelope: items[0],
            transaction: tx,
          });
          await tx.query("ROLLBACK TO SAVEPOINT early", []);
          return outcome;
        });
        assert.equal(early.status, "retry_required");
        await createPickup(nothing);
        for (const event of items) {
          const outcome = await asApi((tx) => readinessService().consume(tx, event));
          assert.equal(outcome.status, "Applied");
        }
        const ready = await queue();
        assert.equal(ready.items.length, 1);
        assert.equal(ready.items[0].phase, "Ready");
        // A repeat of the round makes nothing twice.
        assert.equal((await reach(nothing, "Pickup")).status, "AlreadyAccepted");
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM platform_eventing.outbox_event WHERE event_type='KitchenOrderReady' AND payload_json->>'orderBatchReference'=$1",
              [nothing.batch],
            )
          ).rows[0].n,
          1,
        );
        const collected = await handOver(nothing);
        assert.equal(collected.effect.nextPhase, "Completed");

        // A dine-in round with nothing to prepare says nothing: it is served at the table.
        const table = round([bagFee]);
        await reach(table, "DineIn");
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM platform_eventing.outbox_event WHERE payload_json->>'orderBatchReference'=$1",
              [table.batch],
            )
          ).rows[0].n,
          0,
        );
        assert.equal((await decisionOf(table)).allNotPrepared, true);
      },
    );
  });
});
