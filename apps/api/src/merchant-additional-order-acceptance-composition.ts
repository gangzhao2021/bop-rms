import { createPostgresWorkflowDefinitionStore } from "@bop/workflow";
import {
  createPostgresAdditionalDiningExecutionReader,
  createPostgresOrderAcceptanceStore,
  encodeAdditionalDiningBatchSnapshot,
  parseOrderAcceptanceRecord,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import type { createMerchantOrderAcceptanceComposition } from "./merchant-order-acceptance-composition.js";

type InitialOptions = Parameters<typeof createMerchantOrderAcceptanceComposition>[0];
type Execution = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof createPostgresAdditionalDiningExecutionReader>["loadBySubmission"]>
  >
>;

/** Accept this submitted Batch using the current Order fence and published policy. */
export function createMerchantAdditionalOrderAcceptanceComposition(
  options: Omit<InitialOptions, "validateEligibility"> & {
    sha256(value: string): string;
    validateEligibility(
      transaction: ConsumerTransaction,
      record: Parameters<InitialOptions["authorize"]>[1],
      execution: Execution,
    ): Promise<boolean>;
  },
) {
  const scope = Object.freeze({ ...options.scope });
  const acceptance = Object.freeze({ ...options.acceptance });
  return Object.freeze({
    async commit(input: {
      transaction: ConsumerTransaction;
      record: unknown;
      submissionReference: string;
    }) {
      const record = parseOrderAcceptanceRecord(input.record);
      const authorize = (transaction: ConsumerTransaction, candidate: typeof record) =>
        candidate.actorType === "User" &&
        candidate.purposeCode === acceptance.purposeCode &&
        candidate.permissionCode === acceptance.permissionCode
          ? options.authorize(transaction, candidate)
          : Promise.resolve(false);
      return createPostgresOrderAcceptanceStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize,
        audit: options.audit,
        validateCurrentSource: async (transaction, candidate) => {
          const execution = await createPostgresAdditionalDiningExecutionReader({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: (tx) => authorize(tx, candidate),
          }).loadBySubmission({
            transaction,
            submissionReference: input.submissionReference,
            observedAt: candidate.acceptedAt,
          });
          if (
            !execution ||
            execution.acceptance !== null ||
            execution.batchPhase !== "Submitted" ||
            execution.snapshot.snapshotVersion !== options.quoteVersion ||
            execution.snapshot.orderReference !== candidate.orderReference ||
            execution.snapshot.batch.orderBatchReference !== candidate.orderBatchReference ||
            execution.orderVersion !== candidate.expectedOrderVersion ||
            candidate.sourceDigest !==
              options.sha256(encodeAdditionalDiningBatchSnapshot(execution.snapshot)) ||
            candidate.actorReference === null
          )
            return false;
          const evaluated = await createPostgresWorkflowDefinitionStore(
            { run: (work) => work(transaction) },
            scope,
          ).evaluatePublishedAction(
            {
              ...scope,
              actorReference: candidate.actorReference,
              resourceReference: candidate.orderReference,
              resourceVersion: execution.orderVersion,
              purposeCode: acceptance.purposeCode,
              applicabilityCode: "DineIn",
              expectedVersionReference: candidate.workflowVersionReference,
              currentState: execution.canonicalPhase,
              action: acceptance.action,
              observedAt: candidate.acceptedAt,
            },
            {
              ...options.gates,
              authorizeAction: async (tx, action) =>
                action.transition.nextState === "Accepted" &&
                action.transition.permissionCode === acceptance.permissionCode &&
                (await options.gates.authorizeAction(tx, action)) === true,
            },
          );
          if (
            evaluated.transition.transitionReference !== candidate.transitionReference ||
            evaluated.transition.effects.length !== 0
          )
            return false;
          return (await options.validateEligibility(transaction, candidate, execution)) === true;
        },
      }).commit({ transaction: input.transaction, record });
    },
  });
}
