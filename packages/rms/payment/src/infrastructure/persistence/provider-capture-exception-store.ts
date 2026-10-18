import type { ConsumerTransaction } from "@bop/eventing";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import {
  parseProviderCaptureReconciliationEvidence,
  type ProviderCaptureReconciliationEvidence,
} from "../../application/provider-capture-reconciliation.js";
import { PaymentReconciliationError } from "../../application/payment-reconciliation.js";
import { createPostgresPaymentIntentCreationStore } from "./payment-intent-creation-store.js";
const fail = (
  code: PaymentReconciliationError["code"] = "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new PaymentReconciliationError(code);
};
const columns = {
  brandReference: "brand_id",
  storeReference: "store_id",
  providerAccountReference: "provider_account_id",
  environment: "environment",
  providerIntentReference: "provider_intent_reference",
  providerTransactionReference: "provider_transaction_reference",
  paymentOperationReference: "original_operation_id",
  paymentAttemptReference: "original_attempt_id",
  amountMinor: "amount_minor",
  currencyCode: "currency_code",
  occurredAt: "occurred_at",
  observedAt: "observed_at",
  evidenceDigest: "evidence_digest",
};
const selection = Object.entries(columns)
  .map(([key, column]) => column + (key === "amountMinor" ? "::text" : "") + ' AS "' + key + '"')
  .join(",");
/** Caller must retain one transaction through owner re-read, inserts and Audit. */
export function createPostgresProviderCaptureExceptionStore(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  providerAccountReference: string;
  environment: "Test" | "Live";
  authorize(
    tx: ConsumerTransaction,
    input: { purpose: "ReconcilePayments"; evidence: ProviderCaptureReconciliationEvidence },
  ): Promise<boolean>;
  verifyEvidence(
    tx: ConsumerTransaction,
    evidence: ProviderCaptureReconciliationEvidence,
  ): Promise<boolean>;
  audit(input: {
    candidateReference: string;
    exceptionReference: string;
    evidence: ProviderCaptureReconciliationEvidence;
  }): Promise<unknown>;
}) {
  const tenant = parsePaymentReference(options.scope.tenantReference),
    brand = parsePaymentReference(options.scope.brandReference),
    store = parsePaymentReference(options.scope.storeReference),
    account = parsePaymentReference(options.providerAccountReference);
  if (options.environment !== "Test" && options.environment !== "Live") return fail();
  return Object.freeze({
    async record(tx: ConsumerTransaction, value: unknown) {
      try {
        const raw = exactPaymentObject(value, [
            "candidateReference",
            "exceptionReference",
            "evidence",
          ]),
          candidate = parsePaymentReference(raw.candidateReference),
          exception = parsePaymentReference(raw.exceptionReference),
          evidence = parseProviderCaptureReconciliationEvidence(raw.evidence);
        if (
          evidence.brandReference !== brand ||
          evidence.storeReference !== store ||
          evidence.providerAccountReference !== account ||
          evidence.environment !== options.environment
        )
          return fail("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
        const authorize = async () => {
          if ((await options.authorize(tx, { purpose: "ReconcilePayments", evidence })) !== true)
            return fail("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
        };
        await authorize();
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store],
        );
        for (const key of [
          "ProviderCapture:" +
            brand +
            ":" +
            store +
            ":" +
            account +
            ":" +
            options.environment +
            ":" +
            evidence.providerTransactionReference,
          "PaymentIntent:" + brand + ":" + store + ":" + evidence.paymentOperationReference,
        ])
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
        if ((await options.verifyEvidence(tx, evidence)) !== true) return fail();
        await authorize();
        const existing = await tx.query(
          "SELECT candidate_id AS candidate,reconciliation_exception_id AS exception,tenant_id AS tenant," +
            selection +
            " FROM rms_payment.provider_capture_exception_evidence WHERE brand_id=$1 AND store_id=$2 AND provider_account_id=$3 AND environment=$4 AND provider_transaction_reference=$5",
          [brand, store, account, options.environment, evidence.providerTransactionReference],
        );
        if (existing.rows.length > 1) return fail();
        const operation = await createPostgresPaymentIntentCreationStore(
          { run: async (work) => work(tx) },
          { brandReference: brand, storeReference: store },
          { now: () => evidence.observedAt, generateObservationReference: () => fail() },
        ).resolveOperation(evidence.paymentOperationReference);
        await authorize();
        const prior = existing.rows[0];
        if (prior) {
          const {
            candidate: priorCandidate,
            exception: priorException,
            tenant: priorTenant,
            amountMinor,
            currencyCode,
            occurredAt,
            observedAt,
            ...rest
          } = prior;
          if (
            typeof amountMinor !== "string" ||
            !/^[1-9][0-9]*$/.test(amountMinor) ||
            !(occurredAt instanceof Date) ||
            !(observedAt instanceof Date)
          )
            return fail();
          const parsed = parseProviderCaptureReconciliationEvidence({
            ...rest,
            amount: { amountMinor: BigInt(amountMinor), currencyCode },
            occurredAt: occurredAt.toISOString(),
            observedAt: observedAt.toISOString(),
          });
          if (
            priorCandidate !== candidate ||
            priorException !== exception ||
            priorTenant !== tenant ||
            parsed.observedAt > evidence.observedAt ||
            Object.keys(parsed).some(
              (key) =>
                key !== "observedAt" &&
                key !== "amount" &&
                parsed[key as keyof typeof parsed] !== evidence[key as keyof typeof evidence],
            ) ||
            parsed.amount.amountMinor !== evidence.amount.amountMinor
          )
            return fail("PAYMENT_RECONCILIATION_RUN_CONFLICT");
          return Object.freeze({
            status: "AlreadyRecorded" as const,
            candidateReference: candidate,
            exceptionReference: exception,
          });
        }
        if (operation)
          return Object.freeze({
            status: "OperationPresent" as const,
            paymentIntentReference: operation.intent.paymentIntentReference,
          });
        const audit = validateAuditRecord(
          (await options.audit({
            candidateReference: candidate,
            exceptionReference: exception,
            evidence,
          })) as never,
          Date.parse(evidence.observedAt),
        );
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "PAYMENT_PROVIDER_CAPTURE_UNMATCHED" ||
          audit.targetType !== "PaymentReconciliationException" ||
          audit.targetId !== exception ||
          audit.correlationId !== candidate ||
          audit.occurredAt !== evidence.observedAt ||
          audit.reasonCode !== "PROVIDER_CAPTURE_WITHOUT_INTERNAL_OPERATION" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return fail("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
        await authorize();
        const exceptionResult = await tx.query(
          "INSERT INTO rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at) VALUES($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)",
          [exception, brand, store, candidate, evidence.observedAt],
        );
        if (exceptionResult.rowCount !== 1) return fail();
        const result = await tx.query(
          "INSERT INTO rms_payment.provider_capture_exception_evidence (candidate_id,reconciliation_exception_id,tenant_id,brand_id,store_id,provider_account_id,environment,provider_intent_reference,provider_transaction_reference,original_operation_id,original_attempt_id,amount_minor,currency_code,occurred_at,observed_at,evidence_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
          [
            candidate,
            exception,
            tenant,
            brand,
            store,
            account,
            evidence.environment,
            evidence.providerIntentReference,
            evidence.providerTransactionReference,
            evidence.paymentOperationReference,
            evidence.paymentAttemptReference,
            evidence.amount.amountMinor.toString(),
            "CAD",
            evidence.occurredAt,
            evidence.observedAt,
            evidence.evidenceDigest,
          ],
        );
        if (result.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(tx, audit);
        await authorize();
        return Object.freeze({
          status: "Created" as const,
          candidateReference: candidate,
          exceptionReference: exception,
        });
      } catch (error) {
        if (error instanceof PaymentReconciliationError) throw error;
        return fail();
      }
    },
  });
}

/** Restricted operator summary of immutable discovery evidence, not current financial finality. */
export function createPostgresProviderCaptureEvidenceQuery(options: {
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    input: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      exceptionReference: string;
      purpose: "ReadPaymentReconciliationEvidence";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    tenantReference: parsePaymentReference(options.scope.tenantReference),
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
  });
  return async (tx: ConsumerTransaction, value: unknown) => {
    try {
      const exceptionReference = parsePaymentReference(value);
      const authorize = async () => {
        if (
          (await options.authorize(tx, {
            ...scope,
            exceptionReference,
            purpose: "ReadPaymentReconciliationEvidence",
          })) !== true
        )
          return fail("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [scope.tenantReference, scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        "SELECT tenant_id,brand_id,store_id,reconciliation_exception_id,amount_minor::text AS amount_minor,currency_code,environment,occurred_at,observed_at FROM rms_payment.provider_capture_exception_evidence WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND reconciliation_exception_id=$4 LIMIT 2",
        [scope.tenantReference, scope.brandReference, scope.storeReference, exceptionReference],
      );
      if (!Array.isArray(result.rows) || result.rows.length > 1) return fail();
      await authorize();
      if (result.rows.length === 0) return null;
      const row = exactPaymentObject(result.rows[0], [
        "tenant_id",
        "brand_id",
        "store_id",
        "reconciliation_exception_id",
        "amount_minor",
        "currency_code",
        "environment",
        "occurred_at",
        "observed_at",
      ]);
      if (
        row.tenant_id !== scope.tenantReference ||
        row.brand_id !== scope.brandReference ||
        row.store_id !== scope.storeReference ||
        row.reconciliation_exception_id !== exceptionReference ||
        typeof row.amount_minor !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(row.amount_minor) ||
        BigInt(row.amount_minor) > 9223372036854775807n ||
        row.currency_code !== "CAD" ||
        (row.environment !== "Test" && row.environment !== "Live") ||
        !(row.occurred_at instanceof Date) ||
        !(row.observed_at instanceof Date)
      )
        return fail();
      const occurredAt = parsePaymentInstant(row.occurred_at.toISOString()),
        observedAt = parsePaymentInstant(row.observed_at.toISOString());
      if (occurredAt > observedAt) return fail();
      return Object.freeze({
        amountMinor: row.amount_minor,
        currencyCode: "CAD" as const,
        environment: row.environment as "Test" | "Live",
        occurredAt,
        observedAt,
        recordedReason: "ProviderCaptureWithoutInternalOperation" as const,
      });
    } catch (error) {
      if (error instanceof PaymentReconciliationError) throw error;
      return fail();
    }
  };
}
