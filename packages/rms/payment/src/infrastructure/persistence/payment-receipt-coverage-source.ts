import { createHash } from "node:crypto";
import { createPostgresOrdinaryRefundPositionSource } from "../ordinary-refund-position-source.js";
import { createPostgresPaymentCompensationRefundPositionSource } from "./payment-compensation-refund-position-source.js";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMoney, parseCurrencyCode, type Money } from "@rms/pricing";
import {
  createPaymentProviderSnapshot,
  parsePaymentReference,
} from "../../application/payment-provider-adapter.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { providerStatuses } from "../../contracts/payment-provider-adapter.js";
import { createPostgresPaymentIntentCreationStore } from "./payment-intent-creation-store.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";

export class PaymentReceiptCoverageError extends Error {
  constructor(
    readonly code:
      | "PAYMENT_RECEIPT_COVERAGE_INPUT_INVALID"
      | "PAYMENT_RECEIPT_COVERAGE_PERMISSION_DENIED"
      | "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "PaymentReceiptCoverageError";
  }
}
const maximum = 9223372036854775807n;
const money = (value: bigint): Money => {
  if (value < 0n || value > maximum)
    throw new PaymentReceiptCoverageError("PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE");
  return createMoney({ amountMinor: value, currencyCode: parseCurrencyCode("CAD") });
};
const decimal = (value: unknown) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(value))
    throw new PaymentReceiptCoverageError("PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE");
  return money(BigInt(value));
};
const unavailable = (): never => {
  throw new PaymentReceiptCoverageError("PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE");
};
export interface PaymentReceiptCoverageBatch {
  readonly orderBatchReference: string;
  readonly paymentIntentReference: string;
  readonly paymentOperationReference: string;
  readonly paymentTransactionReference: string;
  readonly observationReference: string;
  readonly observationDigest: string;
  readonly providerObservedAt: string;
  readonly orderAllocation: Money;
  readonly tip: Money;
  readonly captured: Money;
  readonly refunded: Money;
  readonly pendingRefund: Money;
  readonly refundPositionDigest: string;
  readonly refundPositionVersion: number;
}
export interface PaymentReceiptCoverageScope {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly observedAt: string;
  readonly freshAfter: string;
}

/** Complete captured batch and actual ordinary/compensation owner evidence. */
export function createPostgresPaymentReceiptCoverageSource(options: {
  scope: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  };
  authorize(transaction: ConsumerTransaction, scope: PaymentReceiptCoverageScope): Promise<boolean>;
}) {
  const tenantReference = parsePaymentReference(options.scope.tenantReference);
  const brandReference = parsePaymentReference(options.scope.brandReference);
  const storeReference = parsePaymentReference(options.scope.storeReference);
  const providerAccountReference = parsePaymentReference(options.scope.providerAccountReference);
  if (!["Test", "Live"].includes(options.scope.environment)) return unavailable();
  const ownerScope = {
    brandReference,
    storeReference,
    providerAccountReference,
    environment: options.scope.environment,
  };
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, value: unknown) {
      let request: PaymentReceiptCoverageScope;
      let expected: Map<string, bigint>;
      try {
        const raw = exactPaymentObject(value, [
          "orderReference",
          "observedAt",
          "freshAfter",
          "expectedBatches",
        ]);
        request = Object.freeze({
          brandReference,
          storeReference,
          orderReference: String(parsePaymentReference(raw.orderReference)),
          observedAt: parsePaymentInstant(raw.observedAt),
          freshAfter: parsePaymentInstant(raw.freshAfter),
        });
        if (
          request.freshAfter > request.observedAt ||
          !Array.isArray(raw.expectedBatches) ||
          raw.expectedBatches.length < 1 ||
          raw.expectedBatches.length > 100
        )
          return unavailable();
        expected = new Map();
        for (const value of raw.expectedBatches) {
          const batch = exactPaymentObject(value, ["orderBatchReference", "orderAllocationMinor"]);
          const reference = String(parsePaymentReference(batch.orderBatchReference));
          if (
            expected.has(reference) ||
            typeof batch.orderAllocationMinor !== "bigint" ||
            batch.orderAllocationMinor <= 0n ||
            batch.orderAllocationMinor > maximum
          )
            return unavailable();
          expected.set(reference, batch.orderAllocationMinor);
        }
      } catch {
        throw new PaymentReceiptCoverageError("PAYMENT_RECEIPT_COVERAGE_INPUT_INVALID");
      }
      const authorize = async () => {
        if ((await options.authorize(transaction, request)) !== true)
          throw new PaymentReceiptCoverageError("PAYMENT_RECEIPT_COVERAGE_PERMISSION_DENIED");
      };
      try {
        await authorize();
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentReceiptOrder:" +
            brandReference +
            ":" +
            storeReference +
            ":" +
            request.orderReference,
        ]);
        await authorize();
        const intents = await transaction.query(
          "SELECT payment_operation_id FROM rms_payment.payment_intent WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 ORDER BY payment_operation_id LIMIT 101",
          [brandReference, storeReference, request.orderReference],
        );
        if (intents.rows.length < 1 || intents.rows.length > 100) return unavailable();
        const runner = {
          run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
        };
        const history = createPostgresPaymentIntentCreationStore(
          runner,
          { brandReference, storeReference },
          {
            now: () => request.observedAt,
            generateObservationReference: () => {
              throw new Error("read only");
            },
          },
        );
        const terminal = createPostgresPaymentTerminalStore(runner, ownerScope);
        const batches: PaymentReceiptCoverageBatch[] = [];
        const operations = new Set<string>();
        for (const row of intents.rows) {
          const operation = String(parsePaymentReference(row.payment_operation_id));
          if (operations.has(operation)) return unavailable();
          operations.add(operation);
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentIntent:" + brandReference + ":" + storeReference + ":" + operation,
          ]);
          const record = await history.resolveOperation(operation);
          if (
            !record ||
            record.intent.preparation.orderReference !== request.orderReference ||
            record.attempt.providerEnvironment !== options.scope.environment
          )
            return unavailable();
          const intent = record.intent,
            preparation = intent.preparation;
          if (!expected.has(preparation.orderBatchReference)) return unavailable();
          const fact = await terminal.read(intent.paymentIntentReference);
          if (
            !fact ||
            fact.orderReference !== request.orderReference ||
            fact.paymentAttemptReference !== record.attempt.paymentAttemptReference ||
            fact.recordedAt > request.observedAt
          )
            return unavailable();
          const observations = await transaction.query(
            "SELECT provider_observation_id,normalized_status,provider_intent_reference,provider_transaction_reference," +
              "requested_minor::text,authorized_minor::text,captured_minor::text,refunded_minor::text,currency_code," +
              "(max(refunded_minor) OVER ())::text AS maximum_refunded_minor," +
              "evidence_digest,provider_observed_at,recorded_at FROM rms_payment.payment_provider_observation " +
              "WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 AND payment_attempt_id=$4 AND observation_kind='Snapshot' " +
              "ORDER BY provider_observed_at DESC,recorded_at DESC,provider_observation_id DESC LIMIT 2",
            [
              brandReference,
              storeReference,
              intent.paymentIntentReference,
              record.attempt.paymentAttemptReference,
            ],
          );
          const latest = observations.rows[0];
          if (!latest || latest.currency_code !== "CAD") return unavailable();
          const instant = (value: unknown) =>
            parsePaymentInstant(value instanceof Date ? value.toISOString() : value);
          const observedAt = instant(latest.provider_observed_at);
          if (
            observedAt > request.observedAt ||
            instant(latest.recorded_at) > request.observedAt ||
            observedAt < fact.occurredAt
          )
            return unavailable();
          const second = observations.rows[1];
          if (
            second &&
            instant(second.provider_observed_at) === observedAt &&
            [
              "normalized_status",
              "provider_intent_reference",
              "provider_transaction_reference",
              "requested_minor",
              "authorized_minor",
              "captured_minor",
              "refunded_minor",
              "currency_code",
            ].some((key) => second[key] !== latest[key])
          )
            return unavailable();
          const status = providerStatuses.find((status) => status === latest.normalized_status);
          if (!status) return unavailable();
          const snapshot = createPaymentProviderSnapshot({
            kind: "Snapshot",
            context: {
              provider: "Stripe",
              environment: options.scope.environment,
              brandReference,
              storeReference,
              paymentAttemptReference: record.attempt.paymentAttemptReference,
              operationReference: intent.paymentOperationReference,
            },
            providerIntentReference: fact.providerIntentReference,
            providerTransactionReference: latest.provider_transaction_reference as never,
            paymentMethod: intent.paymentMethod,
            captureMode: intent.captureMode,
            status,
            requestedAmount: decimal(latest.requested_minor),
            authorizedAmount: decimal(latest.authorized_minor),
            capturedAmount: decimal(latest.captured_minor),
            refundedAmount: decimal(latest.refunded_minor),
            observedAt,
            evidenceDigest: latest.evidence_digest as never,
          });
          if (
            snapshot.refundedAmount.amountMinor < decimal(latest.maximum_refunded_minor).amountMinor
          )
            return unavailable();
          if (
            latest.provider_intent_reference !== fact.providerIntentReference ||
            snapshot.requestedAmount.amountMinor !== preparation.total.amountMinor
          )
            return unavailable();
          if (fact.outcome === "Failed") {
            if (
              !["Failed", "Cancelled"].includes(snapshot.status) ||
              snapshot.capturedAmount.amountMinor !== 0n ||
              snapshot.refundedAmount.amountMinor !== 0n
            )
              return unavailable();
            continue;
          }
          if (
            snapshot.status !== "Captured" ||
            snapshot.observedAt < request.freshAfter ||
            fact.amount?.amountMinor !== preparation.total.amountMinor ||
            snapshot.capturedAmount.amountMinor !== preparation.total.amountMinor ||
            expected.get(preparation.orderBatchReference) !==
              preparation.orderAllocation.amountMinor ||
            batches.some((batch) => batch.orderBatchReference === preparation.orderBatchReference)
          )
            return unavailable();
          const ordinary = await createPostgresOrdinaryRefundPositionSource({
            scope: { tenantReference, brandReference, storeReference },
            providerAccountReference,
            environment: options.scope.environment,
            authorize: async () => {
              await authorize();
              return true;
            },
          })(transaction, {
            orderReference: request.orderReference,
            paymentTransactionReference: fact.paymentTransactionReference,
            paymentIntentReference: intent.paymentIntentReference,
            paymentAttemptReference: record.attempt.paymentAttemptReference,
            observedAt: request.observedAt,
          });
          const compensation = await createPostgresPaymentCompensationRefundPositionSource({
            scope: { brandReference, storeReference },
            authorize: async () => {
              await authorize();
              return true;
            },
          })(transaction, {
            orderReference: request.orderReference,
            paymentTransactionReference: fact.paymentTransactionReference,
            paymentAttemptReference: record.attempt.paymentAttemptReference,
          });
          const confirmed = money(ordinary.confirmedMinor + compensation.confirmedMinor);
          const pending = money(ordinary.pendingMinor + compensation.pendingMinor);
          if (
            confirmed.amountMinor + pending.amountMinor > snapshot.capturedAmount.amountMinor ||
            snapshot.refundedAmount.amountMinor > confirmed.amountMinor
          )
            return unavailable();
          const refundPositionVersion = ordinary.version + compensation.version;
          if (!Number.isSafeInteger(refundPositionVersion)) return unavailable();
          const refundPositionDigest =
            "sha256:" +
            createHash("sha256")
              .update(
                JSON.stringify({
                  ordinary: ordinary.snapshotDigest,
                  compensation: compensation.snapshotDigest,
                }),
              )
              .digest("hex");
          batches.push(
            Object.freeze({
              orderBatchReference: preparation.orderBatchReference,
              paymentIntentReference: intent.paymentIntentReference,
              paymentOperationReference: operation,
              paymentTransactionReference: fact.paymentTransactionReference,
              observationReference: String(parsePaymentReference(latest.provider_observation_id)),
              observationDigest: snapshot.evidenceDigest,
              providerObservedAt: snapshot.observedAt,
              orderAllocation: preparation.orderAllocation,
              tip: preparation.tip,
              captured: snapshot.capturedAmount,
              refunded: confirmed,
              pendingRefund: pending,
              refundPositionDigest,
              refundPositionVersion,
            }),
          );
        }
        if (batches.length !== expected.size) return unavailable();
        await authorize();
        const total = (
          field: "orderAllocation" | "tip" | "captured" | "refunded" | "pendingRefund",
        ) => money(batches.reduce((sum, batch) => sum + batch[field].amountMinor, 0n));
        return Object.freeze({
          ...request,
          batches: Object.freeze(batches),
          orderAllocation: total("orderAllocation"),
          tip: total("tip"),
          captured: total("captured"),
          refunded: total("refunded"),
          pendingRefund: total("pendingRefund"),
          refundDisposition: batches.some((batch) => batch.pendingRefund.amountMinor > 0n)
            ? ("Pending" as const)
            : ("NonePending" as const),
        });
      } catch (error) {
        if (error instanceof PaymentReceiptCoverageError) throw error;
        return unavailable();
      }
    },
  });
}
