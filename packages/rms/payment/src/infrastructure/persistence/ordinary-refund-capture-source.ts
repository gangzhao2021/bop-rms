import { createPostgresOrdinaryRefundPositionSource } from "../ordinary-refund-position-source.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseOrdinaryRefundRequest,
  type OrdinaryRefundRequest,
} from "../../application/ordinary-refund-request.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { createPostgresPaymentIntentCreationStore } from "./payment-intent-creation-store.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";
import { createPostgresPaymentCompensationRefundPositionSource } from "./payment-compensation-refund-position-source.js";
type RequestScope = Pick<
  OrdinaryRefundRequest,
  "tenantReference" | "brandReference" | "storeReference"
>;
interface PricingInput {
  readonly request: OrdinaryRefundRequest;
  readonly payment: OrdinaryRefundRequest["payments"][number];
  readonly history: readonly OrdinaryRefundRequest[];
  readonly preparation: NonNullable<
    Awaited<
      ReturnType<ReturnType<typeof createPostgresPaymentIntentCreationStore>["resolveOperation"]>
    >
  >["intent"]["preparation"];
}
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_CAPTURE_UNAVAILABLE");
};
const instant = (value: unknown) =>
  parsePaymentInstant(value instanceof Date ? value.toISOString() : value);

/** Trusted in-transaction adapter for the request writer's validateSources port.
 * Retains existing Payment/compensation fences and requires original Pricing
 * validation. Caller must not use this immutable ceiling as dispatch approval. */
export function createPostgresOrdinaryRefundCaptureSource(options: {
  readonly scope: RequestScope & {
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  };
  readonly now: () => string;
  readonly authorize: (tx: ConsumerTransaction, request: OrdinaryRefundRequest) => Promise<boolean>;
  readonly validatePricing: (tx: ConsumerTransaction, input: PricingInput) => Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(options.scope.providerAccountReference)),
    environment: options.scope.environment,
  };
  if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
  return async (
    tx: ConsumerTransaction,
    input: {
      readonly request: OrdinaryRefundRequest;
      readonly history: readonly OrdinaryRefundRequest[];
    },
  ) => {
    const request = parseOrdinaryRefundRequest(input.request);
    if (
      request.tenantReference !== scope.tenantReference ||
      request.brandReference !== scope.brandReference ||
      request.storeReference !== scope.storeReference
    )
      return fail();
    const authorize = async () => {
      if ((await options.authorize(tx, request)) !== true) return fail();
    };
    await authorize();
    const now = parsePaymentInstant(options.now());
    if (now < request.requestedAt) return fail();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
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
    const terminal = createPostgresPaymentTerminalStore(runner, {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      providerAccountReference: scope.providerAccountReference,
      environment: scope.environment,
    });
    const creation = createPostgresPaymentIntentCreationStore(
      runner,
      {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      },
      {
        now: () => now,
        generateObservationReference: () => {
          throw Error("read only");
        },
      },
    );
    const compensation = createPostgresPaymentCompensationRefundPositionSource({
      scope,
      authorize: async () => {
        await authorize();
        return true;
      },
    });
    const balances = [];
    // Parser orders payment attempts deterministically before acquiring their locks.
    for (const payment of request.payments) {
      const identities = await tx.query(
        "SELECT payment_operation_id::text AS operation FROM rms_payment.payment_intent " +
          "WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 AND order_id=$4",
        [
          scope.brandReference,
          scope.storeReference,
          payment.paymentIntentReference,
          request.orderReference,
        ],
      );
      if (identities.rows.length !== 1) return fail();
      const operation = String(parsePaymentReference(identities.rows[0]?.operation));
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PaymentIntent:" + scope.brandReference + ":" + scope.storeReference + ":" + operation,
      ]);
      const record = await creation.resolveOperation(operation);
      const fact = await terminal.read(payment.paymentIntentReference);
      if (
        !record ||
        !fact ||
        fact.outcome !== "Succeeded" ||
        !fact.amount ||
        fact.amount.currencyCode !== "CAD" ||
        fact.amount.amountMinor <= 0n ||
        fact.paymentTransactionReference !== payment.paymentTransactionReference ||
        fact.paymentAttemptReference !== payment.paymentAttemptReference ||
        fact.observationReference !== payment.firstCaptureReference ||
        fact.orderReference !== request.orderReference ||
        fact.recordedAt > request.requestedAt ||
        fact.occurredAt > fact.recordedAt ||
        record.intent.paymentIntentReference !== payment.paymentIntentReference ||
        record.attempt.paymentAttemptReference !== payment.paymentAttemptReference ||
        record.intent.preparation.orderReference !== request.orderReference ||
        record.intent.paymentMethod !== "OnlineCard" ||
        record.intent.captureMode !== "Automatic" ||
        record.attempt.providerEnvironment !== scope.environment ||
        record.intent.preparation.total.currencyCode !== "CAD" ||
        record.intent.preparation.total.amountMinor !== fact.amount.amountMinor
      )
        return fail();
      const other = await compensation(tx, {
        orderReference: request.orderReference,
        paymentTransactionReference: payment.paymentTransactionReference,
        paymentAttemptReference: payment.paymentAttemptReference,
      });
      const observations = await tx.query(
        "SELECT count(*)::text AS count,max(refunded_minor)::text AS refunded," +
          "max(recorded_at) AS recorded_at,max(provider_observed_at) AS observed_at " +
          "FROM rms_payment.payment_provider_observation WHERE brand_id=$1 AND store_id=$2 " +
          "AND payment_intent_id=$3 AND payment_attempt_id=$4 AND observation_kind='Snapshot'",
        [
          scope.brandReference,
          scope.storeReference,
          payment.paymentIntentReference,
          payment.paymentAttemptReference,
        ],
      );
      const observed = observations.rows[0];
      if (
        observations.rows.length !== 1 ||
        !observed ||
        typeof observed.count !== "string" ||
        !/^(0|[1-9][0-9]*)$/u.test(observed.count)
      )
        return fail();
      const ordinary = await createPostgresOrdinaryRefundPositionSource({
        scope: {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        },
        providerAccountReference: scope.providerAccountReference,
        environment: scope.environment,
        authorize: async () => {
          await authorize();
          return true;
        },
      })(tx, {
        orderReference: request.orderReference,
        paymentTransactionReference: payment.paymentTransactionReference,
        paymentIntentReference: payment.paymentIntentReference,
        paymentAttemptReference: payment.paymentAttemptReference,
        observedAt: now,
      });
      if (observed.count !== "0") {
        if (
          typeof observed.refunded !== "string" ||
          !/^(0|[1-9][0-9]{0,18})$/u.test(observed.refunded) ||
          BigInt(observed.refunded) > other.confirmedMinor + ordinary.confirmedMinor ||
          instant(observed.recorded_at) > now ||
          instant(observed.observed_at) > now
        )
          return fail();
      }
      if (
        other.confirmedMinor +
          other.pendingMinor +
          ordinary.confirmedMinor +
          ordinary.pendingMinor >
          fact.amount.amountMinor ||
        (await options.validatePricing(tx, {
          request,
          payment,
          history: input.history,
          preparation: record.intent.preparation,
        })) !== true
      )
        return fail();
      balances.push(
        Object.freeze({
          paymentAttemptReference: payment.paymentAttemptReference,
          capturedAmountMinor: fact.amount.amountMinor,
          otherOccupiedAmountMinor: other.confirmedMinor + other.pendingMinor,
          firstCapturedAt: fact.occurredAt,
          firstCaptureRecordedAt: fact.recordedAt,
          providerBinding: Object.freeze({
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            orderReference: request.orderReference,
            paymentTransactionReference: fact.paymentTransactionReference,
            paymentIntentReference: payment.paymentIntentReference,
            paymentAttemptReference: fact.paymentAttemptReference,
            firstCaptureReference: fact.observationReference,
            providerAccountReference: scope.providerAccountReference,
            environment: scope.environment,
            providerIntentReference: fact.providerIntentReference,
            originalPaymentMethod: record.intent.paymentMethod,
          }),
        }),
      );
    }
    await authorize();
    return Object.freeze(balances);
  };
}
