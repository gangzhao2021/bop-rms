import {
  assertSessionUsable,
  parseCanonicalInstant,
  type AuthenticationSession,
} from "@bop/identity";
import {
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  type CurrentMembershipReadPort,
} from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import { createTenantContext, type TenantContext } from "@bop/tenant";
import type { ConsumerTransaction } from "@bop/eventing";
import type { MerchantExceptionScope } from "./merchant-order-exception-read.js";

/** Transaction-bound public adapters resolve credentials, selected scope and current policy. */
export function createMerchantOrderExceptionAuthorization(options: {
  now(): string;
  session(tx: ConsumerTransaction, cookie: unknown): Promise<AuthenticationSession>;
  context(
    tx: ConsumerTransaction,
    session: AuthenticationSession,
  ): Promise<{ tenantReference: string; context: TenantContext }>;
  membership(tx: ConsumerTransaction, context: TenantContext): CurrentMembershipReadPort;
}) {
  return async (
    tx: ConsumerTransaction,
    input: { sessionCookie: unknown; permission: "operations.order-exception.manage" },
  ): Promise<MerchantExceptionScope | null> => {
    try {
      if (input.permission !== "operations.order-exception.manage") return null;
      const observedAt = parseCanonicalInstant(options.now());
      const session = await options.session(tx, input.sessionCookie);
      assertSessionUsable(session, observedAt);
      const actor = session.actor;
      if (
        !Object.isFrozen(session) ||
        actor.actorType !== "User" ||
        actor.accountKind !== "Workforce" ||
        actor.authenticationMethod !== "Oidc" ||
        actor.actorReference === null
      )
        return null;
      const selected = await options.context(tx, session);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          selected.tenantReference,
        ) ||
        selected.context.actor.actorReference !== actor.actorReference ||
        selected.context.store === null
      )
        return null;
      const context = createTenantContext(
        actor,
        selected.context.brand,
        selected.context.store,
        observedAt,
      );
      const store = context.store;
      if (store === null) return null;
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
      const decision = await createPostgresCurrentPermissionPolicySource(tx).authorize({
        tenantContext: context,
        membership,
        storeAssignment,
        action: input.permission,
      });
      if (decision.effect !== "Allow") return null;
      return Object.freeze({
        tenantReference: selected.tenantReference,
        brandReference: context.brand.brandReference,
        storeReference: store.storeReference,
        sessionReference: session.sessionReference,
      });
    } catch {
      return null;
    }
  };
}
