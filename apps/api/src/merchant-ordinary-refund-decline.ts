import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import {
  createPostgresOrdinaryRefundDeclineStore,
  OrdinaryRefundDeclineError,
  ordinaryRefundDeclineReasons,
} from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantOrdinaryRefundAuthority } from "./merchant-ordinary-refund-authority.js";
import {
  approvalDerivedReference,
  businessTransaction,
  MerchantRefundApprovalError,
  type createMerchantOrdinaryRefundApproval,
} from "./merchant-ordinary-refund-approval.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

type Configuration = Parameters<
  typeof createMerchantOrdinaryRefundApproval
>[0]["resolveConfiguration"];

/**
 * WP-2423 Q5 (RF-D04): an Owner/Finance member who did not ask for the refund declines it, with
 * a reason, after confirming it is them (second factor at most 15 minutes old). Only a request
 * with nothing prepared or sent can be declined; it then stops counting toward the Order's
 * CAD 100 total and the captured balance. Retrying the same operation returns the same decline.
 */
export function createMerchantOrdinaryRefundDecline(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  resolveConfiguration: Configuration;
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
      "operationReference",
      "reasonCode",
    ]);
    const orderReference = ref(raw.orderReference),
      requestReference = ref(raw.requestReference),
      operationReference = ref(raw.operationReference);
    if (!ordinaryRefundDeclineReasons.includes(raw.reasonCode as never))
      throw new MerchantRefundApprovalError("Denied");
    try {
      return await options.persistence.transactions.run(async (transaction) => {
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
        const result = await createPostgresOrdinaryRefundDeclineStore({
          scope,
          authorize: async (_tx, query) =>
            query.tenantReference === scope.tenantReference &&
            query.brandReference === scope.brandReference &&
            query.storeReference === scope.storeReference &&
            query.orderReference === orderReference &&
            query.requestReference === requestReference &&
            (await current.allowed()),
          authority: createMerchantOrdinaryRefundAuthority(configuration.workforce),
        })(
          tx,
          {
            orderReference,
            requestReference,
            declineReference: approvalDerivedReference(operationReference, "decline"),
            operationReference,
            auditReference: approvalDerivedReference(operationReference, "decline-audit"),
            declinerReference: actorReference,
            reasonCode: raw.reasonCode,
          },
          {
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          },
        );
        if (!(await current.allowed())) throw new MerchantRefundApprovalError("Denied");
        return Object.freeze({
          status: "Declined" as const,
          declinedAt: String(result.declinedAt),
          replayed: result.status === "AlreadyCommitted",
        });
      });
    } catch (error) {
      if (error instanceof MerchantRefundApprovalError) throw error;
      if (error instanceof OrdinaryRefundDeclineError) {
        if (error.code === "ORDINARY_REFUND_DECLINE_SAME_PERSON")
          throw new MerchantRefundApprovalError("SamePerson");
        if (error.code === "ORDINARY_REFUND_DECLINE_NEEDS_REVERIFICATION")
          throw new MerchantRefundApprovalError("NeedsReverification", "Approver");
        if (error.code === "ORDINARY_REFUND_DECLINE_DENIED")
          throw new MerchantRefundApprovalError("Denied");
        if (error.code === "ORDINARY_REFUND_DECLINE_ALREADY_PREPARED")
          throw new MerchantRefundApprovalError("AlreadyPrepared");
        if (error.code === "ORDINARY_REFUND_DECLINE_ALREADY_DECLINED")
          throw new MerchantRefundApprovalError("AlreadyDeclined");
        throw new MerchantRefundApprovalError("Changed");
      }
      // The decliner holds no Owner/Finance refund role here; anything else (for example an
      // ended session) stays a plain refusal.
      if (
        error instanceof Error &&
        (error.message === "ORDINARY_REFUND_AUTHORITY_DENIED" ||
          error.message === "WORKFORCE_AUTHORITY_UNAVAILABLE")
      )
        throw new MerchantRefundApprovalError("Denied");
      throw error;
    }
  };
}
