import { createPostgresOrdinaryRefundPositionSource } from "../ordinary-refund-position-source.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMoney, parseCurrencyCode } from "@rms/pricing";
import {
  parsePaymentCompensationSource,
  paymentCompensationSourceSnapshotContent,
  PaymentCompensationError,
} from "../../application/paid-without-fulfillable-order.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import {
  createPaymentProviderSnapshot,
  parsePaymentReference,
} from "../../application/payment-provider-adapter.js";
import { providerStatuses } from "../../contracts/payment-provider-adapter.js";
import type { PaidWithoutFulfillableOrderPorts } from "../../application/ports/paid-without-fulfillable-order-ports.js";
import { createPostgresPaymentCompensationIdentityReader } from "./payment-compensation-evidence-source.js";
import { createPostgresPaymentCompensationRefundPositionSource } from "./payment-compensation-refund-position-source.js";
import { createPostgresPaymentIntentCreationStore } from "./payment-intent-creation-store.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";
type Request = Parameters<PaidWithoutFulfillableOrderPorts["source"]["resolveIdentity"]>[0];
const fail = (): never => {
  throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
};
const money = (amountMinor: bigint) => {
  if (amountMinor < 0n || amountMinor > 9223372036854775807n) return fail();
  return createMoney({ amountMinor, currencyCode: parseCurrencyCode("CAD") });
};
const decimal = (value: unknown) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) return fail();
  return money(BigInt(value));
};
const instant = (value: unknown) =>
  parsePaymentInstant(value instanceof Date ? value.toISOString() : value);
/** Actual Payment identity/terminal/observation/compensation composition.
 * Other refund owners must supply their current disjoint totals under this transaction's fences.
 */
export function createPostgresPaymentCompensationSource(options: {
  readonly tenantReference: string;
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  readonly scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  readonly clock: { now(): string };
  readonly authorize: (tx: ConsumerTransaction, input: Request) => Promise<boolean>;
  /** Additional disjoint owners only; ordinary and compensation are composed here. */
  readonly otherRefunds: (
    tx: ConsumerTransaction,
    input: Request,
  ) => Promise<{
    readonly confirmedMinor: bigint;
    readonly pendingMinor: bigint;
    readonly version: number;
  }>;
}): PaidWithoutFulfillableOrderPorts["source"] {
  const tenantReference = String(parsePaymentReference(options.tenantReference));
  const scope = Object.freeze({ ...options.scope });
  const identityReader = createPostgresPaymentCompensationIdentityReader({ ...options, scope });
  return {
    resolveIdentity: identityReader,
    async resolve(value) {
      const raw = exactPaymentObject(value, [
        "brandReference",
        "storeReference",
        "orderReference",
        "paymentTransactionReference",
        "paymentIntentReference",
        "paymentAttemptReference",
        "environment",
        "identityVersion",
        "identityDigest",
      ]);
      const request: Request = {
        brandReference: String(parsePaymentReference(raw.brandReference)),
        storeReference: String(parsePaymentReference(raw.storeReference)),
        orderReference: String(parsePaymentReference(raw.orderReference)),
        paymentTransactionReference: String(parsePaymentReference(raw.paymentTransactionReference)),
        paymentIntentReference: String(parsePaymentReference(raw.paymentIntentReference)),
        paymentAttemptReference: String(parsePaymentReference(raw.paymentAttemptReference)),
      };
      if (
        request.brandReference !== scope.brandReference ||
        request.storeReference !== scope.storeReference
      )
        throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
      try {
        return await options.transactions.run(async (tx) => {
          const authorize = async () => {
            if ((await options.authorize(tx, request)) !== true)
              throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
          };
          await authorize();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentReceiptOrder:" +
              scope.brandReference +
              ":" +
              scope.storeReference +
              ":" +
              request.orderReference,
          ]);
          const runner = {
            run: async <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
          };
          const identity = await createPostgresPaymentCompensationIdentityReader({
            ...options,
            scope,
            transactions: runner,
          })(request);
          if (
            !identity ||
            identity.environment !== raw.environment ||
            identity.identityVersion !== raw.identityVersion ||
            identity.identityDigest !== raw.identityDigest
          )
            return null;
          const now = parsePaymentInstant(options.clock.now());
          const row = await tx.query(
            "SELECT payment_operation_id FROM rms_payment.payment_intent WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3",
            [scope.brandReference, scope.storeReference, request.paymentIntentReference],
          );
          if (row.rows.length !== 1) return fail();
          const operation = String(parsePaymentReference(row.rows[0]?.payment_operation_id));
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentIntent:" + scope.brandReference + ":" + scope.storeReference + ":" + operation,
          ]);
          const history = createPostgresPaymentIntentCreationStore(
            runner,
            { brandReference: scope.brandReference, storeReference: scope.storeReference },
            {
              now: () => now,
              generateObservationReference: () => {
                throw Error("read only");
              },
            },
          );
          const record = await history.resolveOperation(operation);
          const fact = await createPostgresPaymentTerminalStore(runner, scope).read(
            request.paymentIntentReference,
          );
          if (
            !record ||
            !fact ||
            fact.outcome !== "Succeeded" ||
            !fact.amount ||
            record.intent.paymentIntentReference !== request.paymentIntentReference ||
            record.attempt.paymentAttemptReference !== request.paymentAttemptReference ||
            record.intent.preparation.orderReference !== request.orderReference ||
            fact.recordedAt > now
          )
            return fail();
          const result = await tx.query(
            "SELECT normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor::text,authorized_minor::text," +
              "captured_minor::text,refunded_minor::text,currency_code,evidence_digest,provider_observed_at,recorded_at," +
              "(count(*) OVER ())::text AS observation_count,(max(refunded_minor) OVER ())::text AS maximum_refunded_minor " +
              "FROM rms_payment.payment_provider_observation WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 AND payment_attempt_id=$4 " +
              "AND observation_kind='Snapshot' ORDER BY provider_observed_at DESC,recorded_at DESC,provider_observation_id DESC LIMIT 2",
            [
              scope.brandReference,
              scope.storeReference,
              request.paymentIntentReference,
              request.paymentAttemptReference,
            ],
          );
          const latest = result.rows[0],
            prior = result.rows[1];
          if (!latest || latest.currency_code !== "CAD") return fail();
          const observedAt = instant(latest.provider_observed_at);
          if (observedAt > now || instant(latest.recorded_at) > now || observedAt < fact.occurredAt)
            return fail();
          if (
            prior &&
            instant(prior.provider_observed_at) === observedAt &&
            [
              "normalized_status",
              "provider_intent_reference",
              "provider_transaction_reference",
              "requested_minor",
              "authorized_minor",
              "captured_minor",
              "refunded_minor",
              "currency_code",
            ].some((key) => prior[key] !== latest[key])
          )
            return fail();
          const status = providerStatuses.find((value) => value === latest.normalized_status);
          if (!status) return fail();
          const snapshot = createPaymentProviderSnapshot({
            kind: "Snapshot",
            context: {
              provider: "Stripe",
              environment: scope.environment,
              brandReference: identity.brandReference,
              storeReference: identity.storeReference,
              paymentAttemptReference: identity.paymentAttemptReference,
              operationReference: record.intent.paymentOperationReference,
            },
            providerIntentReference: fact.providerIntentReference,
            providerTransactionReference: latest.provider_transaction_reference as never,
            paymentMethod: record.intent.paymentMethod,
            captureMode: record.intent.captureMode,
            status,
            requestedAmount: decimal(latest.requested_minor),
            authorizedAmount: decimal(latest.authorized_minor),
            capturedAmount: decimal(latest.captured_minor),
            refundedAmount: decimal(latest.refunded_minor),
            observedAt,
            evidenceDigest: latest.evidence_digest as never,
          });
          if (
            snapshot.status !== "Captured" ||
            latest.provider_intent_reference !== fact.providerIntentReference ||
            snapshot.capturedAmount.amountMinor !== fact.amount.amountMinor ||
            snapshot.requestedAmount.amountMinor !== record.intent.preparation.total.amountMinor ||
            snapshot.refundedAmount.amountMinor < decimal(latest.maximum_refunded_minor).amountMinor
          )
            return fail();
          const local = await createPostgresPaymentCompensationRefundPositionSource({
            scope,
            authorize: async () => {
              await authorize();
              return true;
            },
          })(tx, {
            orderReference: request.orderReference,
            paymentTransactionReference: request.paymentTransactionReference,
            paymentAttemptReference: request.paymentAttemptReference,
          });
          const ordinary = await createPostgresOrdinaryRefundPositionSource({
            providerAccountReference: scope.providerAccountReference,
            environment: scope.environment,
            scope: {
              tenantReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            },
            authorize: async () => {
              await authorize();
              return true;
            },
          })(tx, {
            orderReference: request.orderReference,
            paymentTransactionReference: request.paymentTransactionReference,
            paymentIntentReference: request.paymentIntentReference,
            paymentAttemptReference: request.paymentAttemptReference,
            observedAt: now,
          });
          const other = await options.otherRefunds(tx, request);
          if (
            !Number.isSafeInteger(other.version) ||
            other.version < 1 ||
            typeof other.confirmedMinor !== "bigint" ||
            typeof other.pendingMinor !== "bigint" ||
            other.confirmedMinor < 0n ||
            other.pendingMinor < 0n
          )
            return fail();
          if (
            snapshot.refundedAmount.amountMinor >
            local.confirmedMinor + ordinary.confirmedMinor + other.confirmedMinor
          )
            return fail();
          const count = Number(latest.observation_count);
          const sourceVersion = count + local.version + ordinary.version + other.version;
          if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(sourceVersion))
            return fail();
          const source = parsePaymentCompensationSource({
            ...identity,
            sourceReference: fact.observationReference,
            providerAccountReference: fact.providerAccountReference,
            providerIntentReference: fact.providerIntentReference,
            originalPaymentMethod: record.intent.paymentMethod,
            captureMode: record.intent.captureMode,
            status: "Captured",
            requestedAmount: record.intent.preparation.total,
            capturedAmount: fact.amount,
            confirmedRefundedAmount: money(
              local.confirmedMinor + ordinary.confirmedMinor + other.confirmedMinor,
            ),
            pendingRefundClaimedAmount: money(
              local.pendingMinor + ordinary.pendingMinor + other.pendingMinor,
            ),
            terminalOccurredAt: fact.occurredAt,
            lastProviderObservedAt: observedAt,
            terminalEvidenceDigest: fact.evidenceDigest,
            sourceVersion,
            sourceSnapshotDigest: "sha256:" + "0".repeat(64),
          });
          const sourceSnapshotDigest =
            "sha256:" +
            createHash("sha256")
              .update(
                JSON.stringify(
                  paymentCompensationSourceSnapshotContent(source),
                  (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
                ),
              )
              .digest("hex");
          await authorize();
          return parsePaymentCompensationSource({ ...source, sourceSnapshotDigest });
        });
      } catch (error) {
        if (error instanceof PaymentCompensationError) throw error;
        return fail();
      }
    },
  };
}
