import type { ConsumerTransaction } from "@bop/eventing";
import { appendAuditRecordInTransaction } from "@bop/audit";
import { createRefundPaymentRequest } from "../../application/payment-provider-adapter.js";
import type { RefundPaymentRequest } from "../../contracts/payment-provider-adapter.js";

/**
 * WP-2423 P6: refund in full a charge the payment Provider captured that matches no payment or
 * Order of this Store. Requested by staff with refund-request authority, approved by a different
 * person with refund-approve authority (which fixes the Provider idempotency key), and closed by
 * the Provider-confirmed refund. Every step is append-only and audited.
 */
export class UnmatchedCaptureRefundError extends Error {
  constructor(
    readonly code:
      | "UNMATCHED_REFUND_INPUT_INVALID"
      | "UNMATCHED_REFUND_PERMISSION_DENIED"
      | "UNMATCHED_REFUND_NOT_FOUND"
      | "UNMATCHED_REFUND_STATE_CONFLICT"
      | "UNMATCHED_REFUND_SAME_APPROVER"
      | "UNMATCHED_REFUND_UNAVAILABLE",
  ) {
    super(code);
    this.name = "UnmatchedCaptureRefundError";
  }
}
const fail = (code: UnmatchedCaptureRefundError["code"]): never => {
  throw new UnmatchedCaptureRefundError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const reference = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("UNMATCHED_REFUND_INPUT_INVALID");
const instant = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  return typeof text === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text) &&
    new Date(text).toISOString() === text
    ? text
    : fail("UNMATCHED_REFUND_INPUT_INVALID");
};
const at = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

export interface UnmatchedCaptureRefundState {
  readonly candidateReference: string;
  readonly reconciliationExceptionReference: string;
  readonly providerAccountReference: string;
  readonly environment: "Test" | "Live";
  readonly providerIntentReference: string;
  readonly providerTransactionReference: string;
  readonly originalAttemptReference: string;
  readonly amountMinor: string;
  readonly currencyCode: "CAD";
  readonly capturedAt: string;
  /** When the reconciliation exception was opened; no refund step precedes it. */
  readonly openedAt: string;
  readonly request: {
    readonly refundReference: string;
    readonly requestedByActorReference: string;
    readonly requestedAt: string;
  } | null;
  readonly approval: {
    readonly approvedByActorReference: string;
    readonly approvedAt: string;
    readonly operationReference: string;
    readonly providerIdempotencyKey: string;
  } | null;
  readonly outcome: {
    readonly providerRefundReference: string;
    readonly recordedAt: string;
  } | null;
  readonly status: "Unrefunded" | "Requested" | "Approved" | "Refunded";
}

type Access = "Read" | "Request" | "Approve" | "Record";
export function createPostgresUnmatchedCaptureRefundStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  /** Current staff authority for the step (refund request / approve), checked inside the transaction. */
  authorize(
    tx: ConsumerTransaction,
    access: Access,
    actorReference: string | null,
  ): Promise<boolean>;
}) {
  const brand = reference(options.brandReference),
    store = reference(options.storeReference);
  const scope = async (tx: ConsumerTransaction) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  };
  const allow = async (tx: ConsumerTransaction, access: Access, actor: string | null) => {
    if ((await options.authorize(tx, access, actor)) !== true)
      fail("UNMATCHED_REFUND_PERMISSION_DENIED");
  };
  const lock = (tx: ConsumerTransaction, exception: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "UnmatchedCaptureRefund:" + brand + ":" + store + ":" + exception,
    ]);
  async function load(
    tx: ConsumerTransaction,
    exceptionReference: string,
  ): Promise<UnmatchedCaptureRefundState | null> {
    const evidence = (
      await tx.query(
        "SELECT e.*,x.opened_at AS exception_opened_at FROM rms_payment.provider_capture_exception_evidence e JOIN rms_payment.payment_reconciliation_exception x ON x.brand_id=e.brand_id AND x.store_id=e.store_id AND x.reconciliation_exception_id=e.reconciliation_exception_id WHERE e.brand_id=$1 AND e.store_id=$2 AND e.reconciliation_exception_id=$3",
        [brand, store, reference(exceptionReference)],
      )
    ).rows;
    if (evidence.length === 0) return null;
    const e = evidence[0];
    if (evidence.length !== 1 || !e) return fail("UNMATCHED_REFUND_UNAVAILABLE");
    const candidate = reference(String(e.candidate_id));
    const one = async (table: string) => {
      const rows = (
        await tx.query(
          `SELECT * FROM rms_payment.${table} WHERE brand_id=$1 AND store_id=$2 AND ` +
            (table === "unmatched_capture_refund_request"
              ? "candidate_id=$3"
              : "refund_id=(SELECT refund_id FROM rms_payment.unmatched_capture_refund_request WHERE brand_id=$1 AND store_id=$2 AND candidate_id=$3)"),
          [brand, store, candidate],
        )
      ).rows;
      if (rows.length > 1) return fail("UNMATCHED_REFUND_UNAVAILABLE");
      return rows[0] ?? null;
    };
    const request = await one("unmatched_capture_refund_request");
    const approval = request ? await one("unmatched_capture_refund_approval") : null;
    const outcome = approval ? await one("unmatched_capture_refund_outcome") : null;
    if (
      request &&
      (String(request.provider_transaction_reference) !==
        String(e.provider_transaction_reference) ||
        String(request.amount_minor) !== String(e.amount_minor))
    )
      return fail("UNMATCHED_REFUND_UNAVAILABLE");
    return Object.freeze({
      candidateReference: candidate,
      reconciliationExceptionReference: String(e.reconciliation_exception_id),
      providerAccountReference: String(e.provider_account_id),
      environment: e.environment === "Live" ? "Live" : "Test",
      providerIntentReference: String(e.provider_intent_reference),
      providerTransactionReference: String(e.provider_transaction_reference),
      originalAttemptReference: String(e.original_attempt_id),
      amountMinor: String(e.amount_minor),
      currencyCode: "CAD",
      capturedAt: at(e.occurred_at),
      openedAt: at(e.exception_opened_at),
      request: request
        ? Object.freeze({
            refundReference: String(request.refund_id),
            requestedByActorReference: String(request.requested_by_actor_id),
            requestedAt: at(request.requested_at),
          })
        : null,
      approval: approval
        ? Object.freeze({
            approvedByActorReference: String(approval.approved_by_actor_id),
            approvedAt: at(approval.approved_at),
            operationReference: String(approval.operation_id),
            providerIdempotencyKey: String(approval.provider_idempotency_key),
          })
        : null,
      outcome: outcome
        ? Object.freeze({
            providerRefundReference: String(outcome.provider_refund_reference),
            recordedAt: at(outcome.recorded_at),
          })
        : null,
      status: outcome ? "Refunded" : approval ? "Approved" : request ? "Requested" : "Unrefunded",
    } satisfies UnmatchedCaptureRefundState);
  }
  const audit = (
    tx: ConsumerTransaction,
    input: {
      auditReference: string;
      actorReference: string | null;
      actionCode: string;
      refundReference: string;
      correlationReference: string;
      occurredAt: string;
      reasonCode: string;
    },
  ) =>
    appendAuditRecordInTransaction(tx, {
      auditId: input.auditReference,
      brandId: brand,
      storeId: store,
      actor: input.actorReference
        ? { type: "User", reference: input.actorReference }
        : { type: "System" },
      actionCode: input.actionCode,
      targetType: "UnmatchedCaptureRefund",
      targetId: input.refundReference,
      reasonCode: input.reasonCode,
      correlationId: input.correlationReference,
      occurredAt: input.occurredAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    });
  /** The Provider refund request the approval fixed; the same key on every attempt. */
  const providerRequest = (state: UnmatchedCaptureRefundState): RefundPaymentRequest => {
    if (!state.approval) return fail("UNMATCHED_REFUND_STATE_CONFLICT");
    return createRefundPaymentRequest({
      operation: "RefundPayment",
      purpose: "RefundPayment",
      idempotencyKey: state.approval.providerIdempotencyKey,
      context: {
        provider: "Stripe",
        environment: state.environment,
        brandReference: brand,
        storeReference: store,
        paymentAttemptReference: state.originalAttemptReference,
        operationReference: state.approval.operationReference,
      },
      providerIntentReference: state.providerIntentReference,
      originalPaymentMethod: "OnlineCard",
      amount: { amountMinor: BigInt(state.amountMinor), currencyCode: "CAD" },
    } as unknown as RefundPaymentRequest);
  };
  return Object.freeze({
    providerRequest,
    async read(tx: ConsumerTransaction, exceptionReference: string) {
      await scope(tx);
      await allow(tx, "Read", null);
      return load(tx, exceptionReference);
    },
    async request(
      tx: ConsumerTransaction,
      input: {
        exceptionReference: string;
        actorReference: string;
        refundReference: string;
        idempotencyReference: string;
        auditReference: string;
        requestedAt: string;
      },
    ) {
      await scope(tx);
      const actor = reference(input.actorReference);
      await allow(tx, "Request", actor);
      await lock(tx, reference(input.exceptionReference));
      const state =
        (await load(tx, input.exceptionReference)) ?? fail("UNMATCHED_REFUND_NOT_FOUND");
      if (state.request) {
        // The same request repeated returns the original; any other request is a conflict.
        const prior = (
          await tx.query(
            "SELECT idempotency_id FROM rms_payment.unmatched_capture_refund_request WHERE brand_id=$1 AND store_id=$2 AND refund_id=$3",
            [brand, store, state.request.refundReference],
          )
        ).rows[0];
        if (String(prior?.idempotency_id) === reference(input.idempotencyReference)) return state;
        return fail("UNMATCHED_REFUND_STATE_CONFLICT");
      }
      const requestedAt = instant(input.requestedAt);
      if (requestedAt < state.openedAt) fail("UNMATCHED_REFUND_STATE_CONFLICT");
      const evidence = state;
      await tx.query(
        "INSERT INTO rms_payment.unmatched_capture_refund_request (refund_id,brand_id,store_id,candidate_id,reconciliation_exception_id,provider_account_id,environment,provider_intent_reference,provider_transaction_reference,amount_minor,currency_code,reason,requested_by_actor_id,requested_at,idempotency_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CAD','NoMatchingOrder',$11,$12,$13,$14)",
        [
          reference(input.refundReference),
          brand,
          store,
          evidence.candidateReference,
          evidence.reconciliationExceptionReference,
          evidence.providerAccountReference,
          evidence.environment,
          evidence.providerIntentReference,
          evidence.providerTransactionReference,
          evidence.amountMinor,
          actor,
          requestedAt,
          reference(input.idempotencyReference),
          reference(input.auditReference),
        ],
      );
      await audit(tx, {
        auditReference: input.auditReference,
        actorReference: actor,
        actionCode: "UNMATCHED_CAPTURE_REFUND_REQUESTED",
        refundReference: input.refundReference,
        correlationReference: input.idempotencyReference,
        occurredAt: requestedAt,
        reasonCode: "NO_MATCHING_ORDER",
      });
      await allow(tx, "Request", actor);
      return load(tx, input.exceptionReference);
    },
    async approve(
      tx: ConsumerTransaction,
      input: {
        exceptionReference: string;
        actorReference: string;
        operationReference: string;
        idempotencyReference: string;
        auditReference: string;
        approvedAt: string;
      },
    ) {
      await scope(tx);
      const actor = reference(input.actorReference);
      await allow(tx, "Approve", actor);
      await lock(tx, reference(input.exceptionReference));
      const state =
        (await load(tx, input.exceptionReference)) ?? fail("UNMATCHED_REFUND_NOT_FOUND");
      if (!state.request) return fail("UNMATCHED_REFUND_STATE_CONFLICT");
      if (state.approval) {
        const prior = (
          await tx.query(
            "SELECT idempotency_id FROM rms_payment.unmatched_capture_refund_approval WHERE brand_id=$1 AND store_id=$2 AND refund_id=$3",
            [brand, store, state.request.refundReference],
          )
        ).rows[0];
        if (String(prior?.idempotency_id) === reference(input.idempotencyReference)) return state;
        return fail("UNMATCHED_REFUND_STATE_CONFLICT");
      }
      if (state.request.requestedByActorReference === actor) fail("UNMATCHED_REFUND_SAME_APPROVER");
      const approvedAt = instant(input.approvedAt),
        operation = reference(input.operationReference);
      if (approvedAt < state.request.requestedAt) fail("UNMATCHED_REFUND_STATE_CONFLICT");
      await tx.query(
        "INSERT INTO rms_payment.unmatched_capture_refund_approval (refund_id,brand_id,store_id,approved_by_actor_id,approved_at,operation_id,provider_idempotency_key,idempotency_id,audit_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          state.request.refundReference,
          brand,
          store,
          actor,
          approvedAt,
          operation,
          "unmatched-capture-refund:" + operation,
          reference(input.idempotencyReference),
          reference(input.auditReference),
        ],
      );
      await audit(tx, {
        auditReference: input.auditReference,
        actorReference: actor,
        actionCode: "UNMATCHED_CAPTURE_REFUND_APPROVED",
        refundReference: state.request.refundReference,
        correlationReference: operation,
        occurredAt: approvedAt,
        reasonCode: "NO_MATCHING_ORDER",
      });
      await allow(tx, "Approve", actor);
      return load(tx, input.exceptionReference);
    },
    /** Records the Provider-confirmed refund for the approved request; repeats are no-ops. */
    async recordOutcome(
      tx: ConsumerTransaction,
      input: {
        exceptionReference: string;
        observation: {
          readonly providerRefundReference: string;
          readonly providerIntentReference: string;
          readonly amountMinor: bigint;
          readonly status: string;
          readonly observedAt: string;
          readonly evidenceDigest: string;
          readonly idempotencyKey: string;
        };
        auditReference: string;
        recordedAt: string;
      },
    ) {
      await scope(tx);
      await allow(tx, "Record", null);
      await lock(tx, reference(input.exceptionReference));
      const state =
        (await load(tx, input.exceptionReference)) ?? fail("UNMATCHED_REFUND_NOT_FOUND");
      if (!state.approval || !state.request) return fail("UNMATCHED_REFUND_STATE_CONFLICT");
      const o = input.observation;
      if (
        o.status !== "succeeded" ||
        o.providerIntentReference !== state.providerIntentReference ||
        o.amountMinor !== BigInt(state.amountMinor) ||
        o.idempotencyKey !== state.approval.providerIdempotencyKey ||
        !/^sha256:[0-9a-f]{64}$/u.test(o.evidenceDigest)
      )
        return fail("UNMATCHED_REFUND_STATE_CONFLICT");
      if (state.outcome) {
        if (state.outcome.providerRefundReference !== o.providerRefundReference)
          return fail("UNMATCHED_REFUND_STATE_CONFLICT");
        return state;
      }
      const recordedAt = instant(input.recordedAt);
      await tx.query(
        "INSERT INTO rms_payment.unmatched_capture_refund_outcome (refund_id,brand_id,store_id,provider_refund_reference,status,amount_minor,provider_observed_at,evidence_digest,recorded_at,audit_id) VALUES ($1,$2,$3,$4,'Succeeded',$5,$6,$7,$8,$9)",
        [
          state.request.refundReference,
          brand,
          store,
          o.providerRefundReference,
          state.amountMinor,
          instant(o.observedAt),
          o.evidenceDigest,
          recordedAt,
          reference(input.auditReference),
        ],
      );
      await audit(tx, {
        auditReference: input.auditReference,
        actorReference: null,
        actionCode: "UNMATCHED_CAPTURE_REFUND_CONFIRMED",
        refundReference: state.request.refundReference,
        correlationReference: state.approval.operationReference,
        occurredAt: recordedAt,
        reasonCode: "PROVIDER_CONFIRMED",
      });
      return load(tx, input.exceptionReference);
    },
  });
}
