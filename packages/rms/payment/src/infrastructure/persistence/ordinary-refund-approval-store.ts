import { createPostgresOrdinaryRefundApprovalSubjectSource } from "./ordinary-refund-request-store.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  evaluateOrdinaryRefundIndependentApproval,
  parseOrdinaryRefundApproval,
  encodeOrdinaryRefundApproval,
  decodeOrdinaryRefundApproval,
} from "../../application/ordinary-refund-approval.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
} from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
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
      if (
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
        audit.beforeSummary !== undefined ||
        audit.afterSummary !== undefined
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
            "(tenant_id,brand_id,store_id,order_id,request_id,approval_id,operation_id,requester_id,approver_id,audit_id,claim_version,approved_at,requester_mfa_at,approver_mfa_at,claims_digest,allocation_digest,record_json) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)",
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
