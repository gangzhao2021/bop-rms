import { createPostgresDiningOrderItemStateReader } from "./dining-order-item-state-reader.js";
import { createPostgresAdditionalDiningExecutionReader } from "./additional-dining-execution-reader.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createOrderKitchenSourceQueryService,
  parseResolveConfirmedOrderKitchenSourceInput,
} from "../../application/order-kitchen-source.js";
import { createOrderKitchenSourceFromSnapshot } from "../../application/order-kitchen-snapshot.js";
import { createPostgresOrderCreationQueryStore } from "./order-creation-query-store.js";
import { createPostgresOrderPaymentDispositionReader } from "./order-payment-disposition-store.js";
import { createPostgresOrderPayLaterConfirmationStore } from "./order-pay-later-confirmation-store.js";
import {
  acquireOrderDispositionFence,
  createPostgresOrderInitialExecutionReader,
  initialRevisionIsCurrent,
} from "./order-termination-store.js";
import { parseOrderingReference } from "../../domain/cart.js";
import {
  OrderKitchenSourceError,
  type OrderKitchenSourceQueryPorts,
} from "../../contracts/order-kitchen-source.js";

/** Public owner Query bound to caller transaction; no foreign table access or reconstructed current catalog. */
export function createPostgresOrderKitchenSourceStore(options: {
  brandReference: string;
  storeReference: string;
  quoteVersion: 1 | 2;
  sha256(value: string): string;
  authorize(
    transaction: ConsumerTransaction,
    input: Parameters<OrderKitchenSourceQueryPorts["authorization"]["authorize"]>[0],
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.brandReference),
    storeReference: parseOrderingReference(options.storeReference),
  });
  const quoteVersion = options.quoteVersion;
  async function resolveSource(
    input: { transaction: ConsumerTransaction; query: unknown },
    revision: "Exact" | "Issued",
  ) {
    const query = parseResolveConfirmedOrderKitchenSourceInput(input.query);
    const tx = input.transaction;
    if (
      query.brandReference !== scope.brandReference ||
      query.storeReference !== scope.storeReference
    )
      throw new OrderKitchenSourceError("ORDER_KITCHEN_SOURCE_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    // WP-2423 lock order: the Order's disposition fence comes before the Order row lock that
    // `withCurrentSubmission` takes below (FOR UPDATE OF the order header). The dine-in and pickup
    // readers called inside it take the same fence; taken there, after the row lock, a kitchen
    // command holding the header and waiting for the fence deadlocked a guest status read that
    // held the fence and waited for the header FOR SHARE (v15 2026-10-17: 40P01).
    await acquireOrderDispositionFence(tx, { ...scope, orderReference: query.orderReference });
    // A paid round's confirmation (its payment disposition), or — DEC-DINE-IN-PAY-LATER — a round
    // of a pay-later table sent to the kitchen with its automatic acceptance. Both name the
    // submission, the checkpoint the kitchen checks (the acceptance), and the OrderConfirmed event.
    const confirmedSource = async (
      transaction: ConsumerTransaction,
      request: {
        orderReference: string;
        orderBatchReference: string;
        confirmationReference: string;
        sourceEventReference: string;
      },
      paid: readonly Record<string, unknown>[],
    ) => {
      if (paid.length > 1) return null;
      if (paid.length === 1) {
        const stored = await createPostgresOrderPaymentDispositionReader(scope).loadByPaymentEvent({
          transaction,
          paymentEventReference: parseOrderingReference(paid[0]?.payment_event_id),
        });
        if (
          !stored ||
          !("disposition" in stored.record) ||
          stored.record.disposition !== "Confirmed" ||
          !stored.orderConfirmedEvent
        )
          return null;
        return {
          record: {
            submissionReference: stored.record.submissionReference,
            sourceCheckpoint: stored.record.sourceCheckpoint,
            confirmationReference: stored.record.confirmationReference,
            sourceSnapshotDigest: stored.record.sourceSnapshotDigest,
          },
          orderConfirmedEvent: stored.orderConfirmedEvent,
        };
      }
      const later = await createPostgresOrderPayLaterConfirmationStore({
        ...scope,
        quoteVersion,
        sha256: options.sha256,
        authorize: async () => true,
      }).loadConfirmed({
        transaction,
        orderReference: request.orderReference,
        orderBatchReference: request.orderBatchReference,
        confirmationReference: request.confirmationReference,
        orderConfirmedEventReference: request.sourceEventReference,
      });
      if (later === null) return null;
      return {
        record: {
          submissionReference: later.confirmation.submissionReference,
          sourceCheckpoint: later.confirmation.acceptanceReference,
          confirmationReference: later.confirmation.confirmationReference,
          sourceSnapshotDigest: later.confirmation.sourceSnapshotDigest,
        },
        orderConfirmedEvent: later.orderConfirmedEvent,
      };
    };
    const source = createOrderKitchenSourceQueryService({
      authorization: { authorize: (request) => options.authorize(tx, request) },
      digests: { sha256: options.sha256 },
      source: {
        loadExact: async (request) => {
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
          const stored = await confirmedSource(tx, request, found.rows);
          if (
            !stored ||
            stored.record.confirmationReference !== request.confirmationReference ||
            stored.record.sourceSnapshotDigest !== request.sourceSnapshotDigest ||
            stored.orderConfirmedEvent.eventId !== request.sourceEventReference ||
            stored.orderConfirmedEvent.occurredAt > request.observedAt
          )
            return null;
          const kind = await tx.query(
            "SELECT submission_kind FROM rms_ordering.order_submission_record WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND submission_id=$4",
            [
              scope.brandReference,
              scope.storeReference,
              request.orderReference,
              stored.record.submissionReference,
            ],
          );
          if (kind.rows.length !== 1) return null;
          if (kind.rows[0]?.submission_kind === "Additional") {
            const additional = await createPostgresAdditionalDiningExecutionReader({
              ...scope,
              authorize: (transaction) =>
                options.authorize(transaction, {
                  ...request,
                  action: "ResolveConfirmedOrderKitchenSource",
                  purpose: "CreateKitchenWork",
                }),
            }).loadBySubmission({
              transaction: tx,
              submissionReference: stored.record.submissionReference,
              observedAt: request.observedAt,
            });
            if (
              !additional ||
              additional.batchPhase !== "Accepted" ||
              additional.snapshot.batch.orderBatchReference !== request.orderBatchReference ||
              BigInt(additional.batchVersion) !== request.sourceAggregateVersion ||
              additional.batchCheckpoint !== stored.record.sourceCheckpoint ||
              additional.batchOccurredAt > request.observedAt
            )
              return null;
            return createOrderKitchenSourceFromSnapshot({
              order: additional.snapshot,
              submissionKind: "Additional",
              quoteVersion,
              confirmationEvent: stored.orderConfirmedEvent,
              sha256: options.sha256,
            });
          }
          if (kind.rows[0]?.submission_kind !== "Initial") return null;
          const sourceCheckpoint = stored.record.sourceCheckpoint;
          return createPostgresOrderCreationQueryStore(
            { run: async (work) => work(tx) },
            scope,
            quoteVersion,
          ).withCurrentSubmission(stored.record.submissionReference, async (_, order) => {
            if (order.order.orderType === "DineIn") {
              if (!order.order.diningSessionReference) return null;
              const current = await createPostgresDiningOrderItemStateReader({
                ...scope,
                authorize: (transaction) =>
                  options.authorize(transaction, {
                    ...request,
                    action: "ResolveConfirmedOrderKitchenSource",
                    purpose: "CreateKitchenWork",
                  }),
              }).load({
                transaction: tx,
                ...scope,
                orderReference: request.orderReference,
                diningSessionReference: order.order.diningSessionReference,
                guestSessionReference: order.guestSessionReference,
                observedAt: request.observedAt,
              });
              const batch = current?.batches.find(
                (value) => value.orderBatchReference === request.orderBatchReference,
              );
              const acceptance = batch?.acceptance;
              if (
                !current ||
                !batch ||
                batch.sequence !== 1 ||
                batch.cancellation !== null ||
                batch.staffCancellation !== null ||
                !acceptance ||
                BigInt(acceptance.acceptedOrderVersion) !== request.sourceAggregateVersion ||
                acceptance.acceptanceReference !== sourceCheckpoint ||
                acceptance.acceptedAt > request.observedAt
              )
                return null;
            } else {
              const { execution: current, revisions } =
                await createPostgresOrderInitialExecutionReader({
                  ...scope,
                  authorize: (transaction) =>
                    options.authorize(transaction, {
                      ...request,
                      action: "ResolveConfirmedOrderKitchenSource",
                      purpose: "CreateKitchenWork",
                    }),
                }).loadChainByBatch({
                  transaction: tx,
                  orderReference: request.orderReference,
                  orderBatchReference: request.orderBatchReference,
                });
              if (current.phase !== "Accepted" || current.occurredAt > request.observedAt)
                return null;
              if (
                !initialRevisionIsCurrent(
                  revisions,
                  request.sourceAggregateVersion,
                  sourceCheckpoint,
                  revision,
                )
              )
                return null;
            }
            return createOrderKitchenSourceFromSnapshot({
              order,
              quoteVersion,
              confirmationEvent: stored.orderConfirmedEvent,
              sha256: options.sha256,
            });
          });
        },
      },
    });
    return source.resolve(query);
  }
  return Object.freeze({
    /** The source exactly as it is now: creating kitchen work requires the current revision. */
    resolve: (input: { transaction: ConsumerTransaction; query: unknown }) =>
      resolveSource(input, "Exact"),
    /**
     * The source of kitchen work already issued at `sourceAggregateVersion`. The work stays current
     * while every later revision only cancelled item lines inside the Order (policy
     * `cancellation: "StaffItems"`): that cancellation cancelled the same lines' kitchen work in its
     * own transaction, so the remaining work is unchanged. Any other later revision (termination,
     * completion, whole-Batch cancellation) makes the issued work stale.
     */
    resolveIssued: (input: { transaction: ConsumerTransaction; query: unknown }) =>
      resolveSource(input, "Issued"),
  });
}
