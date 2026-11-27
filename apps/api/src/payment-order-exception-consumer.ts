import { createHash } from "node:crypto";
import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import {
  parseOrderExceptionSource,
  type createPostgresOrderExceptionSourceStore,
} from "@bop/projection";
import { parsePaymentRefundedEnvelope } from "@rms/payment";
import type { createPaymentOrderExceptionSource } from "./payment-order-exception-source.js";

/** Event acknowledgement and latest owner-source projection share the caller transaction.
 * refresh is also required after later operations reconciliation; refund delivery alone
 * cannot signal a later Case transition.
 */
export function createPaymentOrderExceptionConsumer(options: {
  readonly source: ReturnType<typeof createPaymentOrderExceptionSource>;
  readonly projections: ReturnType<typeof createPostgresOrderExceptionSourceStore>;
}) {
  const refresh = async (tx: ConsumerTransaction, value: unknown) => {
    const event = parsePaymentRefundedEnvelope(value);
    const source = parseOrderExceptionSource(await options.source(tx, event));
    return options.projections.write(tx, source, event.eventId);
  };
  const registration = Object.freeze<ConsumerRegistration>({
    consumerName: "operations.order-exception:v1",
    consumerVersion: 1,
    eventType: "PaymentRefunded",
    schemaVersions: [1],
    ownerModule: "@bop/projection",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "write-order-exception-projection",
    replaySafe: true,
    async handler({ transaction, envelope }) {
      const event = parsePaymentRefundedEnvelope(envelope);
      await refresh(transaction, event);
      // Hash the immutable event, never a changing Case version, for stable Inbox replay.
      const resultHash = createHash("sha256")
        .update(
          JSON.stringify(event, (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
          ),
        )
        .digest("hex");
      return { status: "completed", resultHash };
    },
  });
  return Object.freeze({
    registration,
    refresh,
    async consume(tx: ConsumerTransaction, value: unknown) {
      const event = parsePaymentRefundedEnvelope(value);
      // Reauthorize and bind current owner identity even for an Inbox duplicate.
      await options.source(tx, event);
      await tx.query("SAVEPOINT operations_refund_consumer", []);
      try {
        const outcome = await consumeEventInTransaction(tx, registration, event);
        if (outcome.status === "duplicate_completed") await refresh(tx, event);
        await tx.query("RELEASE SAVEPOINT operations_refund_consumer", []);
        return outcome;
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT operations_refund_consumer", []);
        await tx.query("RELEASE SAVEPOINT operations_refund_consumer", []);
        throw error;
      }
    },
  });
}
