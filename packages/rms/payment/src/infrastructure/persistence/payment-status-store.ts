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
        // WP-2423 Q20: a later attempt (another card after a decline) supersedes the failed
        // attempt's projection; the earlier snapshot row stays, only no longer active.
        const superseded =
          prior !== null &&
          prior.snapshot.paymentAttemptReference !== snapshot.paymentAttemptReference &&
          prior.snapshot.terminalStatus === "Failed" &&
          prior.snapshot.terminalOccurredAt <= snapshot.terminalOccurredAt;
        if (prior && !superseded) {
          if (!equivalentPaymentStatus(prior, candidate))
            throw new PaymentStatusProjectionError("PAYMENT_STATUS_VERSION_CONFLICT");
          return { status: "Duplicate" as const, projection: prior };
        }
        await tx.query("SAVEPOINT payment_status_initial", []);
        try {
          if (prior && superseded) {
            const retired = await tx.query(
              "UPDATE rms_payment.payment_status_projection SET is_active=false WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 AND projection_generation_id=$4 AND source_event_id=$5 AND is_active",
              [
                scope.brandReference,
                scope.storeReference,
                snapshot.paymentIntentReference,
                prior.generationReference,
                prior.sourceCheckpoint,
              ],
            );
            if (retired.rowCount !== 1) return unavailable();
          }
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

/**
 * WP-2423: the latest active terminal payment outcome of each order batch of the given Orders
 * (a batch with no terminal outcome is absent: its payment is still open). Read only; the caller
 * authorizes the Orders and owns the transaction.
 */
export async function listStoreOrderBatchPaymentOutcomes(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<
  readonly {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly status: "Succeeded" | "Failed";
  }[]
> {
  if (orderReferences.length > 100) return unavailable();
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference),
    orders = orderReferences.map((reference) => parsePaymentReference(reference));
  if (orders.length === 0) return Object.freeze([]);
  try {
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brand, store],
    );
    const found = await transaction.query(
      "SELECT DISTINCT ON (i.order_batch_id) i.order_id::text AS order_id,i.order_batch_id::text AS order_batch_id,p.terminal_status " +
        "FROM rms_payment.payment_intent i JOIN rms_payment.payment_status_projection p ON p.brand_id=i.brand_id " +
        "AND p.store_id=i.store_id AND p.payment_intent_id=i.payment_intent_id AND p.order_id=i.order_id AND p.is_active " +
        "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=ANY($3::uuid[]) " +
        "ORDER BY i.order_batch_id,p.terminal_occurred_at DESC,p.payment_intent_id DESC LIMIT 10001",
      [brand, store, orders],
    );
    if (!Array.isArray(found.rows) || found.rows.length > 10000) return unavailable();
    const seen = new Set<string>();
    return Object.freeze(
      found.rows.map((row: Record<string, unknown>) => {
        if (Object.keys(row).length !== 3) return unavailable();
        const orderReference = parsePaymentReference(row.order_id),
          orderBatchReference = parsePaymentReference(row.order_batch_id);
        if (
          !orders.includes(orderReference) ||
          seen.has(orderBatchReference) ||
          (row.terminal_status !== "Succeeded" && row.terminal_status !== "Failed")
        )
          return unavailable();
        seen.add(orderBatchReference);
        return Object.freeze({
          orderReference,
          orderBatchReference,
          status: row.terminal_status as "Succeeded" | "Failed",
        });
      }),
    );
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return unavailable();
  }
}

/**
 * WP-2423 item 5: the order batches of the given Orders for which an online payment was ever
 * started (a payment intent exists, whatever its outcome). A dine-in round with none, and no
 * card-machine payment, has nothing that could still be charged: it is cancelled automatically when
 * its payment window ends, and staff and guests are told when beforehand. Read only; the caller
 * authorizes the Orders and owns the transaction.
 */
export async function listStoreOrderBatchesWithOnlinePayment(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  if (orderReferences.length > 100) return unavailable();
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference),
    orders = orderReferences.map((reference) => parsePaymentReference(reference));
  if (orders.length === 0) return new Set<string>();
  try {
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brand, store],
    );
    const found = await transaction.query(
      "SELECT DISTINCT i.order_batch_id::text AS order_batch_id FROM rms_payment.payment_intent i " +
        "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=ANY($3::uuid[]) LIMIT 10001",
      [brand, store, orders],
    );
    if (!Array.isArray(found.rows) || found.rows.length > 10000) return unavailable();
    return new Set(
      found.rows.map((row: Record<string, unknown>) => {
        if (Object.keys(row).length !== 1) return unavailable();
        return String(parsePaymentReference(row.order_batch_id));
      }),
    );
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return unavailable();
  }
}

/**
 * WP-2423: what each of the given Orders has been paid online — the sum of its active succeeded
 * payment outcomes (one per payment intent), from the same status projection as the batch
 * outcomes above. Orders with no succeeded online payment are absent. Card-machine payments are
 * a separate Payment record and are not included. Read only; the caller authorizes the Orders and
 * owns the transaction.
 */
export async function listStoreOrderOnlinePaidTotals(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<
  readonly {
    readonly orderReference: string;
    readonly amountMinor: string;
    readonly currencyCode: "CAD";
  }[]
> {
  if (orderReferences.length > 100) return unavailable();
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference),
    orders = orderReferences.map((reference) => parsePaymentReference(reference));
  if (orders.length === 0) return Object.freeze([]);
  try {
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brand, store],
    );
    const found = await transaction.query(
      "SELECT i.order_id::text AS order_id,sum(p.amount_minor)::text AS amount_minor,min(p.currency_code) AS currency_code," +
        "count(DISTINCT p.currency_code)::int AS currencies " +
        "FROM rms_payment.payment_intent i JOIN rms_payment.payment_status_projection p ON p.brand_id=i.brand_id " +
        "AND p.store_id=i.store_id AND p.payment_intent_id=i.payment_intent_id AND p.order_id=i.order_id AND p.is_active " +
        "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=ANY($3::uuid[]) AND p.terminal_status='Succeeded' " +
        "GROUP BY i.order_id ORDER BY i.order_id LIMIT 101",
      [brand, store, orders],
    );
    if (!Array.isArray(found.rows) || found.rows.length > 100) return unavailable();
    const seen = new Set<string>();
    return Object.freeze(
      found.rows.map((row: Record<string, unknown>) => {
        if (Object.keys(row).length !== 4) return unavailable();
        const orderReference = parsePaymentReference(row.order_id);
        if (
          !orders.includes(orderReference) ||
          seen.has(orderReference) ||
          row.currencies !== 1 ||
          row.currency_code !== "CAD" ||
          typeof row.amount_minor !== "string" ||
          !/^[1-9][0-9]{0,18}$/u.test(row.amount_minor) ||
          BigInt(row.amount_minor) > 9223372036854775807n
        )
          return unavailable();
        seen.add(orderReference);
        return Object.freeze({
          orderReference,
          amountMinor: row.amount_minor,
          currencyCode: "CAD" as const,
        });
      }),
    );
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return unavailable();
  }
}

/**
 * WP-2423: the tip an Order's succeeded online payments carried — the tip frozen on each payment
 * intent whose active status projection succeeded (the same payments `listStoreOrderOnlinePaidTotals`
 * sums), so staff read an order's total as what was paid. Zero when nothing was paid online.
 * Read only; the caller authorizes the Order and owns the transaction.
 */
export async function readStoreOrderOnlinePaidTip(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
): Promise<bigint> {
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference),
    order = parsePaymentReference(orderReference);
  try {
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brand, store],
    );
    const found = await transaction.query(
      "SELECT COALESCE(sum(i.tip_minor),0)::text AS tip_minor FROM rms_payment.payment_intent i " +
        "WHERE i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3 AND i.currency_code='CAD' AND EXISTS (" +
        "SELECT 1 FROM rms_payment.payment_status_projection p WHERE p.brand_id=i.brand_id AND p.store_id=i.store_id " +
        "AND p.payment_intent_id=i.payment_intent_id AND p.order_id=i.order_id AND p.is_active AND p.terminal_status='Succeeded')",
      [brand, store, order],
    );
    if (!Array.isArray(found.rows) || found.rows.length !== 1) return unavailable();
    const row: unknown = found.rows[0];
    if (row === null || typeof row !== "object" || Object.keys(row).length !== 1)
      return unavailable();
    const tip = (row as Record<string, unknown>).tip_minor;
    if (
      typeof tip !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/u.test(tip) ||
      BigInt(tip) > 9223372036854775807n
    )
      return unavailable();
    return BigInt(tip);
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return unavailable();
  }
}

/**
 * WP-2423: which of the given Orders have any refund recorded against their online payment — an
 * ordinary refund request (staff refunds and item-cancellation refunds) or a compensation refund
 * (whole-batch cancellations and automatic refunds). Lets the Orders list read the exact refund
 * position (the same one the order detail reads) only for Orders that have one. Read only; the
 * caller authorizes the Orders and owns the transaction.
 */
export async function listStoreOrdersWithOnlineRefunds(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  if (orderReferences.length > 100) return unavailable();
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference),
    orders = orderReferences.map((reference) => parsePaymentReference(reference));
  if (orders.length === 0) return new Set<string>();
  try {
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brand, store],
    );
    const found = await transaction.query(
      "SELECT r.order_id::text AS order_id FROM rms_payment.ordinary_refund_request r " +
        "WHERE r.brand_id=$1 AND r.store_id=$2 AND r.order_id=ANY($3::uuid[]) " +
        "UNION SELECT c.order_id::text FROM rms_payment.payment_compensation_refund c " +
        "WHERE c.brand_id=$1 AND c.store_id=$2 AND c.order_id=ANY($3::uuid[]) LIMIT 101",
      [brand, store, orders],
    );
    if (!Array.isArray(found.rows) || found.rows.length > 100) return unavailable();
    const result = new Set<string>();
    for (const row of found.rows as Record<string, unknown>[]) {
      if (Object.keys(row).length !== 1) return unavailable();
      const orderReference = parsePaymentReference(row.order_id);
      if (!orders.includes(orderReference) || result.has(orderReference)) return unavailable();
      result.add(orderReference);
    }
    return result;
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return unavailable();
  }
}
