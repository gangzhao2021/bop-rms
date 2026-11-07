import {
  createCancelIntentRequest,
  createCreateIntentRequest,
  createPaymentProviderContext,
  createRetrieveIntentRequest,
  parsePaymentIntentCreationRecord,
  parsePaymentReference,
  parseProviderIdempotencyKey,
  type PaymentIntentCreationRecord,
  type PaymentProviderAdapter,
  type PaymentProviderOutcome,
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
 * An attempt whose Provider create has no recorded answer (the create timed out or failed in an
 * unknown way, or the process stopped before it was recorded) never gave the guest a card form —
 * the hand-off needs the recorded intent — but the Provider may still hold an intent for it. Payment
 * asks the Provider again by repeating that same create (same idempotency key, same request): the
 * Provider returns the intent it made, or makes it now unconfirmed; either way it is then resolved
 * as above (normally cancelled as never confirmed). Only possible when the original key can be
 * re-derived and matches the attempt's recorded key digest; otherwise, or while the Provider can't
 * answer, nothing is recorded and the caller keeps waiting (staff are told once that lasts; see
 * `unconfirmedPaymentGraceMs`).
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

/**
 * WP-2423 abandoned payment: how long after a round's payment window ended an online payment that
 * Payment still cannot resolve with the Provider (asked again on every cancellation sweep, every few
 * seconds) is handed to staff: the round shows "card payment not confirmed", and a manager may
 * cancel it after checking with the guest. A charge that still arrives afterwards is refunded by
 * the existing "paid without a fulfillable order" compensation.
 */
export const unconfirmedPaymentGraceMs = 5 * 60_000;

/** True once a round's payment window ended `unconfirmedPaymentGraceMs` ago (ISO instants). */
export function isPaymentUnconfirmed(payBy: string, now: string): boolean {
  const due = Date.parse(payBy),
    at = Date.parse(now);
  return Number.isFinite(due) && Number.isFinite(at) && at >= due + unconfirmedPaymentGraceMs;
}

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
  provider: Pick<PaymentProviderAdapter, "retrieveIntent" | "cancelIntent"> &
    Partial<Pick<PaymentProviderAdapter, "createIntent">>;
  /**
   * The Provider idempotency key the attempt's create used, re-derived by the composition that
   * issued it; null unless its digest equals the attempt's recorded `providerIdempotencyDigest`.
   * Without it an attempt with no recorded create answer can't be asked about again.
   */
  createIdempotencyKey?(record: PaymentIntentCreationRecord): string | null;
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
        if (record.intent.paymentMethod !== "OnlineCard")
          return Object.freeze({ status: "Processing" });
        const created = record.providerOutcome;
        const causationReference = parsePaymentReference(options.newReference());
        let snapshot: PaymentProviderOutcome,
          providerIntentReference: PaymentProviderSnapshot["providerIntentReference"];
        let context: PaymentProviderSnapshot["context"];
        if (created?.kind === "Snapshot") {
          providerIntentReference = created.providerIntentReference;
          context = { ...created.context, operationReference: causationReference };
          snapshot = await options.provider.retrieveIntent(
            createRetrieveIntentRequest({
              operation: "RetrieveIntent",
              purpose: "RetrievePaymentIntent",
              context,
              providerIntentReference,
            }),
          );
        } else {
          // The create's answer is unknown: repeat the same create to learn what the Provider holds.
          const key = options.createIdempotencyKey?.(record) ?? null;
          if (key === null || options.provider.createIntent === undefined)
            return Object.freeze({ status: "Processing" });
          const preparation = record.intent.preparation;
          snapshot = await options.provider.createIntent(
            createCreateIntentRequest({
              operation: "CreateIntent",
              purpose: "CreatePaymentIntent",
              context: createPaymentProviderContext({
                provider: "Stripe",
                environment: record.attempt.providerEnvironment,
                brandReference: String(preparation.brandReference) as never,
                storeReference: String(preparation.storeReference) as never,
                paymentAttemptReference: record.attempt.paymentAttemptReference,
                operationReference: record.intent.paymentOperationReference,
              }),
              idempotencyKey: parseProviderIdempotencyKey(key),
              paymentMethod: "OnlineCard",
              captureMode: "Automatic",
              amount: preparation.total,
            }),
          );
          if (
            snapshot.kind !== "Snapshot" ||
            snapshot.context.paymentAttemptReference !== record.attempt.paymentAttemptReference ||
            snapshot.requestedAmount.amountMinor !== preparation.total.amountMinor
          )
            return Object.freeze({ status: "Unavailable" });
          providerIntentReference = snapshot.providerIntentReference;
          context = { ...snapshot.context, operationReference: causationReference };
        }
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
              providerIntentReference,
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
