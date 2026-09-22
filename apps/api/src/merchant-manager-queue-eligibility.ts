import { createPostgresCurrentBrowserSessionSource, parseCanonicalInstant } from "@bop/identity";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import type { ConsumerTransaction } from "@bop/eventing";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
const fail = (): never => {
  throw new Error("MERCHANT_QUEUE_ELIGIBILITY_UNAVAILABLE");
};
const reference = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value))
    return fail();
  return value;
};
/** Prepare BEFORE constructing the Claim command, keeping this transaction open.
 * checkedAt is the actual evaluation clock, never backdated to a request timestamp.
 * Caller must re-prepare/check the same queue qualification before committing the
 * Task mutation; expiry and permission revocation cannot be bypassed by caching. */
export async function prepareMerchantManagerQueueEligibility(
  tx: ConsumerTransaction,
  source: PersistentMerchantBffOptions,
  input: {
    sessionCookie: unknown;
    actorReference: string;
    evidenceReference: string;
    policy: {
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      queueReference: string;
      managerRoleCode: string;
      effectiveFrom: string;
      effectiveUntil: string;
    };
  },
) {
  try {
    const actorReference = reference(input.actorReference),
      evidenceReference = reference(input.evidenceReference),
      cookie = input.sessionCookie;
    const raw = input.policy,
      policy = Object.freeze({
        tenantReference: reference(raw.tenantReference),
        brandReference: reference(raw.brandReference),
        storeReference: reference(raw.storeReference),
        queueReference: reference(raw.queueReference),
        managerRoleCode: raw.managerRoleCode,
        effectiveFrom: parseCanonicalInstant(raw.effectiveFrom),
        effectiveUntil: parseCanonicalInstant(raw.effectiveUntil),
      });
    const checkedAt = parseCanonicalInstant(source.now());
    if (
      !/^[a-z][a-z0-9_]{1,62}[a-z0-9]$/u.test(policy.managerRoleCode) ||
      policy.effectiveFrom > checkedAt ||
      checkedAt >= policy.effectiveUntil
    )
      return fail();
    const now = () => checkedAt;
    const session = await createPostgresCurrentBrowserSessionSource({
      hasher: source.identity.hasher,
      now,
      currentActor: source.currentActor,
    })(tx, cookie);
    if (
      session.actor.actorType !== "User" ||
      session.actor.accountKind !== "Workforce" ||
      session.actor.authenticationMethod !== "Oidc" ||
      session.actor.actorReference === null ||
      String(session.actor.actorReference) !== actorReference
    )
      return fail();
    const selected = await createMerchantSelectedContext({
      now,
      validateSelection: async (...args) => (await source.validateAssociation(...args)) === true,
    })(tx, session);
    const context = selected.context,
      store = context.store;
    if (
      selected.tenantReference !== policy.tenantReference ||
      String(context.brand.brandReference) !== policy.brandReference ||
      store === null ||
      String(store.storeReference) !== policy.storeReference
    )
      return fail();
    const reader = createPostgresCurrentMembershipSource(tx, context);
    const membership = resolveActiveMembership(
      await reader.findMemberships(session.actor.actorReference, context.brand.brandReference),
      session.actor.actorReference,
      context.brand.brandReference,
      checkedAt,
    );
    const assignment = resolveActiveStoreAssignment(
      membership,
      await reader.findStoreAssignments(membership.membershipReference, store.storeReference),
      store.storeReference,
      checkedAt,
    );
    const permission = createPostgresCurrentPermissionPolicySource(tx),
      request = { tenantContext: context, membership, storeAssignment: assignment };
    const access = await permission.authorize({ ...request, action: "merchant.access" });
    const claim = await permission.authorizeWithRoles({ ...request, action: "task.claim" });
    if (
      access.effect !== "Allow" ||
      access.action !== "merchant.access" ||
      claim.decision.effect !== "Allow" ||
      claim.decision.action !== "task.claim" ||
      claim.decision.scopeKind !== "Store" ||
      !claim.activeRoleCodes.includes(policy.managerRoleCode)
    )
      return fail();
    const expiry = [
      policy.effectiveUntil,
      session.idleExpiresAt,
      session.absoluteExpiresAt,
      membership.effectiveUntil,
      assignment.effectiveUntil,
    ]
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort();
    const validUntil = parseCanonicalInstant(expiry[0]);
    if (validUntil <= checkedAt) return fail();
    return Object.freeze({
      evidenceReference,
      actorReference,
      target: Object.freeze({ kind: "Queue" as const, reference: policy.queueReference }),
      scope: Object.freeze({
        kind: "Store" as const,
        brandReference: policy.brandReference,
        storeReference: policy.storeReference,
      }),
      membershipReference: membership.membershipReference,
      storeAssignmentReference: assignment.storeAssignmentReference,
      eligible: true as const,
      checkedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
