import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { createOrderStatusCreationSource } from "../../rms/ordering/src/index.ts";
import { orderCreatedSourceInput } from "../../rms/ordering/src/application/order-created-source.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPostgresPaymentStatusStore,
  createPaymentStatusEventConsumerService,
} from "../../rms/payment/src/index.ts";
import { exerciseDiningCustomerStatus } from "./dining-customer-status.mjs";

/** Real retained-connection Worker delivers actual Entry OrderCreated/PaymentSucceeded events. */
export async function exerciseEntryDiningWorker({
  admin,
  role,
  run,
  acquire,
  scope,
  order,
  result,
  now,
  reference,
  orderType = "DineIn",
}) {
  await admin.query("GRANT SELECT,INSERT ON rms_payment.payment_status_projection TO " + role);
  const projections = createPostgresPaymentStatusStore({
    scope: result.terminalScope,
    authorize: async () => true, // Explicit synthetic internal projection capability.
  });
  const fact = result.committed.fact;
  const consumer = createPaymentStatusEventConsumerService({
    scope: result.terminalScope,
    authorization: {
      authorize: async (_tx, event) =>
        event.eventId === fact.event.eventId && event.aggregateId === fact.paymentIntentReference,
    },
    projections,
    references: { generateGeneration: reference, now },
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  const sourceRows = await admin.query(
    "SELECT event_id FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND aggregate_id=$3 AND event_type='OrderCreated'",
    [scope.brandReference, scope.storeReference, order.record.order.orderReference],
  );
  const sourceEvent = await run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    return loadOutboxEnvelope(tx, sourceRows.rows[0].event_id);
  });
  assert(sourceEvent, "Scoped original OrderCreated event must exist");
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  try {
    createOrderStatusCreationSource({
      record: order.record,
      quoteVersion: 1,
      envelope: sourceEvent,
      locale: Object.keys(order.record.items[0].catalog.localizedNames)[0],
      sha256: hash,
    });
  } catch (error) {
    assert.fail(
      JSON.stringify({
        code: /^[A-Z_]{1,64}$/.test(error.code ?? "") ? error.code : "unknown",
        digestMatches:
          sourceEvent.payload.sourceSnapshotDigest ===
          hash(
            orderCreatedSourceInput(
              order.record,
              order.record.orderNumberAllocation.businessDateResolution,
            ),
          ),
        countMatches: sourceEvent.payload.itemCount === order.record.items.length,
        timeMatches: sourceEvent.occurredAt === order.record.createdAt,
        frames: String(error.stack ?? "")
          .split("\n")
          .slice(1, 5)
          .map((line) => /([a-z0-9-]+\.[cm]?ts:[0-9]+:[0-9]+)/i.exec(line)?.[1] ?? "source"),
      }),
    );
  }
  const load = () =>
    run((transaction) =>
      projections.load({
        transaction,
        paymentIntentReference: fact.paymentIntentReference,
      }),
    );
  assert.equal(await load(), null);
  const failures = [];
  const observedAcquire = async () => {
    const connection = await acquire();
    return {
      release: connection.release,
      query: async (sql, values) => {
        try {
          return await connection.query(sql, values);
        } catch (error) {
          failures.push({
            table:
              /(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner-query",
            code: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown",
          });
          throw error;
        }
      },
    };
  };
  try {
    await exerciseDiningCustomerStatus({
      orderType,
      admin,
      role,
      runner: { run, acquire: observedAcquire },
      scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
      order: order.record,
      quoteVersion: 1,
      paymentEvent: fact.event,
      observeFailure: (failure) => failures.push(failure),
      services: consumer.registrations.map((registration) => ({
        registration,
        consume: (tx, event) => consumer.consume(tx, event),
      })),
    });
  } catch {
    const events = await admin.query(
      "SELECT event_type,published_at IS NOT NULL AS published,attempt_count,last_error_code FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND ((aggregate_id=$3 AND event_type='OrderCreated') OR event_id=$4)",
      [
        scope.brandReference,
        scope.storeReference,
        order.record.order.orderReference,
        fact.event.eventId,
      ],
    );
    assert.fail(JSON.stringify({ failures: failures.slice(-10), events: events.rows }));
  }
  const projected = await load();
  assert(projected, "Worker must persist Payment status projection");
  const inbox = await admin.query(
    "SELECT count(*)::int AS n FROM platform_eventing.consumer_inbox WHERE brand_id=$1 AND store_id=$2 AND event_id=$3 AND consumer_name='payment.status-projection:v1'",
    [scope.brandReference, scope.storeReference, fact.event.eventId],
  );
  assert.equal(inbox.rows[0].n, 1);
  return { projected };
}
