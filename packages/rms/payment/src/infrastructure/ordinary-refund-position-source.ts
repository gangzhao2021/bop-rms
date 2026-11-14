import { createPostgresOrdinaryRefundRequestPositionSource } from "./persistence/ordinary-refund-request-store.js";
import { createPostgresOrdinaryRefundClaimOutcomeReader } from "./persistence/ordinary-refund-operation-store.js";
import { createPostgresOrdinaryRefundRecoverySource } from "./ordinary-refund-recovery-source.js";
import { ordinaryRefundPaymentAmount } from "../application/ordinary-refund-request.js";
import { createHash } from "node:crypto";
import { createPostgresCardMachinePaymentStore } from "./persistence/card-machine-payment-store.js";

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
      // WP-2423 item 4: a refund of a card-machine payment is made on the Store's machine and
      // recorded once; until then the request's amount stays pending (set aside).
      const cards = createPostgresCardMachinePaymentStore({
        scope: {
          brandReference: options.scope.brandReference,
          storeReference: options.scope.storeReference,
        },
        authorize: async (transaction, query) =>
          query.orderReference === request.orderReference &&
          (await authorize(transaction as typeof tx)),
      });
      const machine = await cards.loadRefundBySource(
        tx,
        "OrdinaryRefund",
        request.requestReference,
      );
      // Recorded after the instant being read: still pending at that instant.
      if (machine !== null && machine.recordedAt <= observedAt) {
        // WP-2423 M52/M131: cash from a counter cash payment goes back in whole nickels, so what
        // was handed back may differ from the request by the cash rounding; the request's amount
        // is what the Order got back (the rounding is the drawer's, as for a table's cash).
        const amount = ordinaryRefundPaymentAmount(payment);
        const inCash =
          machine.amountMinor !== amount &&
          (await cards.loadByIntent(tx, payment.paymentIntentReference))?.cash !== undefined &&
          machine.amountMinor % 5n === 0n;
        if (
          machine.cardMachinePaymentReference !== payment.paymentTransactionReference ||
          machine.orderReference !== request.orderReference ||
          (machine.amountMinor !== amount && !inCash) ||
          request.payments.length !== 1
        )
          throw new Error("ORDINARY_REFUND_HISTORY_UNAVAILABLE");
        return {
          confirmedMinor: amount,
          pendingMinor: 0n,
          observationCount: 1,
          historyDigest:
            "sha256:" +
            createHash("sha256")
              .update("CardMachineRefund:" + machine.cardMachineRefundReference)
              .digest("hex"),
        };
      }
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
