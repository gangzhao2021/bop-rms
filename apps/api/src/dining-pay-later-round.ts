import { createPostgresWorkflowDefinitionStore } from "@bop/workflow";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresDiningPaymentTimingStore } from "@rms/dining";
import { createPostgresOrderPayLaterConfirmationStore } from "@rms/ordering";
import { createHash } from "node:crypto";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a round submitted at a table opened "pay later" goes straight to
 * the kitchen. In the caller's transaction (guest or staff authority already proven): the table's
 * timing is read from Dining, the published dining workflow's Accept transition is evaluated for a
 * System actor (only a transition to Accepted under `order.accept`; no overrides), and Ordering
 * records the automatic acceptance, the pay-later confirmation and the OrderConfirmed event the
 * kitchen takes — with their audit records. Nothing is paid and no payment clock starts.
 */
export interface DiningPayLaterRoundOptions {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly quoteVersion: 1 | 2;
  /** The dining workflow the Store's dine-in Orders follow (its purpose and published version). */
  readonly workflow: {
    readonly purposeCode: string;
    readonly applicabilityCode: string;
    readonly workflowVersionReference: string;
  };
  now(): string;
  generateReference(): string;
}

/** Ordering's digests are prefixed; Dining's intent hashes are bare hex. */
const sha256 = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const intentHash = (value: string) => createHash("sha256").update(value).digest("hex");

export function createDiningPayLaterRound(options: DiningPayLaterRoundOptions) {
  const scope = Object.freeze({ ...options.scope });
  const timings = createPostgresDiningPaymentTimingStore({
    scope,
    hashIntent: intentHash,
    equals: (a, b) => a === b,
  });
  const audit = (input: {
    action: "ORDER_ACCEPTED" | "ORDER_PAY_LATER_SENT_TO_KITCHEN";
    orderReference: string;
    correlationReference: string;
    occurredAt: string;
  }) => ({
    auditId: options.generateReference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" as const },
    actionCode: input.action,
    targetType: "Order",
    targetId: input.orderReference,
    correlationId: input.correlationReference,
    reasonCode: "PAY_LATER_SENT_TO_KITCHEN",
    occurredAt: input.occurredAt,
    sourceChannel: "API",
    afterSummary:
      input.action === "ORDER_ACCEPTED" ? { phase: "Accepted" } : { payment: "PayLater" },
    dataClassification: "Restricted" as const,
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  const confirmations = (authorize: (transaction: ConsumerTransaction) => Promise<boolean>) =>
    createPostgresOrderPayLaterConfirmationStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      quoteVersion: options.quoteVersion,
      sha256,
      authorize,
    });
  return Object.freeze({
    /** Whether this table was opened pay later (Dining), in the caller's transaction. */
    async isPayLater(transaction: ConsumerTransaction, diningSessionReference: string) {
      const found = await timings.loadSessionTimings(transaction, [diningSessionReference]);
      return found.get(diningSessionReference) === "PayLater";
    },

    /**
     * Sends the round of this submission to the kitchen. `actorReference` is who sent it (the
     * guest's session, or the staff member), the workflow request's actor; the acceptance itself
     * is the System's.
     */
    async confirm(
      transaction: ConsumerTransaction,
      input: {
        readonly submissionReference: string;
        readonly actorReference: string;
        readonly operationReference: string;
        readonly correlationReference: string;
        authorize(transaction: ConsumerTransaction): Promise<boolean>;
      },
    ) {
      const observedAt = new Date(Date.parse(options.now())).toISOString();
      return confirmations(input.authorize).confirm({
        transaction,
        operationReference: input.operationReference,
        submissionReference: input.submissionReference,
        observedAt,
        correlationReference: input.correlationReference,
        sessionIsPayLater: async (session) =>
          (await timings.loadSessionTimings(transaction, [session])).get(session) === "PayLater",
        acceptance: async (current) => {
          const evaluated = await createPostgresWorkflowDefinitionStore(
            { run: (work) => work(transaction) },
            scope,
          ).evaluatePublishedAction(
            {
              ...scope,
              actorReference: input.actorReference,
              resourceReference: current.orderReference,
              resourceVersion: current.expectedOrderVersion,
              purposeCode: options.workflow.purposeCode,
              applicabilityCode: options.workflow.applicabilityCode,
              expectedVersionReference: options.workflow.workflowVersionReference,
              currentState: current.currentState,
              action: "Accept",
              observedAt: current.observedAt,
            },
            {
              authorizeResource: async (_tx, request) =>
                request.resourceReference === current.orderReference &&
                request.resourceVersion === current.expectedOrderVersion &&
                (await input.authorize(transaction)) === true,
              authorizeAction: async (_tx, action) =>
                action.transition.nextState === "Accepted" &&
                action.transition.permissionCode === "order.accept",
              evaluateRule: async () => true,
              authorizeOverride: async () => false,
            },
          );
          if (evaluated.transition.effects.length !== 0)
            throw new Error("DINING_PAY_LATER_ACCEPTANCE_UNAVAILABLE");
          return {
            workflowVersionReference: options.workflow.workflowVersionReference,
            transitionReference: String(evaluated.transition.transitionReference),
            purposeCode: options.workflow.purposeCode,
            permissionCode: "order.accept",
          };
        },
        references: { generate: () => options.generateReference() },
        audit: {
          acceptance: (fact) =>
            audit({
              action: "ORDER_ACCEPTED",
              orderReference: fact.orderReference,
              correlationReference: input.correlationReference,
              occurredAt: observedAt,
            }),
          confirmation: (fact) =>
            audit({
              action: "ORDER_PAY_LATER_SENT_TO_KITCHEN",
              orderReference: fact.orderReference,
              correlationReference: input.correlationReference,
              occurredAt: observedAt,
            }),
        },
      });
    },

    /** What the round comes to, tax included (it is owed until the table is settled). */
    async roundTotalMinor(
      transaction: ConsumerTransaction,
      input: {
        readonly orderReference: string;
        readonly orderBatchReference: string;
        authorize(transaction: ConsumerTransaction): Promise<boolean>;
      },
    ) {
      return confirmations(input.authorize).roundTotalMinor({ transaction, ...input });
    },
  });
}

export type DiningPayLaterRound = ReturnType<typeof createDiningPayLaterRound>;
