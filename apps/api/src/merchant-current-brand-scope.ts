import {
  createPostgresBrowserBrandSessionSelectionStore,
  createPostgresCurrentBrowserSessionSource,
  createPostgresCurrentWorkforceBrowserSessionSource,
  type WorkforceBrowserSessionServiceOptions,
  parseSessionReference,
  type AuthenticationSession,
  type OidcAuthorizationTransaction,
} from "@bop/identity";
import {
  createPostgresCurrentBrandOrganizationSource,
  createPostgresBrandAdministrationOrganizationSource,
  createBrandAdministrationContext,
  createTenantContext,
  parseBrandReference,
  parseCanonicalInstant,
  type TenantContext,
  type BrandAdministrationContext,
} from "@bop/tenant";
import {
  createPostgresCurrentBrandMembershipSource,
  createPostgresBrandAdministrationMembershipSource,
  resolveActiveMembership,
} from "@bop/membership";
import {
  createPostgresTransactionCurrentPermissionPolicySource,
  createPostgresCurrentBrandAdministrationPermissionPolicySource,
  parseBrandAdministrationPermissionAction,
  parseBusinessAction,
} from "@bop/permission";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantCurrentBrandOptions = Pick<
  PersistentMerchantBffOptions,
  "currentActor" | "now"
> & {
  readonly identity: Pick<PersistentMerchantBffOptions["identity"], "hasher">;
};
export type MerchantCurrentBrandAdministrationOptions = Omit<
  MerchantCurrentBrandOptions,
  "identity"
> & {
  readonly identity: Pick<
    WorkforceBrowserSessionServiceOptions,
    "hasher" | "envelopes" | "configuration"
  >;
};
type Policy = ReturnType<typeof createPostgresTransactionCurrentPermissionPolicySource>;
export type MerchantBrandAdministrationPolicyPort = Readonly<
  Pick<
    ReturnType<typeof createPostgresCurrentBrandAdministrationPermissionPolicySource>,
    "authorizeActionsWithRoles"
  >
>;
type PolicyDecision = Awaited<ReturnType<Policy["authorizeActionsWithRoles"]>>;
type Authority<C> = Readonly<{
  context: C;
  decisions: PolicyDecision["decisions"];
  validUntil: PolicyDecision["validUntil"];
}>;
const denied = (): never => {
  throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
};

/** Shared actual-owner composition for the session-creation hook and current
 * cookie path. The supplied session must already come from the Identity owner. */
export async function readMerchantCurrentBrandAuthority(
  tx: OidcAuthorizationTransaction,
  session: AuthenticationSession,
  brandReference: string,
  observedAt: string,
  actions: readonly string[],
  policy: Policy,
) {
  const reference = parseBrandReference(brandReference),
    at = parseCanonicalInstant(observedAt);
  const organizations = createPostgresCurrentBrandOrganizationSource(tx, {
    brandReference: reference,
    observedAt: at,
  });
  const brand = await organizations.getBrand(reference);
  if (!brand || session.actor.actorReference === null) return denied();
  const context = createTenantContext(session.actor, brand, null, at);
  const memberships = createPostgresCurrentBrandMembershipSource(tx, context);
  const membership = resolveActiveMembership(
    await memberships.findMemberships(session.actor.actorReference, brand.brandReference),
    session.actor.actorReference,
    brand.brandReference,
    at,
  );
  const permission = await policy.authorizeActionsWithRoles({
    tenantContext: context,
    membership,
    storeAssignment: null,
    actions,
  });
  if (
    permission.decisions.length !== actions.length ||
    permission.decisions.some((d, i) => d.scopeKind !== "Brand" || d.action !== actions[i])
  )
    return denied();
  return Object.freeze({
    context,
    decisions: permission.decisions,
    validUntil: permission.validUntil,
  });
}

/** Genuine administrative facts, without operational TenantContext or Platform
 * authority. The supplied Session must already come from Identity. */
export async function readMerchantCurrentBrandAdministrationAuthority(
  tx: OidcAuthorizationTransaction,
  session: AuthenticationSession,
  brandReference: string,
  observedAt: string,
  actions: readonly string[],
  policy: MerchantBrandAdministrationPolicyPort,
) {
  const reference = parseBrandReference(brandReference),
    at = parseCanonicalInstant(observedAt),
    organizations = createPostgresBrandAdministrationOrganizationSource(tx, {
      brandReference: reference,
      observedAt: at,
    });
  const brand = await organizations.getBrand(reference);
  if (!brand || session.actor.actorReference === null) return denied();
  const context = createBrandAdministrationContext(session.actor, brand, at),
    memberships = createPostgresBrandAdministrationMembershipSource(tx, context),
    membership = resolveActiveMembership(
      await memberships.findMemberships(session.actor.actorReference, brand.brandReference),
      session.actor.actorReference,
      brand.brandReference,
      at,
    ),
    permission = await policy.authorizeActionsWithRoles({
      administrationContext: context,
      membership,
      storeAssignment: null,
      actions: actions.map((action) => String(parseBrandAdministrationPermissionAction(action))),
    });
  if (
    permission.validUntil === null ||
    parseCanonicalInstant(permission.validUntil) <= at ||
    Date.parse(permission.validUntil) > Date.parse(at) + 5000 ||
    permission.decisions.length !== actions.length ||
    permission.decisions.some((d, i) => d.scopeKind !== "Brand" || d.action !== actions[i])
  )
    return denied();
  return Object.freeze({
    context,
    decisions: permission.decisions,
    validUntil: permission.validUntil,
  });
}

/** Current Active Brand administrative scope. No Store selection, assignment,
 * inherited Store grant or independently asserted Tenant identifier is used. */
export function createMerchantCurrentBrandScope(
  source: MerchantCurrentBrandOptions,
  policy?: Policy,
) {
  return currentBrandScope<TenantContext, Policy>(
    source,
    {
      administrative: false,
      checkIdentity: () => undefined,
      sessionSource: (now) =>
        createPostgresCurrentBrowserSessionSource({
          hasher: source.identity.hasher,
          now,
          currentActor: (...args) => source.currentActor.call(source, ...args),
        }),
      createPolicy: createPostgresTransactionCurrentPermissionPolicySource,
      parseAction: (value) => String(parseBusinessAction(value)),
      read: readMerchantCurrentBrandAuthority,
    },
    policy,
  );
}

/** Deliberately selected real Brand administrative scope. The Session selection
 * is read, never written; no browser Brand or automatic grant is accepted. */
export function createMerchantCurrentBrandAdministrationScope(
  source: MerchantCurrentBrandAdministrationOptions,
  policy?: MerchantBrandAdministrationPolicyPort,
) {
  const identity = source.identity,
    configuration = identity.configuration,
    configurationIdentity = JSON.stringify(configuration),
    envelopes = identity.envelopes;
  return currentBrandScope<BrandAdministrationContext, MerchantBrandAdministrationPolicyPort>(
    source,
    {
      administrative: true,
      checkIdentity: () => {
        if (
          source.identity !== identity ||
          identity.configuration !== configuration ||
          JSON.stringify(configuration) !== configurationIdentity ||
          identity.envelopes !== envelopes
        )
          return denied();
      },
      sessionSource: (now) =>
        createPostgresCurrentWorkforceBrowserSessionSource({
          hasher: identity.hasher,
          envelopes,
          configuration: {
            environment: configuration.environment,
            issuer: configuration.issuer,
            clientId: configuration.clientId,
          },
          now,
          currentActor: (...args) => source.currentActor.call(source, ...args),
        }),
      createPolicy: createPostgresCurrentBrandAdministrationPermissionPolicySource,
      parseAction: (value) => String(parseBrandAdministrationPermissionAction(value)),
      read: readMerchantCurrentBrandAdministrationAuthority,
    },
    policy,
  );
}

function currentBrandScope<
  C extends TenantContext | BrandAdministrationContext,
  P extends Policy | MerchantBrandAdministrationPolicyPort,
>(
  source: MerchantCurrentBrandOptions,
  strategy: Readonly<{
    administrative: boolean;
    checkIdentity(): void;
    sessionSource(now: () => string): ReturnType<typeof createPostgresCurrentBrowserSessionSource>;
    createPolicy(tx: OidcAuthorizationTransaction): P;
    parseAction(value: unknown): string;
    read(
      tx: OidcAuthorizationTransaction,
      session: AuthenticationSession,
      brandReference: string,
      observedAt: string,
      actions: readonly string[],
      policy: P,
    ): Promise<Authority<C>>;
  }>,
  policy?: P,
) {
  const nowPort = source.now,
    actorPort = source.currentActor,
    hasher = source.identity.hasher;
  return async (
    tx: OidcAuthorizationTransaction,
    sessionCookie: unknown,
    expectedSession: string,
    originalValidUntil?: string,
  ) => {
    const expected = parseSessionReference(expectedSession),
      originalQuery = tx.query;
    const startedAt = parseCanonicalInstant(nowPort.call(source));
    let deadline = new Date(Date.parse(startedAt) + 5000).toISOString();
    if (originalValidUntil !== undefined) {
      const requested = parseCanonicalInstant(originalValidUntil);
      if (requested <= startedAt || requested > deadline) return denied();
      deadline = requested;
    }
    let failed = false,
      active = false,
      latest: string = startedAt;
    let fixed: Authority<C> | undefined;
    let actorReference: string | undefined;
    let sessionIdentity: string | undefined, selectionIdentity: string | undefined;
    const check = () => {
      strategy.checkIdentity();
      const at = parseCanonicalInstant(nowPort.call(source));
      if (
        failed ||
        source.now !== nowPort ||
        source.currentActor !== actorPort ||
        source.identity.hasher !== hasher ||
        tx.query !== originalQuery ||
        at < latest ||
        at >= deadline
      ) {
        failed = true;
        return denied();
      }
      latest = at;
      return at;
    };
    const retain = (until: string | null) => {
      if (until !== null) {
        const at = parseCanonicalInstant(until);
        if (at < deadline) deadline = at;
      }
      check();
    };
    const currentSession = strategy.sessionSource(check);
    const selection = createPostgresBrowserBrandSessionSelectionStore();
    const currentPolicy = policy ?? strategy.createPolicy(tx),
      policyPort = currentPolicy.authorizeActionsWithRoles;
    const assess = async (actions: readonly string[]) => {
      try {
        if (active) return denied();
        active = true;
        if (
          !Array.isArray(actions) ||
          Object.getPrototypeOf(actions) !== Array.prototype ||
          actions.length < 1 ||
          actions.length > 16 ||
          Reflect.ownKeys(actions).length !== actions.length + 1
        )
          return denied();
        const copied: string[] = [];
        for (let i = 0; i < actions.length; i++) {
          const d = Object.getOwnPropertyDescriptor(actions, String(i));
          if (!d?.enumerable || !("value" in d)) return denied();
          const action = strategy.parseAction(d.value);
          if (copied.includes(action)) return denied();
          copied.push(action);
        }
        check();
        const session = await currentSession(tx, sessionCookie);
        if (
          session.sessionReference !== expected ||
          session.actor.actorReference === null ||
          session.actor.authenticatedAt !== session.authenticatedAt ||
          (actorReference !== undefined && session.actor.actorReference !== actorReference)
        )
          return denied();
        if (strategy.administrative) {
          if (session.actor.recentMfaAt === null) return denied();
          retain(new Date(Date.parse(session.actor.recentMfaAt) + 900000).toISOString());
        }
        retain(session.idleExpiresAt);
        retain(session.absoluteExpiresAt);
        const selected = await selection.read(tx, session, check());
        if (!selected || (fixed && selected.brandReference !== fixed.context.brand.brandReference))
          return denied();
        if (
          strategy.administrative &&
          ((sessionIdentity !== undefined && sessionIdentity !== JSON.stringify(session)) ||
            (selectionIdentity !== undefined && selectionIdentity !== JSON.stringify(selected)) ||
            currentPolicy.authorizeActionsWithRoles !== policyPort)
        )
          return denied();
        // organization.manage is always the administrative entry admission.
        const wanted = Object.freeze([
          "organization.manage",
          ...copied.filter((a) => a !== "organization.manage"),
        ]);
        const result = await strategy.read(
          tx,
          session,
          selected.brandReference,
          check(),
          wanted,
          currentPolicy,
        );
        retain(result.validUntil);
        if (
          result.decisions[0]?.effect !== "Allow" ||
          (fixed &&
            (result.context.brand.version !== fixed.context.brand.version ||
              result.context.brand.updatedAt !== fixed.context.brand.updatedAt ||
              (strategy.administrative &&
                JSON.stringify(result.context.brand) !== JSON.stringify(fixed.context.brand)))) ||
          (strategy.administrative && currentPolicy.authorizeActionsWithRoles !== policyPort)
        )
          return denied();
        actorReference = session.actor.actorReference;
        if (strategy.administrative) {
          sessionIdentity ??= JSON.stringify(session);
          selectionIdentity ??= JSON.stringify(selected);
        }
        fixed ??= result;
        const decisions = copied.map(
          (action) => result.decisions.find((decision) => decision.action === action) ?? denied(),
        );
        check();
        return Object.freeze({
          context: result.context,
          decisions: Object.freeze(decisions),
          validUntil: deadline,
        });
      } catch {
        failed = true;
        return denied();
      } finally {
        active = false;
      }
    };
    const initial = await assess(["organization.manage"]);
    const capturedActor = initial.context.actor.actorReference;
    if (capturedActor === null) return denied();
    return Object.freeze({
      tenantReference: String(initial.context.brand.brandReference),
      context: initial.context,
      actorReference: capturedActor,
      sessionReference: expected,
      authorizeActionsWithValidity: assess,
      async authorizeAction(action: string) {
        return (await assess([action])).decisions[0] ?? denied();
      },
      async authorizeActions(actions: readonly string[]) {
        return (await assess(actions)).decisions;
      },
      authorizationValidUntil: () => deadline,
      assertCurrent() {
        if (strategy.administrative && currentPolicy.authorizeActionsWithRoles !== policyPort)
          failed = true;
        check();
      },
    });
  };
}
