import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import type { PaymentTerminalEnvelope } from "../contracts/payment-terminal-event.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { parsePaymentTerminalEnvelope } from "./payment-terminal-event.js";
import {
  buildPaymentStatusProjection,
  equivalentPaymentStatus,
  parsePaymentStatusProjection,
  PaymentStatusProjectionError,
  type PaymentStatusProjection,
} from "./payment-status-projection.js";

export interface PaymentStatusEventConsumerPorts {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly authorization: {
    authorize(transaction: ConsumerTransaction, event: PaymentTerminalEnvelope): Promise<boolean>;
  };
  readonly projections: {
    load(input: {
      readonly transaction: ConsumerTransaction;
      readonly paymentIntentReference: string;
    }): Promise<PaymentStatusProjection | null>;
    write(input: {
      readonly transaction: ConsumerTransaction;
      readonly projection: PaymentStatusProjection;
    }): Promise<{
      readonly status: "Completed" | "Duplicate";
      readonly projection: PaymentStatusProjection;
    }>;
  };
  readonly references: { generateGeneration(): string; now(): string };
  sha256(input: string): string;
}

export function createPaymentStatusEventConsumerService(ports: PaymentStatusEventConsumerPorts) {
  const brand = parsePaymentReference(ports.scope.brandReference);
  const store = parsePaymentReference(ports.scope.storeReference);
  const unavailable = (): never => {
    throw new PaymentStatusProjectionError("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
  };
  const authorize = async (tx: ConsumerTransaction, event: PaymentTerminalEnvelope) => {
    if (
      event.tenantId !== brand ||
      event.storeId !== store ||
      (await ports.authorization.authorize(tx, event)) !== true
    )
      throw new PaymentStatusProjectionError("PAYMENT_STATUS_PERMISSION_DENIED");
  };
  const bound = (value: PaymentStatusProjection, event: PaymentTerminalEnvelope) => {
    const projection = parsePaymentStatusProjection(value);
    const expected = buildPaymentStatusProjection({
      event,
      generationReference: projection.generationReference,
      projectedAt: projection.projectedAt,
      ...(projection.lastRebuiltAt === null ? {} : { lastRebuiltAt: projection.lastRebuiltAt }),
    });
    if (!equivalentPaymentStatus(projection, expected))
      throw new PaymentStatusProjectionError("PAYMENT_STATUS_VERSION_CONFLICT");
    return projection;
  };
  const load = async (tx: ConsumerTransaction, event: PaymentTerminalEnvelope) => {
    const value = await ports.projections.load({
      transaction: tx,
      paymentIntentReference: event.aggregateId,
    });
    return value === null ? null : bound(value, event);
  };
  const registration = (eventType: "PaymentSucceeded" | "PaymentFailed"): ConsumerRegistration => ({
    consumerName: "payment.status-projection:v1",
    consumerVersion: 1,
    eventType,
    schemaVersions: [1],
    ownerModule: "@rms/payment",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "write-payment-status-projection",
    replaySafe: true,
    async handler({ transaction, envelope }) {
      const event = parsePaymentTerminalEnvelope(envelope);
      if (event.eventType !== eventType) return unavailable();
      await authorize(transaction, event);
      let projection = await load(transaction, event);
      if (projection === null) {
        const candidate = buildPaymentStatusProjection({
          event,
          generationReference: ports.references.generateGeneration(),
          projectedAt: ports.references.now(),
        });
        const saved = await ports.projections.write({ transaction, projection: candidate });
        if (saved.status !== "Completed" && saved.status !== "Duplicate") return unavailable();
        projection = bound(saved.projection, event);
        if (
          saved.status === "Completed" &&
          (projection.generationReference !== candidate.generationReference ||
            projection.projectedAt !== candidate.projectedAt ||
            projection.lastRebuiltAt !== candidate.lastRebuiltAt ||
            projection.freshnessStatus !== candidate.freshnessStatus)
        )
          return unavailable();
      }
      const resultHash = ports.sha256(
        JSON.stringify(projection.snapshot, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
      if (!/^[0-9a-f]{64}$/.test(resultHash)) return unavailable();
      return { status: "completed", resultHash };
    },
  });
  const registrations = Object.freeze([
    Object.freeze(registration("PaymentSucceeded")),
    Object.freeze(registration("PaymentFailed")),
  ]);
  return Object.freeze({
    registrations,
    async consume(transaction: ConsumerTransaction, envelope: PaymentTerminalEnvelope) {
      const event = parsePaymentTerminalEnvelope(envelope);
      await authorize(transaction, event);
      await load(transaction, event); // Reject changed semantic payload even on an Inbox duplicate.
      const selected = registrations.find((value) => value.eventType === event.eventType);
      if (!selected) return unavailable();
      await transaction.query("SAVEPOINT payment_status_event_consumer", []);
      try {
        const result = await consumeEventInTransaction(transaction, selected, event);
        if (result.status === "duplicate_completed" && (await load(transaction, event)) === null)
          return unavailable();
        await transaction.query("RELEASE SAVEPOINT payment_status_event_consumer", []);
        return result;
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT payment_status_event_consumer", []);
        await transaction.query("RELEASE SAVEPOINT payment_status_event_consumer", []);
        throw error;
      }
    },
  });
}
