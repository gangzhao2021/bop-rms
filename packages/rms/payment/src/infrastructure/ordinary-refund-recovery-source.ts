import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundDispatchReader } from "./persistence/ordinary-refund-operation-store.js";
import { createPostgresPaymentTerminalStore } from "./persistence/payment-terminal-store.js";
import { createOrdinaryRefundProviderRequest } from "../application/ordinary-refund-provider-request.js";
import {
  createOrdinaryRefundDispatch,
  encodeOrdinaryRefundDispatch,
} from "../application/ordinary-refund-dispatch.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";

type ReaderOptions = Parameters<typeof createPostgresOrdinaryRefundDispatchReader>[0];
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_RECOVERY_UNAVAILABLE");
};

/** Recover the exact prior request from immutable local facts. No new execution
 * grant, current balance gate or Provider I/O: the caller must reconcile history. */
export function createPostgresOrdinaryRefundRecoverySource(
  options: ReaderOptions & {
    providerAccountReference: string;
    environment: "Test" | "Live";
  },
) {
  const account = String(parsePaymentReference(options.providerAccountReference));
  if (options.environment !== "Test" && options.environment !== "Live") return fail();
  const history = createPostgresOrdinaryRefundDispatchReader(options);
  return async (tx: ConsumerTransaction, value: unknown) => {
    const recovered = await history(tx, value);
    if (!recovered) return null;
    const { operation, dispatch } = recovered;
    if (
      operation.providerAccountReference !== account ||
      operation.environment !== options.environment
    )
      return fail();
    const terminal = createPostgresPaymentTerminalStore(
      {
        run: async <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
      },
      {
        brandReference: operation.brandReference,
        storeReference: operation.storeReference,
        providerAccountReference: account,
        environment: options.environment,
      },
    );
    const fact = await terminal.read(operation.paymentIntentReference);
    if (
      !fact ||
      fact.outcome !== "Succeeded" ||
      !fact.amount ||
      fact.amount.currencyCode !== "CAD" ||
      fact.amount.amountMinor < operation.amountMinor ||
      fact.orderReference !== operation.orderReference ||
      fact.paymentIntentReference !== operation.paymentIntentReference ||
      fact.paymentTransactionReference !== operation.paymentTransactionReference ||
      fact.paymentAttemptReference !== operation.paymentAttemptReference ||
      fact.observationReference !== operation.firstCaptureReference ||
      fact.recordedAt > operation.preparedAt ||
      fact.occurredAt > fact.recordedAt
    )
      return fail();
    const providerBinding = {
      tenantReference: operation.tenantReference,
      brandReference: operation.brandReference,
      storeReference: operation.storeReference,
      orderReference: fact.orderReference,
      paymentTransactionReference: fact.paymentTransactionReference,
      paymentIntentReference: fact.paymentIntentReference,
      paymentAttemptReference: fact.paymentAttemptReference,
      firstCaptureReference: fact.observationReference,
      providerAccountReference: fact.providerAccountReference,
      environment: fact.environment,
      providerIntentReference: fact.providerIntentReference,
      originalPaymentMethod: "OnlineCard",
    };
    const rebuilt = createOrdinaryRefundDispatch({
      operation,
      providerBinding,
      approvalReference: dispatch.approvalReference,
      claimVersion: dispatch.claimVersion,
      claimsDigest: dispatch.claimsDigest,
      startedAt: dispatch.startedAt,
      dispatchReference: dispatch.dispatchReference,
      auditReference: dispatch.auditReference,
    });
    if (encodeOrdinaryRefundDispatch(rebuilt) !== encodeOrdinaryRefundDispatch(dispatch))
      return fail();
    if (
      (await options.authorize(tx, {
        tenantReference: operation.tenantReference,
        brandReference: operation.brandReference,
        storeReference: operation.storeReference,
        orderReference: operation.orderReference,
        operationReference: operation.operationReference,
      })) !== true
    )
      return fail();
    return Object.freeze({
      ...recovered,
      request: createOrdinaryRefundProviderRequest(operation, providerBinding),
    });
  };
}
