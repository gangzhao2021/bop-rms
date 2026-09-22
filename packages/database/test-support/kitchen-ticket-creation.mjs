import { exercisePaidKitchenLifecycle } from "./kitchen-paid-lifecycle.mjs";
import { bootstrapKitchenRecipe } from "./kitchen-recipe-bootstrap.mjs";
import { exerciseKitchenRoutingConfiguration } from "./kitchen-routing-configuration.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPostgresKitchenTicketStore,
  createKitchenTicketIntakeAdapter,
  createConfirmedOrderConsumerService,
  createKitchenWorkPlanService,
} from "../../rms/kitchen/src/index.ts";

/** Actual Ordering source, Kitchen repository, Audit/Outbox/Inbox. Recipe publication/storage and routing are real; external review/Store/authority facts are synthetic. */
export async function exerciseKitchenTicketCreation({
  merchantKitchen,
  kitchenNow,
  onItemReady,
  reuseInventoryRecipe = false,
  admin,
  role,
  runner,
  scope,
  source,
  sourceQuery,
  orderRecord,
  event,
  at,
  id,
}) {
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const references = {
    derive(purpose, identity) {
      const digest = createHash("sha256")
        .update(purpose + ":" + identity)
        .digest("hex");
      return (
        "0190abcd-" +
        digest.slice(0, 4) +
        "-7" +
        digest.slice(4, 7) +
        "-8" +
        digest.slice(7, 10) +
        "-" +
        digest.slice(10, 22)
      );
    },
  };
  const tables = [
    "kitchen_ticket",
    "kitchen_work_item",
    "kitchen_action_record",
    "kitchen_creation_record",
  ];
  await admin.query("GRANT USAGE ON SCHEMA rms_kitchen TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON " +
      tables.map((name) => "rms_kitchen." + name).join(",") +
      " TO " +
      role,
  );
  await admin.query("GRANT UPDATE,DELETE ON rms_kitchen.kitchen_creation_record TO " + role);
  const routing = await exerciseKitchenRoutingConfiguration({
    admin,
    role,
    runner,
    scope,
    at,
    id,
    hash,
  });
  const preparation = await bootstrapKitchenRecipe({
    admin,
    role,
    runner,
    scope,
    orderRecord,
    at,
    hash,
    references,
    capability: routing.requiredCapabilityReference,
    reuseInventoryRecipe,
  });
  let authorized = true;
  let eligible = true;
  let sourceReads = 0;
  let gateReads = 0;
  let planReads = 0;

  function repository() {
    return createPostgresKitchenTicketStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      references,
      digests: { sha256: hash },
      authorize: async (_tx, input) => {
        assert.equal(input.actorType, "System");
        assert.equal(input.purposeCode, "CREATE_KITCHEN_TICKET");
        return authorized; // Synthetic current System capability.
      },
      validateCurrentSource: async (transaction, effect) => {
        gateReads++;
        if (!eligible) return false; // Synthetic current routing/preparation eligibility.
        const exact = await source.resolve({
          transaction,
          query: {
            ...sourceQuery,
            orderReference: effect.ticket.orderReference,
            orderBatchReference: effect.ticket.orderBatchReference,
            confirmationReference: effect.ticket.confirmationReference,
            sourceEventReference: effect.ticket.sourceEventReference,
            sourceAggregateVersion: effect.ticket.sourceAggregateVersion,
            sourceSnapshotDigest: effect.ticket.sourceSnapshotDigest,
          },
        });
        return exact.evidenceDigest === effect.ticket.sourceEvidenceDigest;
      },
    });
  }

  function consumer(transaction) {
    const ports = {
      references,
      digests: { sha256: hash },
      clock: { now: async () => at },
      repository: repository(),
      orderingSource: {
        resolve: async (query) => {
          sourceReads++;
          return source.resolve({ transaction, query });
        },
      },
      plans: {
        resolve: async (input) => {
          planReads++;
          return createKitchenWorkPlanService({
            references,
            digests: { sha256: hash },
            stationRouting: { resolve: (query) => routing.store.resolve({ transaction, query }) },
            preparations: {
              resolve: (query) => preparation.source.resolve(transaction, query),
            },
          }).resolve(input);
        },
      },
    };
    return createConfirmedOrderConsumerService({
      authorization: { authorize: async () => authorized },
      intakes: createKitchenTicketIntakeAdapter(ports),
      digests: { sha256: hash },
    });
  }

  const counts = async () =>
    (
      await admin.query(
        "SELECT " +
          tables
            .map(
              (table) =>
                "(SELECT count(*)::int FROM rms_kitchen." +
                table +
                " WHERE brand_id=$1 AND store_id=$2) AS " +
                table,
            )
            .join(",") +
          ",(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='KITCHEN_TICKET_CREATED') AS audits" +
          ",(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='KitchenWorkCreated') AS events" +
          ",(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE consumer_name='kitchen.confirmed-order:v1') AS inbox",
        [scope.brandReference, scope.storeReference],
      )
    ).rows[0];
  const empty = {
    kitchen_ticket: 0,
    kitchen_work_item: 0,
    kitchen_action_record: 0,
    kitchen_creation_record: 0,
    audits: 0,
    events: 0,
    inbox: 0,
  };
  preparation.revoke();
  await assert.rejects(runner().run((tx) => consumer(tx).consume(tx, event)));
  assert.deepEqual(await counts(), empty);
  preparation.allow();
  preparation.oversize(true);
  await assert.rejects(runner().run((tx) => consumer(tx).consume(tx, event)));
  assert.deepEqual(await counts(), empty);
  preparation.oversize(false);
  const failPoints = [
    "INSERT INTO rms_kitchen.kitchen_work_item",
    "INSERT INTO platform_audit.audit_record",
    "INSERT INTO platform_eventing.outbox_event",
    "INSERT INTO rms_kitchen.kitchen_creation_record",
    "UPDATE platform_eventing.consumer_inbox",
  ];
  for (const failPoint of failPoints) {
    let reached = false;
    let rejectionCode = "unknown";
    await assert.rejects(
      runner().run((tx) => {
        const failing = {
          query: async (sql, values) => {
            if (sql.startsWith(failPoint)) {
              reached = true;
              throw new Error("synthetic mandatory Kitchen transaction failure");
            }
            return tx.query(sql, values);
          },
        };
        return consumer(failing)
          .consume(failing, event)
          .catch((error) => {
            rejectionCode = error.code ?? error.name;
            throw error;
          });
      }),
    );
    assert.equal(
      reached,
      true,
      "must reach transaction failure boundary; code=" +
        rejectionCode +
        "; source=" +
        sourceReads +
        "; plan=" +
        planReads +
        "; gate=" +
        gateReads,
    );
    assert.deepEqual(await counts(), empty);
  }

  authorized = false;
  await assert.rejects(
    runner().run((tx) => consumer(tx).consume(tx, event)),
    {
      code: "KITCHEN_CONFIRMED_ORDER_PERMISSION_DENIED",
    },
  );
  authorized = true;
  eligible = false;
  await assert.rejects(runner().run((tx) => consumer(tx).consume(tx, event)));
  assert.deepEqual(await counts(), empty);
  eligible = true;

  const results = await Promise.all([
    runner().run((tx) => consumer(tx).consume(tx, event)),
    runner().run((tx) => consumer(tx).consume(tx, event)),
  ]);
  assert.deepEqual(results.map((value) => value.status).sort(), ["Accepted", "AlreadyAccepted"]);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  const original = results[0].receipt;
  const identity = {
    brandReference: original.brandReference,
    storeReference: original.storeReference,
    sourceEventReference: original.sourceEventReference,
    confirmationReference: original.confirmationReference,
    orderBatchReference: original.orderBatchReference,
  };
  const recovered = await runner().run((transaction) =>
    repository().resolveBySemanticKeys({ ...identity, transaction }),
  );
  assert.equal(recovered.status, "Resolved");
  const originalEffect = recovered.effect;
  const expected = {
    kitchen_ticket: 1,
    kitchen_work_item: originalEffect.ticket.workItems.length,
    kitchen_action_record: 1,
    kitchen_creation_record: 1,
    audits: 1,
    events: 1,
    inbox: 1,
  };
  assert.deepEqual(await counts(), expected);
  const persistedItems = (
    await admin.query(
      "SELECT order_item_id,required_quantity,customer_note,localized_display_names_json,selected_options_json,preparation_instructions_json,status " +
        "FROM rms_kitchen.kitchen_work_item WHERE brand_id=$1 AND store_id=$2 ORDER BY source_item_ordinal",
      [scope.brandReference, scope.storeReference],
    )
  ).rows;
  assert.deepEqual(
    persistedItems,
    originalEffect.ticket.workItems.map((item) => ({
      order_item_id: item.orderItemReference,
      required_quantity: item.requiredQuantity,
      customer_note: item.customerNote,
      localized_display_names_json: item.localizedDisplayNames,
      selected_options_json: item.selectedOptions,
      preparation_instructions_json: item.preparation.instructions,
      status: "Queued",
    })),
  );
  for (const item of originalEffect.ticket.workItems) {
    const selected = orderRecord.items.find(
      (line) => line.orderItemReference === item.orderItemReference,
    );
    assert.ok(selected);
    const duration = selected.catalog.options.length ? 90 : 60;
    assert.deepEqual(item.preparation.instructions, [
      "Sequence group 0 (same group may run in parallel), " +
        duration +
        " seconds: Synthetic reviewed preparation instruction.",
    ]);
  }
  const boundaryReads = { sourceReads, gateReads, planReads };
  const retry = await runner().run((tx) => consumer(tx).consume(tx, event));
  assert.equal(retry.status, "AlreadyAccepted");
  assert.deepEqual(retry.receipt, original);
  assert.deepEqual({ sourceReads, gateReads, planReads }, boundaryReads);

  const repeatedEvent = { ...event, eventId: id(9110) };
  const semantic = await runner().run((tx) => consumer(tx).consume(tx, repeatedEvent));
  assert.equal(semantic.status, "AlreadyAccepted");
  assert.deepEqual(semantic.receipt, original);
  assert.deepEqual({ sourceReads, gateReads, planReads }, boundaryReads);
  expected.inbox = 2;
  assert.deepEqual(await counts(), expected);
  for (const patch of [{ confirmationReference: id(9111) }, { orderBatchReference: id(9112) }]) {
    const collision = await runner().run((transaction) =>
      repository().resolveBySemanticKeys({ ...identity, ...patch, transaction }),
    );
    assert.equal(collision.status, "Conflict");
  }
  authorized = false;
  await assert.rejects(
    runner().run((transaction) => repository().resolveBySemanticKeys({ ...identity, transaction })),
  );
  await assert.rejects(runner().run((tx) => consumer(tx).consume(tx, event)));
  authorized = true;

  await exercisePaidKitchenLifecycle({
    merchantKitchen,
    kitchenNow,
    onItemReady,
    admin,
    role,
    runner,
    scope,
    ticket: originalEffect.ticket,
    source,
    sourceQuery,
    hash,
    references,
    id,
  });
  eligible = false;
  const afterProgress = await runner().run((transaction) =>
    repository().resolveBySemanticKeys({ ...identity, transaction }),
  );
  assert.deepEqual(afterProgress.effect, originalEffect);
  await runner().run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    assert.equal(
      (
        await tx.query("UPDATE rms_kitchen.kitchen_creation_record SET effect_digest=$1", [
          hash("changed"),
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_kitchen.kitchen_creation_record", [])).rowCount,
      0,
    );
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [id(9199)]);
    assert.equal(
      (await tx.query("SELECT * FROM rms_kitchen.kitchen_creation_record", [])).rows.length,
      0,
    );
  });
  assert.deepEqual(await counts(), expected);
  return async () => {
    const historical = await runner().run((tx) => consumer(tx).consume(tx, event));
    assert.equal(historical.status, "AlreadyAccepted");
    assert.deepEqual(historical.receipt, original);
    assert.deepEqual({ sourceReads, gateReads, planReads }, boundaryReads);
    assert.deepEqual(await counts(), expected);
  };
}
