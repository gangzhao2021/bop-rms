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
}
export interface CustomerSessionPaymentResult {
  readonly checkoutSessionReference: string;
  readonly paymentIntentReference: string | null;
  readonly orderReference: string | null;
  readonly status: "Pending" | "Unknown" | "Succeeded" | "Failed";
  readonly total: Readonly<{ amountMinor: string; currency: "CAD" }> | null;
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
      let result: CustomerSessionPaymentResult = Object.freeze({
        checkoutSessionReference: session.checkoutSessionReference,
        paymentIntentReference: null,
        orderReference: null,
        status: "Pending",
        total: null,
      });
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
        }
        result = Object.freeze({
          checkoutSessionReference: session.checkoutSessionReference,
          paymentIntentReference: String(record.intent.paymentIntentReference),
          orderReference: String(p.orderReference),
          status,
          total: Object.freeze({
            amountMinor: p.total.amountMinor.toString(),
            currency: "CAD" as const,
          }),
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
