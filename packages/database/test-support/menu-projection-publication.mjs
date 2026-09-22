import { setTimeout as delay } from "node:timers/promises";
import { createPersistentConsumerWorker } from "../../../apps/worker/src/persistent-consumer-worker.ts";
import { ConsumerRegistry } from "../../bop/eventing/src/index.ts";
import { ConsumerDeliveryWorker } from "../../../apps/worker/src/consumer-delivery.ts";
import { createConsumerOutboxTransport } from "../../../apps/worker/src/consumer-outbox-transport.ts";
import assert from "node:assert/strict";
import { canonicalizeRfc8785 } from "../../bop/audit/src/index.ts";
import {
  buildPublishedMenuProjection,
  createPostgresPublishedMenuConsumer,
  createPostgresPublishedMenuConsumerService,
  createPostgresPublishedMenuProjectionStore,
  createPostgresPublishedMenuQueryStore,
  createPostgresCurrentSelectionFactsStore,
} from "../../rms/catalog/src/index.ts";

/** Real emitted publication event and reviewed snapshot, no direct projection seed. */
export async function exerciseMenuProjectionPublication({
  admin,
  role,
  runner,
  scope,
  contentStore,
  at,
  generation,
}) {
  const tables = [
    "published_menu_projection_generation",
    "published_menu_projection",
    "published_menu_projection_section",
    "published_menu_projection_sellable",
    "published_menu_projection_checkpoint",
  ];
  for (const table of tables)
    await admin.query("GRANT SELECT,INSERT,UPDATE ON rms_catalog." + table + " TO " + role);
  const row = (
    await admin.query(
      "SELECT * FROM platform_eventing.outbox_event WHERE event_type='MenuPublished' AND brand_id=$1 AND aggregate_id=$2",
      [scope.brandReference, scope.menuReference],
    )
  ).rows[0];
  assert.ok(row);
  const event = {
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString(),
    producerModule: row.producer_module,
    tenantId: row.brand_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: BigInt(row.aggregate_version),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    actor: { type: "Actor", actorId: row.actor_id },
    payload: row.payload_json,
    redactionClassification: row.redaction_classification,
    replayMetadata: row.replay_metadata_json,
  };
  const exact = {
    brandReference: scope.brandReference,
    menuReference: scope.menuReference,
    menuVersionReference: event.payload.menuVersionReference,
    releaseReference: event.payload.releaseReference,
    snapshotDigest: event.payload.snapshotDigest,
  };
  const snapshot = await runner.run((tx) => contentStore.loadExact(tx, exact));
  const projection = buildPublishedMenuProjection({
    envelope: event,
    snapshot,
    generationReference: generation,
    projectedAt: at,
  });
  let denyLate = false;
  let verification = 0;
  const store = (tx) =>
    createPostgresPublishedMenuProjectionStore({
      transaction: tx,
      brandReference: scope.brandReference,
      menuReference: scope.menuReference,
      verifyPublished: async (transaction, envelope, value) => {
        verification++;
        if (denyLate && verification === 2) return false;
        assert.equal(envelope.eventId, event.eventId);
        return (
          canonicalizeRfc8785(await contentStore.loadExact(transaction, exact)) ===
          canonicalizeRfc8785(value)
        );
      },
    });
  const write = () =>
    runner.run((tx) => store(tx).replace({ projection, envelope: event, transaction: tx }));
  denyLate = true;
  await assert.rejects(write);
  for (const table of tables) {
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM rms_catalog." + table)).rows[0].n,
      0,
    );
  }
  denyLate = false;
  verification = 0;
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role);
  let failCompletion = true;
  const rollback = new Error("synthetic Inbox completion failure");
  const consume = () =>
    runner.run(async (tx) => {
      const transaction = {
        query: async (sql, values) => {
          if (failCompletion && sql.startsWith("UPDATE platform_eventing.consumer_inbox"))
            throw rollback;
          return tx.query(sql, values);
        },
      };
      return createPostgresPublishedMenuConsumer({
        transaction,
        brandReference: scope.brandReference,
        menuReference: scope.menuReference,
        authorize: async () => true, // Synthetic current consumer read permission, actual snapshot owner.
        generateGeneration: () => generation,
        now: () => at,
      }).consume(event);
    });
  let allowConsumer = true;
  const service = createPostgresPublishedMenuConsumerService({
    brandReference: scope.brandReference,
    authorize: async (_tx, request) =>
      allowConsumer && request.menuReference === scope.menuReference,
    generateGeneration: () => generation,
    now: () => at,
  });
  const delivery = new ConsumerDeliveryWorker({
    registry: new ConsumerRegistry([service.registration]),
    database: {
      transaction: (requested, work) => {
        assert.deepEqual(requested, { brandId: scope.brandReference });
        return runner.run((tx) =>
          work({
            query: async (sql, values) => {
              if (failCompletion && sql.startsWith("UPDATE platform_eventing.consumer_inbox"))
                throw rollback;
              return tx.query(sql, values);
            },
          }),
        );
      },
    },
    consume: (tx, _registration, envelope) => service.consume(tx, envelope),
  });
  const transport = createConsumerOutboxTransport({
    delivery,
    subscriptions: [
      {
        eventType: "MenuPublished",
        consumerNames: [service.registration.consumerName],
      },
    ],
  });
  const publish = () => transport.publish(event, { attemptCount: 1 });
  await assert.rejects(consume, (error) => error === rollback);
  assert.deepEqual(await publish(), { status: "failed", errorCode: "TRANSPORT_UNAVAILABLE" });
  for (const table of tables)
    assert.equal(
      (await admin.query("SELECT count(*)::int n FROM rms_catalog." + table)).rows[0].n,
      0,
    );
  assert.equal(
    (await admin.query("SELECT count(*)::int n FROM platform_eventing.consumer_inbox")).rows[0].n,
    0,
  );
  failCompletion = false;
  await runMenuOutboxWorker({ admin, role, runner, scope, service, event });
  assert.deepEqual(await publish(), { status: "acknowledged" });
  assert.deepEqual(await consume(), { status: "duplicate_completed" });
  assert.deepEqual(await publish(), { status: "acknowledged" });
  allowConsumer = false;
  assert.deepEqual(await publish(), { status: "failed", errorCode: "TRANSPORT_UNAVAILABLE" });
  allowConsumer = true;
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM platform_eventing.consumer_inbox WHERE status='completed'",
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await write(), projection);
  const replay = await write();
  assert.deepEqual(replay, projection);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM rms_catalog.published_menu_projection_generation",
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await runner.run((tx) => store(tx).load(scope.menuReference)), projection);
  const displayed = await createPostgresPublishedMenuQueryStore(runner, {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  }).loadVersionCandidates({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    menuVersionReference: snapshot.menuVersionReference,
  });
  assert.equal(displayed.length, 1);
  assert.deepEqual(displayed[0].snapshot, snapshot);
  const queryStore = createPostgresPublishedMenuQueryStore(runner, {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  const currentRequest = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    channelCode: "WEB",
    orderTypeCode: "PICKUP",
    requestedAt: at,
  };
  assert.deepEqual(await queryStore.loadCandidates(currentRequest), displayed);
  await admin.query(
    "GRANT SELECT ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option," +
      "rms_catalog.option_conflict,rms_catalog.product_option_binding," +
      "rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope," +
      "rms_catalog.product_option_binding_channel TO " +
      role,
  );
  const facts = createPostgresCurrentSelectionFactsStore(
    {
      run: (work) => runner.run(work, true),
    },
    { brandReference: scope.brandReference, storeReference: scope.storeReference },
  );
  const sellable = snapshot.sections[0].sellables[0];
  const selectionRequest = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    menuReference: scope.menuReference,
    sellableReference: sellable.sellableReference,
    sourceChannel: "Web",
    orderType: "Pickup",
    channelCode: "WEB",
    orderTypeCode: "PICKUP",
    observedAt: at,
  };
  const currentSelection = await facts.load(selectionRequest);
  assert.ok(currentSelection, "normal published product must supply current cart selection facts");
  assert.equal(currentSelection.release.releaseReference, snapshot.releaseReference);
  assert.equal(
    currentSelection.published.productVersionReference,
    sellable.productVersionReference,
  );
  assert.equal(currentSelection.sku.catalogEligible, true);
  assert.ok(Array.isArray(currentSelection.bindings));

  return async () => {
    assert.equal(
      await facts.load(selectionRequest),
      null,
      "archived menu cannot supply a new cart selection",
    );
    assert.deepEqual(await queryStore.loadCandidates(currentRequest), []);
    assert.deepEqual(
      await queryStore.loadVersionCandidates({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        menuVersionReference: snapshot.menuVersionReference,
      }),
      displayed,
    );
  };
}

async function runMenuOutboxWorker({ admin, role, runner, scope, service, event }) {
  await admin.query(
    "GRANT UPDATE (published_at,attempt_count,last_error_code,lease_token,lease_owner,lease_expires_at,available_at,ordering_released_at) ON platform_eventing.outbox_event TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON platform_eventing.delivery_attempt,platform_eventing.dead_letter_item TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_retry_schedule TO " + role,
  );
  const pending = await admin.query(
    "SELECT event_id,event_type FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id IS NULL AND published_at IS NULL",
    [scope.brandReference],
  );
  assert.deepEqual(pending.rows, [{ event_id: event.eventId, event_type: "MenuPublished" }]);
  let sequence = 1;
  const next = () => "0190ce01-0000-7000-8000-" + (sequence++).toString(16).padStart(12, "0");
  const identities = new Map();
  const identity = (key) => {
    if (!identities.has(key))
      identities.set(key, {
        attemptId: next(),
        deadLetterId: next(),
        idempotencyKey: next(),
        scheduleId: next(),
      });
    return identities.get(key);
  };
  const runtime = createPersistentConsumerWorker({
    connections: { acquire: runner.acquire },
    eventing: {
      // Synthetic worker authority, real restricted PostgreSQL role and owner services.
      authorizeScope: async (requested) =>
        requested.brandId === scope.brandReference && requested.storeId === undefined,
      now: () => new Date().toISOString(),
      random: () => 0.5,
      outboxIdentities: (eventId, attempt) => identity(eventId + ":" + attempt),
      consumerIdentities: (input) =>
        identity(input.consumerName + ":" + input.eventId + ":" + input.attemptNumber),
    },
    services: [service],
    scopes: [{ brandId: scope.brandReference }],
    leaseOwner: "wp2402_menu_projection",
    newLeaseToken: next,
    config: { batchMaximum: 1, perScopeMaximum: 1, adapterConcurrency: 1 },
    pollIntervalMs: 25,
    drainDeadlineMs: 25000,
  });
  let failed = false;
  void runtime.workload.completion?.then((status) => {
    failed = status === "failed";
  });
  try {
    await runtime.workload.start();
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.equal(failed, false, "Menu Worker must remain healthy");
      const row = (
        await admin.query(
          "SELECT published_at,attempt_count,last_error_code FROM platform_eventing.outbox_event WHERE event_id=$1",
          [event.eventId],
        )
      ).rows[0];
      if (row.published_at !== null) {
        assert.equal(row.attempt_count, 1);
        assert.equal(row.last_error_code, null);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int n FROM platform_eventing.consumer_inbox WHERE event_id=$1 AND status='completed'",
              [event.eventId],
            )
          ).rows[0].n,
          1,
        );
        return;
      }
      await delay(25);
    }
    assert.fail("Menu Outbox event did not reach committed publication");
  } finally {
    await runtime.workload.stop();
  }
}
