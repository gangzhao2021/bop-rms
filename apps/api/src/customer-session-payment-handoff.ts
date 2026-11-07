import { parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import { parseCheckoutSession, parseOrderingReference, type CheckoutSession } from "@rms/ordering";
import {
  createCustomerPaymentHandoff,
  parsePaymentIntentCreationRecord,
  parsePaymentInstant,
  type CustomerPaymentHandoffPorts,
  type PaymentIntentClaimAdmission,
  type PaymentIntentTransactionRunner,
  type PaymentIntentCreationPorts,
} from "@rms/payment";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";

export interface CustomerSessionPaymentHandoffOptions {
  readonly access: CustomerCheckoutSessionAuthorizationOptions;
  readonly history: Pick<PaymentIntentCreationPorts["repository"], "resolveOperation">;
  readonly transactions: PaymentIntentTransactionRunner;
  /** Actual current Ordering -> Dining/Pickup capacity -> Inventory owner fence chain. */
  readonly currentAdmission: (session: CheckoutSession) => PaymentIntentClaimAdmission;
  /** Explicit current confirmation policy, including in-flight Provider safety policy. */
  readonly allowConfirmation: (session: CheckoutSession, observedAt: string) => Promise<boolean>;
  readonly provider: CustomerPaymentHandoffPorts["provider"];
}
/** Server-owned operation IDs; raw credentials remain within this request. */
export function createCustomerSessionPaymentHandoff(options: CustomerSessionPaymentHandoffOptions) {
  const reader = createCustomerCheckoutSessionRead(options.access);
  return Object.freeze({
    async retrieve(value: unknown) {
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
      const session = parseCheckoutSession(await reader.read(input));
      const sameSession = (value: unknown) =>
        JSON.stringify(parseCheckoutSession(value)) === JSON.stringify(session);
      const admission = options.currentAdmission(session);
      return createCustomerPaymentHandoff({
        now: options.access.now,
        provider: options.provider,
        async loadCurrent(operationReference, observedAt) {
          if (
            operationReference !== session.paymentOperationReference ||
            !sameSession(await reader.read(input))
          )
            return null;
          const stored = await options.history.resolveOperation(operationReference);
          if (stored === null) return null;
          const record = parsePaymentIntentCreationRecord(stored);
          const p = record.intent.preparation,
            v = session.validation;
          if (
            String(record.intent.paymentOperationReference) !== session.paymentOperationReference ||
            String(p.submissionReference) !== session.submissionReference ||
            String(p.guestSessionReference) !== v.guestSessionReference ||
            String(p.brandReference) !== v.brandReference ||
            String(p.storeReference) !== v.storeReference ||
            String(p.sourceCartReference) !== v.cartReference ||
            p.sourceCartVersion !== v.cartVersion ||
            String(p.quoteReference) !== v.quoteReference
          )
            return null;
          let ownerDeadline: string | undefined;
          const admitted = await options.transactions.run(async (tx) => {
            const at = parsePaymentInstant(options.access.now());
            if (at < observedAt) return false;
            const decision = await admission.admit(tx, record, at);
            if (decision === false) return false;
            const end = parsePaymentInstant(options.access.now());
            const deadline =
              decision === true ? p.capacityExpiresAt : parsePaymentInstant(decision.validUntil);
            ownerDeadline = String(deadline);
            return (
              end >= at &&
              String(end) < String(deadline) &&
              String(end) < String(p.capacityExpiresAt)
            );
          });
          if (
            !admitted ||
            (await options.allowConfirmation(session, options.access.now())) !== true ||
            !sameSession(await reader.read(input))
          )
            return null;
          const completedAt = parsePaymentInstant(options.access.now());
          if (
            ownerDeadline === undefined ||
            completedAt < observedAt ||
            String(completedAt) >= ownerDeadline ||
            String(completedAt) >= String(p.capacityExpiresAt)
          )
            return null;
          return record;
        },
      }).retrieve(session.paymentOperationReference);
    },
  });
}
