import type { ConsumerTransaction } from "@bop/eventing";
import type { createOrdinaryRefundRoleResolver } from "@rms/payment";
import type { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";

type Workforce = ReturnType<typeof createMerchantWorkforcePermissionSource>;
type Role = ReturnType<typeof createOrdinaryRefundRoleResolver>;
/**
 * WP-2423 Q5: who may read a payment's refund summary and history. A Store Manager who may
 * request refunds, or an Owner/Finance member who may approve them. Reading grants no request,
 * approval or execution (the catalog has no separate payment read permission yet).
 */
export async function refundReadAccess(
  workforce: Workforce,
  tx: ConsumerTransaction,
  base: {
    tenantReference: string;
    brandReference: string;
    storeReference: string;
    actorReference: string;
    observedAt: string;
  },
  role: Role,
): Promise<{ readonly canRead: boolean; readonly canRequest: boolean }> {
  const request = await workforce(tx, { ...base, permissionCode: "payment.refund.request" });
  const canRequest =
    request.decision.effect === "Allow" &&
    role("payment.refund.request", request.activeRoleCodes) === "Manager";
  if (canRequest) return Object.freeze({ canRead: true, canRequest });
  const approve = await workforce(tx, { ...base, permissionCode: "payment.refund.approve" });
  const approver = role("payment.refund.approve", approve.activeRoleCodes);
  return Object.freeze({
    canRead:
      approve.decision.effect === "Allow" && (approver === "Owner" || approver === "Finance"),
    canRequest: false,
  });
}
