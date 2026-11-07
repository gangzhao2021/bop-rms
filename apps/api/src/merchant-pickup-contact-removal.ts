import type { ConsumerTransaction } from "@bop/eventing";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import {
  CheckoutContactRemovalError,
  parseOrderingInstant,
  parseOrderingReference,
  removeCheckoutContactOnStaffRequest,
} from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { keepingCause, onlyRefusal } from "./merchant-failure.js";

/**
 * M108 (WP-2423 decision recorded 2026-11-06): removing a guest's pickup contact at the guest's
 * request is held by whoever hands orders over: the Store's "Close an order" permission
 * (owner, store manager, area manager and front of house presets; kitchen and inventory presets
 * do not hold it). No new permission is added.
 */
export const pickupContactRemovalPermission = "ordering.order.close" as const;

export const pickupContactRemovalErrorCodes = [
  "PICKUP_CONTACT_REMOVAL_INPUT_INVALID",
  "PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED",
  "PICKUP_CONTACT_REMOVAL_NOT_FOUND",
  "PICKUP_CONTACT_REMOVAL_UNAVAILABLE",
] as const;
export type PickupContactRemovalErrorCode = (typeof pickupContactRemovalErrorCodes)[number];
export class PickupContactRemovalError extends Error {
  constructor(readonly code: PickupContactRemovalErrorCode) {
    super("pickup contact removal is unavailable");
    this.name = "PickupContactRemovalError";
  }
}
const fail = (code: PickupContactRemovalErrorCode): never => {
  throw new PickupContactRemovalError(code);
};

/**
 * M108: a guest whose visit on their phone has ended asks the store to remove the pickup contact
 * they gave; staff remove it from the order's detail. One transaction: permission → Ordering
 * removes the contact once, with evidence naming the staff member (never the value) → a staff
 * audit record without the value. The order, payment and receipt history are unchanged. A replay
 * with the same operation reference answers as the first time and writes nothing.
 */
export function createMerchantPickupContactRemoval(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ status: "Removed" | "AlreadyRemoved" | "NotGiven" }> => {
    const session = await options.authentication.authorize(input);
    let orderReference: string, operationReference: string;
    try {
      const intent = readClosedRecord(input.command, ["orderReference", "operationReference"]);
      orderReference = String(parseOrderingReference(intent.orderReference));
      operationReference = String(parseOrderingReference(intent.operationReference));
    } catch {
      return fail("PICKUP_CONTACT_REMOVAL_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                pickupContactRemovalPermission,
                session.sessionReference,
              ).catch(onlyRefusal(() => fail("PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED")));
              if ((await current.allowed()) !== true)
                return fail("PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED"),
          },
          async (authority) => {
            const scope = authority.scope;
            const tx = transaction as unknown as ConsumerTransaction;
            const selected = {
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const actorReference = String(scope.actorReference);
            // A replay of this operation: its staff audit exists, so the answer is the first one.
            const prior = await tx.query(
              "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE audit_id=$1",
              [operationReference],
            );
            if (prior.rows[0]?.n === 1) {
              if (!(await authority.guard()))
                return fail("PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED");
              return Object.freeze({ status: "Removed" as const });
            }
            const observedAt = parseOrderingInstant(options.persistence.now());
            let result: Awaited<ReturnType<typeof removeCheckoutContactOnStaffRequest>>;
            try {
              result = await removeCheckoutContactOnStaffRequest(tx, selected, {
                orderReference,
                actorReference,
                observedAt,
                redactionReference: operationReference,
              });
            } catch (error) {
              if (
                error instanceof CheckoutContactRemovalError &&
                error.code === "CHECKOUT_CONTACT_REMOVAL_NOT_FOUND"
              )
                return fail("PICKUP_CONTACT_REMOVAL_NOT_FOUND");
              throw error;
            }
            if (result.status === "Removed")
              await appendAuditRecordInTransaction(
                tx,
                validateAuditRecord({
                  auditId: operationReference,
                  brandId: selected.brandReference,
                  storeId: selected.storeReference,
                  actor: { type: "User", reference: actorReference },
                  actionCode: "CHECKOUT_CONTACT_REMOVED_BY_STAFF",
                  targetType: "OrderCheckoutContact",
                  targetId: orderReference,
                  reasonCode: "CUSTOMER_REQUEST",
                  correlationId: operationReference,
                  occurredAt: observedAt,
                  sourceChannel: "MERCHANT_WEB",
                  dataClassification: "Restricted",
                  retentionPolicyCode: "AUDIT_DEFAULT",
                  retentionPolicyVersion: 1,
                }),
              );
            if (!(await authority.guard())) return fail("PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED");
            return Object.freeze({ status: result.status });
          },
        ),
      );
    } catch (error) {
      if (error instanceof PickupContactRemovalError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED")
        return fail("PICKUP_CONTACT_REMOVAL_PERMISSION_DENIED");
      return keepingCause(() => fail("PICKUP_CONTACT_REMOVAL_UNAVAILABLE"))(error);
    }
  };
}
