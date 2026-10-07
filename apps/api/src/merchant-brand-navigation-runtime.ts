import {
  assertSessionUsable,
  createAuthenticationSession,
  createIdentityActor,
  parseCanonicalInstant,
  readClosedRecord,
  type AuthenticationSession,
} from "@bop/identity";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "@bop/membership";
import {
  createPostgresTransactionCurrentPermissionPolicySource,
  revalidateTenantContext,
} from "@bop/permission";
import {
  createTenantContext,
  parsePlatformTenantReference,
  parseBrandReference,
  BrandStoreTopologyError,
} from "@bop/tenant";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import {
  createMerchantBrandStoreTopologyCapability,
  merchantBrandStoreTopologyCapabilityRequiredFields,
} from "./merchant-brand-store-topology-capability.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Transaction = Parameters<Host["registerBeforeCommit"]>[0];
type Selected = Awaited<ReturnType<ReturnType<typeof createMerchantSelectedContext>>>;
export interface MerchantBrandNavigationRuntimeOptions {
  readonly transaction: Transaction;
  readonly session: AuthenticationSession;
  readonly selected: Selected;
  readonly now: () => string;
  readonly currentActor: PersistentMerchantBffOptions["currentActor"];
  readonly validateAssociation: PersistentMerchantBffOptions["validateAssociation"];
  readonly observedAt: string;
  readonly validUntil: string;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
}
export interface MerchantBrandNavigationEntry {
  readonly screenId: "ORG-BRAND-DETAIL";
  readonly href: string;
}
const fail = (): never => {
  throw new BrandStoreTopologyError("BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
/** Server-only admission over the Identity owner's already locked real session.
 * No cookie re-resolution, nested transaction, workspace read or positive grant. */
export function createMerchantBrandNavigationRuntime(
  options: MerchantBrandNavigationRuntimeOptions,
) {
  const tx = options.transaction,
    query = tx.query,
    clockPort = options.now,
    actorPort = options.currentActor,
    associationPort = options.validateAssociation,
    registerPort = options.registerBeforeCommit,
    sessionInput = options.session,
    selectionInput = options.selected;
  const raw = readClosedRecord(sessionInput, [
    "sessionReference",
    "actor",
    "status",
    "policy",
    "version",
    "authenticatedAt",
    "createdAt",
    "lastSeenAt",
    "idleExpiresAt",
    "absoluteExpiresAt",
    "rotatedFromSessionReference",
    "revocationReason",
    "revokedAt",
  ]);
  const policy = readClosedRecord(raw.policy, [
    "code",
    "maxActiveSessions",
    "idleTimeoutMinutes",
    "absoluteTimeoutMinutes",
  ]);
  const { policy: discarded, ...sessionFields } = raw;
  void discarded;
  const session = createAuthenticationSession({
    ...sessionFields,
    policyCode: policy.code,
    maxActiveSessions: policy.maxActiveSessions,
    idleTimeoutMinutes: policy.idleTimeoutMinutes,
    absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
  });
  const selected = readClosedRecord(selectionInput, ["tenantReference", "context"]);
  const initialContext = revalidateTenantContext(selectionInput.context),
    tenantReference = parsePlatformTenantReference(selected.tenantReference),
    actorReference = session.actor.actorReference,
    brandReference = initialContext.brand.brandReference,
    storeReference = initialContext.store?.storeReference;
  const observedAt = parseCanonicalInstant(options.observedAt),
    validUntil = parseCanonicalInstant(options.validUntil);
  if (
    [query, clockPort, actorPort, associationPort, registerPort].some(
      (port) => typeof port !== "function",
    ) ||
    !actorReference ||
    !storeReference ||
    session.actor.actorType !== "User" ||
    session.actor.accountKind !== "Workforce" ||
    session.actor.authenticationMethod !== "Oidc" ||
    session.actor.status !== "Active" ||
    !equal(initialContext.actor, session.actor) ||
    String(initialContext.resolvedAt) < String(observedAt) ||
    validUntil <= observedAt ||
    Date.parse(validUntil) - Date.parse(observedAt) > 5000
  )
    return fail();
  const scope = Object.freeze({
    tenantReference: parsePlatformTenantReference(tenantReference),
    brandReference: parseBrandReference(brandReference),
    actorReference: parseBrandReference(actorReference),
  });
  const permissionSource = createPostgresTransactionCurrentPermissionPolicySource(tx);
  let deadline: string =
      [validUntil, session.idleExpiresAt, session.absoluteExpiresAt].sort()[0] ?? validUntil,
    latest: string = observedAt;
  let failed = false,
    started = false,
    settled = false,
    admittedAuthority = false,
    guardComplete = false,
    finalComplete = false;
  let capability: ReturnType<typeof createMerchantBrandStoreTopologyCapability> | undefined;
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCanonicalInstant(clockPort.call(options));
      if (
        failed ||
        options.transaction !== tx ||
        tx.query !== query ||
        options.now !== clockPort ||
        options.currentActor !== actorPort ||
        options.validateAssociation !== associationPort ||
        options.registerBeforeCommit !== registerPort ||
        options.session !== sessionInput ||
        options.selected !== selectionInput ||
        options.observedAt !== observedAt ||
        options.validUntil !== validUntil ||
        at < latest ||
        at >= deadline
      )
        return poison();
      assertSessionUsable(session, at);
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  if (String(initialContext.resolvedAt) > String(check())) return poison();
  function tighten(value: string) {
    const until = parseCanonicalInstant(value);
    if (until < deadline) deadline = until;
    check();
  }
  const currentActor: PersistentMerchantBffOptions["currentActor"] = (...args) =>
    actorPort.call(options, ...args);
  const validateAssociation: PersistentMerchantBffOptions["validateAssociation"] = (...args) =>
    associationPort.call(options, ...args);
  const selection = createMerchantSelectedContext({
    now: check,
    validateSelection: async (...args) => {
      check();
      const result = await validateAssociation(...args);
      check();
      return result === true;
    },
  });
  const current = async () => {
    check();
    const actor = createIdentityActor(
      await currentActor(tx, actorReference, session.authenticatedAt, check()),
    );
    check();
    if (!equal(actor, session.actor)) return poison();
    const fresh = await selection(tx, session);
    check();
    if (
      fresh.tenantReference !== tenantReference ||
      fresh.context.brand.brandReference !== brandReference ||
      fresh.context.store?.storeReference !== storeReference ||
      !equal(fresh.context.actor, actor)
    )
      return poison();
    const context = createTenantContext(actor, fresh.context.brand, fresh.context.store, check()),
      memberships = createPostgresCurrentMembershipSource(tx, context),
      membership = resolveActiveMembership(
        await memberships.findMemberships(actorReference, brandReference),
        actorReference,
        brandReference,
        context.resolvedAt,
      ),
      assignment = resolveActiveStoreAssignment(
        membership,
        await memberships.findStoreAssignments(membership.membershipReference, storeReference),
        storeReference,
        context.resolvedAt,
      ),
      permissions = permissionSource;
    const authorize = async (input: Parameters<typeof permissions.authorizeWithRoles>[0]) => {
      const held = await permissions.authorizeWithRoles(input);
      if (held.validUntil !== null) {
        const boundary = parseCanonicalInstant(held.validUntil);
        if (boundary < deadline) deadline = boundary;
      }
      check();
      return held.decision;
    };
    for (const boundary of [membership.effectiveUntil, assignment.effectiveUntil]) {
      if (boundary !== null && boundary < deadline) deadline = boundary;
    }
    check();
    const navigation = await authorize({
      tenantContext: createTenantContext(actor, context.brand, context.store, check()),
      membership,
      storeAssignment: assignment,
      action: "merchant.access",
    });
    if (
      navigation.effect !== "Allow" ||
      navigation.action !== "merchant.access" ||
      navigation.scopeKind !== "Store"
    )
      return null;
    const decision = await authorize({
      tenantContext: createTenantContext(actor, context.brand, null, check()),
      membership,
      storeAssignment: null,
      action: "organization.manage",
    });
    if (
      decision.effect !== "Allow" ||
      decision.scopeKind !== "Brand" ||
      decision.action !== "organization.manage"
    )
      return null;
    return Object.freeze({
      context: createTenantContext(actor, context.brand, context.store, check()),
      decision,
    });
  };
  return Object.freeze({
    async read(): Promise<MerchantBrandNavigationEntry | null> {
      if (started) return poison();
      started = true;
      try {
        await registerPort.call(
          options,
          tx,
          async () => {
            try {
              if (!settled || guardComplete) return poison();
              const actual = await current();
              if ((actual !== null) !== admittedAuthority) return poison();
              guardComplete = true;
              check();
            } catch {
              return poison();
            }
          },
          () => {
            if (!guardComplete || !settled || finalComplete) return poison();
            check();
            finalComplete = true;
          },
        );
        const initial = await current();
        admittedAuthority = initial !== null;
        if (initial === null) {
          settled = true;
          return null;
        }
        capability = createMerchantBrandStoreTopologyCapability({
          transaction: tx,
          scope,
          selectedStoreReference: String(storeReference),
          mode: "Navigation",
          clock: { now: check },
          originalObservedAt: String(observedAt),
          originalValidUntil: deadline,
          registerBeforeCommit: registerPort,
          async holdCurrentBrandAuthority(actual, input) {
            readClosedRecord(input, [
              "scope",
              "selectedStoreReference",
              "permission",
              "purposeCode",
              "requiredFields",
              "observedAt",
              "validUntil",
            ]);
            if (
              actual !== tx ||
              !equal(input.scope, scope) ||
              input.selectedStoreReference !== storeReference ||
              input.permission !== "organization.manage" ||
              input.purposeCode !== "STORE_CAPABILITY_EVALUATION" ||
              !equal(input.requiredFields, merchantBrandStoreTopologyCapabilityRequiredFields) ||
              input.observedAt < observedAt ||
              input.observedAt > check() ||
              input.validUntil > validUntil
            )
              return poison();
            tighten(input.validUntil);
            const held = await current();
            if (held === null) return poison();
            check();
            return Object.freeze({
              scope,
              selectedStoreReference: String(storeReference),
              tenantContext: held.context,
              permission: held.decision,
              validUntil: deadline,
            });
          },
        });
        const visible = await capability.holdForNavigation();
        tighten(capability.leaseDeadline());
        check();
        settled = true;
        return visible
          ? Object.freeze({
              screenId: "ORG-BRAND-DETAIL",
              href: "/app/organization/brands/" + brandReference,
            })
          : null;
      } catch (error) {
        failed = true;
        if (error instanceof BrandStoreTopologyError) throw error;
        return fail();
      }
    },
    assertFinalized(): string {
      if (!settled || !guardComplete || !finalComplete) return poison();
      if (capability) tighten(capability.assertFinalized());
      check();
      return deadline;
    },
  });
}
