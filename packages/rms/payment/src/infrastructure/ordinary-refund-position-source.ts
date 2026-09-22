import { createPostgresOrdinaryRefundRequestPositionSource } from "./persistence/ordinary-refund-request-store.js";
import { createPostgresOrdinaryRefundClaimOutcomeReader } from "./persistence/ordinary-refund-operation-store.js";
import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";
import { ordinaryRefundPaymentAmount } from "../application/ordinary-refund-request.js";

type Options = Omit<
  Parameters<typeof createPostgresOrdinaryRefundRequestPositionSource>[0],
  "readOutcome"
>;

/** Actual immutable capture/dispatch/observation composition; no Provider I/O
 * or current human execution grant is required to read already committed facts. */
export function createPostgresOrdinaryRefundPositionSource(
  options: Options & {
    providerAccountReference: string;
    environment: "Test" | "Live";
  },
) {
  return createPostgresOrdinaryRefundRequestPositionSource({
    scope: options.scope,
    authorize: options.authorize,
    readOutcome: async (tx, { request, payment, observedAt }) => {
      const authorize = async (transaction: typeof tx) => {
        const allowed = await options.authorize(transaction, {
          ...options.scope,
          orderReference: request.orderReference,
          paymentTransactionReference: payment.paymentTransactionReference,
          paymentIntentReference: payment.paymentIntentReference,
          paymentAttemptReference: payment.paymentAttemptReference,
          observedAt,
        });
        if (allowed !== true) throw new Error("ORDINARY_REFUND_PERMISSION_DENIED");
        return true;
      };
      const recover = createPostgresOrdinaryRefundRecoverySource({ ...options, authorize });
      const result = await createPostgresOrdinaryRefundClaimOutcomeReader({
        scope: options.scope,
        authorize,
        recover,
      })(tx, {
        orderReference: request.orderReference,
        requestReference: request.requestReference,
        paymentAttemptReference: payment.paymentAttemptReference,
        observedAt,
      });
      if (result === null) return null;
      const { operation, position } = result;
      if (
        operation.paymentTransactionReference !== payment.paymentTransactionReference ||
        operation.paymentIntentReference !== payment.paymentIntentReference ||
        operation.firstCaptureReference !== payment.firstCaptureReference ||
        operation.amountMinor !== ordinaryRefundPaymentAmount(payment)
      )
        throw new Error("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
      return position;
    },
  });
}
