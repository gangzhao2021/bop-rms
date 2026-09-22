import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { canonicalizeRfc8785 } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { createPostgresPaymentOperationFence } from "@rms/payment";
import {
  parseCheckoutSessionAllocation,
  parseOrderingReference,
  parseOrderBatchCheckoutExpiry,
  createPostgresOrderBatchCheckoutExpiryStore,
} from "@rms/ordering";
import { createDiningCheckoutTimeoutObservation } from "./dining-checkout-timeout-observation.js";
const fail = (): never => {
  throw new Error("DINING_CHECKOUT_EXPIRY_RECORDING_UNAVAILABLE");
};
/** Trusted system composition, not an HTTP command or cancellation action.
 * The transaction retains Payment fences through evidence, owner append and Audit.
 */
export function createDiningCheckoutExpiryRecorder(options: {
  scope: Parameters<typeof createDiningCheckoutTimeoutObservation>[0]["scope"];
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorize(
    transaction: ConsumerTransaction,
    identity: { orderReference: string; orderBatchReference: string },
  ): Promise<boolean>;
  now(): string;
  newReference(): string;
}) {
  const scope = Object.freeze({ ...options.scope });
  return Object.freeze({
    async record(value: unknown) {
      try {
        const raw = readClosedRecord(value, [
          "orderReference",
          "orderBatchReference",
          "allocation",
        ]);
        const identity = {
          orderReference: String(parseOrderingReference(raw.orderReference)),
          orderBatchReference: String(parseOrderingReference(raw.orderBatchReference)),
        };
        const allocation = parseCheckoutSessionAllocation(raw.allocation);
        if (
          allocation.brandReference !== scope.brandReference ||
          allocation.storeReference !== scope.storeReference
        )
          return fail();
        return await options.transactions.run(async (transaction) => {
          const authorize = async (tx: ConsumerTransaction) =>
            tx === transaction && (await options.authorize(tx, identity));
          if (!(await authorize(transaction))) return fail();
          const fence = createPostgresPaymentOperationFence({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            now: options.now,
            authorize: async (tx, query) =>
              tx === transaction &&
              query.orderReference === identity.orderReference &&
              query.paymentOperationReference === allocation.paymentOperationReference &&
              (await authorize(transaction)),
          });
          await fence.acquire(transaction, {
            orderReference: identity.orderReference,
            paymentOperationReference: allocation.paymentOperationReference,
          });
          const source = createDiningCheckoutTimeoutObservation({
            scope,
            now: options.now,
            authorize,
          });
          const observation = await source.resolve(transaction, allocation);
          if (
            String(observation.orderReference) !== identity.orderReference ||
            String(observation.orderBatchReference) !== identity.orderBatchReference
          )
            return fail();
          if (observation.status === "NotStarted")
            return Object.freeze({ status: "NotStarted" as const });
          if (observation.status === "NotDue") return Object.freeze({ status: "NotDue" as const });
          const paymentEvidence =
            observation.status === "Unresolved"
              ? null
              : {
                  paymentIntentReference: observation.paymentIntentReference,
                  paymentAttemptReference: observation.paymentAttemptReference,
                  paymentEventReference: observation.paymentEventReference,
                  outcome:
                    observation.status === "Failed" ? ("Failed" as const) : ("Succeeded" as const),
                  occurredAt: observation.terminalOccurredAt,
                };
          const status =
            observation.status === "Unresolved"
              ? "AwaitingPaymentResolution"
              : observation.status === "Failed"
                ? "PaymentFailed"
                : observation.status === "PaidBeforeDeadline"
                  ? "PaidBeforeDeadline"
                  : "LatePayment";
          const evidence = {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            ...identity,
            submissionReference: observation.submissionReference,
            commitmentReference: observation.commitmentReference,
            paymentOperationReference: observation.paymentOperationReference,
            paymentRequestedAt: observation.paymentRequestedAt,
            capacityExpiresAt: observation.capacityExpiresAt,
            observedAt: observation.observedAt,
            paymentEvidence,
          };
          const store = createPostgresOrderBatchCheckoutExpiryStore({
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            now: options.now,
            authorize: async (tx, query) =>
              query.orderReference === identity.orderReference &&
              query.orderBatchReference === identity.orderBatchReference &&
              (await authorize(tx)),
            fence: async (tx, record) =>
              tx === transaction &&
              record.orderReference === identity.orderReference &&
              record.orderBatchReference === identity.orderBatchReference &&
              record.paymentOperationReference === allocation.paymentOperationReference,
            evidence: async () => evidence,
            audit: async (record) => ({
              auditId: options.newReference(),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "System" },
              actionCode: "ORDERING_BATCH_CHECKOUT_EXPIRY_RECORDED",
              targetType: "OrderBatch",
              targetId: identity.orderBatchReference,
              correlationId: record.recordReference,
              reasonCode: "CHECKOUT_DEADLINE_REACHED",
              occurredAt: record.observedAt,
              sourceChannel: "SYSTEM",
              dataClassification: "Restricted",
              retentionPolicyCode: "AUDIT_DEFAULT",
              retentionPolicyVersion: 1,
            }),
          });
          const history = await store.load(transaction, identity),
            prior = history.at(-1);
          if (prior) {
            for (const key of [
              "submissionReference",
              "commitmentReference",
              "paymentOperationReference",
              "paymentRequestedAt",
              "capacityExpiresAt",
            ] as const)
              if (String(prior[key]) !== String(evidence[key])) return fail();
            if (
              prior.status === status &&
              canonicalizeRfc8785(prior.paymentEvidence) === canonicalizeRfc8785(paymentEvidence)
            )
              return Object.freeze({ status: "Existing" as const, record: prior });
            if (prior.status !== "AwaitingPaymentResolution") return fail();
          }
          const record = parseOrderBatchCheckoutExpiry({
            ...evidence,
            recordReference: options.newReference(),
            previousRecordReference: prior?.recordReference ?? null,
            version: prior ? 2 : 1,
            status,
            evidenceDigest:
              "sha256:" + createHash("sha256").update(canonicalizeRfc8785(evidence)).digest("hex"),
          });
          const result = await store.append(transaction, record);
          if (!(await authorize(transaction))) return fail();
          return result;
        });
      } catch {
        return fail();
      }
    },
  });
}
