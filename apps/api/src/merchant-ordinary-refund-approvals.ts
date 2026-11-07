import type { ConsumerTransaction } from "@bop/eventing";
import type { TenantContext } from "@bop/tenant";
import { MemberDirectoryError, loadStoreMember } from "@bop/membership";
import { listStoreOrderNumbers } from "@rms/ordering";
import { createPostgresOrdinaryRefundApprovalQueueRuntime } from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantOrdinaryRefundAuthority } from "./merchant-ordinary-refund-authority.js";
import { createMerchantSoleOperatorApproval } from "./merchant-sole-operator.js";
import {
  businessTransaction,
  refundMfaRecencyMilliseconds,
  recentEnough,
} from "./merchant-ordinary-refund-approval.js";
import type { createMerchantOrdinaryRefundApproval } from "./merchant-ordinary-refund-approval.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Configuration = Parameters<
  typeof createMerchantOrdinaryRefundApproval
>[0]["resolveConfiguration"];
const denied = (): never => {
  throw new Error("ORDINARY_REFUND_APPROVALS_DENIED");
};

/**
 * WP-2423 Q5: refunds at the selected Store awaiting an Owner/Finance approval, or approved and
 * not yet sent, for staff who may request or approve refunds. Shows the order number, amount,
 * reason, who asked and when, and whether the requester's verification is still current. A read
 * model only: approval and sending recheck every fact. Names are shown to staff, never logged.
 */
export function createMerchantOrdinaryRefundApprovals(options: {
  persistence: PersistentMerchantBffOptions;
  resolveConfiguration: Configuration;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown }) =>
    options.persistence.transactions.run((transaction) =>
      // WP-2423: the caller is resolved in full at the start and once before the reply; the owner
      // reads in between (several per request listed) only confirm they run in this authorized
      // transaction.
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolve(transaction, input.sessionCookie, "merchant.access");
            const can = async (action: string) =>
              (await current.authorizeAction(action))?.effect === "Allow";
            const canApprove = await can("payment.refund.approve");
            const canRequest = await can("payment.refund.request");
            if (!canApprove && !canRequest) return denied();
            return Object.freeze({ current, can, canApprove, canRequest });
          },
          recheck: async ({ can, canApprove, canRequest }) =>
            (canApprove && (await can("payment.refund.approve"))) ||
            (canRequest && (await can("payment.refund.request"))),
          denied,
        },
        async (authorized) => {
          const { current, canApprove } = authorized.scope;
          const still = () => authorized.guard();
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
            Object.freeze({ context: current.context as TenantContext, authorize: still }),
          );
          const authorize = async (
            _tx: ConsumerTransaction,
            query: { tenantReference?: string; brandReference: string; storeReference: string },
          ) =>
            (query.tenantReference === undefined ||
              query.tenantReference === scope.tenantReference) &&
            query.brandReference === scope.brandReference &&
            query.storeReference === scope.storeReference &&
            (await still());
          const observedAt = String(current.context.resolvedAt);
          const entries = await createPostgresOrdinaryRefundApprovalQueueRuntime({
            scope,
            providerAccountReference: configuration.providerAccountReference,
            environment: configuration.environment,
            authorize,
            businessDate: configuration.businessDate,
          })(tx, { observedAt });
          const authority = createMerchantOrdinaryRefundAuthority(configuration.workforce);
          // Only the order number is shown: a plain read of Ordering's immutable order number, no
          // Order row lock. Locking the Order after the refund fences the queue holds would invert
          // the canonical lock order (acquireOrdinaryRefundRequestFences; v15 2026-10-18 40P01).
          const orderNumbers = new Map<string, string>();
          const listed = [...new Set(entries.map((entry) => String(entry.orderReference)))];
          for (let index = 0; index < listed.length; index += 100) {
            if (!(await still())) return denied();
            for (const [reference, number] of await listStoreOrderNumbers(
              tx,
              { brandReference: scope.brandReference, storeReference: scope.storeReference },
              listed.slice(index, index + 100),
            ))
              orderNumbers.set(reference, number);
          }
          // The same server-computed recency for every person (Identity enrollment and step-ups).
          const verifiedUntil = async (
            actor: string,
            permissionCode: string,
            orderReference: string,
          ) => {
            try {
              const facts = await authority(tx, {
                ...scope,
                orderReference,
                actorReference: actor,
                permissionCode,
                observedAt,
              });
              return facts.allowed && recentEnough(facts.recentMfaAt, observedAt)
                ? new Date(
                    Date.parse(String(facts.recentMfaAt)) + refundMfaRecencyMilliseconds,
                  ).toISOString()
                : null;
            } catch {
              return null;
            }
          };
          const names = new Map<string, string | null>();
          const name = async (actor: string) => {
            if (!names.has(actor))
              try {
                names.set(actor, (await loadStoreMember(tx, scope, actor)).displayName);
              } catch (error) {
                if (!(error instanceof MemberDirectoryError)) throw error;
                names.set(actor, null);
              }
            return names.get(actor) ?? null;
          };
          // WP-2423 Q19: whether this approver may approve their own requests (sole operator in
          // effect now). Read only when one of the entries is theirs; approval rechecks it.
          const soleOperator =
            canApprove && entries.some((entry) => entry.requesterReference === actorReference)
              ? (
                  await createMerchantSoleOperatorApproval({
                    resolveContext: configuration.workforce.resolveContext,
                    authorize: still,
                  })(tx, {
                    ...scope,
                    permissionCode: "payment.refund.approve",
                    actorReference,
                    observedAt,
                  })
                ).status
              : null;
          const result = [];
          for (const entry of entries) {
            const requesterVerifiedUntil = await verifiedUntil(
              entry.requesterReference,
              "payment.refund.request",
              entry.orderReference,
            );
            const orderNumber = orderNumbers.get(String(entry.orderReference));
            if (orderNumber === undefined) return denied();
            result.push(
              Object.freeze({
                orderReference: entry.orderReference,
                orderNumber,
                requestReference: entry.requestReference,
                paymentIntentReferences: entry.paymentIntentReferences,
                paymentMethod: entry.paymentMethod,
                currencyCode: entry.currencyCode,
                amountMinor: entry.amountMinor.toString(),
                reasonCode: entry.reasonCode,
                note: entry.note,
                escalationReasons: entry.escalationReasons,
                requestedAt: entry.requestedAt,
                requesterName: await name(entry.requesterReference),
                requestedByYou: entry.requesterReference === actorReference,
                requesterVerifiedUntil,
                state: entry.state,
                approvalReference: entry.approval?.approvalReference ?? null,
                approvedAt: entry.approval?.approvedAt ?? null,
                approverName:
                  entry.approval === null ? null : await name(entry.approval.approverReference),
                canApprove:
                  canApprove &&
                  (entry.requesterReference !== actorReference || soleOperator === "Effective") &&
                  (entry.approval === null || entry.approval.approverReference === actorReference),
                /** WP-2423 Q19: approving this one is the Owner approving their own request. */
                soleOperatorApproval:
                  entry.requesterReference === actorReference && soleOperator === "Effective",
              }),
            );
          }
          return Object.freeze({
            observedAt,
            canApprove,
            soleOperator,
            entries: Object.freeze(result),
          });
        },
      ),
    );
}
