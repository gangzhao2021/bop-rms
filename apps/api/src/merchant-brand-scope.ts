import { createTenantContext } from "@bop/tenant";
import { createPostgresCurrentMembershipSource, resolveActiveMembership } from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Selected Store access establishes navigation only. Brand actions require
 * their own current Brand-scoped policy decision; a Store grant is insufficient.
 */
export function createMerchantBrandScope(source: PersistentMerchantBffOptions) {
  const resolveStore = createMerchantStoreScope(source),
    batchNow = typeof source.now === "function" ? source.now.bind(source) : undefined;
  type Transaction = Parameters<Parameters<typeof source.transactions.run>[0]>[0];
  return async (transaction: Transaction, sessionCookie: unknown, expectedSession: string) => {
    if (typeof expectedSession !== "string") throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
    const selected = await resolveStore(
      transaction,
      sessionCookie,
      "merchant.access",
      expectedSession,
    );
    if (!(await selected.allowed())) throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
    const context = createTenantContext(
      selected.context.actor,
      selected.context.brand,
      null,
      selected.context.resolvedAt,
    );
    const authorizeAction = async (action: string) => {
      const current = await resolveStore(
        transaction,
        sessionCookie,
        "merchant.access",
        expectedSession,
      );
      if (
        !(await current.allowed()) ||
        current.selected.tenantReference !== selected.selected.tenantReference ||
        current.context.brand.brandReference !== context.brand.brandReference ||
        current.store.storeReference !== selected.store.storeReference ||
        current.actorReference !== selected.actorReference
      )
        return null;
      const fresh = createTenantContext(
        current.context.actor,
        current.context.brand,
        null,
        current.context.resolvedAt,
      );
      const memberships = createPostgresCurrentMembershipSource(transaction, current.context);
      const membership = resolveActiveMembership(
        await memberships.findMemberships(current.actorReference, fresh.brand.brandReference),
        current.actorReference,
        fresh.brand.brandReference,
        fresh.resolvedAt,
      );
      const decision = await createPostgresCurrentPermissionPolicySource(transaction).authorize({
        tenantContext: fresh,
        membership,
        storeAssignment: null,
        action,
      });
      if (decision.scopeKind !== "Brand" || decision.action !== action) return null;
      return decision;
    };
    // One admission checkpoint only. Never retain a session or policy decision
    // across source callbacks, writes or COMMIT guards.
    const authorizeActions = async (actions: readonly string[]) => {
      if (
        !Array.isArray(actions) ||
        Object.getPrototypeOf(actions) !== Array.prototype ||
        actions.length < 1 ||
        actions.length > 16 ||
        Reflect.ownKeys(actions).length !== actions.length + 1
      )
        return null;
      const copied: string[] = [];
      for (let i = 0; i < actions.length; i++) {
        const d = Object.getOwnPropertyDescriptor(actions, String(i));
        if (
          !d?.enumerable ||
          !("value" in d) ||
          typeof d.value !== "string" ||
          d.value.length > 128 ||
          !/^[a-z][a-z0-9_.]*$/.test(d.value) ||
          copied.includes(d.value)
        )
          return null;
        copied.push(d.value);
      }
      const current = async () => {
        const fresh = await resolveStore(
          transaction,
          sessionCookie,
          "merchant.access",
          expectedSession,
        );
        if (
          !(await fresh.allowed()) ||
          fresh.selected.tenantReference !== selected.selected.tenantReference ||
          fresh.context.brand.brandReference !== context.brand.brandReference ||
          fresh.store.storeReference !== selected.store.storeReference ||
          fresh.actorReference !== selected.actorReference
        )
          return null;
        return fresh;
      };
      if (!batchNow) return null;
      const before = await current();
      if (!before) return null;
      const authorizeCurrent = async (contextSource: typeof before, action: string) => {
        const fresh = createTenantContext(
          contextSource.context.actor,
          contextSource.context.brand,
          null,
          batchNow(),
        );
        const membershipContext = createTenantContext(
          contextSource.context.actor,
          contextSource.context.brand,
          contextSource.context.store,
          fresh.resolvedAt,
        );
        const memberships = createPostgresCurrentMembershipSource(transaction, membershipContext);
        const membership = resolveActiveMembership(
          await memberships.findMemberships(
            contextSource.actorReference,
            fresh.brand.brandReference,
          ),
          contextSource.actorReference,
          fresh.brand.brandReference,
          fresh.resolvedAt,
        );
        const decision = await createPostgresCurrentPermissionPolicySource(transaction).authorize({
          tenantContext: fresh,
          membership,
          storeAssignment: null,
          action,
        });
        if (decision.scopeKind !== "Brand" || decision.action !== action) return null;
        return decision;
      };
      const decisions = [];
      for (const action of copied) {
        const decision = await authorizeCurrent(before, action);
        if (!decision) return null;
        decisions.push(decision);
      }
      const after = await current();
      if (!after) return null;
      // Navigation readers leave Store scope. Re-enter Brand scope through the
      // owning Permission reader, retaining current membership and final action.
      const lastAction = copied[copied.length - 1];
      if (!lastAction) return null;
      const last = await authorizeCurrent(after, lastAction);
      if (!last) return null;
      decisions[decisions.length - 1] = last;
      return Object.freeze(decisions);
    };
    return Object.freeze({
      tenantReference: selected.selected.tenantReference,
      selectedStoreReference: selected.store.storeReference,
      context,
      actorReference: selected.actorReference,
      authorizeAction,
      authorizeActions,
    });
  };
}
