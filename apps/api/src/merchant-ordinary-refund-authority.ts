import type { ConsumerTransaction } from "@bop/eventing";
import { parseOpaqueUuidV7, readClosedRecord } from "@bop/identity";
import { createOrdinaryRefundRoleResolver } from "@rms/payment";
import { createMerchantWorkforceAuthoritySource } from "./merchant-workforce-authority-source.js";

type WorkforceOptions = Parameters<typeof createMerchantWorkforceAuthoritySource>[0];
/** Composes owner facts into Payment's approval port. Scoped role mapping is
 * trusted configuration read under retained fences, never browser input.
 */
export function createMerchantOrdinaryRefundAuthority(
  options: WorkforceOptions & {
    resolveRoleMapping(
      tx: ConsumerTransaction,
      scope: {
        tenantReference: string;
        brandReference: string;
        storeReference: string;
        observedAt: string;
      },
    ): Promise<unknown>;
  },
) {
  const workforce = createMerchantWorkforceAuthoritySource(options);
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = readClosedRecord(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "actorReference",
      "permissionCode",
      "observedAt",
    ]);
    const orderReference = String(parseOpaqueUuidV7(raw.orderReference, "ACTOR_REFERENCE_INVALID"));
    const current = await workforce(tx, {
      tenantReference: raw.tenantReference,
      brandReference: raw.brandReference,
      storeReference: raw.storeReference,
      actorReference: raw.actorReference,
      permissionCode: raw.permissionCode,
      observedAt: raw.observedAt,
    });
    const mapping = await options.resolveRoleMapping(tx, {
      tenantReference: current.tenantReference,
      brandReference: current.brandReference,
      storeReference: current.storeReference,
      observedAt: current.observedAt,
    });
    const role = createOrdinaryRefundRoleResolver(mapping)(
      current.permissionCode,
      current.activeRoleCodes,
    );
    if (role === null) throw new Error("ORDINARY_REFUND_AUTHORITY_DENIED");
    return Object.freeze({
      tenantReference: current.tenantReference,
      brandReference: current.brandReference,
      storeReference: current.storeReference,
      orderReference,
      actorReference: current.actorReference,
      role,
      active: true,
      permissionCode: current.permissionCode,
      allowed: current.decision.effect === "Allow",
      recentMfaAt: current.mfa.status === "TotpVerified" ? current.mfa.verifiedAt : null,
      observedAt: current.observedAt,
    });
  };
}
