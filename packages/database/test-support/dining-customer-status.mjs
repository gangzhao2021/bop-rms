import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createPersistedOrderCreatedProjectionComposition } from "../../../apps/api/src/order-created-projection-composition.ts";
import { createPersistentConsumerWorker } from "../../../apps/worker/src/persistent-consumer-worker.ts";

/** Real Dining owner projection/event transport. Authorization policy is explicitly synthetic. */
export async function exerciseDiningCustomerStatus({
  admin,
  runner,
  role,
  scope,
  order,
  quoteVersion,
  services,
  paymentEvent,
  observeFailure,
  orderType = "DineIn",
}) {
  assert.equal(order.order.orderType, orderType);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.order_status_projection_generation TO " + role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_ordering.order_status_projection TO " + role,
  );
  await admin.query("GRANT SELECT ON rms_ordering.order_fulfillment_completion_record TO " + role);
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
  let sequence = 1;
  const next = () => "0190de01-0000-7000-8000-" + (sequence++).toString(16).padStart(12, "0");
  const created = createPersistedOrderCreatedProjectionComposition({
    scope,
    quoteVersion,
    locale: Object.keys(order.items[0].catalog.localizedNames)[0],
    sha256: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    authorization: {
      authorize: async (_tx, event) =>
        event.tenantId === scope.brandReference &&
        event.storeId === scope.storeReference &&
        event.aggregateId === order.order.orderReference,
    },
    references: { generateGeneration: next, now: () => new Date().toISOString() },
  });
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
      authorizeScope: async (requested) =>
        requested.brandId === scope.brandReference && requested.storeId === scope.storeReference,
      now: () => new Date().toISOString(),
      random: () => 0.5,
      outboxIdentities: (eventId, attempt) => identity(eventId + ":" + attempt),
      consumerIdentities: (input) =>
        identity(input.consumerName + ":" + input.eventId + ":" + input.attemptNumber),
    },
    services: [
      {
        ...created,
        consume: async (transaction, envelope) => {
          try {
            return await created.consume(transaction, envelope);
          } catch (error) {
            observeFailure?.({
              code: /^[A-Z_]{1,64}$/.test(error.code ?? "") ? error.code : "unknown",
              frames: String(error.stack ?? "")
                .split("\n")
                .slice(1, 7)
                .map(
                  (line) => /([a-z0-9-]+\.[cm]?ts:[0-9]+:[0-9]+)/i.exec(line)?.[1] ?? "consumer",
                ),
            });
            throw error;
          }
        },
      },
      ...services,
    ],
    scopes: [{ brandId: scope.brandReference, storeId: scope.storeReference }],
    leaseOwner: "wp2402_dining_status",
    newLeaseToken: next,
    config: { batchMaximum: 1, perScopeMaximum: 1, adapterConcurrency: 1 },
    pollIntervalMs: 25,
    drainDeadlineMs: 25000,
  });
  const pending = await admin.query(
    "SELECT count(*)::int AS count FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND published_at IS NULL AND ((aggregate_id=$3 AND event_type='OrderCreated') OR event_id=$4)",
    [scope.brandReference, scope.storeReference, order.order.orderReference, paymentEvent.eventId],
  );
  assert.equal(pending.rows[0].count, 2, "both source events must await automatic delivery");
  let failed = false;
  void runtime.workload.completion?.then((status) => {
    failed = status === "failed";
  });
  try {
    await runtime.workload.start();
    for (let attempt = 0; attempt < 200; attempt++) {
      assert.equal(failed, false, "persistent Dining Worker must remain healthy");
      const rows = (
        await admin.query(
          "SELECT event_type,published_at FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND ((aggregate_id=$3 AND event_type='OrderCreated') OR event_id=$4)",
          [
            scope.brandReference,
            scope.storeReference,
            order.order.orderReference,
            paymentEvent.eventId,
          ],
        )
      ).rows;
      assert.equal(rows.length, 2);
      if (rows.every((row) => row.published_at !== null)) return;
      await delay(25);
    }
    assert.fail("Dining source events were not published within bounded dispatch");
  } finally {
    await runtime.workload.stop();
    assert.equal(await runtime.workload.completion, "stopped");
  }
}
