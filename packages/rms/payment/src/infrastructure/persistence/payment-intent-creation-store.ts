import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AuditTransaction,
} from "@bop/audit";
import {
  exactPaymentObject,
  parsePaymentInstant,
  parsePaymentIntentCreationRecord,
  paymentAttemptLimit,
  PaymentIntentCreationError,
  type PaymentIntentCreationRecord,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";

export interface PaymentIntentClaimAdmission {
  /**
   * Retain all owner fences until claim commit/rollback.
   * validUntil is an exclusive owner deadline; true adds no deadline beyond capacity.
   * Payment rechecks the earliest deadline after writes and Audit before returning the claim.
   */
  admit(
    transaction: AuditTransaction,
    record: PaymentIntentCreationRecord,
    observedAt: string,
  ): Promise<boolean | Readonly<{ validUntil: string }>>;
}

export interface PaymentIntentTransactionRunner {
  run<T>(action: (transaction: AuditTransaction) => Promise<T>): Promise<T>;
}
function fail(
  code: PaymentIntentCreationError["code"] = "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
): never {
  throw new PaymentIntentCreationError(code);
}
function single(value: unknown): unknown | null {
  if (value === null || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d)) return fail();
  const rows: unknown = d.value;
  if (
    !Array.isArray(rows) ||
    Object.getPrototypeOf(rows) !== Array.prototype ||
    rows.length > 1 ||
    Reflect.ownKeys(rows).length !== rows.length + 1
  )
    return fail();
  if (rows.length === 0) return null;
  const first = Object.getOwnPropertyDescriptor(rows, "0");
  if (!first?.enumerable || !("value" in first)) return fail();
  return first.value;
}
/** Capture only plain data; canonical record parser subsequently rejects unknown fields. */
function data(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const output: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return fail();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    if (key === "amountMinor") {
      if (typeof d.value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(d.value)) return fail();
      output[key] = BigInt(d.value);
    } else output[key] = data(d.value);
  }
  return output;
}
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const selectRecord = `SELECT jsonb_build_object('intent',jsonb_build_object('paymentIntentReference',i.payment_intent_id,'paymentOperationReference',i.payment_operation_id,'intentDigest',i.intent_digest,'preparation',jsonb_build_object('preparationReference',i.preparation_id,'orderReference',i.order_id,'orderBatchReference',i.order_batch_id,'submissionReference',i.submission_id,'sourceCartReference',i.source_cart_id,'sourceCartVersion',i.source_cart_version,'brandReference',i.brand_id,'storeReference',i.store_id,'guestSessionReference',i.guest_session_id,'quoteReference',i.quote_id,'capacityAllocationReference',i.capacity_allocation_id,'readiness','PaymentPending','transactionBoundary','OrderSubmissionPaymentPreparation','orderAllocation',jsonb_build_object('amountMinor',i.order_allocation_minor::text,'currencyCode','CAD'),'tip',jsonb_build_object('amountMinor',i.tip_minor::text,'currencyCode','CAD'),'total',jsonb_build_object('amountMinor',i.total_minor::text,'currencyCode','CAD'),'committedAt',to_char(i.prepared_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'capacityExpiresAt',to_char(i.capacity_expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceDigest',i.preparation_source_digest),'paymentMethod',i.payment_method,'captureMode',i.capture_mode,'aggregateVersion',i.aggregate_version,'creationStatus',i.creation_status,'createdAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'attempt',jsonb_build_object('paymentAttemptReference',a.payment_attempt_id,'paymentIntentReference',a.payment_intent_id,'attemptNumber',a.attempt_number,'provider',a.provider,'providerEnvironment',a.provider_environment,'providerIdempotencyDigest',a.provider_idempotency_digest,'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'providerOutcome',CASE WHEN o.provider_observation_id IS NULL THEN NULL WHEN o.observation_kind='Snapshot' THEN jsonb_build_object('kind','Snapshot','context',jsonb_build_object('provider',a.provider,'environment',a.provider_environment,'brandReference',i.brand_id,'storeReference',i.store_id,'paymentAttemptReference',a.payment_attempt_id,'operationReference',i.payment_operation_id),'providerIntentReference',o.provider_intent_reference,'providerTransactionReference',o.provider_transaction_reference,'paymentMethod',i.payment_method,'captureMode',i.capture_mode,'status',o.normalized_status,'requestedAmount',jsonb_build_object('amountMinor',o.requested_minor::text,'currencyCode','CAD'),'authorizedAmount',jsonb_build_object('amountMinor',o.authorized_minor::text,'currencyCode','CAD'),'capturedAmount',jsonb_build_object('amountMinor',o.captured_minor::text,'currencyCode','CAD'),'refundedAmount',jsonb_build_object('amountMinor',o.refunded_minor::text,'currencyCode','CAD'),'observedAt',to_char(o.provider_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'evidenceDigest',o.evidence_digest) ELSE jsonb_build_object('kind','Failure','context',jsonb_build_object('provider',a.provider,'environment',a.provider_environment,'brandReference',i.brand_id,'storeReference',i.store_id,'paymentAttemptReference',a.payment_attempt_id,'operationReference',i.payment_operation_id),'code',o.failure_code,'retryDisposition',o.retry_disposition,'safeReasonCode',o.safe_reason_code) END) AS record,
(op.payment_operation_id=i.payment_operation_id AND op.guest_session_id=i.guest_session_id
 AND op.intent_digest=i.intent_digest AND op.created_at=i.created_at
 AND i.created_at=date_trunc('milliseconds',i.created_at)
 AND i.prepared_at=date_trunc('milliseconds',i.prepared_at)
 AND i.capacity_expires_at=date_trunc('milliseconds',i.capacity_expires_at)
 AND ((a.attempt_number=1 AND a.created_at=i.created_at)
  OR (a.attempt_number>1 AND a.created_at>i.created_at AND a.created_at<i.capacity_expires_at
   AND a.created_at=date_trunc('milliseconds',a.created_at)))
 AND (o.provider_observed_at IS NULL OR o.provider_observed_at=date_trunc('milliseconds',o.provider_observed_at))) AS coherent
FROM rms_payment.payment_intent i
LEFT JOIN LATERAL (SELECT * FROM rms_payment.payment_attempt pa
 WHERE pa.payment_intent_id=i.payment_intent_id AND pa.brand_id=i.brand_id AND pa.store_id=i.store_id
 ORDER BY pa.attempt_number DESC LIMIT 1) a ON true
LEFT JOIN rms_payment.payment_intent_operation_record op ON op.payment_intent_id=i.payment_intent_id AND op.brand_id=i.brand_id AND op.store_id=i.store_id
LEFT JOIN LATERAL (SELECT * FROM rms_payment.payment_provider_observation obs
 WHERE obs.payment_intent_id=i.payment_intent_id AND obs.payment_attempt_id=a.payment_attempt_id
 AND obs.brand_id=i.brand_id AND obs.store_id=i.store_id
 ORDER BY obs.recorded_at DESC,obs.provider_observation_id DESC LIMIT 1) o ON true
WHERE i.brand_id=$1 AND i.store_id=$2 AND i.payment_operation_id=$3`;
/** Owner persistence only; callers must establish final current payment eligibility. */
export function createPostgresPaymentIntentCreationStore(
  runner: PaymentIntentTransactionRunner,
  scopeInput: unknown,
  options: { now(): string; generateObservationReference(): string },
  admission?: PaymentIntentClaimAdmission,
) {
  const admit = admission?.admit.bind(admission);
  const scope = exactPaymentObject(scopeInput, ["brandReference", "storeReference"]);
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference);
  const scoped = (record: PaymentIntentCreationRecord) => {
    if (
      String(record.intent.preparation.brandReference) !== brand ||
      String(record.intent.preparation.storeReference) !== store
    )
      return fail("PAYMENT_INTENT_PERMISSION_DENIED");
    return record;
  };
  const context = (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const lock = (tx: AuditTransaction, operation: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentIntent:" + brand + ":" + store + ":" + operation,
    ]);
  const read = async (tx: AuditTransaction, operation: string) => {
    const row = single(await tx.query(selectRecord, [brand, store, operation]));
    if (row === null) return null;
    const raw = exactPaymentObject(row, ["record", "coherent"]);
    if (raw.coherent !== true) return fail();
    const record = scoped(parsePaymentIntentCreationRecord(data(raw.record)));
    if (record.intent.paymentOperationReference !== operation) return fail();
    return record;
  };
  const sameOriginal = (left: PaymentIntentCreationRecord, right: PaymentIntentCreationRecord) => {
    if (
      left.intent.paymentOperationReference !== right.intent.paymentOperationReference ||
      left.intent.intentDigest !== right.intent.intentDigest ||
      left.intent.createdAt !== right.intent.createdAt ||
      left.attempt.providerEnvironment !== right.attempt.providerEnvironment ||
      canonical(left.intent.preparation) !== canonical(right.intent.preparation)
    )
      return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
  };
  const affected = async (tx: AuditTransaction, sql: string, values: readonly unknown[]) => {
    const result = await tx.query(sql, values);
    if (
      result === null ||
      typeof result !== "object" ||
      Object.getOwnPropertyDescriptor(result, "rowCount")?.value !== 1
    )
      return fail();
  };
  const safe = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof PaymentIntentCreationError) throw error;
      return fail();
    }
  };
  return Object.freeze({
    /** The intent with its latest attempt (WP-2423 Q20: a retry is a later attempt). */
    resolveOperation(value: unknown) {
      return safe(async () => {
        const operation = parsePaymentReference(value);
        return runner.run(async (tx) => {
          await context(tx);
          return read(tx, operation);
        });
      });
    },
    /**
     * WP-2423 abandoned pickup payment: discovery only. Online card payments whose payment window
     * (`capacity_expires_at`) has ended while their latest attempt still has no recorded outcome,
     * in payment operation order after `after`. The caller decides from the Order's owner whether
     * the Provider should be asked (and the attempt cancelled); a result never authorizes that.
     */
    listExpiredOpenOperations(value: unknown) {
      return safe(async () => {
        const raw = exactPaymentObject(value, ["observedAt", "after", "limit"]);
        const at = parsePaymentInstant(raw.observedAt),
          after = raw.after === null ? null : parsePaymentReference(raw.after),
          limit = raw.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
          return fail("PAYMENT_INTENT_INPUT_INVALID");
        return runner.run(async (tx) => {
          await context(tx);
          const result = await tx.query(
            `SELECT i.payment_operation_id::text AS operation,i.order_id::text AS "order"
            FROM rms_payment.payment_intent i
            JOIN LATERAL (SELECT pa.payment_attempt_id FROM rms_payment.payment_attempt pa
              WHERE pa.payment_intent_id=i.payment_intent_id AND pa.brand_id=i.brand_id AND pa.store_id=i.store_id
              ORDER BY pa.attempt_number DESC LIMIT 1) a ON true
            WHERE i.brand_id=$1 AND i.store_id=$2 AND i.payment_method='OnlineCard'
              AND i.creation_status='ProviderCreatePending' AND i.capacity_expires_at<=$3::timestamptz
              AND ($4::uuid IS NULL OR i.payment_operation_id>$4::uuid)
              AND NOT EXISTS (SELECT 1 FROM rms_payment.payment_terminal_fact t
                WHERE t.brand_id=i.brand_id AND t.store_id=i.store_id AND t.payment_attempt_id=a.payment_attempt_id)
            ORDER BY i.payment_operation_id LIMIT $5`,
            [brand, store, at, after, limit],
          );
          const rows: unknown = (result as { rows?: unknown } | null)?.rows;
          if (!Array.isArray(rows) || rows.length > limit) return fail();
          let previous = after;
          return Object.freeze(
            rows.map((row: unknown) => {
              const item = exactPaymentObject(row, ["operation", "order"]);
              const paymentOperationReference = parsePaymentReference(item.operation),
                orderReference = parsePaymentReference(item.order);
              if (previous !== null && paymentOperationReference <= previous) return fail();
              previous = paymentOperationReference;
              return Object.freeze({ paymentOperationReference, orderReference });
            }),
          );
        });
      });
    },
    claim(value: unknown) {
      return safe(async () => {
        const raw = exactPaymentObject(value, ["record", "audit"]);
        const record = scoped(parsePaymentIntentCreationRecord(raw.record));
        const { intent, attempt } = record,
          p = intent.preparation;
        const at = parsePaymentInstant(options.now());
        if (
          record.providerOutcome !== null ||
          intent.createdAt > at ||
          Date.parse(p.committedAt) > Date.parse(intent.createdAt) ||
          Date.parse(p.capacityExpiresAt) - Date.parse(intent.createdAt) !== 1800000
        )
          return fail("PAYMENT_INTENT_INPUT_INVALID");
        const audit = validateAuditRecord(raw.audit as never, Date.parse(at));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "PAYMENT_INTENT_CREATE" ||
          audit.targetType !== "PaymentIntent" ||
          audit.targetId !== intent.paymentIntentReference ||
          audit.reasonCode !== "AUTHORIZED_PAYMENT_INTENT_CREATE" ||
          audit.occurredAt !== intent.createdAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return fail("PAYMENT_INTENT_PERMISSION_DENIED");
        return runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentReceiptOrder:" + brand + ":" + store + ":" + p.orderReference,
          ]);
          await lock(tx, intent.paymentOperationReference);
          const prior = await read(tx, intent.paymentOperationReference);
          if (prior !== null) {
            sameOriginal(prior, record);
            return Object.freeze({ status: "Existing" as const, record: prior });
          }
          let validUntil: string = p.capacityExpiresAt;
          if (admit !== undefined) {
            const decision = await admit(tx, record, parsePaymentInstant(options.now()));
            if (decision !== true) {
              if (decision === false) return fail("PAYMENT_INTENT_PERMISSION_DENIED");
              const deadline = parsePaymentInstant(
                exactPaymentObject(decision, ["validUntil"]).validUntil,
              );
              if (deadline < validUntil) validUntil = deadline;
            }
            await context(tx);
          }
          const checkClock = async () => {
            const clock = exactPaymentObject(
              single(
                await tx.query(
                  "SELECT clock_timestamp() >= $1::timestamptz AND clock_timestamp() < $2::timestamptz AS live",
                  [intent.createdAt, validUntil],
                ),
              ),
              ["live"],
            );
            if (
              clock.live !== true ||
              Date.parse(parsePaymentInstant(options.now())) >= Date.parse(validUntil)
            )
              return fail("PAYMENT_INTENT_PREPARATION_EXPIRED");
          };
          await checkClock();
          await affected(
            tx,
            "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$19,$20,$21)",
            [
              intent.paymentIntentReference,
              brand,
              store,
              intent.paymentOperationReference,
              p.orderReference,
              p.orderBatchReference,
              p.submissionReference,
              p.guestSessionReference,
              p.sourceCartReference,
              p.sourceCartVersion,
              p.quoteReference,
              p.preparationReference,
              p.capacityAllocationReference,
              intent.intentDigest,
              p.sourceDigest,
              p.orderAllocation.amountMinor.toString(),
              p.tip.amountMinor.toString(),
              p.total.amountMinor.toString(),
              p.committedAt,
              p.capacityExpiresAt,
              intent.createdAt,
            ],
          );
          await affected(
            tx,
            "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe',$5,$6,$7)",
            [
              attempt.paymentAttemptReference,
              brand,
              store,
              intent.paymentIntentReference,
              attempt.providerEnvironment,
              attempt.providerIdempotencyDigest,
              attempt.createdAt,
            ],
          );
          await affected(
            tx,
            "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [
              intent.paymentOperationReference,
              brand,
              store,
              intent.paymentIntentReference,
              p.guestSessionReference,
              intent.intentDigest,
              intent.createdAt,
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          const saved = await read(tx, intent.paymentOperationReference);
          if (saved === null || canonical(saved) !== canonical(record)) return fail();
          await checkClock();
          return Object.freeze({ status: "Claimed" as const, record: saved });
        });
      });
    },
    /**
     * WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): append the next attempt after the previous one failed.
     * Serialized with terminal recording and the payment-window decisions (same fences as
     * `createPostgresPaymentOperationFence`). When another request already appended the next
     * attempt, that attempt is returned as Existing; nothing is ever changed or removed.
     */
    claimRetry(value: unknown) {
      return safe(async () => {
        const raw = exactPaymentObject(value, ["previousAttemptReference", "record", "audit"]);
        const previous = parsePaymentReference(raw.previousAttemptReference);
        const record = scoped(parsePaymentIntentCreationRecord(raw.record));
        const { intent, attempt } = record,
          p = intent.preparation;
        const at = parsePaymentInstant(options.now());
        if (
          record.providerOutcome !== null ||
          attempt.attemptNumber < 2 ||
          attempt.createdAt > at ||
          attempt.paymentAttemptReference === previous
        )
          return fail("PAYMENT_INTENT_INPUT_INVALID");
        const audit = validateAuditRecord(raw.audit as never, Date.parse(at));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "PAYMENT_ATTEMPT_RETRY" ||
          audit.targetType !== "PaymentIntent" ||
          audit.targetId !== intent.paymentIntentReference ||
          audit.reasonCode !== "CUSTOMER_RETRY_AFTER_DECLINE" ||
          audit.occurredAt !== attempt.createdAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          canonical(audit.afterSummary) !== canonical({ attemptNumber: attempt.attemptNumber })
        )
          return fail("PAYMENT_INTENT_PERMISSION_DENIED");
        return runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentReceiptOrder:" + brand + ":" + store + ":" + p.orderReference,
          ]);
          await lock(tx, intent.paymentOperationReference);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentTerminal:" + brand + ":" + store + ":" + intent.paymentIntentReference,
          ]);
          const prior = await read(tx, intent.paymentOperationReference);
          if (prior === null) return fail("PAYMENT_INTENT_ORDER_NOT_READY");
          sameOriginal(prior, record);
          if (canonical(prior.intent) !== canonical(intent))
            return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
          const facts = await tx.query(
            "SELECT payment_attempt_id::text AS attempt,terminal_outcome AS outcome FROM rms_payment.payment_terminal_fact WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 LIMIT 11",
            [brand, store, intent.paymentIntentReference],
          );
          const outcomes = (Object.getOwnPropertyDescriptor(facts, "rows")?.value ??
            fail()) as readonly { attempt: unknown; outcome: unknown }[];
          if (!Array.isArray(outcomes) || outcomes.length > 10) return fail();
          if (outcomes.some((row) => row.outcome === "Succeeded"))
            return fail("PAYMENT_INTENT_ALREADY_PAID");
          // Another request already started the next try: that try is the result.
          if (prior.attempt.paymentAttemptReference !== previous) {
            if (prior.attempt.attemptNumber < attempt.attemptNumber - 1) return fail();
            return Object.freeze({ status: "Existing" as const, record: prior });
          }
          if (prior.attempt.attemptNumber + 1 !== attempt.attemptNumber)
            return fail("PAYMENT_INTENT_INPUT_INVALID");
          // The latest try is still open (no outcome yet): that try is the result.
          if (!outcomes.some((row) => row.attempt === previous))
            return Object.freeze({ status: "Existing" as const, record: prior });
          if (!outcomes.some((row) => row.attempt === previous && row.outcome === "Failed"))
            return fail("PAYMENT_INTENT_RETRY_NOT_ALLOWED");
          if (prior.attempt.attemptNumber >= paymentAttemptLimit)
            return fail("PAYMENT_INTENT_RETRY_LIMIT_REACHED");
          if (
            attempt.providerEnvironment !== prior.attempt.providerEnvironment ||
            attempt.provider !== prior.attempt.provider
          )
            return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
          let validUntil: string = p.capacityExpiresAt;
          if (admit !== undefined) {
            const decision = await admit(tx, record, parsePaymentInstant(options.now()));
            if (decision !== true) {
              if (decision === false) return fail("PAYMENT_INTENT_PERMISSION_DENIED");
              const deadline = parsePaymentInstant(
                exactPaymentObject(decision, ["validUntil"]).validUntil,
              );
              if (deadline < validUntil) validUntil = deadline;
            }
            await context(tx);
          }
          const checkClock = async () => {
            const clock = exactPaymentObject(
              single(
                await tx.query(
                  "SELECT clock_timestamp() >= $1::timestamptz AND clock_timestamp() < $2::timestamptz AS live",
                  [attempt.createdAt, validUntil],
                ),
              ),
              ["live"],
            );
            if (
              clock.live !== true ||
              Date.parse(parsePaymentInstant(options.now())) >= Date.parse(validUntil)
            )
              return fail("PAYMENT_INTENT_PREPARATION_EXPIRED");
          };
          await checkClock();
          await affected(
            tx,
            "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,$5,'Stripe',$6,$7,$8)",
            [
              attempt.paymentAttemptReference,
              brand,
              store,
              intent.paymentIntentReference,
              attempt.attemptNumber,
              attempt.providerEnvironment,
              attempt.providerIdempotencyDigest,
              attempt.createdAt,
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          const saved = await read(tx, intent.paymentOperationReference);
          if (saved === null || canonical(saved) !== canonical(record)) return fail();
          await checkClock();
          return Object.freeze({ status: "Claimed" as const, record: saved });
        });
      });
    },
    recordObservation(value: unknown) {
      return safe(async () => {
        const raw = exactPaymentObject(value, ["record"]);
        const record = scoped(parsePaymentIntentCreationRecord(raw.record));
        const outcome = record.providerOutcome;
        if (outcome === null) return fail("PAYMENT_INTENT_PROVIDER_RESULT_INVALID");
        const at = parsePaymentInstant(options.now());
        if (
          at < record.intent.createdAt ||
          (outcome.kind === "Snapshot" && outcome.observedAt > at)
        )
          return fail("PAYMENT_INTENT_PROVIDER_RESULT_INVALID");
        return runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await context(tx);
          await lock(tx, record.intent.paymentOperationReference);
          const prior = await read(tx, record.intent.paymentOperationReference);
          if (prior === null) return fail();
          sameOriginal(prior, record);
          if (
            canonical(prior.intent) !== canonical(record.intent) ||
            canonical(prior.attempt) !== canonical(record.attempt)
          )
            return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
          if (prior.providerOutcome !== null) {
            if (canonical(prior.providerOutcome) !== canonical(outcome))
              return fail("PAYMENT_INTENT_IDEMPOTENCY_CONFLICT");
            return prior;
          }
          const observation = parsePaymentReference(options.generateObservationReference());
          const snapshot = outcome.kind === "Snapshot" ? outcome : null;
          const failure = outcome.kind === "Failure" ? outcome : null;
          await affected(
            tx,
            "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,failure_code,retry_disposition,safe_reason_code,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)",
            [
              observation,
              brand,
              store,
              record.intent.paymentIntentReference,
              record.attempt.paymentAttemptReference,
              outcome.kind,
              snapshot?.status ?? null,
              snapshot?.providerIntentReference ?? null,
              snapshot?.providerTransactionReference ?? null,
              snapshot?.requestedAmount.amountMinor.toString() ?? null,
              snapshot?.authorizedAmount.amountMinor.toString() ?? null,
              snapshot?.capturedAmount.amountMinor.toString() ?? null,
              snapshot?.refundedAmount.amountMinor.toString() ?? null,
              snapshot === null ? null : "CAD",
              snapshot?.evidenceDigest ?? null,
              failure?.code ?? null,
              failure?.retryDisposition ?? null,
              failure?.safeReasonCode ?? null,
              snapshot?.observedAt ?? null,
              at,
            ],
          );
          const saved = await read(tx, record.intent.paymentOperationReference);
          if (saved === null || canonical(saved) !== canonical(record)) return fail();
          return saved;
        });
      });
    },
  });
}

/** Pilot claim path with mandatory current owner admission inside the Payment transaction. */
export function createPostgresAdmittedPaymentIntentCreationStore(
  runner: PaymentIntentTransactionRunner,
  scope: unknown,
  options: { now(): string; generateObservationReference(): string },
  admission: PaymentIntentClaimAdmission,
) {
  if (!admission || typeof admission.admit !== "function")
    return fail("PAYMENT_INTENT_PERMISSION_DENIED");
  return createPostgresPaymentIntentCreationStore(runner, scope, options, admission);
}

/** Payment-owned synchronization for a caller's timeout/disposition transaction.
 * Retain this transaction through the eventual owner write. A missing intent is
 * not a conclusion about remote payment; callers must still preserve uncertainty.
 */
export function createPostgresPaymentOperationFence(options: {
  brandReference: string;
  storeReference: string;
  now(): string;
  authorize(
    transaction: AuditTransaction,
    query: {
      brandReference: string;
      storeReference: string;
      orderReference: string;
      paymentOperationReference: string;
      observedAt: string;
    },
  ): Promise<boolean>;
}) {
  const brand = parsePaymentReference(options.brandReference),
    store = parsePaymentReference(options.storeReference);
  return Object.freeze({
    async acquire(transaction: AuditTransaction, value: unknown) {
      try {
        const raw = exactPaymentObject(value, ["orderReference", "paymentOperationReference"]);
        const orderReference = parsePaymentReference(raw.orderReference);
        const paymentOperationReference = parsePaymentReference(raw.paymentOperationReference);
        const started = parsePaymentInstant(options.now());
        const authorized = async () => {
          const observedAt = parsePaymentInstant(options.now());
          if (
            observedAt < started ||
            !(await options.authorize(transaction, {
              brandReference: brand,
              storeReference: store,
              orderReference,
              paymentOperationReference,
              observedAt,
            }))
          )
            return fail("PAYMENT_INTENT_PERMISSION_DENIED");
        };
        await authorized();
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        for (const key of [
          "PaymentReceiptOrder:" + brand + ":" + store + ":" + orderReference,
          "PaymentIntent:" + brand + ":" + store + ":" + paymentOperationReference,
        ]) {
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
        }
        const found = single(
          await transaction.query(
            'SELECT payment_intent_id AS "paymentIntentReference",order_id AS "orderReference" FROM rms_payment.payment_intent WHERE brand_id=$1 AND store_id=$2 AND payment_operation_id=$3',
            [brand, store, paymentOperationReference],
          ),
        );
        let paymentIntentReference: string | null = null;
        if (found !== null) {
          const identity = exactPaymentObject(found, ["paymentIntentReference", "orderReference"]);
          paymentIntentReference = parsePaymentReference(identity.paymentIntentReference);
          if (parsePaymentReference(identity.orderReference) !== orderReference)
            return fail("PAYMENT_INTENT_PERMISSION_DENIED");
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentTerminal:" + brand + ":" + store + ":" + paymentIntentReference,
          ]);
        }
        await authorized();
        return Object.freeze({ paymentIntentReference });
      } catch (error) {
        if (error instanceof PaymentIntentCreationError) throw error;
        return fail();
      }
    },
  });
}
