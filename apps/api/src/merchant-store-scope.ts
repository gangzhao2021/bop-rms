import { createPostgresCurrentBrowserSessionSource } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "@bop/membership";
import {
  createPostgresCurrentPermissionPolicySource,
  type createPostgresTransactionCurrentPermissionPolicySource,
} from "@bop/permission";
type TransactionPermissionPolicy = ReturnType<
  typeof createPostgresTransactionCurrentPermissionPolicySource
>;
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

import { kdsOperatorProfileAllows } from "./merchant-kds-operator-profile.js";
/** Re-exported from the one shared kitchen display profile (merchant-kds-operator-profile.ts). */
export { kdsOperatorProfileActions } from "./merchant-kds-operator-profile.js";

/** Current Workforce session, selected Tenant/Brand/Store and per-action policy.
 * Returned allowed rechecks the same selection and actor in this transaction.
 */
function createMerchantStoreScopeResolver(
  source: PersistentMerchantBffOptions,
  permissionPolicy?: TransactionPermissionPolicy,
) {
  const now = source.now.bind(source);
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: source.identity.hasher,
    now,
    currentActor: source.currentActor,
  });
  const selectedContext = createMerchantSelectedContext({
    now,
    validateSelection: async (...args) => (await source.validateAssociation(...args)) === true,
  });
  type Tx = Parameters<Parameters<typeof source.transactions.run>[0]>[0];
  async function resolveScope(
    tx: Tx,
    sessionCookie: unknown,
    action: string,
    expectedSession?: string,
    initiallyAuthorized = false,
  ) {
    let validUntil: string | null = null,
      latest = "",
      failed = false;
    const denied = (): never => {
      failed = true;
      throw new Error("STORE_SERVICE_PERMISSION_DENIED");
    };
    const check = () => {
      try {
        const at = parseCanonicalInstant(now());
        if (failed || (latest && at < latest) || (validUntil !== null && at >= validUntil))
          return denied();
        latest = at;
        return at;
      } catch {
        return denied();
      }
    };
    const retain = (value: unknown, observedAt: string, nullable: boolean) => {
      if (value === null && nullable) return;
      try {
        const until = parseCanonicalInstant(value);
        if (until <= observedAt) return denied();
        if (validUntil === null || until < validUntil) validUntil = until;
      } catch {
        return denied();
      }
    };
    const field = (value: unknown, key: string): unknown => {
      const d =
        value && typeof value === "object"
          ? Object.getOwnPropertyDescriptor(value, key)
          : undefined;
      return d?.enumerable && "value" in d ? d.value : denied();
    };
    const retainSession = (value: unknown, observedAt: string) => {
      retain(field(value, "idleExpiresAt"), observedAt, false);
      retain(field(value, "absoluteExpiresAt"), observedAt, false);
      check();
    };
    const startedAt = check(),
      session = await currentSession(tx, sessionCookie);
    retainSession(session, startedAt);
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
    const assessSelection = async (
      fresh: Awaited<ReturnType<typeof selectedContext>>,
      requestedAction: string,
    ) => {
      if (!kdsOperatorProfileAllows(session, requestedAction)) return null;
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
      const policy = permissionPolicy ?? createPostgresCurrentPermissionPolicySource(tx);
      // WP-2423 item 4: navigation and the requested action from one permission packet read in
      // this transaction (each action is evaluated on its own, exactly as two single reads would),
      // instead of reading the same locked policy rows twice at the same checkpoint.
      const actions =
        requestedAction === "merchant.access"
          ? ["merchant.access"]
          : ["merchant.access", requestedAction];
      const result = await policy.authorizeActionsWithRoles({
        tenantContext: fresh.context,
        membership,
        storeAssignment,
        actions: Object.freeze(actions),
      });
      retain(field(result, "validUntil"), fresh.context.resolvedAt, true);
      check();
      if (result.decisions.length !== actions.length) return denied();
      const [navigation, decision] = result.decisions;
      if (navigation === undefined) return denied();
      if (navigation.effect !== "Allow") return null;
      if (requestedAction === "merchant.access") return navigation;
      return decision ?? denied();
    };
    type Decision = Awaited<ReturnType<typeof assessSelection>>;
    /**
     * WP-2423: several actions from one current-fact read (Session, selection, membership, store
     * assignment and one permission packet), instead of one full resolution per action. Each
     * action is answered as `authorizeAction` would (null unless navigation is allowed and the
     * Session's kitchen display profile allows it).
     */
    const assessSelectionActions = async (
      fresh: Awaited<ReturnType<typeof selectedContext>>,
      requestedActions: readonly string[],
    ): Promise<ReadonlyMap<string, Decision>> => {
      const unique = [...new Set(requestedActions)].filter((a) => a !== "merchant.access");
      const decisions = new Map<string, Decision>(requestedActions.map((a) => [a, null]));
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
      const policy = permissionPolicy ?? createPostgresCurrentPermissionPolicySource(tx);
      const result = await policy.authorizeActionsWithRoles({
        tenantContext: fresh.context,
        membership,
        storeAssignment,
        actions: Object.freeze(["merchant.access", ...unique]),
      });
      retain(field(result, "validUntil"), fresh.context.resolvedAt, true);
      check();
      const navigation = result.decisions[0];
      if (navigation === undefined || result.decisions.length !== unique.length + 1)
        return denied();
      if (navigation.effect !== "Allow") return decisions;
      if (decisions.has("merchant.access") && kdsOperatorProfileAllows(session, "merchant.access"))
        decisions.set("merchant.access", navigation);
      unique.forEach((action, index) => {
        const decision = result.decisions[index + 1];
        if (decision === undefined) return denied();
        if (kdsOperatorProfileAllows(session, action)) decisions.set(action, decision);
      });
      return decisions;
    };
    const authorizeAction = async (requestedAction: string) => {
      const observedAt = check(),
        current = await currentSession(tx, sessionCookie);
      retainSession(current, observedAt);
      if (current.sessionReference !== session.sessionReference) return null;
      const fresh = await selectedContext(tx, current);
      if (
        fresh.tenantReference !== selected.tenantReference ||
        fresh.context.brand.brandReference !== context.brand.brandReference ||
        fresh.context.store?.storeReference !== store.storeReference ||
        fresh.context.actor.actorReference !== actorReference
      )
        return null;
      return assessSelection(fresh, requestedAction);
    };
    /** Several actions at one checkpoint: one current-fact read for all of them. */
    const authorizeActions = async (
      requestedActions: readonly string[],
    ): Promise<ReadonlyMap<string, Decision>> => {
      if (requestedActions.length < 1 || requestedActions.length > 15) return denied();
      const none = new Map<string, Decision>(requestedActions.map((a) => [a, null]));
      const observedAt = check(),
        current = await currentSession(tx, sessionCookie);
      retainSession(current, observedAt);
      if (current.sessionReference !== session.sessionReference) return none;
      const fresh = await selectedContext(tx, current);
      if (
        fresh.tenantReference !== selected.tenantReference ||
        fresh.context.brand.brandReference !== context.brand.brandReference ||
        fresh.context.store?.storeReference !== store.storeReference ||
        fresh.context.actor.actorReference !== actorReference
      )
        return none;
      return assessSelectionActions(fresh, requestedActions);
    };
    const allowed = async () => (await authorizeAction(action))?.effect === "Allow";
    if (initiallyAuthorized && context.actor.actorReference !== actorReference) return denied();
    // Only this initial checkpoint consumes the just-read locked Session/Selection.
    // Later allowed/authorizeAction calls always reacquire their current facts.
    const initialAuthorization = initiallyAuthorized
      ? await assessSelection(selected, action)
      : null;
    check();
    const scope = {
      selected,
      context,
      store,
      actorReference,
      sessionReference: session.sessionReference,
      /** Brand-level scopes apply the same kitchen display profile limit to this Session. */
      kdsOperatorProfileAllows: (requestedAction: string) =>
        kdsOperatorProfileAllows(session, requestedAction),
      initialAuthorization,
      initialObservedAt: context.resolvedAt,
      allowed,
      authorizeAction,
      authorizeActions,
      // This is an observation boundary, not permission. Call allowed/action
      // first, or consume the initialAuthorization from the fixed initial entry;
      // subsequent session/policy reads may only shorten it.
      authorizationValidUntil: (): string | null => validUntil,
    };
    return initiallyAuthorized ? Object.freeze(scope) : scope;
  }
  return resolveScope;
}

export function createMerchantStoreScope(
  source: PersistentMerchantBffOptions,
  permissionPolicy?: TransactionPermissionPolicy,
) {
  const resolve = createMerchantStoreScopeResolver(source, permissionPolicy);
  return (
    tx: Parameters<typeof resolve>[0],
    sessionCookie: unknown,
    action: string,
    expectedSession?: string,
  ) => resolve(tx, sessionCookie, action, expectedSession);
}

/** Fresh navigation admission at one checkpoint, with no retained Allow for later callbacks. */
export function createInitiallyAuthorizedMerchantStoreScope(
  source: PersistentMerchantBffOptions,
  permissionPolicy?: TransactionPermissionPolicy,
) {
  const resolve = createMerchantStoreScopeResolver(source, permissionPolicy);
  return (tx: Parameters<typeof resolve>[0], sessionCookie: unknown, expectedSession: string) => {
    if (typeof expectedSession !== "string") throw new Error("STORE_SERVICE_PERMISSION_DENIED");
    return resolve(tx, sessionCookie, "merchant.access", expectedSession, true);
  };
}
