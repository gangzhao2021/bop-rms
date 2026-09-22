import type { ConsumerTransaction } from "@bop/eventing";
import { exactPaymentObject, parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import { ordinaryRefundPaymentAmount } from "../application/ordinary-refund-request.js";
import { createPostgresOrdinaryRefundRequestContextSource } from "./persistence/ordinary-refund-request-store.js";
import {
  createPostgresOrdinaryRefundClaimOutcomeReader,
  createPostgresOrdinaryRefundPreparedReader,
} from "./persistence/ordinary-refund-operation-store.js";
import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";

type ContextOptions = Parameters<typeof createPostgresOrdinaryRefundRequestContextSource>[0];
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_STATUS_UNAVAILABLE");
};
/** Read committed request/dispatch/observation facts. No execution grant or Provider I/O.
 * Caller must acquire request-operation before order fences, as the context source does. */
export function createPostgresOrdinaryRefundRequestStatusSource(options: {
  scope: ContextOptions["scope"];
  providerAccountReference: string;
  environment: "Test" | "Live";
  authorize: ContextOptions["authorize"];
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  const account = String(parsePaymentReference(options.providerAccountReference));
  if (options.environment !== "Test" && options.environment !== "Live") return fail();
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["orderReference", "operationReference", "observedAt"]);
    const query = {
      orderReference: String(parsePaymentReference(raw.orderReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
      observedAt: parsePaymentInstant(raw.observedAt),
    };
    const allowed = () => options.authorize(tx, { ...scope, ...query });
    if ((await allowed()) !== true) return fail();
    const context = await createPostgresOrdinaryRefundRequestContextSource({
      scope,
      authorize: allowed,
    })(tx, query);
    const request = context.existing;
    if (!request) return fail();
    const recover = createPostgresOrdinaryRefundRecoverySource({
      scope,
      providerAccountReference: account,
      environment: options.environment,
      authorize: allowed,
    });
    const read = createPostgresOrdinaryRefundClaimOutcomeReader({
      scope,
      authorize: allowed,
      recover,
    });
    const readPrepared = createPostgresOrdinaryRefundPreparedReader({
      scope,
      providerAccountReference: account,
      environment: options.environment,
      authorize: allowed,
    });
    const payments = [];
    for (const payment of request.payments) {
      const amountMinor = ordinaryRefundPaymentAmount(payment);
      const prepared = await readPrepared(tx, {
        orderReference: request.orderReference,
        requestReference: request.requestReference,
        paymentAttemptReference: payment.paymentAttemptReference,
        observedAt: query.observedAt,
      });
      if (
        prepared &&
        (prepared.paymentIntentReference !== payment.paymentIntentReference ||
          prepared.paymentTransactionReference !== payment.paymentTransactionReference ||
          prepared.firstCaptureReference !== payment.firstCaptureReference ||
          prepared.amountMinor !== amountMinor)
      )
        return fail();
      const result = await read(tx, {
        orderReference: request.orderReference,
        requestReference: request.requestReference,
        paymentAttemptReference: payment.paymentAttemptReference,
        observedAt: query.observedAt,
      });
      if (
        result &&
        (!prepared || result.operation.operationReference !== prepared.operationReference)
      )
        return fail();
      if (
        result &&
        (result.operation.paymentIntentReference !== payment.paymentIntentReference ||
          result.operation.paymentTransactionReference !== payment.paymentTransactionReference ||
          result.operation.firstCaptureReference !== payment.firstCaptureReference ||
          result.operation.amountMinor !== amountMinor ||
          result.operation.providerAccountReference !== account ||
          result.operation.environment !== options.environment ||
          result.position.confirmedMinor + result.position.pendingMinor !== amountMinor ||
          result.position.releasedMinor !== 0n)
      )
        return fail();
      payments.push(
        Object.freeze({
          paymentAttemptReference: payment.paymentAttemptReference,
          paymentIntentReference: payment.paymentIntentReference,
          executionOperationReference: prepared?.operationReference ?? null,
          state:
            result?.position.state ??
            (prepared ? ("Prepared" as const) : ("NotDispatched" as const)),
          amountMinor: amountMinor.toString(),
          confirmedMinor: (result?.position.confirmedMinor ?? 0n).toString(),
          pendingMinor: (result?.position.pendingMinor ?? amountMinor).toString(),
        }),
      );
    }
    if ((await allowed()) !== true) return fail();
    return Object.freeze({
      orderReference: request.orderReference,
      requestReference: request.requestReference,
      operationReference: request.operationReference,
      observedAt: query.observedAt,
      currencyCode: request.currencyCode,
      amountMinor: request.amountMinor.toString(),
      payments: Object.freeze(payments),
    });
  };
}
