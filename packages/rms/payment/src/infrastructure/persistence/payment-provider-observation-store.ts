import {
  createPaymentProviderSnapshot,
  parsePaymentReference,
} from "../../application/payment-provider-adapter.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
  PaymentIntentCreationError,
} from "../../application/payment-intent-creation.js";
import {
  createPostgresPaymentIntentCreationStore,
  type PaymentIntentTransactionRunner,
} from "./payment-intent-creation-store.js";
function fail(
  code: PaymentIntentCreationError["code"] = "PAYMENT_INTENT_PROVIDER_RESULT_INVALID",
): never {
  throw new PaymentIntentCreationError(code);
}
const fields = [
  "provider_observation_id",
  "brand_id",
  "store_id",
  "payment_intent_id",
  "payment_attempt_id",
  "observation_kind",
  "normalized_status",
  "provider_intent_reference",
  "provider_transaction_reference",
  "requested_minor",
  "authorized_minor",
  "captured_minor",
  "refunded_minor",
  "currency_code",
  "evidence_digest",
  "provider_observed_at",
] as const;
/** Subsequent normalized Provider observations; does not overwrite the original creation response. */
export function createPostgresPaymentProviderObservationStore(
  runner: PaymentIntentTransactionRunner,
  scopeInput: unknown,
  options: { now(): string },
) {
  const scope = exactPaymentObject(scopeInput, ["brandReference", "storeReference"]);
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference);
  return Object.freeze({
    async record(value: unknown): Promise<{
      readonly status: "Recorded" | "AlreadyRecorded";
      readonly observationReference: string;
    }> {
      try {
        const raw = exactPaymentObject(value, [
          "observationReference",
          "paymentIntentReference",
          "snapshot",
        ]);
        const observationReference = parsePaymentReference(raw.observationReference);
        const intent = parsePaymentReference(raw.paymentIntentReference);
        const snapshot = createPaymentProviderSnapshot(raw.snapshot as never);
        if (snapshot.context.brandReference !== brand || snapshot.context.storeReference !== store)
          return fail();
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          const result = await tx.query(
            `SELECT i.payment_operation_id AS "operationReference"
             FROM rms_payment.payment_intent i
             JOIN rms_payment.payment_attempt a
               ON a.payment_intent_id=i.payment_intent_id
               AND a.brand_id=i.brand_id AND a.store_id=i.store_id
             WHERE i.brand_id=$1 AND i.store_id=$2 AND i.payment_intent_id=$3
               AND a.payment_attempt_id=$4 AND a.provider='Stripe'
               AND a.provider_environment=$5`,
            [
              brand,
              store,
              intent,
              snapshot.context.paymentAttemptReference,
              snapshot.context.environment,
            ],
          );
          const rows: unknown =
            result !== null && typeof result === "object"
              ? Object.getOwnPropertyDescriptor(result, "rows")?.value
              : undefined;
          if (!Array.isArray(rows) || rows.length !== 1) return fail();
          const operationReference = parsePaymentReference(
            exactPaymentObject(rows[0], ["operationReference"]).operationReference,
          );
          const bound = createPaymentProviderSnapshot({
            ...snapshot,
            context: { ...snapshot.context, operationReference },
          });
          const recorded = await createPostgresPaymentProviderObservationStore(
            { run: async (work) => work(tx) },
            scope,
            options,
          ).append({ observationReference, snapshot: bound });
          return Object.freeze({
            status: recorded.status,
            observationReference: recorded.observationReference,
          });
        });
      } catch (error) {
        if (error instanceof PaymentIntentCreationError) throw error;
        throw new PaymentIntentCreationError("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
    },
    async append(value: unknown) {
      try {
        const raw = exactPaymentObject(value, ["observationReference", "snapshot"]);
        const observation = parsePaymentReference(raw.observationReference);
        const snapshot = createPaymentProviderSnapshot(raw.snapshot as never);
        const at = parsePaymentInstant(options.now());
        if (
          snapshot.context.brandReference !== brand ||
          snapshot.context.storeReference !== store ||
          snapshot.observedAt > at
        )
          return fail();
        return await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentIntent:" + brand + ":" + store + ":" + snapshot.context.operationReference,
          ]);
          const history = createPostgresPaymentIntentCreationStore(
            { run: async (work) => work(tx) },
            scope,
            {
              now: options.now,
              generateObservationReference: () => {
                throw new Error("read only");
              },
            },
          );
          const record = await history.resolveOperation(snapshot.context.operationReference);
          if (
            !record ||
            snapshot.context.paymentAttemptReference !== record.attempt.paymentAttemptReference ||
            snapshot.context.environment !== record.attempt.providerEnvironment ||
            snapshot.paymentMethod !== record.intent.paymentMethod ||
            snapshot.captureMode !== record.intent.captureMode ||
            snapshot.requestedAmount.amountMinor !== record.intent.preparation.total.amountMinor ||
            at < record.intent.createdAt
          )
            return fail();
          const prior = record.providerOutcome;
          if (
            prior?.kind !== "Snapshot" ||
            prior.providerIntentReference !== snapshot.providerIntentReference
          )
            return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
          const values = [
            observation,
            brand,
            store,
            record.intent.paymentIntentReference,
            record.attempt.paymentAttemptReference,
            "Snapshot",
            snapshot.status,
            snapshot.providerIntentReference,
            snapshot.providerTransactionReference,
            snapshot.requestedAmount.amountMinor.toString(),
            snapshot.authorizedAmount.amountMinor.toString(),
            snapshot.capturedAmount.amountMinor.toString(),
            snapshot.refundedAmount.amountMinor.toString(),
            "CAD",
            snapshot.evidenceDigest,
            snapshot.observedAt,
          ];
          const matched = await tx.query(
            "SELECT (" +
              fields
                .map((name, index) => name + " IS NOT DISTINCT FROM $" + (index + 1))
                .join(" AND ") +
              ") AS matches FROM rms_payment.payment_provider_observation WHERE provider_observation_id=$1",
            values,
          );
          const rows: unknown =
            matched !== null && typeof matched === "object"
              ? Object.getOwnPropertyDescriptor(matched, "rows")?.value
              : undefined;
          if (!Array.isArray(rows) || rows.length > 1) return fail();
          if (rows.length === 1) {
            if (exactPaymentObject(rows[0], ["matches"]).matches !== true)
              return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
            return Object.freeze({
              status: "AlreadyRecorded" as const,
              observationReference: observation,
              snapshot,
            });
          }
          if (
            snapshot.observedAt < prior.observedAt ||
            (["Captured", "Failed", "Cancelled"].includes(prior.status) &&
              snapshot.status !== prior.status)
          )
            return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
          const result = await tx.query(
            "INSERT INTO rms_payment.payment_provider_observation (" +
              fields.join(",") +
              ",recorded_at) VALUES (" +
              values.map((_v, index) => "$" + (index + 1)).join(",") +
              ",$17)",
            [...values, at],
          );
          if (
            result === null ||
            typeof result !== "object" ||
            Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1
          )
            return fail();
          return Object.freeze({
            status: "Recorded" as const,
            observationReference: observation,
            snapshot,
          });
        });
      } catch (error) {
        if (error instanceof PaymentIntentCreationError) throw error;
        throw new PaymentIntentCreationError("PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
