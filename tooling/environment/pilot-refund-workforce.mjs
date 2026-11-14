import { createTenantContext } from "../../packages/bop/tenant/src/index.ts";
import { parseCanonicalInstant } from "../../packages/bop/identity/src/index.ts";
import { notAfterDatabaseNow } from "./pilot-database-clock.mjs";

/**
 * WP-2423 M15: the `current` check refund authority is resolved under: the same transaction, an
 * instant not after the database's now (never the application clock, which trails it), and the
 * session's authority still in effect.
 */
export function refundAuthorityCurrent(tx, authorize) {
  return async (t, at) => t === tx && (await notAfterDatabaseNow(t, at)) && (await authorize());
}

const refundPermissions = ["payment.refund.request", "payment.refund.approve"];
/**
 * WP-2423 Q5: InternalTest workforce context for refund authority. The signed-in actor uses its
 * own session context; the other party of an escalated refund (the recorded requester, or the
 * recorded approver) is resolved through the Identity roster (`currentActor`) for request/approve
 * facts only, with Membership, Permission and MFA then read from their owners for that person.
 * Execution is never resolved for anyone but the signed-in actor; no session is borrowed.
 * `permissions` (WP-2423 DEC-SOLE-OPERATOR-APPROVAL) names another approval permission set this
 * context answers for instead (Store configuration approval); execution is then never answered.
 */
export function createInternalRefundWorkforceContext({
  expected,
  persistence,
  sessionActorReference,
  sessionContext,
  current,
  permissions = null,
}) {
  const deny = () => {
    throw new Error("INTERNAL_REFUND_WORKFORCE_DENIED");
  };
  return async (tx, query) => {
    for (const key of ["tenantReference", "brandReference", "storeReference"])
      if (query[key] !== expected[key]) deny();
    const observedAt = parseCanonicalInstant(query.observedAt);
    const own = query.actorReference === sessionActorReference;
    const answered =
      permissions !== null
        ? permissions
        : own
          ? [...refundPermissions, "payment.refund.execute"]
          : refundPermissions;
    if (!answered.includes(query.permissionCode) || !(await current(tx, observedAt))) deny();
    const context = await sessionContext(tx, observedAt);
    if (
      context.actor.actorReference !== sessionActorReference ||
      context.brand.brandReference !== expected.brandReference ||
      context.store?.storeReference !== expected.storeReference
    )
      deny();
    const actor = own
      ? context.actor
      : await persistence.currentActor(tx, query.actorReference, observedAt, observedAt);
    if (actor.actorReference !== query.actorReference) deny();
    return {
      tenantReference: expected.tenantReference,
      context: createTenantContext(actor, context.brand, context.store, observedAt),
    };
  };
}
