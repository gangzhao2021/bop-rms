import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AuditTransaction,
} from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";
import {
  parsePaymentTerminalObservation,
  PaymentTerminalError,
  type PaymentTerminalFact,
} from "../../application/payment-terminal-fact.js";
import {
  createPaymentTerminalEnvelope,
  parsePaymentTerminalEnvelope,
} from "../../application/payment-terminal-event.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaymentTerminalPorts } from "../../application/ports/payment-terminal-ports.js";
import type { PaymentIntentTransactionRunner } from "./payment-intent-creation-store.js";
import { createPostgresPaymentTerminalSource } from "./payment-terminal-source.js";

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
function fail(
  code: PaymentTerminalError["code"] = "PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE",
): never {
  throw new PaymentTerminalError(code);
}
function rows(value: unknown): unknown[] {
  const result: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")?.value
      : undefined;
  if (!Array.isArray(result) || result.length > 1) return fail();
  return result;
}
function count(value: unknown): number {
  const result: unknown =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rowCount")?.value
      : undefined;
  if (result !== 1) return fail();
  return result;
}
function observationOf(fact: PaymentTerminalFact) {
  return parsePaymentTerminalObservation({
    observationReference: fact.observationReference,
    causationReference: fact.causationReference,
    webhookReceiptReference: fact.webhookReceiptReference,
    providerEventReference: fact.providerEventReference,
    providerAccountReference: fact.providerAccountReference,
    providerIntentReference: fact.providerIntentReference,
    environment: fact.environment,
    paymentIntentReference: fact.paymentIntentReference,
    paymentAttemptReference: fact.paymentAttemptReference,
    brandReference: fact.brandReference,
    storeReference: fact.storeReference,
    source: fact.source,
    status: fact.outcome === "Succeeded" ? "Captured" : "Failed",
    amount: fact.amount,
    failureReason: fact.failureReason,
    retryDisposition: fact.retryDisposition,
    occurredAt: fact.occurredAt,
    evidenceDigest: fact.evidenceDigest,
  });
}
function parseFact(value: unknown): PaymentTerminalFact {
  const raw = exactPaymentObject(value, [
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "brandReference",
    "storeReference",
    "causationReference",
    "webhookReceiptReference",
    "providerEventReference",
    "providerAccountReference",
    "providerIntentReference",
    "environment",
    "observationReference",
    "source",
    "outcome",
    "amount",
    "failureReason",
    "retryDisposition",
    "occurredAt",
    "recordedAt",
    "evidenceDigest",
    "event",
  ]);
  if (raw.outcome !== "Succeeded" && raw.outcome !== "Failed")
    return fail("PAYMENT_TERMINAL_INPUT_INVALID");
  const observation = observationOf(raw as unknown as PaymentTerminalFact);
  const { status, ...observed } = observation;
  const event = parsePaymentTerminalEnvelope(raw.event);
  const fact: PaymentTerminalFact = Object.freeze({
    ...observed,
    paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
    orderReference: parsePaymentReference(raw.orderReference),
    outcome: status === "Captured" ? "Succeeded" : "Failed",
    recordedAt: parsePaymentInstant(raw.recordedAt),
    event,
  });
  if (
    fact.recordedAt < fact.occurredAt ||
    canonical(
      createPaymentTerminalEnvelope({
        eventReference: event.eventId,
        correlationReference: event.correlationId,
        fact,
      }),
    ) !== canonical(event)
  )
    return fail("PAYMENT_TERMINAL_INPUT_INVALID");
  return fact;
}

const selectFact = `SELECT to_jsonb(f) || jsonb_build_object(
 'amount_minor',f.amount_minor::text,
 'occurred_at',to_char(f.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'recorded_at',to_char(f.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'operation',i.payment_operation_id) AS fact,
 (f.occurred_at=date_trunc('milliseconds',f.occurred_at) AND
  f.recorded_at=date_trunc('milliseconds',f.recorded_at) AND f.order_id=i.order_id) AS coherent
 FROM rms_payment.payment_terminal_fact f
 JOIN rms_payment.payment_intent i ON i.payment_intent_id=f.payment_intent_id
 AND i.brand_id=f.brand_id AND i.store_id=f.store_id
 WHERE f.brand_id=$1 AND f.store_id=$2 AND f.payment_intent_id=$3
 AND f.payment_attempt_id=COALESCE($4::uuid,(SELECT a.payment_attempt_id FROM rms_payment.payment_attempt a
  WHERE a.brand_id=$1 AND a.store_id=$2 AND a.payment_intent_id=$3
  ORDER BY a.attempt_number DESC LIMIT 1))`;

export function createPostgresPaymentTerminalStore(
  runner: PaymentIntentTransactionRunner,
  scopeInput: unknown,
  occurrence?: Parameters<typeof createPostgresPaymentTerminalSource>[2],
) {
  const scope = exactPaymentObject(scopeInput, [
    "brandReference",
    "storeReference",
    "providerAccountReference",
    "environment",
  ]);
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference);
  const account = parsePaymentReference(scope.providerAccountReference);
  if (scope.environment !== "Test" && scope.environment !== "Live")
    return fail("PAYMENT_TERMINAL_INPUT_INVALID");
  const context = (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const scoped = (fact: PaymentTerminalFact) => {
    if (
      fact.brandReference !== brand ||
      fact.storeReference !== store ||
      fact.providerAccountReference !== account ||
      fact.environment !== scope.environment
    )
      return fail("PAYMENT_TERMINAL_SCOPE_MISMATCH");
    return fact;
  };
  /** The terminal fact of the intent's latest attempt (or of `attempt`); null while it is open. */
  const read = async (tx: AuditTransaction, intent: string, attempt: string | null = null) => {
    const found = rows(await tx.query(selectFact, [brand, store, intent, attempt]));
    if (found.length === 0) return null;
    const row = exactPaymentObject(found[0], ["fact", "coherent"]);
    if (row.coherent !== true || row.fact === null || typeof row.fact !== "object") return fail();
    const r = row.fact as Record<string, unknown>;
    if (
      r.amount_minor !== null &&
      (typeof r.amount_minor !== "string" || !/^[1-9][0-9]{0,18}$/u.test(r.amount_minor))
    )
      return fail();
    const base = {
      paymentTransactionReference: r.payment_transaction_id,
      paymentIntentReference: r.payment_intent_id,
      paymentAttemptReference: r.payment_attempt_id,
      orderReference: r.order_id,
      brandReference: r.brand_id,
      storeReference: r.store_id,
      causationReference: r.causation_id,
      webhookReceiptReference: r.webhook_receipt_id,
      providerEventReference: r.provider_event_id,
      providerAccountReference: r.provider_account_id,
      providerIntentReference: r.provider_intent_reference,
      environment: r.provider_environment,
      observationReference: r.provider_observation_id,
      source: r.authoritative_source,
      outcome: r.terminal_outcome,
      amount:
        r.amount_minor === null
          ? null
          : { amountMinor: BigInt(r.amount_minor as string), currencyCode: r.currency_code },
      failureReason: r.failure_reason,
      retryDisposition: r.retry_disposition,
      occurredAt: r.occurred_at,
      recordedAt: r.recorded_at,
      evidenceDigest: r.evidence_digest,
    };
    const fact = scoped(
      parseFact({
        ...base,
        event: createPaymentTerminalEnvelope({
          eventReference: r.event_id,
          correlationReference: r.operation,
          fact: base as Omit<PaymentTerminalFact, "event">,
        }),
      }),
    );
    if (
      fact.paymentIntentReference !== intent ||
      (attempt !== null && fact.paymentAttemptReference !== attempt)
    )
      return fail();
    return fact;
  };
  /** An intent is paid at most once: another attempt's success conflicts with a new success. */
  const succeeded = async (tx: AuditTransaction, intent: string) => {
    const found = rows(
      await tx.query(
        "SELECT payment_attempt_id::text AS attempt FROM rms_payment.payment_terminal_fact WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 AND terminal_outcome='Succeeded'",
        [brand, store, intent],
      ),
    );
    if (found.length === 0) return null;
    const attempt = exactPaymentObject(found[0], ["attempt"]).attempt;
    return read(tx, intent, parsePaymentReference(attempt));
  };
  const safe = async <T>(action: () => Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PaymentTerminalError) throw error;
      return fail();
    }
  };
  return Object.freeze({
    /**
     * The terminal outcome of the intent's latest attempt; null while that attempt is open
     * (WP-2423 Q20: a retry after a decline is a later attempt of the same intent).
     * Caller must establish current Guest/Actor permission before exposing any result.
     */
    read(paymentIntentReference: unknown) {
      return safe(() =>
        runner.run(async (tx) => {
          const intent = parsePaymentReference(paymentIntentReference);
          await context(tx);
          return read(tx, intent);
        }),
      );
    },
    commit(input: Parameters<PaymentTerminalPorts["repository"]["commit"]>[0]) {
      return safe(() =>
        runner.run(async (tx) => {
          const request = exactPaymentObject(input, ["fact", "audit", "event"]);
          const fact = scoped(parseFact(request.fact));
          const event = parsePaymentTerminalEnvelope(request.event);
          if (canonical(event) !== canonical(fact.event))
            return fail("PAYMENT_TERMINAL_INPUT_INVALID");
          const audit = validateAuditRecord(request.audit as never, Date.parse(fact.recordedAt));
          if (
            audit.brandId !== brand ||
            audit.storeId !== store ||
            audit.actor.type !== "System" ||
            audit.actionCode !== "PAYMENT_TERMINAL_RECORDED" ||
            audit.targetType !== "PaymentIntent" ||
            audit.targetId !== fact.paymentIntentReference ||
            audit.correlationId !== event.correlationId ||
            audit.reasonCode !==
              (fact.outcome === "Succeeded" ? "PAYMENT_CAPTURED" : "PAYMENT_FAILED") ||
            audit.occurredAt !== fact.recordedAt ||
            audit.dataClassification !== "Restricted" ||
            audit.retentionPolicyCode !== "FINANCIAL_COMPLIANCE" ||
            audit.retentionPolicyVersion !== 1 ||
            audit.beforeSummary !== undefined ||
            canonical(audit.afterSummary) !== canonical({ outcome: fact.outcome }) ||
            audit.sourceChannel !==
              (fact.source === "VerifiedWebhook" ? "PROVIDER_WEBHOOK" : "PAYMENT_RECONCILIATION")
          )
            return fail("PAYMENT_TERMINAL_INPUT_INVALID");
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "PaymentTerminal:" + brand + ":" + store + ":" + fact.paymentIntentReference,
          ]);
          const source = await createPostgresPaymentTerminalSource(
            { run: async (action) => action(tx) },
            scope,
            occurrence,
          ).resolve(observationOf(fact));
          if (source === null) return fail("PAYMENT_TERMINAL_SOURCE_NOT_FOUND");
          if (
            source.orderReference !== fact.orderReference ||
            source.paymentOperationReference !== event.correlationId
          )
            return fail("PAYMENT_TERMINAL_SCOPE_MISMATCH");
          const existing =
            (await read(tx, fact.paymentIntentReference, fact.paymentAttemptReference)) ??
            (fact.outcome === "Succeeded"
              ? await succeeded(tx, fact.paymentIntentReference)
              : null);
          if (existing !== null) {
            const same =
              canonical(observationOf(existing)) === canonical(observationOf(fact)) &&
              existing.orderReference === fact.orderReference;
            return Object.freeze({
              status: same ? ("AlreadyCommitted" as const) : ("Conflict" as const),
              fact: existing,
            });
          }
          count(
            await tx.query(
              `INSERT INTO rms_payment.payment_terminal_fact (
          payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,
          webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,
          provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,
          failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
              [
                fact.paymentTransactionReference,
                brand,
                store,
                fact.paymentIntentReference,
                fact.paymentAttemptReference,
                fact.orderReference,
                fact.webhookReceiptReference,
                fact.providerEventReference,
                account,
                fact.environment,
                fact.providerIntentReference,
                fact.observationReference,
                fact.source,
                fact.outcome,
                fact.amount?.amountMinor.toString() ?? null,
                fact.amount?.currencyCode ?? null,
                fact.failureReason,
                fact.retryDisposition,
                fact.occurredAt,
                fact.recordedAt,
                fact.evidenceDigest,
                event.eventId,
                fact.causationReference,
              ],
            ),
          );
          await appendAuditRecordInTransaction(tx, audit);
          await appendEventInTransaction(
            { query: async (sql, values) => ({ rowCount: count(await tx.query(sql, values)) }) },
            event,
          );
          const saved = await read(tx, fact.paymentIntentReference, fact.paymentAttemptReference);
          if (saved === null || canonical(saved) !== canonical(fact)) return fail();
          return Object.freeze({ status: "Created" as const, fact: saved });
        }),
      );
    },
  });
}

export interface OrderPaymentTerminalOutcome {
  readonly paymentIntentReference: string;
  readonly outcome: "Succeeded" | "Failed";
  readonly amount: { readonly amountMinor: bigint; readonly currencyCode: string } | null;
  readonly occurredAt: string;
  /** The order batch (dine-in round) this payment is for. */
  readonly orderBatchReference: string;
  /** WP-2423: the tip the guest chose for this payment (part of `amount`); null unless Succeeded. */
  readonly tip: { readonly amountMinor: bigint; readonly currencyCode: string } | null;
}

/**
 * WP-2423 Q10: the Payment owner's own terminal facts for one Order (the same facts the payment
 * result page reads). The customer status projection is updated asynchronously and may lag behind
 * them; a reader uses these so the order page never says "pending" for a payment the result page
 * already confirmed. Caller must authorize the Order in the same transaction first.
 */
export async function listOrderPaymentTerminalOutcomes(
  transaction: { query(text: string, values: readonly unknown[]): Promise<unknown> },
  scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  },
  orderReference: string,
): Promise<readonly OrderPaymentTerminalOutcome[]> {
  try {
    const brand = parsePaymentReference(scope.brandReference),
      store = parsePaymentReference(scope.storeReference),
      account = parsePaymentReference(scope.providerAccountReference),
      order = parsePaymentReference(orderReference);
    if (scope.environment !== "Test" && scope.environment !== "Live") return fail();
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brand, store],
    );
    const result: unknown = await transaction.query(
      "SELECT latest.payment_intent_id::text AS payment_intent_id,latest.terminal_outcome,latest.amount_minor::text AS amount_minor,latest.currency_code," +
        "to_char(latest.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS occurred_at," +
        // WP-2423: the round and the tip frozen on the intent, so a page shows what was paid.
        "i.order_batch_id::text AS order_batch_id,i.tip_minor::text AS tip_minor,i.currency_code AS intent_currency_code " +
        "FROM (SELECT DISTINCT ON (payment_intent_id) * FROM rms_payment.payment_terminal_fact " +
        "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND provider_account_id=$4 AND provider_environment=$5 " +
        // WP-2423 Q20: a retry after a decline is a later outcome of the same intent.
        "ORDER BY payment_intent_id,occurred_at DESC,recorded_at DESC) latest " +
        "JOIN rms_payment.payment_intent i ON i.brand_id=latest.brand_id AND i.store_id=latest.store_id " +
        "AND i.payment_intent_id=latest.payment_intent_id AND i.order_id=latest.order_id " +
        "ORDER BY latest.occurred_at,latest.payment_intent_id LIMIT 101",
      [brand, store, order, account, scope.environment],
    );
    const found: unknown =
      result !== null && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rows")?.value
        : undefined;
    if (!Array.isArray(found) || found.length > 100) return fail();
    return Object.freeze(
      found.map((value: unknown) => {
        const row = exactPaymentObject(value, [
          "payment_intent_id",
          "terminal_outcome",
          "amount_minor",
          "currency_code",
          "occurred_at",
          "order_batch_id",
          "tip_minor",
          "intent_currency_code",
        ]);
        const outcome = row.terminal_outcome;
        if (outcome !== "Succeeded" && outcome !== "Failed") return fail();
        const amount =
          outcome === "Succeeded"
            ? typeof row.amount_minor === "string" &&
              /^[1-9][0-9]{0,18}$/u.test(row.amount_minor) &&
              row.currency_code === "CAD"
              ? Object.freeze({ amountMinor: BigInt(row.amount_minor), currencyCode: "CAD" })
              : fail()
            : row.amount_minor === null && row.currency_code === null
              ? null
              : fail();
        const tip =
          amount === null
            ? null
            : typeof row.tip_minor === "string" &&
                /^(?:0|[1-9][0-9]{0,18})$/u.test(row.tip_minor) &&
                row.intent_currency_code === amount.currencyCode &&
                BigInt(row.tip_minor) <= amount.amountMinor
              ? Object.freeze({ amountMinor: BigInt(row.tip_minor), currencyCode: "CAD" })
              : fail();
        return Object.freeze({
          paymentIntentReference: String(parsePaymentReference(row.payment_intent_id)),
          outcome,
          amount,
          occurredAt: String(parsePaymentInstant(row.occurred_at)),
          orderBatchReference: String(parsePaymentReference(row.order_batch_id)),
          tip,
        });
      }),
    );
  } catch (error) {
    if (error instanceof PaymentTerminalError) throw error;
    return fail();
  }
}
