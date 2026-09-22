import { bindOrdinaryRefundProviderOutcome } from "../application/ordinary-refund-provider-result.js";
import { exactPaymentObject } from "../application/payment-intent-creation.js";
import { createPostgresOrdinaryRefundObservationRuntime } from "./ordinary-refund-observation-runtime.js";
import type { ConsumerTransaction } from "@bop/eventing";
import type { RefundPaymentRequest } from "../contracts/payment-provider-adapter.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import { createPostgresOrdinaryRefundDispatchRuntime } from "./ordinary-refund-dispatch-runtime.js";
import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";

type DispatchOptions = Parameters<typeof createPostgresOrdinaryRefundDispatchRuntime>[0];
type RecoveryOptions = Parameters<typeof createPostgresOrdinaryRefundRecoverySource>[0];

/** Internal coordinator. The transaction runner must resolve only after commit.
 * Existing journals never trigger another send. A normalized channel snapshot
 * is evidence for reconciliation, not proof that this individual refund settled.
 * The actual observation/Audit writer is mandatory internal composition. */
export function createPostgresOrdinaryRefundSendRuntime(options: {
  dispatch: DispatchOptions;
  authorizeRecovery: RecoveryOptions["authorize"];
  transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  provider: { refundPayment(request: RefundPaymentRequest): Promise<unknown> };
  generateObservationIdentity(): { observationReference: string; auditReference: string };
}) {
  const dispatch = createPostgresOrdinaryRefundDispatchRuntime(options.dispatch);
  const recover = createPostgresOrdinaryRefundRecoverySource({
    scope: options.dispatch.scope,
    providerAccountReference: options.dispatch.providerAccountReference,
    environment: options.dispatch.environment,
    authorize: options.authorizeRecovery,
  });
  const observations = createPostgresOrdinaryRefundObservationRuntime({
    scope: options.dispatch.scope,
    providerAccountReference: options.dispatch.providerAccountReference,
    environment: options.dispatch.environment,
    authorize: options.authorizeRecovery,
  });
  return async (input: unknown, policy: unknown) => {
    const committed = await options.transactions.run(async (tx) => {
      const journal = await dispatch.record(tx, input, policy);
      const recovery = await recover(tx, {
        orderReference: journal.dispatch.orderReference,
        operationReference: journal.dispatch.operationReference,
      });
      if (!recovery) throw new Error("ORDINARY_REFUND_RECOVERY_UNAVAILABLE");
      const rawIdentity =
        journal.status === "Created"
          ? exactPaymentObject(options.generateObservationIdentity(), [
              "observationReference",
              "auditReference",
            ])
          : null;
      const observationIdentity =
        rawIdentity === null
          ? null
          : {
              observationReference: String(parsePaymentReference(rawIdentity.observationReference)),
              auditReference: String(parsePaymentReference(rawIdentity.auditReference)),
            };
      return { journal, recovery, observationIdentity };
    });
    if (committed.journal.status === "Created") {
      let result: unknown;
      try {
        result = await options.provider.refundPayment(committed.recovery.request);
      } catch {
        result = null;
      }
      const outcome = bindOrdinaryRefundProviderOutcome(committed.recovery.request, result);
      // Failure here leaves DispatchStarted durable. A later call recovers
      // that original identity; it must not automatically send again.
      if (!committed.observationIdentity) throw new Error("ORDINARY_REFUND_OBSERVATION_INVALID");
      await options.transactions.run((tx) =>
        observations.record(tx, {
          orderReference: committed.journal.dispatch.orderReference,
          operationReference: committed.journal.dispatch.operationReference,
          ...committed.observationIdentity,
          outcome,
        }),
      );
    }
    return Object.freeze({
      ...committed.journal,
      state: "NeedsReconciliation" as const,
    });
  };
}
