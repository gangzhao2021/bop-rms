import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import type { TenantContext } from "@bop/tenant";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  createPostgresOrdinaryRefundApprovalReader,
  createPostgresOrdinaryRefundApprovalSource,
  createPostgresOrdinaryRefundApprovalStore,
  createPostgresOrdinaryRefundApprovalSubjectSource,
  createPostgresOrdinaryRefundCurrentEscalationSource,
  ordinaryRefundClaimKind,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantOrdinaryRefundAuthority } from "./merchant-ordinary-refund-authority.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** RF-D06: both people's second-factor verification must be at most 15 minutes old. */
export const refundMfaRecencyMilliseconds = 15 * 60 * 1000;
export type RefundVerificationParty = "Requester" | "Approver" | "Both";
export class MerchantRefundApprovalError extends Error {
  constructor(
    readonly code:
      | "Denied"
      | "SamePerson"
      | "NeedsReverification"
      | "Changed"
      | "AlreadyPrepared"
      | "AlreadyDeclined",
    readonly party: RefundVerificationParty | null = null,
  ) {
    super("Refund approval was not recorded");
    this.name = "MerchantRefundApprovalError";
  }
}
interface Scope {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}
type Authority = Parameters<typeof createMerchantOrdinaryRefundAuthority>[0];
type Command = (input: {
  sessionCookie: unknown;
  csrf: unknown;
  command: unknown;
}) => Promise<unknown>;

/** Identities of the approval's own records, derived from the client's approval reference so a
 * retry of the same approval reuses the same approval, operation and dispatch (never a new send). */
export function approvalDerivedReference(approvalReference: string, purpose: string): string {
  const digest = createHash("sha256")
    .update("bop-rms/ordinary-refund-approval/v1:" + approvalReference + ":" + purpose)
    .digest("hex");
  return (
    approvalReference.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-" +
    ((parseInt(digest.slice(3, 4), 16) & 3) | 8).toString(16) +
    digest.slice(4, 7) +
    "-" +
    digest.slice(7, 19)
  );
}
export function recentEnough(mfaAt: string | null, at: string): boolean {
  if (mfaAt === null) return false;
  const age = Date.parse(at) - Date.parse(mfaAt);
  return age >= 0 && age <= refundMfaRecencyMilliseconds;
}
export function businessTransaction(transaction: {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}): ConsumerTransaction {
  return {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      const result = await transaction.query(sql, values);
      if (!result || typeof result !== "object")
        throw new Error("ORDINARY_REFUND_APPROVAL_UNAVAILABLE");
      const rows = Object.getOwnPropertyDescriptor(result, "rows");
      const count = Object.getOwnPropertyDescriptor(result, "rowCount");
      if (
        !rows ||
        !("value" in rows) ||
        !Array.isArray(rows.value) ||
        !count ||
        !("value" in count) ||
        (count.value !== null &&
          (typeof count.value !== "number" ||
            !Number.isSafeInteger(count.value) ||
            count.value < 0))
      )
        throw new Error("ORDINARY_REFUND_APPROVAL_UNAVAILABLE");
      return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
    },
  };
}

/**
 * WP-2423 Q5 (DEC-REFUND-ESCALATION-PILOT): an Owner/Finance member who is not the requester
 * approves an escalated ordinary refund in person, then it is sent at once through the existing
 * preparation and send commands with the approval. Requester facts (role, permission, recent MFA)
 * are read from their owners for the recorded requester; no session is borrowed. A stale
 * verification returns NeedsReverification naming who must verify again; nothing is sent.
 */
export function createMerchantOrdinaryRefundApproval(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  /** Trusted configuration; workforce must resolve any current Store actor through owners. */
  resolveConfiguration(
    tx: ConsumerTransaction,
    scope: Scope & { actorReference: string },
    authority: { readonly context: TenantContext; authorize(): Promise<boolean> },
  ): Promise<{
    providerAccountReference: string;
    environment: "Test" | "Live";
    workforce: Authority;
    businessDate: Parameters<
      typeof createPostgresOrdinaryRefundCurrentEscalationSource
    >[0]["businessDate"];
  }>;
  prepare: Command;
  send: Command;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const ref = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.command, [
      "orderReference",
      "requestReference",
      "approvalReference",
    ]);
    const orderReference = ref(raw.orderReference),
      requestReference = ref(raw.requestReference),
      approvalReference = ref(raw.approvalReference);
    const approved = await options.persistence.transactions.run(async (transaction) => {
      try {
        return await approveInTransaction(transaction);
      } catch (error) {
        // WP-2423 Q5: a declined request is closed and is never approved or sent.
        if (error instanceof Error && error.message === "ORDINARY_REFUND_DECLINED")
          throw new MerchantRefundApprovalError("AlreadyDeclined");
        throw error;
      }
    });
    async function approveInTransaction(
      transaction: Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0],
    ) {
      const current = await resolve(
        transaction,
        input.sessionCookie,
        "payment.refund.approve",
        authenticated.sessionReference,
      );
      if (!(await current.allowed())) throw new MerchantRefundApprovalError("Denied");
      const tx = businessTransaction(transaction);
      const actorReference = String(current.actorReference);
      const scope = {
        tenantReference: current.selected.tenantReference,
        brandReference: String(current.context.brand.brandReference),
        storeReference: String(current.store.storeReference),
      };
      const configuration = await options.resolveConfiguration(
        tx,
        { ...scope, actorReference },
        Object.freeze({ context: current.context, authorize: current.allowed }),
      );
      const authorize = async (
        _tx: ConsumerTransaction,
        query: Scope & { orderReference?: string; requestReference?: string },
      ) =>
        query.tenantReference === scope.tenantReference &&
        query.brandReference === scope.brandReference &&
        query.storeReference === scope.storeReference &&
        (query.orderReference === undefined || query.orderReference === orderReference) &&
        (query.requestReference === undefined || query.requestReference === requestReference) &&
        (await current.allowed());
      const escalation = await createPostgresOrdinaryRefundCurrentEscalationSource({
        scope,
        providerAccountReference: configuration.providerAccountReference,
        environment: configuration.environment,
        authorize,
        businessDate: configuration.businessDate,
      })(tx, { orderReference, requestReference });
      const observedAt = escalation.observedAt;
      const subject = await createPostgresOrdinaryRefundApprovalSubjectSource({
        scope,
        authorize,
      })(tx, { orderReference, requestReference, observedAt });
      if (ordinaryRefundClaimKind(subject.request) !== "Ordinary")
        throw new MerchantRefundApprovalError("Changed");
      if (subject.requesterReference === actorReference)
        throw new MerchantRefundApprovalError("SamePerson");
      const authority = createMerchantOrdinaryRefundAuthority(configuration.workforce);
      const party = async (actor: string, permissionCode: string) =>
        authority(tx, {
          ...scope,
          orderReference,
          actorReference: actor,
          permissionCode,
          observedAt,
        });
      const requester = await party(subject.requesterReference, "payment.refund.request");
      const approver = await party(actorReference, "payment.refund.approve");
      if (
        requester.role !== "Manager" ||
        !requester.allowed ||
        (approver.role !== "Owner" && approver.role !== "Finance") ||
        !approver.allowed
      )
        throw new MerchantRefundApprovalError("Denied");
      const staleRequester = !recentEnough(requester.recentMfaAt, observedAt),
        staleApprover = !recentEnough(approver.recentMfaAt, observedAt);
      if (staleRequester || staleApprover)
        throw new MerchantRefundApprovalError(
          "NeedsReverification",
          staleRequester && staleApprover ? "Both" : staleRequester ? "Requester" : "Approver",
        );
      const existing = await createPostgresOrdinaryRefundApprovalReader({
        scope,
        authorize,
      })(tx, { orderReference, approvalReference, observedAt });
      const payments = subject.request.payments.map((payment) => payment.paymentAttemptReference);
      if (existing !== null) {
        if (
          existing.approval.subject.requestReference !== requestReference ||
          existing.approval.approverReference !== actorReference
        )
          throw new MerchantRefundApprovalError("Changed");
        return { replayed: true, payments };
      }
      const approvalOptions = { scope, authorize, authority };
      const prepared = await createPostgresOrdinaryRefundApprovalSource(approvalOptions)(tx, {
        orderReference,
        requestReference,
        approvalReference,
        approverReference: actorReference,
        observedAt,
      });
      const operationReference = approvalDerivedReference(approvalReference, "approval-operation");
      const auditReference = approvalDerivedReference(approvalReference, "approval-audit");
      await createPostgresOrdinaryRefundApprovalStore(approvalOptions).record(
        tx,
        {
          approval: prepared.approval,
          operationReference,
          auditReference,
          claimVersion: prepared.claimVersion,
        },
        {
          auditId: auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: actorReference },
          actionCode: "PAYMENT_ORDINARY_REFUND_APPROVED",
          targetType: "PaymentRefundApproval",
          targetId: approvalReference,
          reasonCode: subject.request.reasonCode,
          correlationId: operationReference,
          occurredAt: prepared.approval.approvedAt,
          sourceChannel: "MERCHANT_WEB",
          dataClassification: "Restricted",
          retentionPolicyCode: options.retentionPolicyCode,
          retentionPolicyVersion: options.retentionPolicyVersion,
        },
      );
      if (!(await current.allowed())) throw new MerchantRefundApprovalError("Denied");
      return { replayed: false, payments };
    }
    // Send at once, one payment at a time, with identities fixed by the approval reference.
    const results = [];
    for (const paymentAttemptReference of approved.payments) {
      const operationReference = approvalDerivedReference(
        approvalReference,
        "operation:" + paymentAttemptReference,
      );
      let state: "SendRecorded" | "ResultUnknown";
      try {
        await options.prepare({
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
          command: {
            orderReference,
            requestReference,
            paymentAttemptReference,
            operationReference,
            auditReference: approvalDerivedReference(
              approvalReference,
              "operation-audit:" + paymentAttemptReference,
            ),
            approvalReference,
          },
        });
        await options.send({
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
          command: {
            operationReference,
            orderReference,
            requestReference,
            dispatchReference: approvalDerivedReference(
              approvalReference,
              "dispatch:" + paymentAttemptReference,
            ),
            auditReference: approvalDerivedReference(
              approvalReference,
              "dispatch-audit:" + paymentAttemptReference,
            ),
            approvalReference,
          },
        });
        state = "SendRecorded";
      } catch {
        // A send may have reached the Provider; only the same approval retry or a result check
        // may follow. Never report that nothing happened.
        state = "ResultUnknown";
      }
      results.push(Object.freeze({ paymentAttemptReference, operationReference, state }));
    }
    return Object.freeze({
      status: "Approved" as const,
      approvalReference,
      replayed: approved.replayed,
      payments: Object.freeze(results),
    });
  };
}
