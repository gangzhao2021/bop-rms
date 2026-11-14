import type { AuditTransaction } from "@bop/audit";
import {
  createPaymentWebhookInboxRecord,
  parsePaymentWebhookInboxRecord,
  parsePaymentWebhookProcessingCompletion,
  paymentWebhookInboxConsumer,
  PaymentWebhookInboxError,
  type PaymentWebhookInboxRecord,
  type PaymentWebhookProcessingCompletion,
} from "../../application/payment-webhook-inbox.js";
import {
  parseWebhookDigest,
  parseWebhookInstant,
} from "../../application/provider-webhook-verification.js";
import { exactPaymentObject } from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaymentWebhookInboxPorts } from "../../application/ports/payment-webhook-inbox-ports.js";
import type { PaymentIntentTransactionRunner } from "./payment-intent-creation-store.js";

const fail = (): never => {
  throw new PaymentWebhookInboxError("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
};
function rowsOf(result: unknown): readonly unknown[] {
  const rows: unknown =
    result !== null && typeof result === "object"
      ? Object.getOwnPropertyDescriptor(result, "rows")?.value
      : undefined;
  if (!Array.isArray(rows)) return fail();
  return rows;
}
/**
 * The inbox tables carry append-only rules, so `INSERT … ON CONFLICT` is not available. A
 * concurrent first insert of the same identity surfaces as a unique violation, rolled back to a
 * savepoint so the transaction can read the winner instead.
 */
async function insertOnce(
  tx: AuditTransaction,
  sql: string,
  values: readonly unknown[],
): Promise<boolean> {
  await tx.query("SAVEPOINT payment_webhook_insert", []);
  try {
    await tx.query(sql, values);
  } catch (error) {
    const code =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
    if (code !== "23505") throw error;
    await tx.query("ROLLBACK TO SAVEPOINT payment_webhook_insert", []);
    return false;
  }
  await tx.query("RELEASE SAVEPOINT payment_webhook_insert", []);
  return true;
}
const iso = (value: unknown) => {
  if (value instanceof Date) return parseWebhookInstant(value.toISOString());
  return parseWebhookInstant(value);
};
const receiptColumns = `webhook_receipt_id AS "webhookReceiptReference",provider,
 provider_environment AS "environment",provider_account_id AS "providerAccountReference",
 brand_id AS "brandReference",store_id AS "storeReference",provider_event_id AS "providerEventReference",
 provider_event_type AS "providerEventType",provider_created_at AS "providerCreatedAt",
 received_at AS "receivedAt",signature_timestamp AS "signatureTimestamp",evidence_digest AS "evidenceDigest",
 accepted_at AS "acceptedAt",raw_evidence_expires_at AS "rawEvidenceExpiresAt",
 dedupe_expires_at AS "dedupeExpiresAt"`;
function receiptFromRow(row: unknown, rawEvidence: Uint8Array): PaymentWebhookInboxRecord {
  const raw = exactPaymentObject(row, [
    "webhookReceiptReference",
    "provider",
    "environment",
    "providerAccountReference",
    "brandReference",
    "storeReference",
    "providerEventReference",
    "providerEventType",
    "providerCreatedAt",
    "receivedAt",
    "signatureTimestamp",
    "evidenceDigest",
    "acceptedAt",
    "rawEvidenceExpiresAt",
    "dedupeExpiresAt",
  ]);
  return createPaymentWebhookInboxRecord({
    webhookReceiptReference: parsePaymentReference(raw.webhookReceiptReference),
    provider: raw.provider as "Stripe",
    environment: raw.environment as "Test" | "Live",
    providerAccountReference: parsePaymentReference(raw.providerAccountReference),
    brandReference: parsePaymentReference(raw.brandReference),
    storeReference: parsePaymentReference(raw.storeReference),
    providerEventReference: raw.providerEventReference as never,
    providerEventType: raw.providerEventType as never,
    providerCreatedAt: iso(raw.providerCreatedAt),
    receivedAt: iso(raw.receivedAt),
    signatureTimestamp: iso(raw.signatureTimestamp),
    evidenceDigest: parseWebhookDigest(raw.evidenceDigest),
    acceptedAt: iso(raw.acceptedAt),
    rawEvidenceExpiresAt: iso(raw.rawEvidenceExpiresAt),
    dedupeExpiresAt: iso(raw.dedupeExpiresAt),
    rawEvidence,
  });
}

/**
 * DEC-STRIPE-PILOT-WIRING: the Payment Webhook Inbox over `rms_payment.provider_webhook_*`
 * (WP-1304 tables). Acceptance is one atomic receipt + Restricted raw evidence, deduplicated on
 * Provider/environment/account/Event. Processing runs the mapper (whose own writes are
 * idempotent Payment owner operations) and then appends exactly one completion marker; a failed
 * mapper leaves the receipt unprocessed so the Provider's redelivery processes it again.
 */
export function createPostgresPaymentWebhookInboxStore(
  runner: PaymentIntentTransactionRunner,
  scopeInput: unknown,
  options: { now(): string },
): PaymentWebhookInboxPorts["repository"] {
  const scope = exactPaymentObject(scopeInput, ["brandReference", "storeReference"]);
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference);
  const bind = (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  async function readReceipt(tx: AuditTransaction, reference: string) {
    const rows = rowsOf(
      await tx.query(
        `SELECT ${receiptColumns} FROM rms_payment.provider_webhook_record
         WHERE brand_id=$1 AND store_id=$2 AND webhook_receipt_id=$3`,
        [brand, store, reference],
      ),
    );
    if (rows.length > 1) return fail();
    return rows[0] ?? null;
  }
  return Object.freeze({
    async accept({ record: value }) {
      try {
        const proposed = parsePaymentWebhookInboxRecord(value);
        if (proposed.brandReference !== brand || proposed.storeReference !== store) return fail();
        return await runner.run(async (tx) => {
          await bind(tx);
          const inserted = await insertOnce(
            tx,
            `INSERT INTO rms_payment.provider_webhook_record
               (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,
                provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,
                evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at)
               VALUES ($1,$2,$3,'Stripe',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              proposed.webhookReceiptReference,
              brand,
              store,
              proposed.environment,
              proposed.providerAccountReference,
              proposed.providerEventReference,
              proposed.providerEventType,
              proposed.providerCreatedAt,
              proposed.receivedAt,
              proposed.signatureTimestamp,
              proposed.evidenceDigest,
              proposed.acceptedAt,
              proposed.rawEvidenceExpiresAt,
              proposed.dedupeExpiresAt,
            ],
          );
          if (inserted) {
            const bytes = proposed.copyRawEvidence();
            try {
              await tx.query(
                `INSERT INTO rms_payment.provider_webhook_raw_evidence
                 (webhook_receipt_id,brand_id,store_id,evidence_digest,raw_evidence,expires_at)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                  proposed.webhookReceiptReference,
                  brand,
                  store,
                  proposed.evidenceDigest,
                  Buffer.from(bytes),
                  proposed.rawEvidenceExpiresAt,
                ],
              );
            } finally {
              bytes.fill(0);
            }
            return Object.freeze({ status: "Accepted" as const, record: proposed });
          }
          const rows = rowsOf(
            await tx.query(
              `SELECT ${receiptColumns} FROM rms_payment.provider_webhook_record
               WHERE brand_id=$1 AND store_id=$2 AND provider='Stripe' AND provider_environment=$3
                 AND provider_account_id=$4 AND provider_event_id=$5`,
              [
                brand,
                store,
                proposed.environment,
                proposed.providerAccountReference,
                proposed.providerEventReference,
              ],
            ),
          );
          if (rows.length !== 1) return fail();
          // The stored receipt keeps its own identity and digest; the service compares them with
          // the proposal. Its raw bytes are not re-read: a matching digest proves the same bytes.
          const bytes = proposed.copyRawEvidence();
          try {
            const existing = receiptFromRow(rows[0], bytes);
            return Object.freeze({
              status:
                existing.evidenceDigest === proposed.evidenceDigest
                  ? ("Duplicate" as const)
                  : ("Conflict" as const),
              record: existing,
            });
          } finally {
            bytes.fill(0);
          }
        });
      } catch (error) {
        if (error instanceof PaymentWebhookInboxError) throw error;
        return fail();
      }
    },
    async process({ webhookReceiptReference, consumerName, requestedAt, handler }) {
      try {
        const reference = parsePaymentReference(webhookReceiptReference);
        if (consumerName !== paymentWebhookInboxConsumer) return fail();
        parseWebhookInstant(requestedAt);
        const completed = async (tx: AuditTransaction) => {
          const rows = rowsOf(
            await tx.query(
              `SELECT webhook_receipt_id AS "webhookReceiptReference",consumer_name AS "consumerName",
               processed_at AS "processedAt",result_digest AS "resultDigest"
               FROM rms_payment.provider_webhook_processing_record
               WHERE brand_id=$1 AND store_id=$2 AND webhook_receipt_id=$3 AND consumer_name=$4`,
              [brand, store, reference, consumerName],
            ),
          );
          if (rows.length === 0) return null;
          const row = exactPaymentObject(rows[0], [
            "webhookReceiptReference",
            "consumerName",
            "processedAt",
            "resultDigest",
          ]);
          return parsePaymentWebhookProcessingCompletion({
            ...row,
            processedAt: iso(row.processedAt),
          });
        };
        const loaded = await runner.run(async (tx) => {
          await bind(tx);
          const done = await completed(tx);
          if (done !== null) return { kind: "Completed" as const, completion: done };
          const row = await readReceipt(tx, reference);
          if (row === null) return { kind: "NotFound" as const };
          const raw = rowsOf(
            await tx.query(
              `SELECT raw_evidence AS "rawEvidence" FROM rms_payment.provider_webhook_raw_evidence
               WHERE brand_id=$1 AND store_id=$2 AND webhook_receipt_id=$3 AND expires_at>$4`,
              [brand, store, reference, options.now()],
            ),
          );
          if (raw.length !== 1) return fail();
          const bytes = exactPaymentObject(raw[0], ["rawEvidence"]).rawEvidence;
          if (!(bytes instanceof Uint8Array)) return fail();
          return { kind: "Pending" as const, record: receiptFromRow(row, bytes) };
        });
        if (loaded.kind === "NotFound") return Object.freeze({ status: "NotFound" as const });
        if (loaded.kind === "Completed")
          return Object.freeze({
            status: "AlreadyCompleted" as const,
            completion: loaded.completion,
          });
        const resultDigest = parseWebhookDigest(await handler(loaded.record));
        return await runner.run(async (tx) => {
          await bind(tx);
          const processedAt = iso(options.now());
          const inserted = await insertOnce(
            tx,
            `INSERT INTO rms_payment.provider_webhook_processing_record
               (webhook_receipt_id,brand_id,store_id,consumer_name,processed_at,result_digest)
               VALUES ($1,$2,$3,$4,$5,$6)`,
            [reference, brand, store, consumerName, processedAt, resultDigest],
          );
          if (inserted)
            return Object.freeze({
              status: "Completed" as const,
              completion: parsePaymentWebhookProcessingCompletion({
                webhookReceiptReference: reference,
                consumerName,
                processedAt,
                resultDigest,
              }) satisfies PaymentWebhookProcessingCompletion,
            });
          // A concurrent delivery completed the same receipt first; its idempotent effect stands.
          const done = await completed(tx);
          if (done === null) return fail();
          return Object.freeze({ status: "AlreadyCompleted" as const, completion: done });
        });
      } catch (error) {
        if (error instanceof PaymentWebhookInboxError) throw error;
        return fail();
      }
    },
  });
}

/** DEC-STRIPE-PILOT-WIRING: Restricted raw webhook bytes are kept 30 days (WP-1304 schema). */
export const paymentWebhookRawEvidenceRetention = Object.freeze({
  retentionDays: 30,
  maximumBatch: 500,
});

/**
 * Deletes one bounded batch of this Store's raw webhook evidence whose 30-day retention has
 * ended. Only the raw bytes go: the receipt (event identity, evidence digest, times) and its
 * processing record stay append-only, and the database itself refuses any deletion before
 * `expires_at` (`provider_webhook_raw_evidence_no_early_delete`). Idempotent; returns how many
 * were removed so the caller continues while a full batch was due.
 */
export async function purgeExpiredPaymentWebhookRawEvidence(
  transaction: AuditTransaction,
  scopeInput: unknown,
  input: { readonly observedAt: string; readonly limit: number },
): Promise<{ readonly purged: number }> {
  const scope = exactPaymentObject(scopeInput, ["brandReference", "storeReference"]);
  const brand = parsePaymentReference(scope.brandReference),
    store = parsePaymentReference(scope.storeReference),
    observedAt = parseWebhookInstant(input.observedAt);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > paymentWebhookRawEvidenceRetention.maximumBatch
  )
    return fail();
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  // Due by both clocks: the application's observation and the database's own rule time.
  const due = rowsOf(
    await transaction.query(
      `SELECT webhook_receipt_id::text AS "webhookReceiptReference"
         FROM rms_payment.provider_webhook_raw_evidence
        WHERE brand_id=$1 AND store_id=$2 AND expires_at<=$3::timestamptz
          AND expires_at<=CURRENT_TIMESTAMP
        ORDER BY expires_at,webhook_receipt_id LIMIT $4::int`,
      [brand, store, observedAt, input.limit],
    ),
  ).map((row) =>
    String(
      parsePaymentReference(
        exactPaymentObject(row, ["webhookReceiptReference"]).webhookReceiptReference,
      ),
    ),
  );
  if (due.length === 0) return Object.freeze({ purged: 0 });
  await transaction.query(
    `DELETE FROM rms_payment.provider_webhook_raw_evidence
      WHERE brand_id=$1 AND store_id=$2 AND webhook_receipt_id=ANY($3::uuid[])
        AND expires_at<=$4::timestamptz AND expires_at<=CURRENT_TIMESTAMP`,
    [brand, store, due, observedAt],
  );
  // The append-only rule turns a refused deletion into a silent no-op: confirm none remain.
  const remaining = rowsOf(
    await transaction.query(
      `SELECT count(*)::int AS remaining FROM rms_payment.provider_webhook_raw_evidence
        WHERE brand_id=$1 AND store_id=$2 AND webhook_receipt_id=ANY($3::uuid[])`,
      [brand, store, due],
    ),
  );
  const left = exactPaymentObject(remaining[0], ["remaining"]).remaining;
  if (left !== 0) return fail();
  return Object.freeze({ purged: due.length });
}
