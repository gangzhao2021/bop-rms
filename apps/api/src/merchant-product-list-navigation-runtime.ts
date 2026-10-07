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
  createPostgresCurrentPermissionPolicySource,
  revalidateTenantContext,
} from "@bop/permission";
import { createTenantContext } from "@bop/tenant";
import {
  createCurrentStoreCapabilityService,
  createEmptyStoreCapabilityDependencySource,
  createPostgresFeatureControlAdministrationQueryStore,
  createProductStoreCapabilityBindings,
  createOptionSetStoreCapabilityBindings,
  type FeatureControlAdministrationSource,
} from "@bop/feature-control";
import {
  copyCategoryPersistenceValue,
  parseCatalogReference,
  optionSetListFields,
} from "@rms/catalog";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import { merchantProductListRequiredFields } from "./merchant-product-list-query.js";
import type { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Host = ReturnType<typeof createMerchantCategoryTransactions>;
type Transaction = Parameters<Host["registerBeforeCommit"]>[0];
type Selected = Awaited<ReturnType<ReturnType<typeof createMerchantSelectedContext>>>;
const fail = (): never => {
  throw new Error("MERCHANT_BFF_UNAVAILABLE");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);

/** Server-only navigation admission. Identity supplied and locked this actual
 * session in the same transaction (including newly created/rotated sessions).
 * No cookie, caller TenantContext, or synthetic capability decision is accepted.
 */
export function createMerchantProductListNavigationRuntime(options: {
  readonly target?: "Product" | "OptionSet";
  readonly transaction: Transaction;
  readonly session: AuthenticationSession;
  readonly selected: Selected;
  readonly now: () => string;
  readonly currentActor: PersistentMerchantBffOptions["currentActor"];
  readonly validateAssociation: PersistentMerchantBffOptions["validateAssociation"];
  readonly observedAt: string;
  readonly validUntil: string;
  readonly registerBeforeCommit: Host["registerBeforeCommit"];
}) {
  const target = options.target === undefined ? "Product" : options.target;
  if (target !== "Product" && target !== "OptionSet") return fail();
  const optionSet = target === "OptionSet",
    controlKey = optionSet ? "catalog.optionset.list" : "catalog.product.list";
  const tx = options.transaction,
    query = tx.query,
    now = options.now.bind(options),
    currentActor = options.currentActor.bind(options),
    validateAssociation = options.validateAssociation.bind(options),
    register = options.registerBeforeCommit.bind(options),
    raw = readClosedRecord(copyCategoryPersistenceValue(options.session), [
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
    ]),
    policy = readClosedRecord(raw.policy, [
      "code",
      "maxActiveSessions",
      "idleTimeoutMinutes",
      "absoluteTimeoutMinutes",
    ]),
    { policy: discardedPolicy, ...sessionFields } = raw,
    session = createAuthenticationSession({
      ...sessionFields,
      policyCode: policy.code,
      maxActiveSessions: policy.maxActiveSessions,
      idleTimeoutMinutes: policy.idleTimeoutMinutes,
      absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
    }),
    selected = readClosedRecord(options.selected, ["tenantReference", "context"]),
    tenantReference = parseCatalogReference(selected.tenantReference),
    initialContext = revalidateTenantContext(selected.context as Selected["context"]),
    actorReference = session.actor.actorReference,
    brandReference = initialContext.brand.brandReference,
    storeReference = initialContext.store?.storeReference,
    observedAt = parseCanonicalInstant(options.observedAt),
    validUntil = parseCanonicalInstant(options.validUntil);
  void discardedPolicy;
  if (
    typeof query !== "function" ||
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
  const request = Object.freeze({
    tenantReference,
    brandReference,
    storeReference,
    actorReference,
    sessionReference: session.sessionReference,
    observedAt,
    screenId: optionSet ? "CAT-OPTIONSET-LIST" : "CAT-PRODUCT-LIST",
    permission: "catalog.manage",
    action: optionSet ? "catalog.option_set.read" : "catalog.product.manage",
    capability: optionSet ? "catalog.cat_optionset_list" : "catalog.cat_product_list",
    purposeCode: optionSet ? "CATALOG_OPTION_SET_LIST" : "CATALOG_PRODUCT_LIST",
    requiredFields: optionSet ? optionSetListFields : merchantProductListRequiredFields,
  } as const);
  let deadline: string =
      [validUntil, session.idleExpiresAt, session.absoluteExpiresAt].sort()[0] ?? validUntil,
    latest: string = observedAt,
    failed = false,
    started = false,
    settled = false,
    admitted = false,
    guardComplete = false,
    guardCalls = 0,
    finalCalls = 0;
  const poison = (): never => {
    failed = true;
    return fail();
  };
  const check = () => {
    try {
      const at = parseCanonicalInstant(now());
      if (failed || tx.query !== query || at < latest || at >= deadline) return poison();
      assertSessionUsable(session, at);
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const selection = createMerchantSelectedContext({
    now: check,
    validateSelection: async (...args) => {
      check();
      const result = await validateAssociation(...args);
      check();
      return result === true;
    },
  });
  // This fixed field/purpose projection has full Brand grants. A selected Store
  // grant alone never authorizes the fixed owning all-locale list fields.
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
      permissions = createPostgresCurrentPermissionPolicySource(tx);
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
    for (const action of optionSet
      ? [request.permission, request.action]
      : [request.permission, request.action, "catalog.product.read", "catalog.sku.read"]) {
      const brandContext = createTenantContext(actor, context.brand, null, check());
      const decision = await authorize({
        tenantContext: brandContext,
        membership,
        storeAssignment: null,
        action,
      });
      check();
      if (
        decision.effect !== "Allow" ||
        decision.scopeKind !== "Brand" ||
        decision.action !== action
      )
        return null;
    }
    return createTenantContext(actor, context.brand, context.store, check());
  };
  return Object.freeze({
    async allows(): Promise<boolean> {
      if (started) return poison();
      started = true;
      try {
        await register(
          tx,
          async () => {
            try {
              if (++guardCalls !== 1 || !settled) return poison();
              check();
              if (admitted && !(await current())) return poison();
              check();
              guardComplete = true;
            } catch {
              return poison();
            }
          },
          () => {
            if (++finalCalls !== 1 || !guardComplete || !settled) return poison();
            check();
          },
        );
        const context = await current();
        if (context === null) {
          settled = true;
          return false;
        }
        let source: FeatureControlAdministrationSource | undefined;
        const definitions = createPostgresFeatureControlAdministrationQueryStore(
          {
            async run(work) {
              check();
              const result = await work(tx);
              check();
              return result;
            },
          },
          { brandReference, storeReference },
          {
            async withAuthorizedDefinitionsScope(input, work) {
              check();
              if (
                input.actorReference !== actorReference ||
                input.brandReference !== brandReference ||
                input.storeReference !== storeReference ||
                input.key !== controlKey ||
                input.purposeCode !== "STORE_CAPABILITY_EVALUATION" ||
                input.access !== "AdministrationDefinitions"
              )
                return poison();
              const result = await work();
              check();
              return result;
            },
          },
        );
        const service = createCurrentStoreCapabilityService(
          {
            clock: { now: check },
            bindings: optionSet
              ? createOptionSetStoreCapabilityBindings()
              : createProductStoreCapabilityBindings(),
            dependencies: createEmptyStoreCapabilityDependencySource(),
            definitions: {
              withCurrentDefinitions(input, work) {
                return definitions.withCurrentDefinitions(input, async (value) => {
                  source = value;
                  return work(value);
                });
              },
            },
            authority: {
              async withCurrentStoreScope(input, work) {
                const at = check();
                if (
                  input.brandReference !== brandReference ||
                  input.storeReference !== storeReference ||
                  input.capabilityKey !== request.capability ||
                  input.observedAt < context.resolvedAt ||
                  input.observedAt > at
                )
                  return poison();
                // Re-date only the real, currently held owner context for this one
                // evaluation; its identity and authority came from current() above.
                const result = await work(
                  createTenantContext(
                    context.actor,
                    context.brand,
                    context.store,
                    input.observedAt,
                  ),
                );
                check();
                return result;
              },
            },
          },
          { brandReference, storeReference },
        );
        let calls = 0;
        await service.withCurrentCapability(request.capability, async (decision) => {
          if (++calls !== 1) return poison();
          check();
          if (
            decision.capabilityKey !== request.capability ||
            decision.controlKey !== controlKey ||
            decision.brandReference !== brandReference ||
            decision.storeReference !== storeReference
          )
            return poison();
          if (decision.backendExecution !== "Allow" || decision.frontendVisibility !== "Show")
            return;
          const chosen = source?.definitions.find(
            (d) =>
              d.controlId === decision.controlReference && d.version === decision.controlVersion,
          );
          if (!chosen || !source) return poison();
          for (const boundary of [chosen.effectiveUntil, chosen.expiresAt]) {
            if (boundary !== null && boundary < deadline) deadline = boundary;
          }
          for (const definition of source.definitions) {
            if (
              (definition.lifecycle === "Published" || definition.lifecycle === "Disabled") &&
              definition.effectiveFrom > decision.observedAt &&
              definition.effectiveFrom < deadline
            )
              deadline = definition.effectiveFrom;
          }
          check();
          admitted = true;
        });
        if (calls !== 1) return poison();
        check();
        settled = true;
        return admitted;
      } catch {
        return poison();
      }
    },
  });
}
