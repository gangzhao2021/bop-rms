import { createMerchantServicePauseProof } from "./merchant-service-pause-proof.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreOperatingStatusReader,
} from "@rms/store";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import {
  BrowserSessionService,
  createPostgresBrowserSessionStore,
  createPostgresCurrentBrowserSessionSource,
  type AuthenticationSession,
  type BrowserSessionSelection,
  type BrowserSessionServiceOptions,
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
import { createMerchantSessionSelection } from "./merchant-session-selection.js";
import { createMerchantSelectedContext } from "./merchant-selected-context.js";
import {
  parseMerchantWorkspaceSnapshot,
  type MerchantBffService,
  type MerchantWorkspaceSnapshot,
} from "./merchant-bff.js";

type Persistence = Parameters<typeof createPostgresBrowserSessionStore>[0];
type Transaction = Parameters<NonNullable<Persistence["onSessionCreated"]>>[0];
type SelectedContext = Awaited<ReturnType<ReturnType<typeof createMerchantSelectedContext>>>;

export interface PersistentMerchantBffOptions {
  readonly identity: Omit<BrowserSessionServiceOptions, "store" | "now">;
  readonly transactions: Persistence["transactions"];
  readonly currentActor: Persistence["currentActor"];
  readonly now: () => string;
  readonly publication: Pick<
    Parameters<typeof createPostgresCurrentStorePublicationProof>[0],
    "configurationType" | "purposeCode" | "requiredLiveGateRequirementCodes"
  >;
  readonly validateAssociation: Parameters<
    typeof createMerchantSessionSelection
  >[0]["validateAssociation"];
  initialScope(tx: Transaction, session: AuthenticationSession): Promise<BrowserSessionSelection>;
  targetScope(
    tx: Transaction,
    session: AuthenticationSession,
    storeReference: string,
  ): Promise<BrowserSessionSelection>;
  /** Supply Store candidates and current operational metadata. Candidate access and
   * labels are verified through public owners; navigation is filtered by policy. */
  workspace(tx: Transaction, selected: SelectedContext): Promise<unknown>;
}

export function createPersistentMerchantBffService(
  options: PersistentMerchantBffOptions,
): MerchantBffService {
  const configuration = options.identity.configuration;
  const selectedContext = createMerchantSelectedContext({
    now: options.now,
    validateSelection: async (...args) => (await options.validateAssociation(...args)) === true,
  });
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: options.identity.hasher,
    now: options.now,
    currentActor: options.currentActor,
  });
  async function workspace(tx: Transaction, session: AuthenticationSession) {
    const selected = await selectedContext(tx, session);
    const context = selected.context;
    const actor = context.actor.actorReference;
    const store = context.store;
    if (actor === null || store === null) throw new Error("MERCHANT_BFF_UNAVAILABLE");
    const memberships = createPostgresCurrentMembershipSource(tx, context);
    const membership = resolveActiveMembership(
      await memberships.findMemberships(actor, context.brand.brandReference),
      actor,
      context.brand.brandReference,
      context.resolvedAt,
    );
    const storeAssignment = resolveActiveStoreAssignment(
      membership,
      await memberships.findStoreAssignments(membership.membershipReference, store.storeReference),
      store.storeReference,
      context.resolvedAt,
    );
    const policy = createPostgresCurrentPermissionPolicySource(tx);
    const allowed = async (action: string) =>
      (await policy.authorize({ tenantContext: context, membership, storeAssignment, action }))
        .effect === "Allow";
    if (!(await allowed("merchant.access"))) throw new Error("MERCHANT_BFF_UNAVAILABLE");
    let published:
      | Awaited<ReturnType<ReturnType<typeof createPostgresCurrentStorePublicationProof>>>
      | undefined;
    const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
    const equalContent = (a: unknown, b: unknown) =>
      canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
    const operating = await createPostgresStoreOperatingStatusReader({
      brandReference: context.brand.brandReference,
      storeReference: store.storeReference,
      timeZone: store.timeZone,
      authorize: async () => allowed("merchant.access"),
      publicationProof: async (transaction, candidate, at) => {
        published = await createPostgresCurrentStorePublicationProof({
          ...options.publication,
          tenantReference: selected.tenantReference,
          brandReference: context.brand.brandReference,
          storeReference: store.storeReference,
          configurationReference: candidate.configurationReference,
          authorize: async () => allowed("merchant.access"),
          hashContent: digest,
        })(transaction, at);
        return {
          contentDigest: published.contentDigest,
          businessDayStartSource: published.businessDayStartSource,
        };
      },
      verifyWeeklyContent: async (_transaction, input) =>
        !!published &&
        input.configurationReference === published.configuration.configurationReference &&
        equalContent(input.weeklySchedule, published.configuration.weeklySchedule),
      verifyExceptionContent: async (_transaction, input) => {
        const expected = published?.configuration.exceptions.find(
          (entry) => entry.localDate === input.exception.localDate,
        );
        return (
          !!expected &&
          equalContent(input.exception, expected) &&
          input.summaryDigest === digest(expected.intervals)
        );
      },
      verifyPauseOperation: createMerchantServicePauseProof({
        brandReference: context.brand.brandReference,
        storeReference: store.storeReference,
        authorize: async () => allowed("merchant.access"),
      }),
      verifyOperatingContent: async (_transaction, input) =>
        !!published &&
        input.businessDate.contentDigest === published.contentDigest &&
        equalContent(input.weeklySchedule, published.configuration.weeklySchedule) &&
        equalContent(input.exceptions, published.configuration.exceptions),
    })(tx, context.resolvedAt);
    const result = parseMerchantWorkspaceSnapshot(await options.workspace(tx, selected));
    if (result.selectedScope.storeReference !== store.storeReference)
      throw new Error("MERCHANT_BFF_UNAVAILABLE");
    const navigation = [];
    for (const item of result.navigation) {
      if (item.permission === "merchant.access" || (await allowed(item.permission)))
        navigation.push(item);
    }
    const selectedScope = Object.freeze({
      brandLabel: context.brand.displayName,
      storeLabel: store.displayName,
      storeReference: store.storeReference,
    });
    const authorizedStores = [];
    for (const candidate of result.authorizedStores) {
      if (candidate.storeReference === store.storeReference) {
        authorizedStores.push(selectedScope);
        continue;
      }
      const target = await options.targetScope(tx, session, candidate.storeReference);
      if (target.storeReference !== candidate.storeReference)
        throw new Error("MERCHANT_BFF_UNAVAILABLE");
      if ((await options.validateAssociation(tx, session, target, context.resolvedAt)) !== true)
        continue;
      const organizations = createPostgresMerchantOrganizationSource(tx, {
        ...target,
        observedAt: context.resolvedAt,
      });
      const targetBrand = await organizations.getBrand(parseBrandReference(target.brandReference));
      const targetStore = await organizations.getStore(parseStoreReference(target.storeReference));
      if (!targetBrand || !targetStore) throw new Error("MERCHANT_BFF_UNAVAILABLE");
      const targetContext = createTenantContext(
        session.actor,
        targetBrand,
        targetStore,
        context.resolvedAt,
      );
      const targetMemberships = createPostgresCurrentMembershipSource(tx, targetContext);
      const targetMembership = resolveActiveMembership(
        await targetMemberships.findMemberships(actor, targetBrand.brandReference),
        actor,
        targetBrand.brandReference,
        context.resolvedAt,
      );
      const targetAssignment = resolveActiveStoreAssignment(
        targetMembership,
        await targetMemberships.findStoreAssignments(
          targetMembership.membershipReference,
          targetStore.storeReference,
        ),
        targetStore.storeReference,
        context.resolvedAt,
      );
      const decision = await policy.authorize({
        tenantContext: targetContext,
        membership: targetMembership,
        storeAssignment: targetAssignment,
        action: "merchant.access",
      });
      if (decision.effect === "Allow")
        authorizedStores.push(
          Object.freeze({
            brandLabel: targetBrand.displayName,
            storeLabel: targetStore.displayName,
            storeReference: targetStore.storeReference,
          }),
        );
    }
    return Object.freeze({
      ...result,
      businessDate: operating.businessDate.businessDate,
      storeStatus: operating.state === "TemporarilyClosed" ? "Paused" : operating.state,
      freshness: "Current",
      selectedScope,
      authorizedStores: Object.freeze(authorizedStores),
      navigation: Object.freeze(navigation),
    });
  }
  function service(onSessionCreated: NonNullable<Persistence["onSessionCreated"]>) {
    return new BrowserSessionService({
      ...options.identity,
      now: options.now,
      store: createPostgresBrowserSessionStore({
        transactions: options.transactions,
        currentActor: options.currentActor,
        now: options.now,
        environment: configuration.environment,
        redirectUri: configuration.redirectUri,
        allowedPostLoginPaths: configuration.allowedPostLoginPaths,
        onSessionCreated,
      }),
    });
  }
  const base = service(async (tx, record) => {
    const scope = await options.initialScope(tx, record.session);
    const actorReference = record.session.actor.actorReference;
    if (actorReference === null) throw new Error("MERCHANT_BFF_UNAVAILABLE");
    await createMerchantSessionSelection({
      scope,
      actorReference,
      previousSessionReference: null,
      now: options.now,
      validateAssociation: options.validateAssociation,
    })(tx, record);
    await workspace(tx, record.session);
  });
  const bff: MerchantBffService = {
    start: (path) => base.start(path),
    callback: (input) => base.callback(input),
    authorize: (input) => base.authorize(input),
    logout: (cookie) => base.logout(cookie),
    async bootstrap(cookie) {
      const bootstrap = await base.bootstrap(cookie);
      return options.transactions.run(async (tx) => {
        const session = await currentSession(tx, cookie);
        if (session.sessionReference !== bootstrap.session.sessionReference)
          throw new Error("MERCHANT_BFF_UNAVAILABLE");
        return Object.freeze({
          session,
          csrf: bootstrap.csrf,
          workspace: await workspace(tx, session),
        });
      });
    },
    async switchStore(input) {
      try {
        const current = await base.authorize(input);
        const target = parseStoreReference(input.targetStoreReference);
        const scope = await options.transactions.run(async (tx) => {
          const session = await currentSession(tx, input.sessionCookie);
          if (session.sessionReference !== current.sessionReference)
            throw new Error("MERCHANT_BFF_UNAVAILABLE");
          return options.targetScope(tx, session, target);
        });
        if (scope.storeReference !== target || current.actor.actorReference === null)
          throw new Error("MERCHANT_BFF_UNAVAILABLE");
        const bind = createMerchantSessionSelection({
          scope,
          actorReference: current.actor.actorReference,
          previousSessionReference: current.sessionReference,
          now: options.now,
          validateAssociation: options.validateAssociation,
        });
        let nextWorkspace: MerchantWorkspaceSnapshot | undefined;
        const rotation = service(async (tx, record) => {
          await bind(tx, record);
          nextWorkspace = await workspace(tx, record.session);
        });
        const result = await rotation.rotate(input.sessionCookie, "StoreContextElevation");
        if (!nextWorkspace) throw new Error("MERCHANT_BFF_UNAVAILABLE");
        return Object.freeze({ cookie: result.cookie, workspace: nextWorkspace });
      } catch {
        throw new Error("STORE_SWITCH_DENIED");
      }
    },
  };
  return Object.freeze(bff);
}
