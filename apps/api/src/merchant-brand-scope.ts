import { createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import { createPostgresCurrentMembershipSource, resolveActiveMembership } from "@bop/membership";
import {
  createPostgresCurrentPermissionPolicySource,
  type createPostgresTransactionCurrentPermissionPolicySource,
} from "@bop/permission";
type TransactionPermissionPolicy = ReturnType<
  typeof createPostgresTransactionCurrentPermissionPolicySource
>;
import {
  createMerchantStoreScope,
  createInitiallyAuthorizedMerchantStoreScope,
} from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Selected Store access establishes navigation only. Brand actions require
 * their own current Brand-scoped policy decision; a Store grant is insufficient.
 */
export function createMerchantBrandScope(
  source: PersistentMerchantBffOptions,
  permissionPolicy?: TransactionPermissionPolicy,
) {
  const resolveStore =
      permissionPolicy === undefined
        ? createMerchantStoreScope(source)
        : createMerchantStoreScope(source, permissionPolicy),
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
      const decision = await (
        permissionPolicy ?? createPostgresCurrentPermissionPolicySource(transaction)
      ).authorize({
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
    const authorizeActionsWithValidity = async (actions: readonly string[]) => {
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
          !/^[a-z][a-z0-9_.-]*$/.test(d.value) ||
          copied.includes(d.value)
        )
          return null;
        copied.push(d.value);
      }
      if (!batchNow) return null;
      let validUntil: string | null = null,
        latest = "";
      const authorizationValidUntil = (): string | null => validUntil;
      const check = () => {
        const at = parseCanonicalInstant(batchNow());
        if ((latest && at < latest) || (validUntil !== null && at >= validUntil))
          throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
        latest = at;
        return at;
      };
      const retain = (value: unknown, observedAt: string) => {
        if (value === null) return;
        const until = parseCanonicalInstant(value);
        if (until <= observedAt) throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
        if (validUntil === null || until < validUntil) validUntil = until;
      };
      const boundary = (value: unknown) => {
        const d =
          value && typeof value === "object"
            ? Object.getOwnPropertyDescriptor(value, "validUntil")
            : undefined;
        if (!d?.enumerable || !("value" in d)) throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
        return d.value;
      };
      const storeBoundary = (
        value: Awaited<ReturnType<typeof resolveStore>>,
        observedAt: string,
      ) => {
        if (typeof value.authorizationValidUntil !== "function")
          throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
        retain(value.authorizationValidUntil(), observedAt);
        check();
      };
      const startedAt = check();
      storeBoundary(selected, startedAt);
      const current = async () => {
        const observedAt = check();
        const fresh = await (
          permissionPolicy === undefined
            ? createInitiallyAuthorizedMerchantStoreScope(source)
            : createInitiallyAuthorizedMerchantStoreScope(source, permissionPolicy)
        )(transaction, sessionCookie, expectedSession);
        const initialObservedAt = parseCanonicalInstant(fresh.initialObservedAt);
        if (
          fresh.initialAuthorization?.effect !== "Allow" ||
          fresh.initialAuthorization.action !== "merchant.access" ||
          fresh.sessionReference !== expectedSession ||
          initialObservedAt !== String(fresh.context.resolvedAt) ||
          initialObservedAt < String(selected.context.resolvedAt) ||
          initialObservedAt > check() ||
          fresh.selected.tenantReference !== selected.selected.tenantReference ||
          fresh.context.brand.brandReference !== context.brand.brandReference ||
          fresh.store.storeReference !== selected.store.storeReference ||
          fresh.actorReference !== selected.actorReference
        )
          return null;
        storeBoundary(fresh, observedAt);
        return fresh;
      };
      const before = await current();
      if (!before) return null;
      const currentMembership = async (contextSource: typeof before) => {
        const fresh = createTenantContext(
          contextSource.context.actor,
          contextSource.context.brand,
          null,
          check(),
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
        return Object.freeze({ fresh, membership });
      };
      const authorizeCurrent = async (contextSource: typeof before, action: string) => {
        const { fresh, membership } = await currentMembership(contextSource);
        const result = await (
          permissionPolicy ?? createPostgresCurrentPermissionPolicySource(transaction)
        ).authorizeWithRoles({
          tenantContext: fresh,
          membership,
          storeAssignment: null,
          action,
        });
        retain(boundary(result), fresh.resolvedAt);
        check();
        const decision = result.decision;
        if (decision.scopeKind !== "Brand" || decision.action !== action) return null;
        return decision;
      };
      const { fresh, membership } = await currentMembership(before);
      const result = await (
        permissionPolicy ?? createPostgresCurrentPermissionPolicySource(transaction)
      ).authorizeActionsWithRoles({
        tenantContext: fresh,
        membership,
        storeAssignment: null,
        actions: Object.freeze(copied),
      });
      retain(boundary(result), fresh.resolvedAt);
      check();
      if (
        !Array.isArray(result.decisions) ||
        result.decisions.length !== copied.length ||
        result.decisions.some(
          (decision, index) => decision.scopeKind !== "Brand" || decision.action !== copied[index],
        )
      )
        return null;
      const decisions = [...result.decisions];
      const after = await current();
      if (!after) return null;
      // Navigation readers leave Store scope. Recheck the final action after
      // this separate admission checkpoint and retain its original boundary.
      // The owning Permission read also restores Brand RLS for caller SQL.
      const lastAction = copied[copied.length - 1];
      if (!lastAction) return null;
      const last = await authorizeCurrent(after, lastAction);
      if (!last) return null;
      decisions[decisions.length - 1] = last;
      check();
      return Object.freeze({
        decisions: Object.freeze(decisions),
        validUntil: authorizationValidUntil(),
      });
    };
    return Object.freeze({
      tenantReference: selected.selected.tenantReference,
      selectedStoreReference: selected.store.storeReference,
      context,
      actorReference: selected.actorReference,
      authorizeAction,
      authorizeActionsWithValidity,
      async authorizeActions(actions: readonly string[]) {
        return (await authorizeActionsWithValidity(actions))?.decisions ?? null;
      },
    });
  };
}
