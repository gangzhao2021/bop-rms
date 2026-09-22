import type { ConsumerTransaction } from "@bop/eventing";
import { createOrdinaryRefundIndependentApproval } from "../application/ordinary-refund-approval.js";
import { exactPaymentObject, parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import { createPostgresOrdinaryRefundApprovalSubjectSource } from "./persistence/ordinary-refund-request-store.js";

type SubjectOptions = Parameters<typeof createPostgresOrdinaryRefundApprovalSubjectSource>[0];

/** Prepare an approval inside the caller's retained transaction. Identity,
 * Membership and Permission adapters must retain their applicable fences.
 * The result still requires atomic approval/Audit persistence; never dispatch
 * merely because this read succeeds.
 */
export function createPostgresOrdinaryRefundApprovalSource(
  options: SubjectOptions & {
    readonly authority: (
      tx: ConsumerTransaction,
      query: SubjectOptions["scope"] & {
        readonly orderReference: string;
        readonly actorReference: string;
        readonly permissionCode: "payment.refund.request" | "payment.refund.approve";
        readonly observedAt: string;
      },
    ) => Promise<unknown>;
  },
) {
  const subjectSource = createPostgresOrdinaryRefundApprovalSubjectSource(options);
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "requestReference",
      "approvalReference",
      "approverReference",
      "observedAt",
    ]);
    const orderReference = String(parsePaymentReference(raw.orderReference));
    const requestReference = String(parsePaymentReference(raw.requestReference));
    const approvalReference = String(parsePaymentReference(raw.approvalReference));
    const approverReference = String(parsePaymentReference(raw.approverReference));
    const observedAt = parsePaymentInstant(raw.observedAt);
    const persisted = await subjectSource(tx, { orderReference, requestReference, observedAt });
    const base = {
      tenantReference: persisted.subject.tenantReference,
      brandReference: persisted.subject.brandReference,
      storeReference: persisted.subject.storeReference,
      orderReference,
      observedAt,
    };
    const requester = await options.authority(tx, {
      ...base,
      actorReference: persisted.requesterReference,
      permissionCode: "payment.refund.request",
    });
    const approver = await options.authority(tx, {
      ...base,
      actorReference: approverReference,
      permissionCode: "payment.refund.approve",
    });
    const approval = createOrdinaryRefundIndependentApproval({
      approvalReference,
      subject: persisted.subject,
      requester,
      approver,
      observedAt,
    });
    if (
      approval.requesterReference !== persisted.requesterReference ||
      approval.approverReference !== approverReference
    )
      throw new Error("ORDINARY_REFUND_APPROVAL_DENIED");
    return Object.freeze({ approval, claimVersion: persisted.claimVersion });
  };
}
