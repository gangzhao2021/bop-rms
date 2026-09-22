import type { AuditTransaction } from "@bop/audit";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { createPostgresPaymentIntentCreationStore } from "./payment-intent-creation-store.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";

export interface CapturedBatchPaymentScope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
}
export interface CapturedBatchPaymentQuery {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly observedAt: string;
}
const unavailable = (): never => {
  throw new Error("CAPTURED_BATCH_PAYMENT_UNAVAILABLE");
};

/** Owner-only lookup for merchant acceptance. Returns the exact stored successful
 * event, not caller evidence, payment eligibility or a whole-order paid assertion.
 * Caller retains transaction and authorization fences through acceptance commit.
 */
export function createPostgresCapturedBatchPaymentSource(options: {
  scope: CapturedBatchPaymentScope;
  authorize(transaction: AuditTransaction, query: CapturedBatchPaymentQuery): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(options.scope.providerAccountReference)),
    environment: options.scope.environment,
  });
  if (scope.environment !== "Test" && scope.environment !== "Live") return unavailable();
  return Object.freeze({
    async load(transaction: AuditTransaction, input: CapturedBatchPaymentQuery) {
      try {
        const query = Object.freeze({
          orderReference: String(parsePaymentReference(input.orderReference)),
          orderBatchReference: String(parsePaymentReference(input.orderBatchReference)),
          observedAt: String(parsePaymentInstant(input.observedAt)),
        });
        const allowed = () => options.authorize(transaction, query);
        if (!(await allowed())) return unavailable();
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const result = await transaction.query(
          "SELECT i.payment_operation_id,i.payment_intent_id FROM rms_payment.payment_intent i " +
            "JOIN rms_payment.payment_terminal_fact f ON f.brand_id=i.brand_id AND f.store_id=i.store_id AND f.payment_intent_id=i.payment_intent_id AND f.order_id=i.order_id " +
            "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.order_batch_id=$4 " +
            "AND f.provider_account_id=$5 AND f.provider_environment=$6 AND f.terminal_outcome='Succeeded' " +
            "AND f.recorded_at <= $7::timestamptz ORDER BY i.payment_intent_id LIMIT 2",
          [
            scope.brandReference,
            scope.storeReference,
            query.orderReference,
            query.orderBatchReference,
            scope.providerAccountReference,
            scope.environment,
            query.observedAt,
          ],
        );
        if (!result || typeof result !== "object") return unavailable();
        const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
        if (!Array.isArray(rows) || rows.length > 1) return unavailable();
        if (!(await allowed())) return unavailable();
        if (rows.length === 0) return null;
        const row = rows[0] as Record<string, unknown>;
        const operation = String(parsePaymentReference(row.payment_operation_id));
        const intent = String(parsePaymentReference(row.payment_intent_id));
        const runner = {
          run: <T>(work: (tx: AuditTransaction) => Promise<T>) => work(transaction),
        };
        const payment = await createPostgresPaymentIntentCreationStore(
          runner,
          {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          },
          { now: () => query.observedAt, generateObservationReference: unavailable },
        ).resolveOperation(operation);
        const terminal = await createPostgresPaymentTerminalStore(runner, scope).read(intent);
        if (
          !payment ||
          !terminal ||
          terminal.outcome !== "Succeeded" ||
          payment.intent.paymentIntentReference !== intent ||
          payment.intent.preparation.orderReference !== query.orderReference ||
          payment.intent.preparation.orderBatchReference !== query.orderBatchReference ||
          terminal.orderReference !== query.orderReference ||
          terminal.paymentAttemptReference !== payment.attempt.paymentAttemptReference ||
          terminal.amount?.amountMinor !== payment.intent.preparation.total.amountMinor ||
          terminal.amount.currencyCode !== payment.intent.preparation.total.currencyCode ||
          terminal.recordedAt > query.observedAt ||
          !(await allowed())
        )
          return unavailable();
        return Object.freeze({
          submissionReference: payment.intent.preparation.submissionReference,
          paymentOperationReference: operation,
          paymentIntentReference: intent,
          paymentEvent: terminal.event,
        });
      } catch {
        return unavailable();
      }
    },
  });
}
