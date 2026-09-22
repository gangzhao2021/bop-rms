import {
  createPostgresBrowserSessionSelectionStore,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  type BrowserSessionSelection,
  type createPostgresBrowserSessionStore,
} from "@bop/identity";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "@bop/membership";
import {
  createPostgresMerchantOrganizationSource,
  createTenantContext,
  parseBrandReference,
  parseStoreReference,
} from "@bop/tenant";

type SessionCreated = NonNullable<
  Parameters<typeof createPostgresBrowserSessionStore>[0]["onSessionCreated"]
>;
type Association = Parameters<typeof createPostgresBrowserSessionSelectionStore>[0]["validate"];

/** Request-scoped hook for the Identity store transaction.
 * Target scope comes from trusted server resolution. Association must fence the
 * current Tenant/Brand link; stored selection alone never supplies that authority.
 * A thrown error rolls back both the session rotation and its selection.
 */
export function createMerchantSessionSelection(options: {
  readonly scope: BrowserSessionSelection;
  readonly actorReference: string;
  readonly previousSessionReference: string | null;
  readonly now: () => string;
  readonly validateAssociation: Association;
}): SessionCreated {
  const scope = Object.freeze({
    tenantReference: parseOpaqueUuidV7(options.scope.tenantReference, "ACTOR_REFERENCE_INVALID"),
    brandReference: parseBrandReference(options.scope.brandReference),
    storeReference: parseStoreReference(options.scope.storeReference),
  });
  const actorReference = parseOpaqueUuidV7(options.actorReference, "ACTOR_REFERENCE_INVALID");
  const previousSessionReference =
    options.previousSessionReference === null
      ? null
      : parseOpaqueUuidV7(options.previousSessionReference, "ACTOR_REFERENCE_INVALID");
  const selections = createPostgresBrowserSessionSelectionStore({
    async validate(tx, session, selected, at) {
      if (
        session.actor.actorReference !== actorReference ||
        session.rotatedFromSessionReference !== previousSessionReference ||
        selected.tenantReference !== scope.tenantReference ||
        selected.brandReference !== scope.brandReference ||
        selected.storeReference !== scope.storeReference ||
        (await options.validateAssociation(tx, session, selected, at)) !== true
      )
        return false;
      const currentActorReference = session.actor.actorReference;
      if (currentActorReference === null) return false;
      const organizations = createPostgresMerchantOrganizationSource(tx, {
        ...scope,
        observedAt: at,
      });
      const brand = await organizations.getBrand(scope.brandReference);
      const store = await organizations.getStore(scope.storeReference);
      if (!brand || !store) return false;
      const context = createTenantContext(session.actor, brand, store, at);
      const memberships = createPostgresCurrentMembershipSource(tx, context);
      const membership = resolveActiveMembership(
        await memberships.findMemberships(currentActorReference, scope.brandReference),
        currentActorReference,
        scope.brandReference,
        at,
      );
      resolveActiveStoreAssignment(
        membership,
        await memberships.findStoreAssignments(
          membership.membershipReference,
          scope.storeReference,
        ),
        scope.storeReference,
        at,
      );
      return (await options.validateAssociation(tx, session, selected, at)) === true;
    },
  });
  return async (tx, record) => {
    try {
      await selections.write(tx, record.session, scope, parseCanonicalInstant(options.now()));
    } catch {
      throw new Error("MERCHANT_SESSION_SELECTION_DENIED");
    }
  };
}
