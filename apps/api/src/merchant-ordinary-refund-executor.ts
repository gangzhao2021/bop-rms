import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";

/** Current owner-backed execute capability; requester/approver MFA is checked
 * separately by Payment. No caller-supplied permission action or role mapping.
 */
export function createMerchantOrdinaryRefundExecutor(
  options: Parameters<typeof createMerchantWorkforcePermissionSource>[0],
) {
  const permission = createMerchantWorkforcePermissionSource(options);
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = readClosedRecord(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "actorReference",
      "observedAt",
    ]);
    const orderReference = String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID"));
    const result = await permission(tx, {
      tenantReference: raw.tenantReference,
      brandReference: raw.brandReference,
      storeReference: raw.storeReference,
      actorReference: raw.actorReference,
      observedAt: raw.observedAt,
      permissionCode: "payment.refund.execute",
    });
    return Object.freeze({
      tenantReference: result.tenantReference,
      brandReference: result.brandReference,
      storeReference: result.storeReference,
      orderReference,
      actorReference: result.actorReference,
      observedAt: result.observedAt,
      permissionCode: "payment.refund.execute" as const,
      active: true,
      allowed: result.decision.effect === "Allow",
    });
  };
}
