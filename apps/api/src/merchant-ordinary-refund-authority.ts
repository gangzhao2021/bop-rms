import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresLatestWorkforceStepUpSource,
  parseOpaqueUuidV7,
  readClosedRecord,
  resolveRecentWorkforceMfaAt,
} from "@bop/identity";
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
    /** WP-2423 Q5: recent MFA also counts the actor's latest step-up at this Store
     * (Identity owner read), not only the original enrollment verification. */
    stepUp?: boolean;
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
    const latestStepUpAt =
      options.stepUp === true
        ? await createPostgresLatestWorkforceStepUpSource({
            // The same retained actor/Store fence as the enrollment read.
            authorize: async (_tx, query) => {
              const fresh = await options.resolveContext(tx, {
                tenantReference: current.tenantReference,
                brandReference: current.brandReference,
                storeReference: current.storeReference,
                actorReference: current.actorReference,
                observedAt: current.observedAt,
                permissionCode: current.permissionCode,
              });
              return (
                query.actorReference === current.actorReference &&
                query.observedAt === String(current.observedAt) &&
                fresh.tenantReference === current.tenantReference &&
                fresh.context.actor.actorReference === current.actorReference &&
                fresh.context.actor.status === "Active" &&
                fresh.context.brand.brandReference === query.brandReference &&
                fresh.context.store?.storeReference === query.storeReference &&
                String(fresh.context.resolvedAt) === String(current.observedAt)
              );
            },
          })(tx, {
            brandReference: current.brandReference,
            storeReference: current.storeReference,
            actorReference: current.actorReference,
            observedAt: current.observedAt,
          })
        : null;
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
      recentMfaAt: resolveRecentWorkforceMfaAt({
        status: current.mfa.status,
        verifiedAt: current.mfa.verifiedAt,
        resetAt: current.mfa.resetAt,
        latestStepUpAt,
      }),
      observedAt: current.observedAt,
    });
  };
}
