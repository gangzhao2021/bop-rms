import { readClosedRecord } from "@bop/identity";
import { createPostgresPaymentOperationFence } from "@rms/payment";
import {
  createPostgresOrderBatchCheckoutCancellationReader,
  createPostgresOrderBatchCheckoutCancellationStore,
  parseOrderBatchCheckoutCancellation,
  parseOrderBatchCheckoutExpiry,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { createDiningBatchCancellationSource } from "./dining-batch-cancellation-source.js";
import { evaluateDiningBatchCancellationWorkflow } from "./dining-batch-cancellation-workflow.js";
type SourceOptions = Parameters<typeof createDiningBatchCancellationSource>[0];
type Evidence = Awaited<ReturnType<ReturnType<typeof createDiningBatchCancellationSource>["load"]>>;
type Workflow = Parameters<typeof evaluateDiningBatchCancellationWorkflow>[0];
const unavailable = (): never => {
  throw new Error("DINING_BATCH_CANCELLATION_UNAVAILABLE");
};
/** Internal System command with mandatory same-transaction Inventory completion.
 * No financial compensation or table/session mutation.
 * The caller must reuse the same durable operation reference after uncertain responses.
 */
export function createDiningBatchCancellation(
  options: SourceOptions & {
    transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
    newReference(): string;
    inventory(
      transaction: ConsumerTransaction,
      input: Readonly<{
        mode: "Release" | "Verify";
        cancellation: ReturnType<typeof parseOrderBatchCheckoutCancellation>;
      }>,
    ): Promise<boolean>;
    resolvePolicy(
      tx: ConsumerTransaction,
      evidence: Evidence,
    ): Promise<null | {
      systemActorReference: string;
      workflowVersionReference: string;
      transitionReference: string;
      policy: Workflow["policy"];
      gates: Workflow["gates"];
    }>;
  },
) {
  const scope = {
    tenantReference: parseOrderingReference(options.scope.tenantReference),
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  };
  return Object.freeze({
    async cancel(value: unknown) {
      try {
        if (typeof options.inventory !== "function") return unavailable();
        const raw = readClosedRecord(value, ["operationReference", "expiry"]),
          operationReference = parseOrderingReference(raw.operationReference),
          expiry = parseOrderBatchCheckoutExpiry(raw.expiry),
          started = parseOrderingInstant(options.now());
        if (
          expiry.status !== "PaymentFailed" ||
          expiry.tenantReference !== scope.tenantReference ||
          expiry.brandReference !== scope.brandReference ||
          expiry.storeReference !== scope.storeReference ||
          expiry.observedAt > started
        )
          return unavailable();
        return await options.transactions.run(async (transaction) => {
          const allowed = async (tx: unknown) =>
            tx === transaction && (await options.authorize(transaction, expiry));
          if (!(await allowed(transaction))) return unavailable();
          await createPostgresPaymentOperationFence({
            ...scope,
            now: options.now,
            authorize: async (tx, query) =>
              query.orderReference === expiry.orderReference &&
              query.paymentOperationReference === expiry.paymentOperationReference &&
              (await allowed(tx)),
          }).acquire(transaction, {
            orderReference: expiry.orderReference,
            paymentOperationReference: expiry.paymentOperationReference,
          });
          const original = await createPostgresOrderBatchCheckoutCancellationReader({
            ...scope,
            now: options.now,
            authorize: allowed,
          }).loadOperation(transaction, {
            orderReference: expiry.orderReference,
            orderBatchReference: expiry.orderBatchReference,
            operationReference,
          });
          if (original) {
            if (
              original.operationReference !== operationReference ||
              original.expiryRecordReference !== expiry.recordReference ||
              original.expiryEvidenceDigest !== expiry.evidenceDigest ||
              original.submissionReference !== expiry.submissionReference ||
              original.paymentOperationReference !== expiry.paymentOperationReference ||
              !(await allowed(transaction))
            )
              return unavailable();
            if (
              (await options.inventory(
                transaction,
                Object.freeze({ mode: "Verify", cancellation: original }),
              )) !== true ||
              !(await allowed(transaction))
            )
              return unavailable();
            return Object.freeze({ status: "Existing" as const, record: original });
          }
          const evidence = await createDiningBatchCancellationSource({
            ...options,
            scope,
            authorize: allowed,
          }).load(transaction, expiry);
          const policy = await options.resolvePolicy(transaction, evidence);
          if (!policy) return unavailable();
          const record = parseOrderBatchCheckoutCancellation({
            ...scope,
            operationReference,
            cancellationReference: options.newReference(),
            orderReference: expiry.orderReference,
            orderBatchReference: expiry.orderBatchReference,
            submissionReference: expiry.submissionReference,
            paymentOperationReference: expiry.paymentOperationReference,
            expiryRecordReference: expiry.recordReference,
            expiryEvidenceDigest: expiry.evidenceDigest,
            expectedOrderVersion: evidence.orderVersion,
            cancelledOrderVersion: evidence.orderVersion + 1,
            expectedSourceCheckpoint: evidence.checkpoint,
            workflowVersionReference: policy.workflowVersionReference,
            transitionReference: policy.transitionReference,
            orderItemReferences: evidence.items
              .filter((item) => item.orderBatchReference === expiry.orderBatchReference)
              .map((item) => item.orderItemReference)
              .sort(),
            cancelledAt: evidence.observedAt,
            phase: "Cancelled",
            reasonCode: "CHECKOUT_DEADLINE_REACHED",
          });
          const matches = (candidate: typeof record) =>
            candidate.orderReference === expiry.orderReference &&
            candidate.orderBatchReference === expiry.orderBatchReference &&
            candidate.paymentOperationReference === expiry.paymentOperationReference;
          const writer = createPostgresOrderBatchCheckoutCancellationStore({
            ...scope,
            now: options.now,
            authorize: async (tx, candidate) => matches(candidate) && (await allowed(tx)),
            fence: async (tx, candidate) => tx === transaction && matches(candidate),
            source: async (tx) => {
              if (tx !== transaction) return unavailable();
              return evidence;
            },
            workflow: async (tx, candidate) => {
              if (tx !== transaction) return unavailable();
              await evaluateDiningBatchCancellationWorkflow({
                transaction,
                source: { record: candidate, expiry: evidence.expiry, items: evidence.items },
                systemActorReference: policy.systemActorReference,
                policy: policy.policy,
                gates: policy.gates,
                request: {
                  ...scope,
                  actorReference: policy.systemActorReference,
                  resourceReference: record.orderReference,
                  resourceVersion: record.expectedOrderVersion,
                  purposeCode: policy.policy.purposeCode,
                  applicabilityCode: "DineIn",
                  expectedVersionReference: record.workflowVersionReference,
                  currentState: evidence.progress.phase,
                  action: policy.policy.action,
                  observedAt: record.cancelledAt,
                },
              });
              return true;
            },
            audit: (candidate) =>
              Promise.resolve({
                auditId: options.newReference(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "System" },
                actionCode: "ORDERING_BATCH_CHECKOUT_CANCELLED",
                targetType: "OrderBatch",
                targetId: candidate.orderBatchReference,
                correlationId: candidate.operationReference,
                reasonCode: candidate.reasonCode,
                occurredAt: candidate.cancelledAt,
                sourceChannel: "SYSTEM",
                dataClassification: "Restricted",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              }),
          });
          const result = await writer.append(transaction, record);
          if (
            (await options.inventory(
              transaction,
              Object.freeze({ mode: "Release", cancellation: record }),
            )) !== true
          )
            return unavailable();
          if (parseOrderingInstant(options.now()) < started || !(await allowed(transaction)))
            return unavailable();
          return result;
        });
      } catch {
        return unavailable();
      }
    },
  });
}
