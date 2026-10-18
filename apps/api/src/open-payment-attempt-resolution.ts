import {
  createCancelIntentRequest,
  createRetrieveIntentRequest,
  parsePaymentIntentCreationRecord,
  parsePaymentReference,
  parseProviderIdempotencyKey,
  type PaymentIntentCreationRecord,
  type PaymentProviderAdapter,
  type PaymentProviderSnapshot,
} from "@rms/payment";

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): what became of a round's online payment
 * that has no recorded outcome when the round has to be decided (its payment window ended, or staff
 * cancel the unpaid round). Payment asks the Provider for the latest attempt:
 *
 * - captured / declined / already cancelled at the Provider → that outcome is recorded (as the
 *   customer's own "check payment" would) and returned;
 * - never confirmed by the customer (Stripe `requires_payment_method|confirmation|action`) → the
 *   Provider attempt is cancelled first (idempotent per attempt), then recorded as failed
 *   (`Cancelled`), so it can never be confirmed later from an old page;
 * - still processing or the Provider unreachable → nothing is recorded; the caller keeps waiting.
 *
 * Never creates an attempt and never charges. The caller holds no database transaction while this
 * talks to the Provider; it re-reads Payment under its own fences before acting on the result.
 */
export type OpenPaymentAttemptResolution =
  | { readonly status: "NoPayment" }
  | { readonly status: "Paid" }
  | { readonly status: "Failed"; readonly notCompleted: boolean }
  | { readonly status: "Processing" }
  | { readonly status: "Unavailable" };

export interface OpenPaymentAttemptState {
  /** Payment's intent creation record (latest attempt) for the operation, or null. */
  readonly record: unknown;
  /** Payment's terminal outcome for the intent's latest attempt, or null. */
  readonly terminal: null | {
    readonly outcome: "Succeeded" | "Failed";
    readonly failureReason: string | null;
  };
  /** A payment recorded on the Store's card machine for this round. */
  readonly cardMachine: boolean;
}

export function createOpenPaymentAttemptResolution(options: {
  load(paymentOperationReference: string): Promise<OpenPaymentAttemptState>;
  provider: Pick<PaymentProviderAdapter, "retrieveIntent" | "cancelIntent">;
  /** Records the Provider's terminal state through Payment's terminal owner (Provider retrieval). */
  recordTerminal(input: {
    readonly record: PaymentIntentCreationRecord;
    readonly snapshot: PaymentProviderSnapshot;
    readonly status: "Captured" | "Failed";
    readonly failureReason: "Declined" | "Cancelled" | null;
    readonly causationReference: string;
  }): Promise<unknown>;
  newReference(): string;
}) {
  const failed = (failureReason: string | null): OpenPaymentAttemptResolution =>
    Object.freeze({ status: "Failed", notCompleted: failureReason === "Cancelled" });
  return Object.freeze({
    async resolve(paymentOperationReference: string): Promise<OpenPaymentAttemptResolution> {
      try {
        const state = await options.load(paymentOperationReference);
        if (state.cardMachine) return Object.freeze({ status: "Paid" });
        if (state.record === null) return Object.freeze({ status: "NoPayment" });
        const record = parsePaymentIntentCreationRecord(state.record);
        if (String(record.intent.paymentOperationReference) !== paymentOperationReference)
          return Object.freeze({ status: "Unavailable" });
        if (state.terminal !== null)
          return state.terminal.outcome === "Succeeded"
            ? Object.freeze({ status: "Paid" })
            : failed(state.terminal.failureReason);
        const created = record.providerOutcome;
        if (record.intent.paymentMethod !== "OnlineCard" || created?.kind !== "Snapshot")
          return Object.freeze({ status: "Processing" });
        const causationReference = parsePaymentReference(options.newReference());
        const context = { ...created.context, operationReference: causationReference };
        let snapshot = await options.provider.retrieveIntent(
          createRetrieveIntentRequest({
            operation: "RetrieveIntent",
            purpose: "RetrievePaymentIntent",
            context,
            providerIntentReference: created.providerIntentReference,
          }),
        );
        if (snapshot.kind !== "Snapshot") return Object.freeze({ status: "Unavailable" });
        if (snapshot.status === "RequiresCustomerAction") {
          snapshot = await options.provider.cancelIntent(
            createCancelIntentRequest({
              operation: "CancelIntent",
              purpose: "CancelPaymentIntent",
              context,
              idempotencyKey: parseProviderIdempotencyKey(
                "cancel-abandoned:" + String(record.attempt.paymentAttemptReference),
              ),
              providerIntentReference: created.providerIntentReference,
            }),
          );
          if (snapshot.kind !== "Snapshot") return Object.freeze({ status: "Unavailable" });
        }
        const recorded = async (
          status: "Captured" | "Failed",
          failureReason: "Declined" | "Cancelled" | null,
        ) => {
          await options.recordTerminal({
            record,
            snapshot: snapshot as PaymentProviderSnapshot,
            status,
            failureReason,
            causationReference,
          });
        };
        switch (snapshot.status) {
          case "Captured":
            await recorded("Captured", null);
            return Object.freeze({ status: "Paid" });
          case "Failed":
            await recorded("Failed", "Declined");
            return failed("Declined");
          case "Cancelled":
            await recorded("Failed", "Cancelled");
            return failed("Cancelled");
          default:
            return Object.freeze({ status: "Processing" });
        }
      } catch {
        return Object.freeze({ status: "Unavailable" });
      }
    },
  });
}
