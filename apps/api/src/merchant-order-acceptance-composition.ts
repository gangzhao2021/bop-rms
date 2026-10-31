import { createInitialDiningAcceptanceSource } from "./initial-dining-acceptance-source.js";
import {
  createPostgresOrderAcceptanceStore,
  createPostgresOrderCreationQueryStore,
  parseOrderAcceptanceRecord,
  type OrderCreationRecord,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { evaluateOrderAcceptanceWorkflow } from "./order-acceptance-workflow.js";

type WriterOptions = Parameters<typeof createPostgresOrderAcceptanceStore>[0];
type Evaluation = Parameters<typeof evaluateOrderAcceptanceWorkflow>[0];

/** Server composition for named merchant actors; caller owns transaction and source fences. */
export function createMerchantOrderAcceptanceComposition(options: {
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
  quoteVersion: 1 | 2;
  acceptance: Evaluation["acceptance"];
  gates: Evaluation["gates"];
  authorize: WriterOptions["authorize"];
  audit: WriterOptions["audit"];
  validateEligibility(
    transaction: ConsumerTransaction,
    record: Parameters<WriterOptions["validateCurrentSource"]>[1],
    order: OrderCreationRecord<1 | 2>,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({ ...options.scope });
  const acceptance = Object.freeze({ ...options.acceptance });
  return Object.freeze({
    async commit(input: {
      transaction: ConsumerTransaction;
      record: unknown;
      submissionReference: string;
    }) {
      const record = parseOrderAcceptanceRecord(input.record);
      const writer = createPostgresOrderAcceptanceStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async (transaction, candidate) =>
          candidate.actorType === "User" &&
          candidate.purposeCode === acceptance.purposeCode &&
          candidate.permissionCode === acceptance.permissionCode &&
          (await options.authorize(transaction, candidate)) === true,
        audit: options.audit,
        validateCurrentSource: async (transaction, candidate) => {
          const reader = createPostgresOrderCreationQueryStore(
            { run: async (work) => work(transaction) },
            { brandReference: scope.brandReference, storeReference: scope.storeReference },
            options.quoteVersion,
          );
          const allowed = await reader.withCurrentSubmission(
            input.submissionReference,
            async (_, order) => {
              const currentDining =
                order.order.orderType === "DineIn"
                  ? await createInitialDiningAcceptanceSource({
                      brandReference: scope.brandReference,
                      storeReference: scope.storeReference,
                      quoteVersion: options.quoteVersion,
                      authorize: (tx) => options.authorize(tx, candidate),
                    }).resolve(transaction, {
                      orderReference: candidate.orderReference,
                      orderBatchReference: candidate.orderBatchReference,
                      submissionReference: input.submissionReference,
                      observedAt: candidate.acceptedAt,
                    })
                  : null;
              if (
                order.order.orderReference !== candidate.orderReference ||
                (currentDining?.current.orderVersion ?? order.order.aggregateVersion) !==
                  candidate.expectedOrderVersion ||
                !order.order.batches.some(
                  (batch) => batch.orderBatchReference === candidate.orderBatchReference,
                ) ||
                candidate.actorReference === null
              )
                return false;
              const evaluated = await evaluateOrderAcceptanceWorkflow({
                transaction,
                order,
                currentDining,
                quoteVersion: options.quoteVersion,
                acceptance,
                gates: options.gates,
                request: {
                  tenantReference: scope.tenantReference,
                  brandReference: scope.brandReference,
                  storeReference: scope.storeReference,
                  actorReference: candidate.actorReference,
                  resourceReference: candidate.orderReference,
                  resourceVersion: candidate.expectedOrderVersion,
                  purposeCode: acceptance.purposeCode,
                  applicabilityCode: order.order.orderType,
                  expectedVersionReference: candidate.workflowVersionReference,
                  currentState: currentDining?.current.canonicalPhase ?? order.order.canonicalPhase,
                  action: acceptance.action,
                  observedAt: candidate.acceptedAt,
                },
              });
              if (evaluated.transition.transitionReference !== candidate.transitionReference)
                return false;
              return (await options.validateEligibility(transaction, candidate, order)) === true;
            },
          );
          return allowed === true;
        },
      });
      return writer.commit({ transaction: input.transaction, record });
    },
  });
}
