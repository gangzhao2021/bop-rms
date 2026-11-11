import type { ConsumerTransaction } from "@bop/eventing";
import type { createOrdinaryRefundRoleResolver } from "@rms/payment";
import type { createMerchantWorkforcePermissionSource } from "./merchant-workforce-authority-source.js";

type Workforce = ReturnType<typeof createMerchantWorkforcePermissionSource>;
type Role = ReturnType<typeof createOrdinaryRefundRoleResolver>;
/**
 * WP-2423 Q5: who may read a payment's refund summary and history. A Store Manager who may
 * request refunds (WP-2423 M14: or a cashier, Staff, who records requests a manager sends), or an
 * Owner/Finance member who may approve them. Reading grants no request,
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
  /** The Session's profile (store scope `kdsOperatorProfileAllows`): a kitchen display sign-in
   * reads no refunds, whatever the Actor's roles allow. */
  profileAllows: (action: string) => boolean,
  /** WP-2423 Q19: an Owner may also request while sole operator is in effect for them. */
  soleOperatorEffective?: () => Promise<boolean>,
): Promise<{
  readonly canRead: boolean;
  readonly canRequest: boolean;
  /**
   * WP-2423 M13 (DEC-OWNER-DEFAULTS-2026-11-06 item 1, two people kept): why this reader may not
   * record a request, so the page names the way forward. SoleOperatorOff: an Owner whose sole
   * operator is not in effect. null when they may request, or only approve (Finance).
   */
  readonly requestBlocked: "SoleOperatorOff" | null;
  /**
   * WP-2423 M14: this reader may send a refund (payment.refund.execute), online or by recording
   * the one made on the Store's card machine or from the drawer. A cashier's request is recorded
   * only; a manager or the owner sends it. An Owner/Finance approver who holds execute sends too
   * (as on Approvals), whether or not they may request.
   */
  readonly canSend: boolean;
}> {
  if (!profileAllows("payment.refund.request") || !profileAllows("payment.refund.approve"))
    return Object.freeze({
      canRead: false,
      canRequest: false,
      requestBlocked: null,
      canSend: false,
    });
  const request = await workforce(tx, { ...base, permissionCode: "payment.refund.request" });
  const requestRole =
    request.decision.effect === "Allow"
      ? role("payment.refund.request", request.activeRoleCodes)
      : null;
  const canRequest =
    requestRole === "Manager" ||
    requestRole === "Staff" ||
    (requestRole === "Owner" &&
      soleOperatorEffective !== undefined &&
      (await soleOperatorEffective()));
  if (canRequest) {
    const execute = await workforce(tx, { ...base, permissionCode: "payment.refund.execute" });
    return Object.freeze({
      canRead: true,
      canRequest,
      requestBlocked: null,
      canSend: execute.decision.effect === "Allow" && requestRole !== "Staff",
    });
  }
  const approve = await workforce(tx, { ...base, permissionCode: "payment.refund.approve" });
  const approver = role("payment.refund.approve", approve.activeRoleCodes);
  const canRead =
    approve.decision.effect === "Allow" && (approver === "Owner" || approver === "Finance");
  return Object.freeze({
    canRead,
    canRequest: false,
    requestBlocked: requestRole === "Owner" ? "SoleOperatorOff" : null,
    // b9 refund-cashier-authorization: the approver may still send (a cashier's request, or
    // record the card-machine refund) when they hold execute, as Approvals lets them.
    canSend:
      canRead &&
      (await workforce(tx, { ...base, permissionCode: "payment.refund.execute" })).decision
        .effect === "Allow",
  });
}
