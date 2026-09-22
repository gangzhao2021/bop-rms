import type { ConsumerTransaction } from "@bop/eventing";
import type { RefundPaymentRequest } from "../contracts/payment-provider-adapter.js";
import { exactPaymentObject } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import { bindOrdinaryRefundProviderOutcome } from "../application/ordinary-refund-provider-result.js";
import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";
import {
  createPostgresOrdinaryRefundObservationStore,
  createPostgresOrdinaryRefundObservationReader,
} from "./persistence/ordinary-refund-operation-store.js";

export function createPostgresOrdinaryRefundReconciliationRuntime(
  options: Parameters<typeof createPostgresOrdinaryRefundRecoverySource>[0] & {
    transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
    provider: { lookupRefund(request: RefundPaymentRequest): Promise<unknown> };
  },
) {
  const recover = createPostgresOrdinaryRefundRecoverySource(options);
  const storageOptions = { scope: options.scope, authorize: options.authorize, recover };
  const reader = createPostgresOrdinaryRefundObservationReader(storageOptions);
  const writer = createPostgresOrdinaryRefundObservationStore(storageOptions);
  return async (value: unknown) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "operationReference",
      "observationReference",
      "auditReference",
    ]);
    const query = {
      orderReference: String(parsePaymentReference(raw.orderReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
      observationReference: String(parsePaymentReference(raw.observationReference)),
    };
    const auditReference = String(parsePaymentReference(raw.auditReference));
    const already = (observation: NonNullable<Awaited<ReturnType<typeof reader>>>) => {
      if (observation.auditReference !== auditReference)
        throw new Error("ORDINARY_REFUND_OBSERVATION_CONFLICT");
      return Object.freeze({ status: "AlreadyCommitted" as const, observation });
    };
    const prepared = await options.transactions.run(async (tx) => {
      const existing = await reader(tx, query);
      if (existing) return { existing, recovery: null };
      const recovery = await recover(tx, {
        orderReference: query.orderReference,
        operationReference: query.operationReference,
      });
      if (!recovery) throw new Error("ORDINARY_REFUND_RECOVERY_UNAVAILABLE");
      return { existing: null, recovery };
    });
    if (prepared.existing) return already(prepared.existing);
    if (!prepared.recovery) throw new Error("ORDINARY_REFUND_RECOVERY_UNAVAILABLE");
    let response: unknown;
    try {
      response = await options.provider.lookupRefund(prepared.recovery.request);
    } catch {
      response = null;
    }
    const outcome = bindOrdinaryRefundProviderOutcome(prepared.recovery.request, response);
    return options.transactions.run(async (tx) => {
      const existing = await reader(tx, query);
      if (existing) return already(existing);
      return writer.record(tx, { ...query, auditReference, outcome });
    });
  };
}
