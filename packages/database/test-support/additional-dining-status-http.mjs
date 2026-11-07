import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp } from "../../../apps/api/src/app.ts";
import { CustomerOrderStatusHandler } from "../../../apps/api/src/customer-order-status.ts";
import { createCustomerOrderStatusRead } from "../../../apps/api/src/customer-order-status-read.ts";
import {
  createPostgresOrderSubmittedConsumer,
  createPostgresAdditionalDiningExecutionReader,
  createPostgresOrderAcceptanceReader,
  buildOrderStatusProjection,
  createOrderStatusAdditionalSource,
  createPostgresOrderStatusProjectionStore,
} from "../../rms/ordering/src/index.ts";
import {
  createDiningGuestBindingQuery,
  createPostgresDiningGuestBindingStore,
} from "../../rms/dining/src/index.ts";

// Initial presentation is from explicitly seeded history; Additional event/read/HTTP are actual.
export async function exerciseAdditionalDiningStatusHttp({
  combinedOrder = false,
  client,
  runner,
  scope,
  snapshot,
  initial,
  guest,
  capacity,
  at,
  hash,
}) {
  const id = (n) => "01909986-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const header = (
    await client.query(
      "SELECT order_number,business_date::text FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3",
      [scope.brandReference, scope.storeReference, snapshot.orderReference],
    )
  ).rows[0];
  assert.ok(header);
  const events = (
    await client.query(
      "SELECT * FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND aggregate_id=$3 AND event_type='OrderSubmitted'",
      [scope.brandReference, scope.storeReference, snapshot.orderReference],
    )
  ).rows;
  assert.equal(events.length, 1);
  const row = events[0];
  const event = {
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString(),
    producerModule: row.producer_module,
    tenantId: row.brand_id,
    storeId: row.store_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: BigInt(row.aggregate_version),
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    actor:
      row.actor_type === "System"
        ? { type: "System" }
        : { type: row.actor_type, reference: row.actor_reference },
    payload: row.payload_json,
    redactionClassification: row.redaction_classification,
    replayMetadata: row.replay_metadata_json,
  };
  const locale = Object.keys(snapshot.items[0].catalog.localizedNames)[0];
  let previous = {
    sourceVersion: 1,
    sourceCheckpoint: id(1),
    sourceDigest: hash("explicit initial presentation fixture"),
    orderReference: snapshot.orderReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    guestSessionReference: initial.guestSessionReference,
    submissionReference: initial.submissionReference,
    businessDate: header.business_date,
    orderNumber: header.order_number,
    orderType: "DineIn",
    sourceChannel: initial.order.sourceChannel,
    canonicalPhase: "Submitted",
    closureStatus: "Open",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    fulfillmentReference: null,
    fulfillmentCompletionEventReference: null,
    fulfillmentCompletedAt: null,
    eta: null,
    submittedAt: initial.createdAt,
    batches: initial.order.batches.map((batch) => ({
      orderBatchReference: batch.orderBatchReference,
      submittedAt: batch.submittedAt,
      items: initial.items
        .filter((item) => item.orderBatchReference === batch.orderBatchReference)
        .map((item) => ({
          orderItemReference: item.orderItemReference,
          displayName: item.catalog.localizedNames[locale],
          quantity: item.quantity,
          lineTotal: item.pricing.total,
        })),
    })),
  };
  if (combinedOrder) {
    previous = await runner().run(async (transaction) => {
      const persisted = await createPostgresOrderStatusProjectionStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async () => true,
        validateCurrentSource: async () => false,
      }).load({ transaction, orderReference: snapshot.orderReference });
      const acceptance = await createPostgresOrderAcceptanceReader({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async () => true,
      }).loadByBatch({
        transaction,
        orderReference: snapshot.orderReference,
        orderBatchReference: initial.order.batches[0].orderBatchReference,
      });
      assert.ok(persisted);
      assert.ok(acceptance);
      assert.equal(acceptance.acceptedOrderVersion, snapshot.expectedOrderVersion);
      assert.equal(persisted.snapshot.batches.length, 1);
      return {
        ...persisted.snapshot,
        canonicalPhase: "Accepted",
        sourceVersion: acceptance.acceptedOrderVersion,
        sourceCheckpoint: acceptance.acceptanceReference,
        sourceDigest: hash(JSON.stringify(acceptance)),
      };
    });
  }
  const source = createOrderStatusAdditionalSource({
    previous,
    additional: snapshot,
    envelope: event,
    locale,
    sha256: hash,
  });
  const projection = buildOrderStatusProjection({
    source,
    generationReference: id(2),
    projectedAt: at,
  });
  if (combinedOrder) {
    const consumer = createPostgresOrderSubmittedConsumer({
      projection: {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async () => true,
        validateCurrentSource: async (_tx, candidate) =>
          candidate.snapshot.sourceCheckpoint === event.eventId,
      },
      authorization: { authorize: async () => true },
      history: { quoteVersion: snapshot.snapshotVersion, locale },
      freshness: async (transaction, candidate) => {
        const current = await createPostgresAdditionalDiningExecutionReader({
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          authorize: async () => true,
        }).loadBySubmission({
          transaction,
          submissionReference: snapshot.batch.submissionReference,
          observedAt: at,
        });
        assert.ok(current);
        return current.orderVersion === candidate.sourceVersion ? "Fresh" : "Stale";
      },
      references: { generateGeneration: () => id(2), now: () => at },
    });
    assert.deepEqual(await runner().run((tx) => consumer.consume(tx, event)), {
      status: "processed",
    });
    assert.deepEqual(await runner().run((tx) => consumer.consume(tx, event)), {
      status: "duplicate_completed",
    });
  } else {
    await runner().run((transaction) =>
      createPostgresOrderStatusProjectionStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async () => true,
        validateCurrentSource: async (_tx, candidate) =>
          candidate.snapshot.sourceCheckpoint === event.eventId,
      }).replace({ transaction, projection }),
    );
  }
  let bindingReads = 0,
    bindingSuccess = 0;
  let lastReadError = "none";
  const port = createCustomerOrderStatusRead({
    scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
    transactions: runner(),
    credentials: guest.identity.session.credentials,
    diningScope: scope,
    now: () => at,
    binding: (transaction) => ({
      validate: async (session, observedAt) => {
        bindingReads += 1;
        const binding = createDiningGuestBindingQuery({
          scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
          now: () => observedAt,
          repository: createPostgresDiningGuestBindingStore(
            { run: (work) => work(transaction) },
            scope,
          ),
        });
        const evidence = await binding.resolve({
          purpose: "GuestSessionBinding",
          diningSessionReference: session.diningSessionReference,
          participantReference: session.diningParticipantReference,
          tableReference: capacity.tableReference,
        });
        if (evidence) bindingSuccess += 1;
        return evidence ? "Current" : "Unavailable";
      },
    }),
  });
  const server = createServer(
    createApp({
      customerOrderStatus: new CustomerOrderStatusHandler({
        allowedOrigin: "https://pilot.example",
        port: {
          read: async (input) => {
            try {
              return await port.read(input);
            } catch (error) {
              lastReadError = typeof error?.code === "string" ? error.code : "unexpected";
              throw error;
            }
          },
        },
      }),
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url =
      "http://127.0.0.1:" +
      server.address().port +
      "/api/v1/orders/" +
      snapshot.orderReference +
      "/status";
    const headers = {
      "sec-fetch-site": "same-origin",
      cookie: "__Host-bop-guest=" + guest.sessionCredential,
      "x-csrf-token": guest.csrfCredential,
    };
    const response = await globalThis.fetch(url, { headers });
    assert.equal(
      response.status,
      200,
      "status source " + lastReadError + " binding " + bindingReads + "/" + bindingSuccess,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    const items = body.status.sources.dining.items;
    assert.equal(items.length, initial.items.length + snapshot.items.length);
    assert.equal(
      items.find((item) => item.orderItemReference === snapshot.items[0].orderItemReference)
        .servedQuantity,
      snapshot.items[0].quantity,
    );
    assert.ok(
      items
        .filter((item) =>
          initial.items.some((prior) => prior.orderItemReference === item.orderItemReference),
        )
        .every((item) => item.servedQuantity === 0),
    );
    assert.deepEqual(
      Object.keys(items[0]).sort(),
      ["orderItemReference", "orderBatchReference", "servedQuantity"].sort(),
    );
    assert.equal(
      (await globalThis.fetch(url, { headers: { ...headers, "x-csrf-token": guest.wrongCsrf } }))
        .status,
      404,
    );
    assert.equal(
      (await globalThis.fetch(url.replace(snapshot.orderReference, id(99)), { headers })).status,
      404,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
