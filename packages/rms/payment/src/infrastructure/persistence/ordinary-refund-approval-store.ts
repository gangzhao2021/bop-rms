import { createPostgresOrdinaryRefundApprovalSubjectSource } from "./ordinary-refund-request-store.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  evaluateOrdinaryRefundIndependentApproval,
  ordinaryRefundApprovalModeOf,
  parseOrdinaryRefundApproval,
  encodeOrdinaryRefundApproval,
  decodeOrdinaryRefundApproval,
} from "../../application/ordinary-refund-approval.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { ordinaryRefundClaimKind } from "../../application/ordinary-refund-request.js";
import { createPostgresOrdinaryRefundApprovalSource } from "../ordinary-refund-approval-source.js";

type Options = Parameters<typeof createPostgresOrdinaryRefundApprovalSource>[0];
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_APPROVAL_CONFLICT");
};
/** Recheck at database time, never at a caller-supplied historic instant. */
export async function assertCurrentOrdinaryRefundApprovalAuthority(
  tx: ConsumerTransaction,
  approvalValue: unknown,
  authority: Options["authority"],
) {
  const approval = parseOrdinaryRefundApproval(approvalValue);
  const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
  if (clock.rows.length !== 1) return fail();
  const value = clock.rows[0]?.now;
  const observedAt = parsePaymentInstant(value instanceof Date ? value.toISOString() : value);
  const subject = approval.subject;
  const base = {
    tenantReference: subject.tenantReference,
    brandReference: subject.brandReference,
    storeReference: subject.storeReference,
    orderReference: subject.orderReference,
    observedAt,
  };
  const requester = await authority(tx, {
    ...base,
    actorReference: approval.requesterReference,
    permissionCode: "payment.refund.request",
  });
  const approver = await authority(tx, {
    ...base,
    actorReference: approval.approverReference,
    permissionCode: "payment.refund.approve",
  });
  if (
    evaluateOrdinaryRefundIndependentApproval({
      subject,
      approval,
      requester,
      approver,
      observedAt,
    }).status !== "ApprovalCurrent"
  )
    return fail();
}

/** Caller retains the transaction and all authority fences through commit.
 * Exact replay recovers history, not present-day dispatch authority.
 */
export function createPostgresOrdinaryRefundApprovalStore(options: Options) {
  const prepare = createPostgresOrdinaryRefundApprovalSource(options);
  return {
    async record(tx: ConsumerTransaction, value: unknown, auditValue: unknown) {
      const raw = exactPaymentObject(value, [
        "approval",
        "operationReference",
        "auditReference",
        "claimVersion",
      ]);
      const approval = parseOrdinaryRefundApproval(raw.approval);
      const operation = String(parsePaymentReference(raw.operationReference));
      const auditReference = String(parsePaymentReference(raw.auditReference));
      const claimVersion = raw.claimVersion;
      if (
        typeof claimVersion !== "number" ||
        !Number.isSafeInteger(claimVersion) ||
        claimVersion < 1
      )
        return fail();
      const subject = approval.subject;
      if (
        subject.tenantReference !== options.scope.tenantReference ||
        subject.brandReference !== options.scope.brandReference ||
        subject.storeReference !== options.scope.storeReference
      )
        return fail();
      const audit = validateAuditRecord(auditValue);
      // WP-2423 Q19: a sole-operator approval says so in its Audit; an independent one carries
      // no summary (unchanged).
      const mode = ordinaryRefundApprovalModeOf(approval);
      const summaryValid =
        mode === "SoleOperator"
          ? JSON.stringify(audit.afterSummary) === JSON.stringify({ approvalMode: "SoleOperator" })
          : audit.afterSummary === undefined;
      if (
        !summaryValid ||
        audit.auditId !== auditReference ||
        audit.brandId !== subject.brandReference ||
        audit.storeId !== subject.storeReference ||
        audit.actor.type !== "User" ||
        audit.actor.reference !== approval.approverReference ||
        audit.actionCode !== "PAYMENT_ORDINARY_REFUND_APPROVED" ||
        audit.targetType !== "PaymentRefundApproval" ||
        audit.targetId !== approval.approvalReference ||
        audit.correlationId !== operation ||
        audit.occurredAt !== approval.approvedAt ||
        audit.dataClassification !== "Restricted" ||
        audit.beforeSummary !== undefined
      )
        return fail();
      const query = {
        tenantReference: subject.tenantReference,
        brandReference: subject.brandReference,
        storeReference: subject.storeReference,
        orderReference: subject.orderReference,
        requestReference: subject.requestReference,
      };
      const authorize = async () => {
        if ((await options.authorize(tx, query)) !== true) return fail();
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [subject.brandReference, subject.storeReference],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrdinaryRefundApproval:" +
          subject.brandReference +
          ":" +
          subject.storeReference +
          ":" +
          operation,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PaymentReceiptOrder:" +
          subject.brandReference +
          ":" +
          subject.storeReference +
          ":" +
          subject.orderReference,
      ]);
      const encoded = encodeOrdinaryRefundApproval(approval);
      const prior = await tx.query(
        "SELECT record_json::text AS record,audit_id::text AS audit,claim_version::text AS version FROM rms_payment.ordinary_refund_approval WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
        [subject.brandReference, subject.storeReference, operation],
      );
      if (prior.rows.length > 1) return fail();
      if (prior.rows.length === 1) {
        const row = prior.rows[0];
        if (
          !row ||
          row.audit !== auditReference ||
          row.version !== String(claimVersion) ||
          encodeOrdinaryRefundApproval(decodeOrdinaryRefundApproval(row.record)) !== encoded
        )
          return fail();
        await authorize();
        return Object.freeze({
          status: "AlreadyCommitted" as const,
          approvalReference: approval.approvalReference,
        });
      }
      const current = await prepare(tx, {
        orderReference: subject.orderReference,
        requestReference: subject.requestReference,
        approvalReference: approval.approvalReference,
        approverReference: approval.approverReference,
        observedAt: approval.approvedAt,
        ...(mode === "SoleOperator" ? { approvalMode: "SoleOperator" } : {}),
      });
      if (
        current.claimVersion !== claimVersion ||
        encodeOrdinaryRefundApproval(current.approval) !== encoded
      )
        return fail();
      await authorize();
      await assertCurrentOrdinaryRefundApprovalAuthority(tx, approval, options.authority);
      await tx.query("SAVEPOINT ordinary_refund_approval_append", []);
      try {
        const inserted = await tx.query(
          "INSERT INTO rms_payment.ordinary_refund_approval " +
            "(tenant_id,brand_id,store_id,order_id,request_id,approval_id,operation_id,requester_id,approver_id,audit_id,claim_version,approved_at,requester_mfa_at,approver_mfa_at,claims_digest,allocation_digest,record_json,approval_mode) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)",
          [
            subject.tenantReference,
            subject.brandReference,
            subject.storeReference,
            subject.orderReference,
            subject.requestReference,
            approval.approvalReference,
            operation,
            approval.requesterReference,
            approval.approverReference,
            auditReference,
            claimVersion,
            approval.approvedAt,
            approval.requesterMfaAt,
            approval.approverMfaAt,
            subject.claimsDigest,
            subject.allocationDigest,
            encoded,
            mode,
          ],
        );
        if (inserted.rowCount !== 1) return fail();
        await appendAuditRecordInTransaction(tx, audit);
        await authorize();
        await assertCurrentOrdinaryRefundApprovalAuthority(tx, approval, options.authority);
        await tx.query("RELEASE SAVEPOINT ordinary_refund_approval_append", []);
        return Object.freeze({
          status: "Created" as const,
          approvalReference: approval.approvalReference,
        });
      } catch (error) {
        await tx.query("ROLLBACK TO SAVEPOINT ordinary_refund_approval_append", []);
        await tx.query("RELEASE SAVEPOINT ordinary_refund_approval_append", []);
        throw error;
      }
    },
  };
}

/** Historical read only. Dispatch must recheck current subject, authority and
 * financial occupancy under its retained fences after loading this record.
 */
export function createPostgresOrdinaryRefundApprovalReader(options: {
  scope: Options["scope"];
  authorize(
    tx: ConsumerTransaction,
    query: Options["scope"] & {
      orderReference: string;
      approvalReference: string;
      observedAt: string;
    },
  ): Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["orderReference", "approvalReference", "observedAt"]);
    const query = {
      ...scope,
      orderReference: String(parsePaymentReference(raw.orderReference)),
      approvalReference: String(parsePaymentReference(raw.approvalReference)),
      observedAt: parsePaymentInstant(raw.observedAt),
    };
    const authorize = async () => {
      if ((await options.authorize(tx, query)) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      "SELECT record_json::text AS record,operation_id::text AS operation,audit_id::text AS audit,claim_version::text AS version FROM rms_payment.ordinary_refund_approval WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND approval_id=$4",
      [scope.brandReference, scope.storeReference, query.orderReference, query.approvalReference],
    );
    if (result.rows.length > 1) return fail();
    if (result.rows.length === 0) {
      await authorize();
      return null;
    }
    const row = result.rows[0];
    if (!row) return fail();
    const approval = decodeOrdinaryRefundApproval(row.record);
    if (
      approval.subject.tenantReference !== scope.tenantReference ||
      approval.subject.brandReference !== scope.brandReference ||
      approval.subject.storeReference !== scope.storeReference ||
      approval.subject.orderReference !== query.orderReference ||
      approval.approvalReference !== query.approvalReference ||
      approval.approvedAt > query.observedAt ||
      typeof row.version !== "string" ||
      !/^[1-9][0-9]*$/u.test(row.version) ||
      !Number.isSafeInteger(Number(row.version))
    )
      return fail();
    const loaded = Object.freeze({
      approval,
      operationReference: String(parsePaymentReference(row.operation)),
      auditReference: String(parsePaymentReference(row.audit)),
      claimVersion: Number(row.version),
    });
    await authorize();
    return loaded;
  };
}

/** Independent approval gate only. Executor capability, escalation refresh,
 * captured balance and durable Provider operation are separate required gates.
 */
export function createPostgresOrdinaryRefundApprovalValidationSource(options: Options) {
  const currentSubject = createPostgresOrdinaryRefundApprovalSubjectSource(options);
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "requestReference",
      "approvalReference",
    ]);
    const orderReference = String(parsePaymentReference(raw.orderReference));
    const requestReference = String(parsePaymentReference(raw.requestReference));
    const approvalReference = String(parsePaymentReference(raw.approvalReference));
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    if (clock.rows.length !== 1) return fail();
    const time = clock.rows[0]?.now;
    const observedAt = parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
    const current = await currentSubject(tx, { orderReference, requestReference, observedAt });
    if (ordinaryRefundClaimKind(current.request) !== "Ordinary") return fail();
    const stored = await createPostgresOrdinaryRefundApprovalReader({
      scope: options.scope,
      authorize: (transaction, query) =>
        options.authorize(transaction, {
          ...query,
          requestReference,
        }),
    })(tx, { orderReference, approvalReference, observedAt });
    if (
      stored === null ||
      stored.claimVersion !== current.claimVersion ||
      stored.approval.requesterReference !== current.requesterReference ||
      Object.entries(current.subject).some(
        ([key, value]) => Reflect.get(stored.approval.subject, key) !== value,
      )
    )
      return fail();
    await assertCurrentOrdinaryRefundApprovalAuthority(tx, stored.approval, options.authority);
    return Object.freeze({
      approvalReference: stored.approval.approvalReference,
      requestReference: current.subject.requestReference,
      claimVersion: current.claimVersion,
    });
  };
}

/** WP-2423 Q5: ordinary refund requests at this Store that may still need an independent
 * approval decision or its first send: recent Ordinary requests with no prepared operation
 * (candidates; the caller re-evaluates escalation), and approved requests whose every payment
 * is not yet dispatched. A list entry grants nothing; approval and dispatch recheck everything. */
export function createPostgresOrdinaryRefundApprovalQueueReader(options: {
  scope: Options["scope"];
  authorize(
    tx: ConsumerTransaction,
    query: Options["scope"] & { observedAt: string },
  ): Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["observedAt", "since", "limit"]);
    const observedAt = parsePaymentInstant(raw.observedAt);
    const since = parsePaymentInstant(raw.since);
    if (
      since > observedAt ||
      typeof raw.limit !== "number" ||
      !Number.isSafeInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > 100
    )
      return fail();
    const authorize = async () => {
      if ((await options.authorize(tx, { ...scope, observedAt })) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      "SELECT r.order_id::text AS order_ref,r.request_id::text AS request_ref,a.approval_id::text AS approval_ref " +
        "FROM rms_payment.ordinary_refund_request r " +
        "LEFT JOIN LATERAL (SELECT x.approval_id FROM rms_payment.ordinary_refund_approval x " +
        "WHERE x.brand_id=r.brand_id AND x.store_id=r.store_id AND x.request_id=r.request_id " +
        "ORDER BY x.approved_at DESC,x.approval_id DESC LIMIT 1) a ON true " +
        "WHERE r.brand_id=$1 AND r.store_id=$2 AND r.requested_at>=$3 AND r.requested_at<=$4 " +
        "AND NOT (r.record_json ? 'claim') AND NOT EXISTS (SELECT 1 FROM rms_payment.ordinary_refund_decline y " +
        "WHERE y.brand_id=r.brand_id AND y.store_id=r.store_id AND y.request_id=r.request_id) AND (" +
        // WP-2423 item 4: a card-machine refund is finished once it is recorded as made on the
        // Store's machine (never prepared or dispatched).
        "NOT EXISTS (SELECT 1 FROM rms_payment.card_machine_refund m WHERE m.brand_id=r.brand_id " +
        "AND m.store_id=r.store_id AND m.source_kind='OrdinaryRefund' AND m.source_id=r.request_id) AND (" +
        "(a.approval_id IS NULL AND NOT EXISTS (SELECT 1 FROM rms_payment.ordinary_refund_operation o " +
        "WHERE o.brand_id=r.brand_id AND o.store_id=r.store_id AND o.request_id=r.request_id)) OR " +
        "(a.approval_id IS NOT NULL AND (SELECT count(*) FROM rms_payment.ordinary_refund_dispatch d " +
        "WHERE d.brand_id=r.brand_id AND d.store_id=r.store_id AND d.request_id=r.request_id)" +
        "<jsonb_array_length(r.record_json->'payments')))) " +
        "ORDER BY r.requested_at DESC,r.request_id DESC LIMIT $5",
      [scope.brandReference, scope.storeReference, since, observedAt, raw.limit],
    );
    const entries = result.rows.map((row) =>
      Object.freeze({
        orderReference: String(parsePaymentReference(row.order_ref)),
        requestReference: String(parsePaymentReference(row.request_ref)),
        approvalReference:
          row.approval_ref === null ? null : String(parsePaymentReference(row.approval_ref)),
      }),
    );
    await authorize();
    return Object.freeze(entries);
  };
}

/** WP-2423 Q5: why an Owner/Finance member declines an ordinary refund request. */
export const ordinaryRefundDeclineReasons = Object.freeze([
  "NOT_ELIGIBLE",
  "NEEDS_MORE_INFORMATION",
  "ENTERED_IN_ERROR",
  "CUSTOMER_WITHDREW",
] as const);
export class OrdinaryRefundDeclineError extends Error {
  constructor(
    readonly code:
      | "ORDINARY_REFUND_DECLINE_DENIED"
      | "ORDINARY_REFUND_DECLINE_SAME_PERSON"
      | "ORDINARY_REFUND_DECLINE_NEEDS_REVERIFICATION"
      | "ORDINARY_REFUND_DECLINE_ALREADY_PREPARED"
      | "ORDINARY_REFUND_DECLINE_ALREADY_DECLINED"
      | "ORDINARY_REFUND_DECLINE_CONFLICT",
  ) {
    super(code);
    this.name = "OrdinaryRefundDeclineError";
  }
}

/**
 * WP-2423 Q5 (RF-D04): an Owner/Finance member who is not the requester, with a second-factor
 * verification at most 15 minutes old, declines an Ordinary request for which nothing has been
 * prepared or sent. The decline is durable no-Provider-effect evidence: the request stops
 * occupying the Order's ordinary total and captured balance. Idempotent per operation reference;
 * atomic with its Audit. The caller retains its authority fences through commit.
 */
export function createPostgresOrdinaryRefundDeclineStore(options: Options) {
  const subject = createPostgresOrdinaryRefundApprovalSubjectSource(options);
  const denied = (code: OrdinaryRefundDeclineError["code"]): never => {
    throw new OrdinaryRefundDeclineError(code);
  };
  return async (tx: ConsumerTransaction, value: unknown, auditPolicy: unknown) => {
    const keys = [
      "orderReference",
      "requestReference",
      "declineReference",
      "operationReference",
      "auditReference",
      "declinerReference",
      "reasonCode",
    ];
    // WP-2423 Q19: declineMode "SoleOperator" is an Owner withdrawing their own request while
    // sole operator is in effect for them (entered in error or the customer withdrew).
    const withMode =
      value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "declineMode");
    const raw = exactPaymentObject(value, withMode ? [...keys, "declineMode"] : keys);
    if (withMode && raw.declineMode !== "Independent" && raw.declineMode !== "SoleOperator")
      return denied("ORDINARY_REFUND_DECLINE_DENIED");
    const sole = withMode && raw.declineMode === "SoleOperator";
    const policy = exactPaymentObject(auditPolicy, [
      "retentionPolicyCode",
      "retentionPolicyVersion",
    ]);
    const ids = {
      orderReference: String(parsePaymentReference(raw.orderReference)),
      requestReference: String(parsePaymentReference(raw.requestReference)),
      declineReference: String(parsePaymentReference(raw.declineReference)),
      operationReference: String(parsePaymentReference(raw.operationReference)),
      auditReference: String(parsePaymentReference(raw.auditReference)),
      declinerReference: String(parsePaymentReference(raw.declinerReference)),
    };
    if (!ordinaryRefundDeclineReasons.includes(raw.reasonCode as never))
      return denied("ORDINARY_REFUND_DECLINE_DENIED");
    const reasonCode = raw.reasonCode as (typeof ordinaryRefundDeclineReasons)[number];
    if (sole && reasonCode !== "ENTERED_IN_ERROR" && reasonCode !== "CUSTOMER_WITHDREW")
      return denied("ORDINARY_REFUND_DECLINE_DENIED");
    const scope = {
      tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
      brandReference: String(parsePaymentReference(options.scope.brandReference)),
      storeReference: String(parsePaymentReference(options.scope.storeReference)),
    };
    const authorize = async () => {
      if (
        (await options.authorize(tx, {
          ...scope,
          orderReference: ids.orderReference,
          requestReference: ids.requestReference,
        })) !== true
      )
        return denied("ORDINARY_REFUND_DECLINE_DENIED");
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrdinaryRefundDecline:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        ids.operationReference,
    ]);
    const clock = await tx.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now", []);
    const time = clock.rows[0]?.now;
    const observedAt = parsePaymentInstant(time instanceof Date ? time.toISOString() : time);
    // Holds the Order fence shared with request, preparation and dispatch writers.
    const current = await subject(tx, {
      orderReference: ids.orderReference,
      requestReference: ids.requestReference,
      observedAt,
    });
    if (ordinaryRefundClaimKind(current.request) !== "Ordinary")
      return denied("ORDINARY_REFUND_DECLINE_CONFLICT");
    const prior = await tx.query(
      "SELECT decline_id::text AS decline,request_id::text AS request,decliner_id::text AS decliner,reason_code,audit_id::text AS audit,operation_id::text AS operation,declined_at,decline_mode FROM rms_payment.ordinary_refund_decline WHERE brand_id=$1 AND store_id=$2 AND (operation_id=$3 OR request_id=$4)",
      [scope.brandReference, scope.storeReference, ids.operationReference, ids.requestReference],
    );
    if (prior.rows.length > 1) return denied("ORDINARY_REFUND_DECLINE_CONFLICT");
    const row = prior.rows[0];
    if (row) {
      if (row.operation !== ids.operationReference)
        return denied("ORDINARY_REFUND_DECLINE_ALREADY_DECLINED");
      if (
        (row.decline_mode === "SoleOperator") !== sole ||
        row.decline !== ids.declineReference ||
        row.request !== ids.requestReference ||
        row.decliner !== ids.declinerReference ||
        row.reason_code !== reasonCode ||
        row.audit !== ids.auditReference
      )
        return denied("ORDINARY_REFUND_DECLINE_CONFLICT");
      await authorize();
      const at = row.declined_at;
      return Object.freeze({
        status: "AlreadyCommitted" as const,
        declinedAt: parsePaymentInstant(at instanceof Date ? at.toISOString() : at),
      });
    }
    // WP-2423 item 4: a refund already made on the Store's card machine counts as prepared.
    const prepared = await tx.query(
      "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_operation WHERE brand_id=$1 AND store_id=$2 AND request_id=$3)+" +
        "(SELECT count(*)::int FROM rms_payment.card_machine_refund WHERE brand_id=$1 AND store_id=$2 AND source_kind='OrdinaryRefund' AND source_id=$3) AS n",
      [scope.brandReference, scope.storeReference, ids.requestReference],
    );
    if (prepared.rows[0]?.n !== 0) return denied("ORDINARY_REFUND_DECLINE_ALREADY_PREPARED");
    if ((current.requesterReference === ids.declinerReference) !== sole)
      return denied(
        sole ? "ORDINARY_REFUND_DECLINE_DENIED" : "ORDINARY_REFUND_DECLINE_SAME_PERSON",
      );
    const facts = await options.authority(tx, {
      ...scope,
      orderReference: ids.orderReference,
      actorReference: ids.declinerReference,
      permissionCode: "payment.refund.approve",
      observedAt,
    });
    const fact = (key: string): unknown => {
      const descriptor =
        facts !== null && typeof facts === "object"
          ? Object.getOwnPropertyDescriptor(facts, key)
          : undefined;
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    if (
      fact("actorReference") !== ids.declinerReference ||
      fact("permissionCode") !== "payment.refund.approve" ||
      fact("active") !== true ||
      fact("allowed") !== true ||
      (fact("role") !== "Owner" && fact("role") !== "Finance") ||
      (sole && (fact("role") !== "Owner" || fact("soleOperator") !== "Effective")) ||
      fact("observedAt") !== observedAt
    )
      return denied("ORDINARY_REFUND_DECLINE_DENIED");
    const mfa = fact("recentMfaAt");
    const mfaAt = typeof mfa === "string" ? parsePaymentInstant(mfa) : null;
    const age = mfaAt === null ? -1 : Date.parse(observedAt) - Date.parse(mfaAt);
    if (mfaAt === null || age < 0 || age > 15 * 60 * 1000)
      return denied("ORDINARY_REFUND_DECLINE_NEEDS_REVERIFICATION");
    const audit = validateAuditRecord({
      auditId: ids.auditReference,
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: ids.declinerReference },
      actionCode: "PAYMENT_ORDINARY_REFUND_DECLINED",
      targetType: "PaymentRefundDecline",
      targetId: ids.declineReference,
      ...(sole ? { afterSummary: { declineMode: "SoleOperator" } } : {}),
      reasonCode,
      correlationId: ids.operationReference,
      occurredAt: observedAt,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Restricted",
      retentionPolicyCode: policy.retentionPolicyCode,
      retentionPolicyVersion: policy.retentionPolicyVersion,
    });
    await tx.query("SAVEPOINT ordinary_refund_decline_append", []);
    try {
      const inserted = await tx.query(
        "INSERT INTO rms_payment.ordinary_refund_decline (tenant_id,brand_id,store_id,order_id,request_id,decline_id,operation_id,requester_id,decliner_id,reason_code,claim_count,declined_at,decliner_mfa_at,audit_id,decline_mode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        [
          scope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          ids.orderReference,
          ids.requestReference,
          ids.declineReference,
          ids.operationReference,
          current.requesterReference,
          ids.declinerReference,
          reasonCode,
          current.claimVersion,
          observedAt,
          mfaAt,
          ids.auditReference,
          sole ? "SoleOperator" : "Independent",
        ],
      );
      if (inserted.rowCount !== 1) return denied("ORDINARY_REFUND_DECLINE_CONFLICT");
      await appendAuditRecordInTransaction(tx, audit);
      await authorize();
      await tx.query("RELEASE SAVEPOINT ordinary_refund_decline_append", []);
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT ordinary_refund_decline_append", []);
      await tx.query("RELEASE SAVEPOINT ordinary_refund_decline_append", []);
      throw error;
    }
    return Object.freeze({ status: "Created" as const, declinedAt: observedAt });
  };
}

/**
 * WP-2423 Q19 (DEC-SOLE-OPERATOR-APPROVAL): refunds an Owner approved for themself (approval mode
 * SoleOperator) within a Business Date window, for the Owner's after-the-fact review at day close.
 * Counts approvals (whatever the later send result) and sums their requested amounts. Read only.
 */
export function createPostgresSoleOperatorRefundSummaryReader(options: {
  scope: Options["scope"];
  authorize(
    tx: ConsumerTransaction,
    query: Options["scope"] & { startsAt: string; endsAt: string },
  ): Promise<boolean>;
}) {
  const scope = {
    tenantReference: String(parsePaymentReference(options.scope.tenantReference)),
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  };
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, ["startsAt", "endsAt"]);
    const startsAt = parsePaymentInstant(raw.startsAt),
      endsAt = parsePaymentInstant(raw.endsAt);
    if (startsAt >= endsAt) return fail();
    const authorize = async () => {
      if ((await options.authorize(tx, { ...scope, startsAt, endsAt })) !== true) return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      "SELECT count(*)::text AS n,COALESCE(sum(r.amount_minor),0)::text AS amount " +
        "FROM rms_payment.ordinary_refund_approval a JOIN rms_payment.ordinary_refund_request r " +
        "ON r.brand_id=a.brand_id AND r.store_id=a.store_id AND r.request_id=a.request_id " +
        "WHERE a.brand_id=$1 AND a.store_id=$2 AND a.tenant_id=$3 AND a.approval_mode='SoleOperator' " +
        "AND a.approved_at>=$4 AND a.approved_at<$5",
      [scope.brandReference, scope.storeReference, scope.tenantReference, startsAt, endsAt],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !row ||
      typeof row.n !== "string" ||
      typeof row.amount !== "string" ||
      !/^(0|[1-9][0-9]{0,17})$/u.test(row.n) ||
      !/^(0|[1-9][0-9]{0,17})$/u.test(row.amount)
    )
      return fail();
    await authorize();
    return Object.freeze({
      count: Number(row.n),
      amountMinor: BigInt(row.amount),
      currencyCode: "CAD" as const,
      startsAt,
      endsAt,
    });
  };
}

/** WP-2423 item 4: the approvals recorded for one request, newest first (the caller parses each
 * through {@link createPostgresOrdinaryRefundApprovalReader}). Same Store scope as every read. */
export async function listOrdinaryRefundApprovalReferences(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  query: { readonly orderReference: string; readonly requestReference: string },
): Promise<readonly string[]> {
  const brand = String(parsePaymentReference(scope.brandReference));
  const store = String(parsePaymentReference(scope.storeReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brand,
    store,
  ]);
  const result = await tx.query(
    "SELECT approval_id::text AS approval FROM rms_payment.ordinary_refund_approval WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND request_id=$4 ORDER BY approved_at DESC,approval_id DESC LIMIT 21",
    [
      brand,
      store,
      String(parsePaymentReference(query.orderReference)),
      String(parsePaymentReference(query.requestReference)),
    ],
  );
  if (result.rows.length > 20) return fail();
  return Object.freeze(result.rows.map((row) => String(parsePaymentReference(row.approval))));
}
