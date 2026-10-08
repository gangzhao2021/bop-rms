import type { ConsumerTransaction } from "@bop/eventing";
import {
  createOrderFulfillmentSourceQueryService,
  parseResolveConfirmedOrderFulfillmentSourceInput,
} from "../../application/order-fulfillment-source.js";
import { createOrderFulfillmentSourceFromSnapshot } from "../../application/order-fulfillment-snapshot.js";
import {
  createPostgresOrderCreationQueryStore,
  readOrderCreationQuoteVersion,
} from "./order-creation-query-store.js";
import { createPostgresOrderPaymentDispositionReader } from "./order-payment-disposition-store.js";
import { createPostgresOrderInitialExecutionReader } from "./order-termination-store.js";
import { parseOrderingReference } from "../../domain/cart.js";
import {
  OrderFulfillmentSourceError,
  type OrderFulfillmentSourceQueryPorts,
} from "../../contracts/order-fulfillment-source.js";

/** Public owner Query bound to caller transaction; no foreign table access or reconstructed current catalog. */
export function createPostgresOrderFulfillmentSourceStore(options: {
  brandReference: string;
  storeReference: string;
  quoteVersion: 1 | 2;
  sha256(value: string): string;
  authorize(
    transaction: ConsumerTransaction,
    input: Parameters<OrderFulfillmentSourceQueryPorts["authorization"]["authorize"]>[0],
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  });
  const quoteVersion = options.quoteVersion;
  return Object.freeze({
    async resolve(input: { transaction: ConsumerTransaction; query: unknown }) {
      const query = parseResolveConfirmedOrderFulfillmentSourceInput(input.query);
      const tx = input.transaction;
      if (
        query.brandReference !== scope.brandReference ||
        query.storeReference !== scope.storeReference
      )
        throw new OrderFulfillmentSourceError("ORDER_FULFILLMENT_SOURCE_PERMISSION_DENIED");
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const source = createOrderFulfillmentSourceQueryService({
        authorization: { authorize: (request) => options.authorize(tx, request) },
        digests: { sha256: options.sha256 },
        source: {
          loadExact: async (request) => {
            const current = await createPostgresOrderInitialExecutionReader({
              ...scope,
              authorize: (transaction) =>
                options.authorize(transaction, {
                  ...request,
                  action: "ResolveConfirmedOrderFulfillmentSource",
                  purpose: "CreatePickupFulfillment",
                }),
            }).loadByBatch({
              transaction: tx,
              orderReference: request.orderReference,
              orderBatchReference: request.orderBatchReference,
            });
            if (
              current.phase !== "Accepted" ||
              BigInt(current.version) !== request.sourceAggregateVersion ||
              current.occurredAt > request.observedAt
            )
              return null;
            const found = await tx.query(
              "SELECT payment_event_id FROM rms_ordering.order_payment_disposition_record " +
                "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4 " +
                "AND confirmation_id=$5 AND order_confirmed_event_id=$6 AND disposition='Confirmed' LIMIT 2",
              [
                scope.brandReference,
                scope.storeReference,
                request.orderReference,
                request.orderBatchReference,
                request.confirmationReference,
                request.sourceEventReference,
              ],
            );
            if (found.rows.length !== 1) return null;
            const stored = await createPostgresOrderPaymentDispositionReader(
              scope,
            ).loadByPaymentEvent({
              transaction: tx,
              paymentEventReference: parseOrderingReference(found.rows[0]?.payment_event_id),
            });
            if (
              !stored ||
              !("disposition" in stored.record) ||
              stored.record.disposition !== "Confirmed" ||
              !stored.orderConfirmedEvent ||
              stored.record.sourceCheckpoint !== current.checkpoint ||
              stored.record.confirmationReference !== request.confirmationReference ||
              stored.record.sourceSnapshotDigest !== request.sourceSnapshotDigest ||
              stored.orderConfirmedEvent.eventId !== request.sourceEventReference ||
              stored.orderConfirmedEvent.occurredAt > request.observedAt
            )
              return null;
            // WP-2423: each Order is read with the Quote version it was priced with (its stored
            // snapshot discriminator), so history priced before a version change stays readable.
            const version =
              (await readOrderCreationQuoteVersion(tx, scope, stored.record.submissionReference)) ??
              quoteVersion;
            return createPostgresOrderCreationQueryStore(
              { run: async (work) => work(tx) },
              scope,
              version,
            ).withCurrentSubmission(stored.record.submissionReference, async (_, order) =>
              createOrderFulfillmentSourceFromSnapshot({
                order: order as never,
                quoteVersion: version,
                confirmationEvent: stored.orderConfirmedEvent,
                sha256: options.sha256,
              }),
            );
          },
        },
      });
      return source.resolve(query);
    },
  });
}
