import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  parseCheckoutSession,
  parseOrderingReference,
  CheckoutSessionServiceError,
} from "@rms/ordering";
import {
  parsePaymentIntentCreationRecord,
  parsePaymentTerminalEnvelope,
  parsePaymentInstant,
  type PaymentIntentCreationPorts,
  type createPostgresPaymentTerminalStore,
} from "@rms/payment";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";

export interface CustomerSessionPaymentResultOptions {
  readonly access: CustomerCheckoutSessionAuthorizationOptions;
  readonly history: Pick<PaymentIntentCreationPorts["repository"], "resolveOperation">;
  readonly terminal: Pick<ReturnType<typeof createPostgresPaymentTerminalStore>, "read">;
  /**
   * v15 batch-5: Ordering's record that this round's dishes went back to the table's cart because
   * the guest paying for it stopped before paying (absent: not composed; a failed read: not said).
   */
  readonly returned?: (orderBatchReference: string) => Promise<boolean>;
  /**
   * v15 b15: who cancelled the unpaid round this checkout's payment was for (Ordering's record,
   * by the payment operation), or null; absent: not composed; a failed read: not said.
   */
  readonly cancelledBy?: (
    paymentOperationReference: string,
  ) => Promise<"Staff" | "Guest" | "System" | null>;
}
export interface CustomerSessionPaymentResult {
  readonly checkoutSessionReference: string;
  readonly paymentIntentReference: string | null;
  readonly orderReference: string | null;
  /**
   * WP-2423: the round (order batch) this checkout paid for, so the guest's page can tell from the
   * order status read whether staff have sent it to the kitchen yet; null before a payment exists.
   */
  readonly orderBatchReference: string | null;
  readonly status: "Pending" | "Unknown" | "Succeeded" | "Failed";
  readonly total: Readonly<{ amountMinor: string; currency: "CAD" }> | null;
  /**
   * WP-2423 abandoned payment: until when this payment can still be finished (its payment window);
   * null before a payment exists.
   */
  readonly payBy: string | null;
  /**
   * Why a failed payment failed: the card was declined, or the payment was never finished and was
   * cancelled when its time ran out (`NotCompleted`), or (v15 batch-5) the guest paying for the
   * round stopped before paying and its dishes went back to the cart (`StoppedByGuest`), or (v15
   * b15) staff cancelled the round before it was paid (`CancelledByStaff`). Null unless Failed.
   */
  readonly failure: "Declined" | "NotCompleted" | "StoppedByGuest" | "CancelledByStaff" | null;
}
const unavailable = (): never => {
  throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
};
/** Read-only composition. A Provider snapshot is never itself a successful customer result. */
export function createCustomerSessionPaymentResult(options: CustomerSessionPaymentResultOptions) {
  const reader = createCustomerCheckoutSessionRead(options.access);
  return Object.freeze({
    async read(value: unknown): Promise<CustomerSessionPaymentResult> {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "checkoutSessionReference",
      ]);
      const input = {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
      };
      const startedAt = parsePaymentInstant(options.access.now());
      const session = parseCheckoutSession(await reader.read(input));
      if (session.checkoutSessionReference !== input.checkoutSessionReference) return unavailable();
      const stored = await options.history.resolveOperation(session.paymentOperationReference);
      // v15 b15 (L14 OSC A round 3): who cancelled the round this checkout pays for, read only
      // while Payment has no outcome to say (no payment, or none recorded yet). Ordering records a
      // cancellation only once Payment proved nothing was or can be charged, so the guest is told
      // the round was cancelled instead of being offered to pay it. Unreadable: not said.
      const cancelledRound = async (): Promise<CustomerSessionPaymentResult["failure"]> => {
        if (options.cancelledBy === undefined) return null;
        const by = await options
          .cancelledBy(String(session.paymentOperationReference))
          .catch(() => null);
        return by === "Staff"
          ? "CancelledByStaff"
          : by === "Guest"
            ? "StoppedByGuest"
            : by === "System"
              ? "NotCompleted"
              : null;
      };
      let result: CustomerSessionPaymentResult = Object.freeze({
        checkoutSessionReference: session.checkoutSessionReference,
        paymentIntentReference: null,
        orderReference: null,
        orderBatchReference: null,
        status: "Pending",
        total: null,
        payBy: null,
        failure: null,
      });
      if (stored === null) {
        const failure = await cancelledRound();
        if (failure !== null) result = Object.freeze({ ...result, status: "Failed", failure });
      }
      if (stored !== null) {
        const record = parsePaymentIntentCreationRecord(stored);
        const p = record.intent.preparation,
          v = session.validation;
        if (
          record.intent.paymentOperationReference !== session.paymentOperationReference ||
          p.submissionReference !== session.submissionReference ||
          p.guestSessionReference !== v.guestSessionReference ||
          p.brandReference !== v.brandReference ||
          p.storeReference !== v.storeReference ||
          p.sourceCartReference !== v.cartReference ||
          p.sourceCartVersion !== v.cartVersion ||
          p.quoteReference !== v.quoteReference
        )
          return unavailable();
        let status: CustomerSessionPaymentResult["status"] =
          record.providerOutcome?.kind === "Failure" ? "Unknown" : "Pending";
        let failure: CustomerSessionPaymentResult["failure"] = null;
        const fact = await options.terminal.read(record.intent.paymentIntentReference);
        if (fact !== null) {
          const event = parsePaymentTerminalEnvelope(fact.event);
          const expectedOutcome = event.eventType === "PaymentSucceeded" ? "Succeeded" : "Failed";
          if (
            event.aggregateId !== record.intent.paymentIntentReference ||
            event.tenantId !== p.brandReference ||
            event.storeId !== p.storeReference ||
            event.correlationId !== session.paymentOperationReference ||
            event.payload.paymentIntentReference !== record.intent.paymentIntentReference ||
            event.payload.paymentAttemptReference !== record.attempt.paymentAttemptReference ||
            event.payload.orderReference !== p.orderReference ||
            fact.paymentIntentReference !== record.intent.paymentIntentReference ||
            fact.paymentAttemptReference !== record.attempt.paymentAttemptReference ||
            String(fact.orderReference) !== String(p.orderReference) ||
            String(fact.brandReference) !== String(p.brandReference) ||
            String(fact.storeReference) !== String(p.storeReference) ||
            fact.outcome !== expectedOutcome ||
            fact.environment !== record.attempt.providerEnvironment ||
            event.occurredAt !== fact.occurredAt ||
            event.payload.paymentTransactionReference !== fact.paymentTransactionReference ||
            event.causationId !== fact.causationReference ||
            (record.providerOutcome?.kind === "Snapshot" &&
              record.providerOutcome.providerIntentReference !== fact.providerIntentReference) ||
            parsePaymentInstant(fact.recordedAt) < parsePaymentInstant(fact.occurredAt) ||
            parsePaymentInstant(fact.recordedAt) > parsePaymentInstant(options.access.now())
          )
            return unavailable();
          if (
            event.eventType === "PaymentSucceeded" &&
            (event.payload.amountMinor !== p.total.amountMinor.toString() ||
              event.payload.currencyCode !== p.total.currencyCode ||
              fact.amount?.amountMinor !== p.total.amountMinor ||
              fact.amount.currencyCode !== p.total.currencyCode)
          )
            return unavailable();
          status = expectedOutcome;
          if (expectedOutcome === "Failed")
            failure = fact.failureReason === "Cancelled" ? "NotCompleted" : "Declined";
          // v15 batch-5: a payment the round's payer stopped (its dishes are back in the cart) is
          // said as that, never as one whose time ran out. Unreadable: said as before.
          if (failure === "NotCompleted" && options.returned !== undefined)
            failure = (await options.returned(String(p.orderBatchReference)).catch(() => false))
              ? "StoppedByGuest"
              : failure;
          // v15 b15: a payment staff stopped by cancelling its round is said as that, never as
          // one whose time ran out ("Cancel unpaid round" while the guest was on the page).
          if (failure === "NotCompleted" && options.cancelledBy !== undefined)
            failure =
              (await options
                .cancelledBy(String(session.paymentOperationReference))
                .catch(() => null)) === "Staff"
                ? "CancelledByStaff"
                : failure;
        } else {
          const cancelled = await cancelledRound();
          if (cancelled !== null) {
            status = "Failed";
            failure = cancelled;
          }
        }
        result = Object.freeze({
          checkoutSessionReference: session.checkoutSessionReference,
          paymentIntentReference: String(record.intent.paymentIntentReference),
          orderReference: String(p.orderReference),
          orderBatchReference: String(p.orderBatchReference),
          status,
          total: Object.freeze({
            amountMinor: p.total.amountMinor.toString(),
            currency: "CAD" as const,
          }),
          payBy: String(p.capacityExpiresAt),
          failure,
        });
      }
      if (
        JSON.stringify(parseCheckoutSession(await reader.read(input))) !== JSON.stringify(session)
      )
        throw new CheckoutSessionServiceError("PERMISSION_DENIED");
      if (parsePaymentInstant(options.access.now()) < startedAt) return unavailable();
      return result;
    },
  });
}
