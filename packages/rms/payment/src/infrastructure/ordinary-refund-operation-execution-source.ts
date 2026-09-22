import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrdinaryRefundOperation } from "../application/ordinary-refund-operation.js";
import { assertOrdinaryRefundExecutor } from "../application/ordinary-refund-executor.js";
import { parsePaymentInstant } from "../application/payment-intent-creation.js";
import { createPostgresOrdinaryRefundCaptureSource } from "./persistence/ordinary-refund-capture-source.js";
import { createPostgresOrdinaryRefundExecutionBalanceSource } from "./persistence/ordinary-refund-request-store.js";

type CaptureOptions = Parameters<typeof createPostgresOrdinaryRefundCaptureSource>[0];
type ExecutorQuery = Pick<
  CaptureOptions["scope"],
  "tenantReference" | "brandReference" | "storeReference"
> & {
  readonly orderReference: string;
  readonly actorReference: string;
  readonly observedAt: string;
};
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_EXECUTION_SOURCE_UNAVAILABLE");
};

/** Actual original capture/Pricing/current occupancy and executor source.
 * Caller retains the transaction fences. Escalation and independent approval
 * are separate mandatory gates; this result never authorizes Provider I/O. */
export function createPostgresOrdinaryRefundOperationExecutionSource(
  options: Omit<CaptureOptions, "now"> & {
    executor(tx: ConsumerTransaction, query: ExecutorQuery): Promise<unknown>;
  },
) {
  return async (tx: ConsumerTransaction, value: unknown, at: string) => {
    const operation = parseOrdinaryRefundOperation(value);
    const observedAt = parsePaymentInstant(at);
    if (
      operation.preparedAt > observedAt ||
      operation.tenantReference !== options.scope.tenantReference ||
      operation.brandReference !== options.scope.brandReference ||
      operation.storeReference !== options.scope.storeReference ||
      operation.providerAccountReference !== options.scope.providerAccountReference ||
      operation.environment !== options.scope.environment
    )
      return fail();
    const current = await createPostgresOrdinaryRefundExecutionBalanceSource({
      scope: options.scope,
      authorize: options.authorize,
      validateSources: createPostgresOrdinaryRefundCaptureSource({
        ...options,
        now: () => observedAt,
      }),
    })(tx, {
      orderReference: operation.orderReference,
      requestReference: operation.requestReference,
    });
    if (observedAt > current.observedAt || current.claimVersion !== operation.claimVersion)
      return fail();
    const leg = current.request.payments.find(
      (p) => p.paymentAttemptReference === operation.paymentAttemptReference,
    );
    const position = current.positions.find(
      (p) => p.paymentAttemptReference === operation.paymentAttemptReference,
    );
    if (
      !leg ||
      !position ||
      leg.paymentTransactionReference !== operation.paymentTransactionReference ||
      leg.paymentIntentReference !== operation.paymentIntentReference ||
      leg.firstCaptureReference !== operation.firstCaptureReference ||
      position.requestAmountMinor !== operation.amountMinor
    )
      return fail();
    const expected = {
      tenantReference: operation.tenantReference,
      brandReference: operation.brandReference,
      storeReference: operation.storeReference,
      orderReference: operation.orderReference,
      actorReference: operation.executorReference,
    };
    assertOrdinaryRefundExecutor({
      expected,
      observedAt: current.observedAt,
      authority: await options.executor(tx, { ...expected, observedAt: current.observedAt }),
    });
    return Object.freeze({
      position,
      observedAt: current.observedAt,
      claimVersion: current.claimVersion,
    });
  };
}
