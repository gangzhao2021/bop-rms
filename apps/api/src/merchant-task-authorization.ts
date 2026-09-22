import {
  assertSessionUsable,
  createPostgresCurrentBrowserSessionSource,
  parseCanonicalInstant,
  type AuthenticationSession,
} from "@bop/identity";
import {
  resolveActiveMembership,
  createPostgresCurrentMembershipSource,
  resolveActiveStoreAssignment,
  type CurrentMembershipReadPort,
} from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import { createTenantContext, type TenantContext } from "@bop/tenant";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const unavailable = (): never => {
  throw new Error("MERCHANT_TASK_AUTHORIZATION_UNAVAILABLE");
};
/** Current staff authority for transaction-bound Task create/assign/claim commands.
 * Injected public session/context/membership adapters must retain their fences
 * until the enclosing transaction ends. Never reuse this result across transactions. */
export function createMerchantTaskAuthorization(
  tx: ConsumerTransaction,
  options: {
    scope: { tenantReference: string; brandReference: string; storeReference: string };
    sessionCookie: unknown;
    now(): string;
    session(tx: ConsumerTransaction, cookie: unknown): Promise<AuthenticationSession>;
    context(
      tx: ConsumerTransaction,
      session: AuthenticationSession,
    ): Promise<{ tenantReference: string; context: TenantContext }>;
    membership(tx: ConsumerTransaction, context: TenantContext): CurrentMembershipReadPort;
  },
) {
  const scope = Object.freeze({ ...options.scope });
  if (
    Object.values(scope).length !== 3 ||
    Object.values(scope).some(
      (value) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value),
    )
  )
    return unavailable();
  const sessionCookie = options.sessionCookie;
  return Object.freeze({
    authorize: async (request: {
      actorReference: string;
      action: string;
      scope: { kind: string; brandReference: string; storeReference: string | null };
      evaluatedAt: string;
    }) => {
      try {
        const input = Object.freeze({
          actorReference: request.actorReference,
          action: request.action,
          scope: Object.freeze({ ...request.scope }),
          evaluatedAt: parseCanonicalInstant(request.evaluatedAt),
        });
        if (
          !["task.create", "task.assign", "task.claim"].includes(input.action) ||
          input.scope.kind !== "Store" ||
          input.scope.brandReference !== scope.brandReference ||
          input.scope.storeReference !== scope.storeReference
        )
          return unavailable();
        const observedAt = parseCanonicalInstant(options.now());
        const session = await options.session(tx, sessionCookie);
        assertSessionUsable(session, observedAt);
        if (input.evaluatedAt > observedAt) return unavailable();
        const actor = session.actor;
        if (
          !Object.isFrozen(session) ||
          actor.actorType !== "User" ||
          actor.accountKind !== "Workforce" ||
          actor.authenticationMethod !== "Oidc" ||
          actor.actorReference === null ||
          String(actor.actorReference) !== input.actorReference
        )
          return unavailable();
        const selected = await options.context(tx, session);
        if (
          selected.tenantReference !== scope.tenantReference ||
          String(selected.context.brand.brandReference) !== scope.brandReference ||
          String(selected.context.store?.storeReference) !== scope.storeReference ||
          selected.context.actor.actorReference !== actor.actorReference ||
          selected.context.store === null
        )
          return unavailable();
        const context = createTenantContext(
          actor,
          selected.context.brand,
          selected.context.store,
          observedAt,
        );
        const store = context.store;
        if (store === null) return unavailable();
        const memberships = options.membership(tx, context);
        const membership = resolveActiveMembership(
          await memberships.findMemberships(actor.actorReference, context.brand.brandReference),
          actor.actorReference,
          context.brand.brandReference,
          observedAt,
        );
        const storeAssignment = resolveActiveStoreAssignment(
          membership,
          await memberships.findStoreAssignments(
            membership.membershipReference,
            store.storeReference,
          ),
          store.storeReference,
          observedAt,
        );
        const policy = createPostgresCurrentPermissionPolicySource(tx);
        const access = await policy.authorize({
          tenantContext: context,
          membership,
          storeAssignment,
          action: "merchant.access",
        });
        if (
          !Object.isFrozen(access) ||
          access.effect !== "Allow" ||
          access.action !== "merchant.access" ||
          access.scopeKind !== "Store"
        )
          return unavailable();
        const decision = await policy.authorize({
          tenantContext: context,
          membership,
          storeAssignment,
          action: input.action,
        });
        if (
          !Object.isFrozen(decision) ||
          decision.effect !== "Allow" ||
          decision.action !== input.action ||
          decision.scopeKind !== "Store"
        )
          return unavailable();
        return decision;
      } catch {
        return unavailable();
      }
    },
  });
}

/** Production-shaped composition of existing public current-state PostgreSQL sources.
 * Does not grant permissions, issue sessions or create Tasks. */
export function createPersistentMerchantTaskAuthorization(
  tx: ConsumerTransaction,
  source: PersistentMerchantBffOptions,
  input: {
    scope: { tenantReference: string; brandReference: string; storeReference: string };
    sessionCookie: unknown;
  },
) {
  return createMerchantTaskAuthorization(tx, {
    ...input,
    now: source.now,
    session: createPostgresCurrentBrowserSessionSource({
      hasher: source.identity.hasher,
      now: source.now,
      currentActor: source.currentActor,
    }),
    context: createMerchantSelectedContext({
      now: source.now,
      validateSelection: async (...args) => (await source.validateAssociation(...args)) === true,
    }),
    membership: createPostgresCurrentMembershipSource,
  });
}
