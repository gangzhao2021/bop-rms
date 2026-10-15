import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresOrderAcceptanceHoldStore,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { staffOrderCancellationPermission } from "./merchant-order-staff-cancellation.js";

export const acceptanceHoldRefundErrorCodes = [
  "ACCEPTANCE_HOLD_REFUND_INPUT_INVALID",
  "ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED",
  "ACCEPTANCE_HOLD_REFUND_NOT_HELD",
  "ACCEPTANCE_HOLD_REFUND_UNAVAILABLE",
] as const;
export type AcceptanceHoldRefundErrorCode = (typeof acceptanceHoldRefundErrorCodes)[number];
export class AcceptanceHoldRefundError extends Error {
  constructor(readonly code: AcceptanceHoldRefundErrorCode) {
    super(code);
    this.name = "AcceptanceHoldRefundError";
  }
}
const fail = (code: AcceptanceHoldRefundErrorCode): never => {
  throw new AcceptanceHoldRefundError(code);
};

/**
 * WP-2423 Q9-G1 (DEC-OUTAGE-ACCEPTANCE-HOLD): a manager decides to refund an order paid online
 * while the Store was offline instead of accepting it. Ordering records the decision on the hold
 * (append-only, audited with the manager); the order's deadline becomes now, so the System closes
 * it and Payment refunds it in full as for any order not accepted in time. Same authority as a
 * staff cancellation (ordering.order.cancel).
 */
export function createMerchantOrderAcceptanceHoldRefund(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
  audit: Readonly<{ retentionPolicyCode: string; retentionPolicyVersion: number }>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{
    status: "RefundChosen" | "AlreadyChosen";
    orderReference: string;
    decidedAt: string;
  }> => {
    const session = await options.authentication.authorize(input);
    let orderReference: string, orderBatchReference: string, holdReference: string;
    try {
      const intent = readClosedRecord(input.command, [
        "orderReference",
        "orderBatchReference",
        "holdReference",
      ]);
      orderReference = String(parseOrderingReference(intent.orderReference));
      orderBatchReference = String(parseOrderingReference(intent.orderBatchReference));
      holdReference = String(parseOrderingReference(intent.holdReference));
    } catch {
      return fail("ACCEPTANCE_HOLD_REFUND_INPUT_INVALID");
    }
    try {
      const denied = () => fail("ACCEPTANCE_HOLD_REFUND_PERMISSION_DENIED");
      // WP-2423: one authorized run. The caller and `ordering.order.cancel` are resolved in full
      // once at the start and once more before the commit (inside this transaction, so a
      // withdrawn permission or ended Session never commits the refund decision); the hold
      // store's authorize callback, taken while the hold is locked, uses the run's no-query guard.
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const resolved = await resolveScope(
                transaction,
                input.sessionCookie,
                staffOrderCancellationPermission,
                session.sessionReference,
              ).catch(denied);
              if ((await resolved.allowed()) !== true) return denied();
              return resolved;
            },
            recheck: async (scope) => (await scope.allowed()) === true,
            denied,
          },
          async (authority) => {
            const scope = authority.scope;
            const tx = transaction as unknown as ConsumerTransaction;
            const brandReference = String(scope.context.brand.brandReference);
            const storeReference = String(scope.store.storeReference);
            const actorReference = String(scope.actorReference);
            const recordedAt = String(parseOrderingInstant(options.persistence.now()));
            const holds = createPostgresOrderAcceptanceHoldStore({
              brandReference,
              storeReference,
              authorize: async (t) => t === tx && (await authority.guard(t)),
            });
            const result = await holds.resolve(tx, {
              orderReference,
              orderBatchReference,
              holdReference,
              resolution: "StaffRefund",
              storeBackOnlineAt: null,
              decideBy: recordedAt,
              actorReference,
              recordedAt,
              audit: async (hold) => ({
                auditId: options.nextReference(),
                brandId: brandReference,
                storeId: storeReference,
                actor: { type: "User", reference: actorReference },
                actionCode: "ORDER_ACCEPTANCE_HOLD_REFUND_CHOSEN",
                targetType: "OrderAcceptanceHold",
                targetId: hold.holdReference,
                correlationId: hold.holdReference,
                afterSummary: {
                  orderReference: hold.orderReference,
                  holdSequence: hold.sequence,
                  decision: "Refund",
                },
                reasonCode: "PAID_DURING_STORE_OUTAGE",
                occurredAt: recordedAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Restricted",
                retentionPolicyCode: options.audit.retentionPolicyCode,
                retentionPolicyVersion: options.audit.retentionPolicyVersion,
              }),
            });
            if (result.status === "Closed" || result.status === "Stale")
              return fail("ACCEPTANCE_HOLD_REFUND_NOT_HELD");
            const chosen = result.hold.resolutions.find(
              (entry) => entry.resolution === "StaffRefund",
            );
            if (chosen === undefined) return fail("ACCEPTANCE_HOLD_REFUND_UNAVAILABLE");
            return Object.freeze({
              status:
                result.status === "Created"
                  ? ("RefundChosen" as const)
                  : ("AlreadyChosen" as const),
              orderReference,
              decidedAt: chosen.recordedAt,
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof AcceptanceHoldRefundError) throw error;
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: unknown }).code === "ORDER_ACCEPTANCE_HOLD_UNAVAILABLE"
      )
        return fail("ACCEPTANCE_HOLD_REFUND_NOT_HELD");
      return fail("ACCEPTANCE_HOLD_REFUND_UNAVAILABLE");
    }
  };
}
