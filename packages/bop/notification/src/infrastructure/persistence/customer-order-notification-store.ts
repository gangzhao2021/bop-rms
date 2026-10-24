import {
  createCustomerOrderNotificationAttempt,
  createCustomerOrderNotificationOutcome,
  type CustomerOrderNotificationAttempt,
  type CustomerOrderNotificationOutcome,
  type CustomerOrderNotificationRecordPort,
} from "../../contracts/customer-order-message.js";
import {
  NotificationContractError,
  parseNotificationReference,
} from "../../contracts/notification.js";

interface Transaction {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}
const fail = (): never => {
  throw new NotificationContractError("NOTIFICATION_ATTEMPT_INVALID");
};
const rowCount = (value: unknown): number => {
  const count: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rowCount")?.value
      : undefined;
  return typeof count === "number" ? count : fail();
};

/**
 * WP-2423 Q10: append-only evidence of customer order messages, one Store scope per adapter. Each
 * call runs in its own transaction so the attempt is durable before the provider is called.
 */
export function createPostgresCustomerOrderNotificationRecords(
  runner: { run<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> },
  scope: { readonly brandReference: string; readonly storeReference: string },
): CustomerOrderNotificationRecordPort {
  const brand = parseNotificationReference(scope.brandReference),
    store = parseNotificationReference(scope.storeReference);
  const scoped = (tx: Transaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  return Object.freeze({
    async appendAttempt(value: CustomerOrderNotificationAttempt) {
      const attempt = createCustomerOrderNotificationAttempt(value);
      if (attempt.brandReference !== brand || attempt.storeReference !== store) return fail();
      return runner.run(async (tx) => {
        await scoped(tx);
        const inserted = await tx.query(
          "INSERT INTO bop_notification.customer_order_notification_attempt " +
            "(notification_id,brand_id,store_id,order_id,purpose,channel,contact_details_id,contact_details_version,created_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz) " +
            "ON CONFLICT ON CONSTRAINT customer_order_notification_once DO NOTHING",
          [
            attempt.notificationReference,
            brand,
            store,
            attempt.orderReference,
            attempt.purpose,
            attempt.channel,
            attempt.contactDetailsReference,
            attempt.contactDetailsVersion,
            attempt.createdAt,
          ],
        );
        const count = rowCount(inserted);
        if (count !== 0 && count !== 1) return fail();
        return count === 1 ? ("Created" as const) : ("Exists" as const);
      });
    },
    async appendOutcome(value: CustomerOrderNotificationOutcome) {
      const outcome = createCustomerOrderNotificationOutcome(value);
      if (outcome.brandReference !== brand || outcome.storeReference !== store) return fail();
      await runner.run(async (tx) => {
        await scoped(tx);
        const inserted = await tx.query(
          "INSERT INTO bop_notification.customer_order_notification_outcome " +
            "(notification_id,brand_id,store_id,outcome,provider_message_reference,recorded_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6::timestamptz)",
          [
            outcome.notificationReference,
            brand,
            store,
            outcome.outcome,
            outcome.providerMessageReference,
            outcome.recordedAt,
          ],
        );
        if (rowCount(inserted) !== 1) return fail();
      });
    },
  });
}
