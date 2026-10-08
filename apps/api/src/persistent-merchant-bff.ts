import { createMerchantBrandNavigationRuntime } from "./merchant-brand-navigation-runtime.js";
import {
  allowsProductListNavigation,
  type MerchantProductListNavigationAuthority,
} from "./merchant-product-list-navigation.js";
import { createMerchantProductListNavigationRuntime } from "./merchant-product-list-navigation-runtime.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantServicePauseProof } from "./merchant-service-pause-proof.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresCurrentStorePublicationProof,
  createPostgresStoreOperatingStatusReader,
  createStoreConfigurationPublicationHash,
} from "@rms/store";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import {
  BrowserSessionService,
  createPostgresBrowserSessionStore,
  createPostgresCurrentBrowserSessionSource,
  type AuthenticationSession,
  type BrowserSessionSelection,
  type BrowserSessionServiceOptions,
  parseCanonicalInstant,
  readClosedRecord,
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
  readonly currentBrandNavigation?: true;
  readonly catalogProductNavigation?:
    MerchantProductListNavigationAuthority | { readonly currentRuntime: true };
  readonly publication: Pick<
    Parameters<typeof createPostgresCurrentStorePublicationProof>[0],
    | "configurationType"
    | "purposeCode"
    | "requiredLiveGateRequirementCodes"
    | "requiredValidationCheckCodes"
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
  const now = options.now.bind(options),
    currentActor = options.currentActor.bind(options),
    validateAssociation = options.validateAssociation.bind(options),
    navigation = options.catalogProductNavigation;
  if (options.currentBrandNavigation !== undefined && options.currentBrandNavigation !== true)
    throw new Error("MERCHANT_BFF_UNAVAILABLE");
  const currentBrandNavigation = options.currentBrandNavigation === true;
  let currentNavigation = false;
  let legacyNavigation: MerchantProductListNavigationAuthority | undefined;
  if (navigation !== undefined) {
    if (Object.hasOwn(navigation, "currentRuntime")) {
      const mode = readClosedRecord(navigation, ["currentRuntime"]);
      if (mode.currentRuntime !== true) throw new Error("MERCHANT_BFF_UNAVAILABLE");
      currentNavigation = true;
    } else {
      if (
        !("holdUntilTransactionCompletes" in navigation) ||
        typeof navigation.holdUntilTransactionCompletes !== "function"
      )
        throw new Error("MERCHANT_BFF_UNAVAILABLE");
      legacyNavigation = Object.freeze({
        holdUntilTransactionCompletes: navigation.holdUntilTransactionCompletes.bind(navigation),
      });
    }
  }
  const configuration = options.identity.configuration;
  const selectedContext = createMerchantSelectedContext({
    now,
    validateSelection: async (...args) => (await validateAssociation(...args)) === true,
  });
  const currentSession = createPostgresCurrentBrowserSessionSource({
    hasher: options.identity.hasher,
    now: options.now,
    currentActor: options.currentActor,
  });
  interface WorkspaceHold {
    readonly transaction: Parameters<
      ReturnType<typeof createMerchantCategoryTransactions>["registerBeforeCommit"]
    >[0];
    readonly observedAt: string;
    readonly validUntil: string;
    readonly registerBeforeCommit: ReturnType<
      typeof createMerchantCategoryTransactions
    >["registerBeforeCommit"];
    readonly finalizers: (() => void)[];
  }
  async function workspace(
    tx: Transaction,
    session: AuthenticationSession,
    finalizers: (() => void)[] = [],
  ) {
    if (!currentNavigation && !currentBrandNavigation) return workspaceCurrent(tx, session);
    const observedAt = parseCanonicalInstant(now()),
      validUntil = new Date(Date.parse(observedAt) + 5000).toISOString(),
      borrowed: PersistentMerchantBffOptions["transactions"] = {
        async run(work) {
          return work(tx);
        },
      },
      host = createMerchantCategoryTransactions(borrowed);
    return host.transactions.run(async (actual) => {
      const query = actual.query;
      let latest: string = observedAt,
        failed = false,
        ready = false;
      const check = () => {
        try {
          const at = parseCanonicalInstant(now());
          if (failed || actual.query !== query || at < latest || at >= validUntil)
            throw new Error("MERCHANT_BFF_UNAVAILABLE");
          latest = at;
        } catch {
          failed = true;
          throw new Error("MERCHANT_BFF_UNAVAILABLE");
        }
      };
      await host.registerBeforeCommit(
        actual,
        async () => {
          if (!ready) throw new Error("MERCHANT_BFF_UNAVAILABLE");
          check();
        },
        check,
      );
      try {
        check();
        finalizers.push(check);
        const result = await workspaceCurrent(actual, session, {
          transaction: actual,
          observedAt,
          validUntil,
          registerBeforeCommit: host.registerBeforeCommit,
          finalizers,
        });
        check();
        ready = true;
        return result;
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  }
  async function workspaceCurrent(
    tx: Transaction,
    session: AuthenticationSession,
    hold?: WorkspaceHold,
  ) {
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
    const setupSnapshotReferences = {
      canonicalize: canonicalizeRfc8785,
      hashIntent: (canonical: string) => "sha256:" + sha256Hex(canonical),
    };
    const publicationHash = createStoreConfigurationPublicationHash(setupSnapshotReferences);
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
          hashContent: publicationHash,
          setupSnapshotReferences,
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
      if (item.screenId === "ORG-BRAND-DETAIL") {
        if (item.href !== "/app/organization/brands/" + context.brand.brandReference)
          throw new Error("MERCHANT_BFF_UNAVAILABLE");
        // Only the current owning admission below may emit this entry.
        continue;
      }
      if (item.screenId === "CAT-OPTIONSET-LIST") {
        // This entry has no legacy authority fallback: actual Option IAM and
        // owning Feature admission must remain held through this COMMIT.
        if (
          currentNavigation &&
          hold &&
          (await createMerchantProductListNavigationRuntime({
            session,
            selected,
            now,
            currentActor,
            validateAssociation,
            ...hold,
            target: "OptionSet",
          }).allows())
        )
          navigation.push(item);
        continue;
      }
      // WP-2423 / DEC-CAT-PRODUCT-ADMIN: without a WP-2421 product-list runtime the entry leads to
      // the Brand Product pages and follows the ordinary current permission check below.
      if (item.screenId === "CAT-PRODUCT-LIST" && (currentNavigation || legacyNavigation)) {
        const show =
          currentNavigation && hold
            ? await createMerchantProductListNavigationRuntime({
                session,
                selected,
                now,
                currentActor,
                validateAssociation,
                ...hold,
              }).allows()
            : await allowsProductListNavigation(
                tx,
                selected,
                session.sessionReference,
                legacyNavigation,
              );
        if (show) navigation.push(item);
        continue;
      }
      if (item.permission === "merchant.access" || (await allowed(item.permission)))
        navigation.push(item);
    }
    if (currentBrandNavigation) {
      if (!hold) throw new Error("MERCHANT_BFF_UNAVAILABLE");
      const runtime = createMerchantBrandNavigationRuntime({
        session,
        selected,
        now,
        currentActor,
        validateAssociation,
        transaction: hold.transaction,
        observedAt: hold.observedAt,
        validUntil: hold.validUntil,
        registerBeforeCommit: hold.registerBeforeCommit,
      });
      const entry = await runtime.read();
      hold.finalizers.push(() => {
        runtime.assertFinalized();
      });
      if (entry) {
        if (
          entry.screenId !== "ORG-BRAND-DETAIL" ||
          entry.href !== "/app/organization/brands/" + context.brand.brandReference
        )
          throw new Error("MERCHANT_BFF_UNAVAILABLE");
        navigation.push(
          Object.freeze({
            ...entry,
            label: "Brand administration",
            permission: "organization.manage",
          }),
        );
      }
    }
    const storeOption = Object.freeze({
      brandLabel: context.brand.displayName,
      storeLabel: store.displayName,
      storeReference: store.storeReference,
    });
    // WP-2423: the selected Store's own time zone, for Store-local order times.
    const selectedScope = Object.freeze({ ...storeOption, timeZone: store.timeZone });
    const authorizedStores = [];
    for (const candidate of result.authorizedStores) {
      if (candidate.storeReference === store.storeReference) {
        authorizedStores.push(storeOption);
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
      const finalizers: (() => void)[] = [];
      const result = await options.transactions.run(async (tx) => {
        const session = await currentSession(tx, cookie);
        if (session.sessionReference !== bootstrap.session.sessionReference)
          throw new Error("MERCHANT_BFF_UNAVAILABLE");
        return Object.freeze({
          session,
          csrf: bootstrap.csrf,
          workspace: await workspace(tx, session, finalizers),
        });
      });
      for (const finalize of finalizers) finalize();
      return result;
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
        const finalizers: (() => void)[] = [];
        const rotation = service(async (tx, record) => {
          await bind(tx, record);
          nextWorkspace = await workspace(tx, record.session, finalizers);
        });
        const result = await rotation.rotate(input.sessionCookie, "StoreContextElevation");
        for (const finalize of finalizers) finalize();
        if (!nextWorkspace) throw new Error("MERCHANT_BFF_UNAVAILABLE");
        return Object.freeze({ cookie: result.cookie, workspace: nextWorkspace });
      } catch {
        throw new Error("STORE_SWITCH_DENIED");
      }
    },
  };
  return Object.freeze(bff);
}
