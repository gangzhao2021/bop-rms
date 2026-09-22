import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Current Workforce session, selected Tenant/Brand/Store and per-action policy.
 * Returned allowed rechecks the same selection and actor in this transaction.
 */
export function createMerchantStoreScope(source: PersistentMerchantBffOptions) {
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: source.identity.hasher,
    now: source.now,
    currentActor: source.currentActor,
  });
  const selectedContext = createMerchantSelectedContext({
    now: source.now,
    validateSelection: async (...args) => (await source.validateAssociation(...args)) === true,
  });
  type Tx = Parameters<Parameters<typeof source.transactions.run>[0]>[0];
  async function resolveScope(
    tx: Tx,
    sessionCookie: unknown,
    action: string,
    expectedSession?: string,
  ) {
    const session = await currentSession(tx, sessionCookie);
    if (
      (expectedSession !== undefined && session.sessionReference !== expectedSession) ||
      session.actor.actorType !== "User" ||
      session.actor.accountKind !== "Workforce" ||
      session.actor.authenticationMethod !== "Oidc" ||
      session.actor.actorReference === null
    )
      throw new Error("STORE_SERVICE_PERMISSION_DENIED");
    const selected = await selectedContext(tx, session);
    const context = selected.context;
    const store = context.store;
    if (!store) throw new Error("STORE_SERVICE_PERMISSION_DENIED");
    const actorReference = session.actor.actorReference;
    const authorizeAction = async (requestedAction: string) => {
      const current = await currentSession(tx, sessionCookie);
      if (current.sessionReference !== session.sessionReference) return null;
      const fresh = await selectedContext(tx, current);
      if (
        fresh.tenantReference !== selected.tenantReference ||
        fresh.context.brand.brandReference !== context.brand.brandReference ||
        fresh.context.store?.storeReference !== store.storeReference ||
        fresh.context.actor.actorReference !== actorReference
      )
        return null;
      const memberships = createPostgresCurrentMembershipSource(tx, fresh.context);
      const membership = resolveActiveMembership(
        await memberships.findMemberships(actorReference, context.brand.brandReference),
        actorReference,
        context.brand.brandReference,
        fresh.context.resolvedAt,
      );
      const storeAssignment = resolveActiveStoreAssignment(
        membership,
        await memberships.findStoreAssignments(
          membership.membershipReference,
          store.storeReference,
        ),
        store.storeReference,
        fresh.context.resolvedAt,
      );
      const policy = createPostgresCurrentPermissionPolicySource(tx);
      const request = { tenantContext: fresh.context, membership, storeAssignment };
      if ((await policy.authorize({ ...request, action: "merchant.access" })).effect !== "Allow")
        return null;
      return policy.authorize({ ...request, action: requestedAction });
    };
    const allowed = async () => (await authorizeAction(action))?.effect === "Allow";
    return {
      selected,
      context,
      store,
      actorReference,
      sessionReference: session.sessionReference,
      allowed,
      authorizeAction,
    };
  }
  return resolveScope;
}
