import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import type { PaymentRefundedEnvelope } from "../contracts/payment-refunded-event.js";
import { parsePaymentRefundedEnvelope } from "./payment-refunded-event.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { PaymentStatusProjectionError } from "./payment-status-projection.js";

/** Refund status is an additive projection of a confirmed fact, never a replacement capture
 * terminal or evidence of operations reconciliation / whole-order financial closure.
 * The supplied projection store persists the strict source envelope and Inbox in one transaction.
 */
export function createPaymentRefundStatusConsumer(ports: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(transaction: ConsumerTransaction, event: PaymentRefundedEnvelope): Promise<boolean>;
  readonly projections: {
    load(
      transaction: ConsumerTransaction,
      refundReference: string,
    ): Promise<PaymentRefundedEnvelope | null>;
    write(transaction: ConsumerTransaction, event: PaymentRefundedEnvelope): Promise<void>;
  };
  sha256(value: string): string;
}) {
  const brand = parsePaymentReference(ports.scope.brandReference);
  const store = parsePaymentReference(ports.scope.storeReference);
  const fail = (
    code:
      | "PAYMENT_STATUS_PERMISSION_DENIED"
      | "PAYMENT_STATUS_VERSION_CONFLICT"
      | "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new PaymentStatusProjectionError(code);
  };
  const content = (event: PaymentRefundedEnvelope) =>
    JSON.stringify(event, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  const authorize = async (tx: ConsumerTransaction, event: PaymentRefundedEnvelope) => {
    if (
      event.tenantId !== brand ||
      event.storeId !== store ||
      (await ports.authorize(tx, event)) !== true
    )
      fail("PAYMENT_STATUS_PERMISSION_DENIED");
  };
  const load = async (tx: ConsumerTransaction, event: PaymentRefundedEnvelope) => {
    const current = await ports.projections.load(tx, event.payload.refundReference);
    if (current === null) return null;
    const parsed = parsePaymentRefundedEnvelope(current);
    if (content(parsed) !== content(event)) fail("PAYMENT_STATUS_VERSION_CONFLICT");
    return parsed;
  };
  const registration: ConsumerRegistration = Object.freeze<ConsumerRegistration>({
    consumerName: "payment.status-projection:v1",
    consumerVersion: 1,
    eventType: "PaymentRefunded",
    schemaVersions: [1],
    ownerModule: "@rms/payment",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "write-payment-refund-status-projection",
    replaySafe: true,
    async handler({ transaction, envelope }) {
      const event = parsePaymentRefundedEnvelope(envelope);
      await authorize(transaction, event);
      if ((await load(transaction, event)) === null) {
        await ports.projections.write(transaction, event);
        if ((await load(transaction, event)) === null)
          fail("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      await authorize(transaction, event);
      const resultHash = ports.sha256(content(event));
      if (!/^[0-9a-f]{64}$/.test(resultHash)) fail("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
      return { status: "completed", resultHash };
    },
  });
  return Object.freeze({
    registration,
    async consume(transaction: ConsumerTransaction, value: unknown) {
      const event = parsePaymentRefundedEnvelope(value);
      await authorize(transaction, event);
      await load(transaction, event);
      await transaction.query("SAVEPOINT payment_refund_status_consumer", []);
      try {
        const outcome = await consumeEventInTransaction(transaction, registration, event);
        if (outcome.status === "duplicate_completed" && (await load(transaction, event)) === null)
          fail("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
        await authorize(transaction, event);
        await transaction.query("RELEASE SAVEPOINT payment_refund_status_consumer", []);
        return outcome;
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT payment_refund_status_consumer", []);
        await transaction.query("RELEASE SAVEPOINT payment_refund_status_consumer", []);
        throw error;
      }
    },
  });
}
