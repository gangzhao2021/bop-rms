import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import {
  createPostgresMerchantOrganizationSource,
  createTenantContext,
  parseBrandReference,
  parseStoreReference,
} from "@bop/tenant";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Transaction = Parameters<
  Parameters<PersistentMerchantBffOptions["transactions"]["run"]>[0]
>[0];

/**
 * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION segment 7: may the person whose Session this is act on
 * another Store of the Brand they are signed in to (without switching to it) — a read the Brand
 * page makes per Store? Exactly the check switching there would make, in the caller's transaction:
 * a current workforce Session; the target Store of the same Brand, served and associated
 * (`targetScope`); the person's current Membership and Store assignment there; and an Allow for
 * `merchant.access` and the action in that Store's current permission policy. Anything else: null.
 */
export function createMerchantTargetStoreAuthority(options: PersistentMerchantBffOptions) {
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: options.identity.hasher,
    now: options.now,
    currentActor: options.currentActor,
  });
  const selectedContext = createMerchantSelectedContext({
    now: options.now,
    validateSelection: async (...args) => (await options.validateAssociation(...args)) === true,
  });
  return async (
    tx: Transaction,
    sessionCookie: unknown,
    targetStoreReference: string,
    action: string,
  ) => {
    try {
      const target = String(parseStoreReference(targetStoreReference));
      const session = await currentSession(tx, sessionCookie);
      const actor = session.actor.actorReference;
      if (
        actor === null ||
        session.actor.actorType !== "User" ||
        session.actor.accountKind !== "Workforce"
      )
        return null;
      const selected = await selectedContext(tx, session);
      const scope = await options.targetScope(tx, session, target);
      if (
        scope.storeReference !== target ||
        scope.brandReference !== selected.context.brand.brandReference ||
        scope.tenantReference !== selected.tenantReference
      )
        return null;
      const at = selected.context.resolvedAt;
      const organizations = createPostgresMerchantOrganizationSource(tx, {
        ...scope,
        observedAt: at,
      });
      const brand = await organizations.getBrand(parseBrandReference(scope.brandReference));
      const store = await organizations.getStore(parseStoreReference(scope.storeReference));
      if (!brand || !store) return null;
      const context = createTenantContext(session.actor, brand, store, at);
      const memberships = createPostgresCurrentMembershipSource(tx, context);
      const membership = resolveActiveMembership(
        await memberships.findMemberships(actor, brand.brandReference),
        actor,
        brand.brandReference,
        at,
      );
      const storeAssignment = resolveActiveStoreAssignment(
        membership,
        await memberships.findStoreAssignments(
          membership.membershipReference,
          store.storeReference,
        ),
        store.storeReference,
        at,
      );
      const result = await createPostgresCurrentPermissionPolicySource(
        tx,
      ).authorizeActionsWithRoles({
        tenantContext: context,
        membership,
        storeAssignment,
        actions: Object.freeze(
          action === "merchant.access" ? ["merchant.access"] : ["merchant.access", action],
        ),
      });
      if (
        result.decisions.length !== (action === "merchant.access" ? 1 : 2) ||
        result.decisions.some((decision) => decision.effect !== "Allow")
      )
        return null;
      return Object.freeze({
        sessionReference: String(session.sessionReference),
        tenantReference: String(selected.tenantReference),
        brandReference: String(brand.brandReference),
        storeReference: String(store.storeReference),
        storeLabel: String(store.displayName),
        timeZone: String(store.timeZone),
        locale: String(store.locale),
      });
    } catch {
      return null;
    }
  };
}
