import {
  createPostgresOrderFulfillmentCompletionStore,
  createOrderFulfillmentCompletionRecord,
  createPostgresOrderExecutionReader,
  parseFulfillmentCompletedEnvelope,
  createPostgresOrderCreationQueryStore,
  validateOrderFulfillmentCompletionRecord,
  createPostgresPickupOrderCompletionLookup,
  OrderFulfillmentCompletionError,
  parseOrderingReference,
  type OrderCreationRecord,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { evaluateOrderFulfillmentWorkflow } from "./order-fulfillment-workflow.js";

type WriterOptions = Parameters<typeof createPostgresOrderFulfillmentCompletionStore>[0];
type Evaluation = Parameters<typeof evaluateOrderFulfillmentWorkflow>[0];

/** Server composition: caller supplies current system authority and owns transaction completion. */
export function createOrderFulfillmentComposition(options: {
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
  quoteVersion: 1 | 2;
  systemActorReference: string;
  fulfillment: Evaluation["fulfillment"];
  gates: Evaluation["gates"];
  sha256: WriterOptions["sha256"];
  authorize: WriterOptions["authorize"];
  audit: WriterOptions["audit"];
  validateEligibility(
    transaction: ConsumerTransaction,
    record: Parameters<WriterOptions["validateCurrentWorkflow"]>[1],
    order: OrderCreationRecord<1 | 2>,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({ ...options.scope });
  const fulfillment = Object.freeze({ ...options.fulfillment });
  const systemActorReference = parseOrderingReference(options.systemActorReference);
  return Object.freeze({
    async commit(input: { transaction: ConsumerTransaction; record: unknown }) {
      const record = validateOrderFulfillmentCompletionRecord(input.record, options.sha256);
      if (
        record.brandReference !== scope.brandReference ||
        record.storeReference !== scope.storeReference
      )
        throw new OrderFulfillmentCompletionError("ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE");
      const authorize: WriterOptions["authorize"] = async (transaction, candidate) =>
        candidate.purposeCode === fulfillment.purposeCode &&
        candidate.permissionCode === fulfillment.permissionCode &&
        (await options.authorize(transaction, candidate)) === true;
      const association = await createPostgresPickupOrderCompletionLookup({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: (transaction) => authorize(transaction, record),
      })
        .loadByOrder({ transaction: input.transaction, orderReference: record.orderReference })
        .catch(() => {
          throw new OrderFulfillmentCompletionError("ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE");
        });
      if (association === null || association.orderBatchReference !== record.orderBatchReference)
        throw new OrderFulfillmentCompletionError("ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE");
      const writer = createPostgresOrderFulfillmentCompletionStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        sha256: options.sha256,
        authorize,
        audit: options.audit,
        validateCurrentWorkflow: async (transaction, candidate) => {
          const source = createPostgresOrderCreationQueryStore(
            { run: async (work) => work(transaction) },
            { brandReference: scope.brandReference, storeReference: scope.storeReference },
            options.quoteVersion,
          );
          return (
            (await source.withCurrentSubmission(
              association.submissionReference,
              async (_, order) => {
                const evaluated = await evaluateOrderFulfillmentWorkflow({
                  transaction,
                  order,
                  quoteVersion: options.quoteVersion,
                  completion: candidate,
                  fulfillment,
                  gates: options.gates,
                  request: {
                    ...scope,
                    actorReference: systemActorReference,
                    resourceReference: candidate.orderReference,
                    resourceVersion: candidate.expectedOrderVersion,
                    purposeCode: fulfillment.purposeCode,
                    applicabilityCode: order.order.orderType,
                    expectedVersionReference: candidate.workflowVersionReference,
                    currentState: candidate.phaseBefore,
                    action: fulfillment.action,
                    observedAt: candidate.recordedAt,
                  },
                });
                return (
                  evaluated.transition.transitionReference === candidate.transitionReference &&
                  (await options.validateEligibility(transaction, candidate, order)) === true
                );
              },
            )) === true
          );
        },
      });
      return writer.commit({ transaction: input.transaction, record });
    },
  });
}

type FulfillmentEvent = ReturnType<typeof parseFulfillmentCompletedEnvelope>;

/** Event-only entry for an authorized worker; no caller-built Order completion fact is accepted. */
export function createOrderFulfillmentEventComposition(
  options: Parameters<typeof createOrderFulfillmentComposition>[0] & {
    authorizeEvent(transaction: ConsumerTransaction, event: FulfillmentEvent): Promise<boolean>;
    workflowVersionReference: string;
    transitionReference: string;
    references: {
      derive(kind: "Completion" | "Operation" | "Audit", eventReference: string): string;
      now(): string;
    };
  },
) {
  const scope = Object.freeze({ ...options.scope });
  const fulfillment = Object.freeze({ ...options.fulfillment });
  const workflowVersionReference = parseOrderingReference(options.workflowVersionReference);
  const transitionReference = parseOrderingReference(options.transitionReference);
  const composition = createOrderFulfillmentComposition(options);
  return Object.freeze({
    async commitEvent(input: { transaction: ConsumerTransaction; envelope: unknown }) {
      const event = parseFulfillmentCompletedEnvelope(input.envelope);
      const tx = input.transaction;
      if (
        event.tenantId !== scope.brandReference ||
        event.storeId !== scope.storeReference ||
        (await options.authorizeEvent(tx, event)) !== true
      )
        throw new OrderFulfillmentCompletionError("ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE");
      // These internal public-owner calls follow the event authorization above in the same transaction.
      const association = await createPostgresPickupOrderCompletionLookup({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async () => true,
      }).loadByOrder({ transaction: tx, orderReference: event.payload.orderReference });
      if (association === null)
        throw new OrderFulfillmentCompletionError("ORDER_FULFILLMENT_COMPLETION_UNAVAILABLE");
      const state = await createPostgresOrderExecutionReader({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        sha256: options.sha256,
        authorize: async () => true,
      }).loadByBatch({
        transaction: tx,
        orderReference: association.orderReference,
        orderBatchReference: association.orderBatchReference,
      });
      if (state.completion !== null) {
        try {
          validateOrderFulfillmentCompletionRecord(
            { ...state.completion, sourceEvent: event },
            options.sha256,
          );
        } catch {
          throw new OrderFulfillmentCompletionError("ORDER_FULFILLMENT_COMPLETION_CONFLICT");
        }
        return composition.commit({ transaction: tx, record: state.completion });
      }
      const record = createOrderFulfillmentCompletionRecord(
        {
          completionReference: options.references.derive("Completion", event.eventId),
          operationReference: options.references.derive("Operation", event.eventId),
          auditReference: options.references.derive("Audit", event.eventId),
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          orderReference: association.orderReference,
          orderBatchReference: association.orderBatchReference,
          orderType: "Pickup",
          phaseBefore: state.phase,
          expectedOrderVersion: state.version,
          expectedSourceCheckpoint: state.checkpoint,
          fulfilledOrderVersion: state.version + 1,
          phase: "Fulfilled",
          closureStatus: "Open",
          actorType: "System",
          actorReference: null,
          purposeCode: fulfillment.purposeCode,
          permissionCode: fulfillment.permissionCode,
          workflowVersionReference,
          transitionReference,
          completedAt: event.occurredAt,
          recordedAt: options.references.now(),
          sourceEvent: event,
        },
        options.sha256,
      );
      return composition.commit({ transaction: tx, record });
    },
  });
}
