import { createHash } from "node:crypto";
import { createPostgresPaymentIntentCreationStore } from "./payment-intent-creation-store.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";
import { createPostgresOrderPaymentRefundPosition } from "../order-payment-refund-position.js";
import { parseOperationalReconciliationCandidate } from "../../application/payment-reconciliation.js";
import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { PaymentReconciliationError } from "../../application/payment-reconciliation.js";
/** Routing only; hydrate current Payment facts before constructing reconciliation candidates. */
export function createPostgresPaymentReconciliationCandidates(options: {
  readonly scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly environment: "Test" | "Live";
  };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly environment: "Test" | "Live";
      readonly cutoffAt: string;
      readonly purpose: "ReconcilePayments";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    ...options.scope,
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
  });
  const fail = (): never => {
    throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE");
  };
  if (!["Test", "Live"].includes(scope.environment)) return fail();
  return async (
    tx: ConsumerTransaction,
    input: { readonly cutoffAt: string; readonly limit: number },
  ) => {
    try {
      const cutoffAt = parsePaymentInstant(input.cutoffAt);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) return fail();
      const authorize = async () => {
        if (
          (await options.authorize(tx, { ...scope, cutoffAt, purpose: "ReconcilePayments" })) !==
          true
        )
          throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        // WP-2423: a payment is checked when first seen and again as soon as a new payment fact
        // (terminal result, compensation or ordinary refund) is recorded. Otherwise an unresolved
        // payment is rechecked every 13 minutes on its first day, then daily; a matched one daily;
        // after 30 days only new facts bring it back. Rechecking every payment every 13 minutes
        // forever grew this history by thousands of rows a day for a single Store.
        `SELECT i.brand_id::text AS brand,i.store_id::text AS store,i.payment_intent_id::text AS intent,i.payment_operation_id::text AS operation,i.order_id::text AS order_reference,a.payment_attempt_id::text AS attempt,a.provider_environment AS environment,i.created_at,d.due_at
FROM rms_payment.payment_intent i JOIN rms_payment.payment_attempt a ON a.brand_id=i.brand_id AND a.store_id=i.store_id AND a.payment_intent_id=i.payment_intent_id AND a.attempt_number=1
LEFT JOIN LATERAL (SELECT r.checked_at,r.outcome FROM rms_payment.payment_reconciliation_record r WHERE r.brand_id=i.brand_id AND r.store_id=i.store_id AND r.payment_intent_id=i.payment_intent_id AND r.mode='Operational' ORDER BY r.checked_at DESC,r.reconciliation_check_id DESC LIMIT 1) c ON true
LEFT JOIN LATERAL (SELECT max(f.at) AS fact_at FROM (
  SELECT t.recorded_at AS at FROM rms_payment.payment_terminal_fact t WHERE t.brand_id=i.brand_id AND t.store_id=i.store_id AND t.payment_intent_id=i.payment_intent_id
  UNION ALL SELECT cr.recorded_at FROM rms_payment.payment_compensation_refund cr JOIN rms_payment.payment_attempt pa ON pa.brand_id=cr.brand_id AND pa.store_id=cr.store_id AND pa.payment_attempt_id=cr.payment_attempt_id WHERE cr.brand_id=i.brand_id AND cr.store_id=i.store_id AND pa.payment_intent_id=i.payment_intent_id
  UNION ALL SELECT ro.recorded_at FROM rms_payment.ordinary_refund_observation ro JOIN rms_payment.payment_attempt pa ON pa.brand_id=ro.brand_id AND pa.store_id=ro.store_id AND pa.payment_attempt_id=ro.payment_attempt_id WHERE ro.brand_id=i.brand_id AND ro.store_id=i.store_id AND pa.payment_intent_id=i.payment_intent_id) f) n ON true
CROSS JOIN LATERAL (SELECT CASE
  WHEN c.checked_at IS NULL THEN i.created_at
  WHEN n.fact_at > c.checked_at THEN n.fact_at
  WHEN i.created_at < $4::timestamptz - interval '30 days' THEN NULL
  WHEN c.outcome = 'Matched' THEN c.checked_at + interval '1 day'
  WHEN c.checked_at < i.created_at + interval '1 day' THEN c.checked_at + interval '13 minutes'
  ELSE c.checked_at + interval '1 day' END AS due_at) d
WHERE i.brand_id=$1 AND i.store_id=$2 AND a.provider_environment=$3 AND i.created_at<=$4 AND d.due_at IS NOT NULL AND d.due_at<=$4
ORDER BY d.due_at,i.payment_intent_id LIMIT $5`,
        [scope.brandReference, scope.storeReference, scope.environment, cutoffAt, input.limit],
      );
      if (!Array.isArray(result.rows) || result.rows.length > input.limit) return fail();
      const seen = new Set<string>();
      let previousDue: string | null = null,
        previousIntent: string | null = null;
      const items = result.rows.map((row) => {
        const createdAt = parsePaymentInstant(
            row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
          ),
          dueAt = parsePaymentInstant(
            row.due_at instanceof Date ? row.due_at.toISOString() : row.due_at,
          );
        const item = Object.freeze({
          paymentIntentReference: parsePaymentReference(row.intent),
          paymentOperationReference: parsePaymentReference(row.operation),
          paymentAttemptReference: parsePaymentReference(row.attempt),
          orderReference: parsePaymentReference(row.order_reference),
          createdAt,
          dueAt,
        });
        if (
          row.brand !== scope.brandReference ||
          row.store !== scope.storeReference ||
          row.environment !== scope.environment ||
          createdAt > dueAt ||
          dueAt > cutoffAt ||
          seen.has(item.paymentIntentReference) ||
          (previousDue !== null &&
            (dueAt < previousDue ||
              (dueAt === previousDue &&
                previousIntent !== null &&
                item.paymentIntentReference <= previousIntent)))
        )
          return fail();
        seen.add(item.paymentIntentReference);
        previousDue = dueAt;
        previousIntent = item.paymentIntentReference;
        return item;
      });
      await authorize();
      return Object.freeze(items);
    } catch (error) {
      if (
        error instanceof PaymentReconciliationError &&
        error.code === "PAYMENT_RECONCILIATION_PERMISSION_DENIED"
      )
        throw error;
      return fail();
    }
  };
}

/** Hydrates owner facts; a Provider terminal observation alone is not an internal terminal. */
export function createPostgresPaymentReconciliationCandidateSource(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly orderReference: string;
      readonly paymentIntentReference: string;
      readonly observedAt: string;
      readonly purpose: "ReconcilePayments";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    ...options.scope,
    tenantReference: parsePaymentReference(options.scope.tenantReference),
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
    providerAccountReference: parsePaymentReference(options.scope.providerAccountReference),
  });
  const fail = (): never => {
    throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE");
  };
  if (!["Test", "Live"].includes(scope.environment)) return fail();
  return async (
    tx: ConsumerTransaction,
    input: {
      readonly paymentIntentReference: string;
      readonly paymentOperationReference: string;
      readonly paymentAttemptReference: string;
      readonly orderReference: string;
      readonly createdAt: string;
      readonly dueAt: string;
    },
    time: string,
  ) => {
    const observedAt = parsePaymentInstant(time),
      orderReference = parsePaymentReference(input.orderReference),
      intent = parsePaymentReference(input.paymentIntentReference),
      operation = parsePaymentReference(input.paymentOperationReference),
      attempt = parsePaymentReference(input.paymentAttemptReference),
      createdAt = parsePaymentInstant(input.createdAt),
      dueAt = parsePaymentInstant(input.dueAt);
    const authorize = async () => {
      if (
        (await options.authorize(tx, {
          orderReference,
          paymentIntentReference: intent,
          observedAt,
          purpose: "ReconcilePayments",
        })) !== true
      )
        throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
      return true;
    };
    try {
      await authorize();
      if (createdAt > dueAt || dueAt > observedAt) return fail();
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PaymentReceiptOrder:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          orderReference,
      ]);
      const runner = {
        run: <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
      };
      const ownerScope = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      };
      const record = await createPostgresPaymentIntentCreationStore(runner, ownerScope, {
        now: () => observedAt,
        generateObservationReference: fail,
      }).resolveOperation(operation);
      if (
        !record ||
        record.intent.paymentIntentReference !== intent ||
        record.intent.paymentOperationReference !== operation ||
        record.attempt.paymentAttemptReference !== attempt ||
        record.attempt.paymentIntentReference !== intent ||
        String(record.intent.preparation.orderReference) !== String(orderReference) ||
        record.attempt.providerEnvironment !== scope.environment ||
        record.intent.createdAt !== createdAt ||
        record.attempt.createdAt > observedAt
      )
        return fail();
      const snapshot = record.providerOutcome;
      if (
        snapshot?.kind !== "Snapshot" ||
        snapshot.context.environment !== scope.environment ||
        snapshot.context.brandReference !== scope.brandReference ||
        snapshot.context.storeReference !== scope.storeReference ||
        snapshot.context.paymentAttemptReference !== attempt ||
        snapshot.observedAt > observedAt
      )
        return fail();
      const fact = await createPostgresPaymentTerminalStore(runner, {
        ...ownerScope,
        providerAccountReference: scope.providerAccountReference,
        environment: scope.environment,
      }).read(intent);
      if (
        fact &&
        (fact.paymentIntentReference !== intent ||
          fact.paymentAttemptReference !== attempt ||
          fact.orderReference !== orderReference ||
          fact.providerIntentReference !== snapshot.providerIntentReference ||
          fact.recordedAt > observedAt ||
          fact.occurredAt > observedAt)
      )
        return fail();
      let captured = 0n,
        refunded = 0n;
      if (fact?.outcome === "Succeeded") {
        if (!fact.amount) return fail();
        captured = fact.amount.amountMinor;
        const refunds = await createPostgresOrderPaymentRefundPosition({
          scope,
          providerAccountReference: scope.providerAccountReference,
          environment: scope.environment,
          authorize: async (t) => t === tx && authorize(),
        })(tx, {
          orderReference,
          paymentTransactionReference: fact.paymentTransactionReference,
          paymentIntentReference: intent,
          paymentAttemptReference: attempt,
          observedAt,
        });
        refunded = refunds.confirmedMinor;
      }
      const internalStatus = fact
        ? fact.outcome === "Succeeded"
          ? "Captured"
          : fact.failureReason === "Cancelled"
            ? "Cancelled"
            : "Failed"
        : ["Captured", "Failed", "Cancelled"].includes(snapshot.status)
          ? "Unknown"
          : snapshot.status;
      const lastObservedAt =
        fact && fact.recordedAt > snapshot.observedAt ? fact.recordedAt : snapshot.observedAt;
      const result = parseOperationalReconciliationCandidate({
        candidateReference: intent,
        ...ownerScope,
        paymentIntentReference: intent,
        paymentAttemptReference: attempt,
        orderReference,
        providerAccountReference: scope.providerAccountReference,
        providerIntentReference: snapshot.providerIntentReference,
        environment: scope.environment,
        paymentMethod: record.intent.paymentMethod,
        captureMode: record.intent.captureMode,
        internalStatus,
        requestedAmount: snapshot.requestedAmount,
        capturedAmount: { currencyCode: "CAD", amountMinor: captured },
        refundedAmount: { currencyCode: "CAD", amountMinor: refunded },
        lastObservedAt,
        dueAt,
      });
      await authorize();
      return result;
    } catch (error) {
      if (
        error instanceof PaymentReconciliationError &&
        error.code === "PAYMENT_RECONCILIATION_PERMISSION_DENIED"
      )
        throw error;
      return fail();
    }
  };
}

/** Capture facts only, independent of Provider journal totals. Caller retains the transaction. */
export function createPostgresPaymentCaptureWindowSource(options: {
  readonly scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly startsAt: string;
      readonly endsAt: string;
      readonly observedAt: string;
      readonly purpose: "ReconcilePayments";
    },
  ): Promise<boolean>;
}) {
  const scope = {
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(options.scope.providerAccountReference)),
    environment: options.scope.environment,
  };
  const fail = (): never => {
    throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE");
  };
  if (!["Test", "Live"].includes(scope.environment)) return fail();
  return async (
    tx: ConsumerTransaction,
    value: { startsAt: string; endsAt: string; observedAt: string },
  ) => {
    try {
      const input = {
        startsAt: parsePaymentInstant(value.startsAt),
        endsAt: parsePaymentInstant(value.endsAt),
        observedAt: parsePaymentInstant(value.observedAt),
        purpose: "ReconcilePayments" as const,
      };
      if (input.startsAt >= input.endsAt || input.endsAt > input.observedAt) return fail();
      const authorize = async () => {
        if ((await options.authorize(tx, input)) !== true) return fail();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        "SELECT payment_transaction_id::text AS reference,brand_id::text AS brand,store_id::text AS store,provider_account_id::text AS account,provider_environment AS environment,amount_minor::text AS amount,currency_code AS currency,occurred_at,recorded_at,evidence_digest AS digest FROM rms_payment.payment_terminal_fact WHERE brand_id=$1 AND store_id=$2 AND provider_account_id=$3 AND provider_environment=$4 AND terminal_outcome='Succeeded' AND occurred_at >= $5 AND occurred_at < $6 AND recorded_at <= $7 ORDER BY payment_transaction_id LIMIT 100001",
        [
          scope.brandReference,
          scope.storeReference,
          scope.providerAccountReference,
          scope.environment,
          input.startsAt,
          input.endsAt,
          input.observedAt,
        ],
      );
      if (result.rows.length > 100000) return fail();
      let capturedAmountMinor = 0n;
      const seen = new Set<string>(),
        events = [];
      for (const row of result.rows) {
        const reference = String(parsePaymentReference(row.reference));
        if (
          row.brand !== scope.brandReference ||
          row.store !== scope.storeReference ||
          row.account !== scope.providerAccountReference ||
          row.environment !== scope.environment ||
          row.currency !== "CAD" ||
          typeof row.amount !== "string" ||
          !/^[1-9][0-9]{0,18}$/u.test(row.amount) ||
          BigInt(row.amount) > 9223372036854775807n ||
          typeof row.digest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/u.test(row.digest) ||
          seen.has(reference)
        )
          return fail();
        if (!(row.occurred_at instanceof Date) || !(row.recorded_at instanceof Date)) return fail();
        const occurredAt = parsePaymentInstant(row.occurred_at.toISOString()),
          recordedAt = parsePaymentInstant(row.recorded_at.toISOString());
        if (
          occurredAt < input.startsAt ||
          occurredAt >= input.endsAt ||
          recordedAt < occurredAt ||
          recordedAt > input.observedAt
        )
          return fail();
        seen.add(reference);
        capturedAmountMinor += BigInt(row.amount);
        events.push([reference, row.amount, occurredAt, recordedAt, row.digest]);
      }
      await authorize();
      return Object.freeze({
        ...scope,
        ...input,
        currencyCode: "CAD" as const,
        capturedAmountMinor,
        captureCount: events.length,
        evidenceDigest:
          "sha256:" +
          createHash("sha256")
            .update(JSON.stringify(["PAYMENT_CAPTURE_WINDOW_V1", scope, input, events]))
            .digest("hex"),
      });
    } catch {
      return fail();
    }
  };
}
