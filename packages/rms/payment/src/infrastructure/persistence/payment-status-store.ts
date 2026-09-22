import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  buildPaymentStatusProjection,
  equivalentPaymentStatus,
  parsePaymentStatusProjection,
  PaymentStatusProjectionError,
  type PaymentStatusProjection,
} from "../../application/payment-status-projection.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";

const unavailable = (): never => {
  throw new PaymentStatusProjectionError("PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE");
};
const instant = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
function decode(row: Record<string, unknown>): PaymentStatusProjection {
  if (
    row.amount_minor !== null &&
    (typeof row.amount_minor !== "string" || !/^[1-9][0-9]{0,18}$/u.test(row.amount_minor))
  )
    return unavailable();
  return parsePaymentStatusProjection({
    projectionName: row.projection_name,
    projectionVersion: row.projection_version,
    generationReference: row.projection_generation_id,
    sourceCheckpoint: row.source_event_id,
    projectedAt: instant(row.projected_at),
    lastRebuiltAt: row.last_rebuilt_at === null ? null : instant(row.last_rebuilt_at),
    freshnessStatus: row.freshness_status,
    snapshot: {
      paymentTransactionReference: row.payment_transaction_id,
      paymentIntentReference: row.payment_intent_id,
      paymentAttemptReference: row.payment_attempt_id,
      orderReference: row.order_id,
      brandReference: row.brand_id,
      storeReference: row.store_id,
      terminalStatus: row.terminal_status,
      amount:
        row.amount_minor === null
          ? null
          : { amountMinor: BigInt(row.amount_minor as string), currencyCode: row.currency_code },
      failureReason: row.failure_reason,
      retryDisposition: row.retry_disposition,
      terminalOccurredAt: instant(row.terminal_occurred_at),
      sourceEventReference: row.source_event_id,
      sourceAggregateVersion: Number(row.source_aggregate_version),
    },
  });
}

/** Initial immutable terminal projection; rebuild generation switching is a separate operation. */
export function createPostgresPaymentStatusStore(options: {
  readonly scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  authorizeOrder?(
    transaction: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
      readonly access: "Read";
    },
  ): Promise<boolean>;
  authorize(
    transaction: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentIntentReference: string;
      readonly access: "Read" | "Write";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    ...options.scope,
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
  });
  const context = async (
    transaction: ConsumerTransaction,
    intent: string,
    access: "Read" | "Write",
  ) => {
    if (
      (await options.authorize(transaction, {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        paymentIntentReference: intent,
        access,
      })) !== true
    )
      throw new PaymentStatusProjectionError("PAYMENT_STATUS_PERMISSION_DENIED");
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [scope.brandReference, scope.storeReference],
    );
  };
  const read = async (transaction: ConsumerTransaction, intent: string) => {
    const rows = await transaction.query(
      "SELECT p.*,p.amount_minor::text AS amount_minor FROM rms_payment.payment_status_projection p WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 AND is_active LIMIT 2",
      [scope.brandReference, scope.storeReference, intent],
    );
    if (rows.rows.length > 1) return unavailable();
    return rows.rows[0] ? decode(rows.rows[0]) : null;
  };
  return Object.freeze({
    /** Per-intent terminal facts only. Missing projections are not pending or whole-order payment facts. */
    async listByOrder(input: {
      readonly transaction: ConsumerTransaction;
      readonly orderReference: string;
    }): Promise<readonly PaymentStatusProjection[]> {
      const orderReference = parsePaymentReference(input.orderReference);
      const tx = input.transaction;
      const authorizeOrder = async () => {
        if (
          !options.authorizeOrder ||
          (await options.authorizeOrder(tx, {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            orderReference,
            access: "Read",
          })) !== true
        )
          throw new PaymentStatusProjectionError("PAYMENT_STATUS_PERMISSION_DENIED");
      };
      await authorizeOrder();
      try {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const rows = await tx.query(
          "SELECT p.*,p.amount_minor::text AS amount_minor FROM rms_payment.payment_status_projection p " +
            "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND is_active ORDER BY payment_intent_id LIMIT 101",
          [scope.brandReference, scope.storeReference, orderReference],
        );
        if (rows.rows.length > 100) return unavailable();
        const projections: PaymentStatusProjection[] = [];
        const seen = new Set<string>();
        for (const row of rows.rows) {
          const projection = decode(row);
          const snapshot = projection.snapshot;
          if (
            snapshot.brandReference !== scope.brandReference ||
            snapshot.storeReference !== scope.storeReference ||
            snapshot.orderReference !== orderReference ||
            seen.has(snapshot.paymentIntentReference)
          )
            return unavailable();
          await context(tx, snapshot.paymentIntentReference, "Read");
          seen.add(snapshot.paymentIntentReference);
          projections.push(projection);
        }
        await authorizeOrder();
        return Object.freeze(projections);
      } catch (error) {
        if (error instanceof PaymentStatusProjectionError) throw error;
        return unavailable();
      }
    },
    async load(input: {
      readonly transaction: ConsumerTransaction;
      readonly paymentIntentReference: string;
    }) {
      const intent = parsePaymentReference(input.paymentIntentReference);
      await context(input.transaction, intent, "Read");
      try {
        return await read(input.transaction, intent);
      } catch {
        return unavailable();
      }
    },
    async write(input: {
      readonly transaction: ConsumerTransaction;
      readonly projection: PaymentStatusProjection;
    }) {
      const candidate = parsePaymentStatusProjection(input.projection);
      const snapshot = candidate.snapshot;
      if (
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        candidate.lastRebuiltAt !== null ||
        candidate.freshnessStatus !== "Fresh"
      )
        throw new PaymentStatusProjectionError("PAYMENT_STATUS_INPUT_INVALID");
      const tx = input.transaction;
      await context(tx, snapshot.paymentIntentReference, "Write");
      try {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentStatus:" +
            scope.brandReference +
            ":" +
            scope.storeReference +
            ":" +
            snapshot.paymentIntentReference,
        ]);
        const terminal = await createPostgresPaymentTerminalStore(
          { run: async (work) => work(tx) },
          scope,
        ).read(snapshot.paymentIntentReference);
        if (!terminal || terminal.recordedAt > candidate.projectedAt) return unavailable();
        const expected = buildPaymentStatusProjection({
          event: terminal.event,
          generationReference: candidate.generationReference,
          projectedAt: candidate.projectedAt,
        });
        if (!equivalentPaymentStatus(expected, candidate)) return unavailable();
        const prior = await read(tx, snapshot.paymentIntentReference);
        if (prior) {
          if (!equivalentPaymentStatus(prior, candidate))
            throw new PaymentStatusProjectionError("PAYMENT_STATUS_VERSION_CONFLICT");
          return { status: "Duplicate" as const, projection: prior };
        }
        await tx.query("SAVEPOINT payment_status_initial", []);
        try {
          const saved = await tx.query(
            `INSERT INTO rms_payment.payment_status_projection (
              projection_generation_id,brand_id,store_id,payment_intent_id,payment_transaction_id,
              payment_attempt_id,order_id,terminal_status,amount_minor,currency_code,failure_reason,
              retry_disposition,terminal_occurred_at,source_event_id,source_aggregate_version,
              projection_name,projection_version,projected_at,last_rebuilt_at,freshness_status,is_active
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,2,'payment_status_v1',1,$15,NULL,'Fresh',true)`,
            [
              candidate.generationReference,
              scope.brandReference,
              scope.storeReference,
              snapshot.paymentIntentReference,
              snapshot.paymentTransactionReference,
              snapshot.paymentAttemptReference,
              snapshot.orderReference,
              snapshot.terminalStatus,
              snapshot.amount?.amountMinor.toString() ?? null,
              snapshot.amount?.currencyCode ?? null,
              snapshot.failureReason,
              snapshot.retryDisposition,
              snapshot.terminalOccurredAt,
              snapshot.sourceEventReference,
              candidate.projectedAt,
            ],
          );
          if (saved.rowCount !== 1) return unavailable();
          const stored = await read(tx, snapshot.paymentIntentReference);
          if (
            !stored ||
            !equivalentPaymentStatus(stored, candidate) ||
            stored.generationReference !== candidate.generationReference
          )
            return unavailable();
          await tx.query("RELEASE SAVEPOINT payment_status_initial", []);
          return { status: "Completed" as const, projection: stored };
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT payment_status_initial", []);
          await tx.query("RELEASE SAVEPOINT payment_status_initial", []);
          throw error;
        }
      } catch (error) {
        if (error instanceof PaymentStatusProjectionError) throw error;
        return unavailable();
      }
    },
  });
}
