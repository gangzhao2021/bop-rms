import {
  WorkforceBrowserSessionService,
  createPostgresWorkforceBrowserSessionStore,
  readClosedRecord,
} from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createPersistentBrandAdministrationBff } from "./persistent-brand-administration-bff.js";
import {
  createMerchantBrandDiscovery,
  MerchantBrandDiscoveryError,
  type MerchantBrandDiscoveryPersistence,
} from "./merchant-brand-discovery.js";

export type PersistentBrandDiscoveryBffOptions = MerchantBrandDiscoveryPersistence;
const path = "/app/organization/brands";
const unavailable = (): never => {
  throw new MerchantBrandDiscoveryError("Unavailable");
};

/** Authentication has no target Brand. Genuine new sessions, including step-up,
 * start without a selection; only the explicit authorized discovery command can
 * create the immutable Identity choice. Existing fixed-target entry is separate. */
export function createPersistentBrandDiscoveryBff(options: PersistentBrandDiscoveryBffOptions) {
  if (!options.identity.configuration.allowedPostLoginPaths.includes(path)) return unavailable();
  const nowPort = options.now,
    actorPort = options.currentActor,
    identity = options.identity,
    sourceConfiguration = identity.configuration,
    sourceConfigurationIdentity = JSON.stringify(sourceConfiguration),
    configuration = Object.freeze({
      ...sourceConfiguration,
      allowedPostLoginPaths: Object.freeze([path]),
    }),
    host = createMerchantCategoryTransactions(options.transactions);
  const captured = () => {
    if (
      options.now !== nowPort ||
      options.currentActor !== actorPort ||
      options.identity !== identity ||
      identity.configuration !== sourceConfiguration ||
      JSON.stringify(sourceConfiguration) !== sourceConfigurationIdentity
    )
      return unavailable();
  };
  const now = () => {
    captured();
    return nowPort.call(options);
  };
  const transactions: Parameters<
    typeof createPostgresWorkforceBrowserSessionStore
  >[0]["transactions"] = {
    async run(work) {
      return host.transactions.run(async (tx) => {
        const query = tx.query,
          origin = parseCanonicalInstant(now()),
          until = new Date(Date.parse(origin) + 5000).toISOString();
        let latest: string = origin,
          failed = false;
        const check = () => {
          captured();
          const at = parseCanonicalInstant(now());
          if (failed || tx.query !== query || at < latest || at >= until) {
            failed = true;
            return unavailable();
          }
          latest = at;
        };
        await host.registerBeforeCommit(
          tx,
          async () => {
            check();
          },
          check,
        );
        try {
          const answer = await work(tx);
          check();
          return answer;
        } catch (error) {
          failed = true;
          throw error;
        }
      });
    },
  };
  const base = new WorkforceBrowserSessionService({
    ...identity,
    configuration,
    now,
    store: createPostgresWorkforceBrowserSessionStore({
      transactions,
      now,
      currentActor: (...args) => {
        captured();
        return actorPort.call(options, ...args);
      },
      environment: configuration.environment,
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      envelopes: identity.envelopes,
      hasher: identity.hasher,
      redirectUri: configuration.redirectUri,
      allowedPostLoginPaths: configuration.allowedPostLoginPaths,
      // Deliberately no onSessionCreated: zero inferred Brand/Membership selection.
    }),
  });
  const discovery = createMerchantBrandDiscovery({
    source: options,
    transactions: host.transactions,
    registerBeforeCommit: host.registerBeforeCommit,
  });
  const onboarding = options.identity.workforceOnboarding;
  const invitationMethods = onboarding
    ? [onboarding.resolveInvitation, onboarding.exchangeCode, onboarding.complete]
    : [];
  const invitationCurrent = () => {
    if (
      options.identity.workforceOnboarding !== onboarding ||
      (onboarding &&
        invitationMethods.some(
          (method, index) =>
            method !==
            [onboarding.resolveInvitation, onboarding.exchangeCode, onboarding.complete][index],
        ))
    )
      return unavailable();
  };
  return Object.freeze({
    ...(onboarding
      ? {
          async startInvitation(secret: unknown) {
            invitationCurrent();
            const result = await base.startInvitation({ secret, postLoginPath: path });
            invitationCurrent();
            return result;
          },
        }
      : {}),
    start: (requestedPath: unknown) =>
      requestedPath === path
        ? base.start(path)
        : Promise.reject(new MerchantBrandDiscoveryError("Invalid")),
    callback(input: {
      readonly code: unknown;
      readonly state: unknown;
      readonly authCookie: unknown;
    }) {
      const value = readClosedRecord(input, ["code", "state", "authCookie"]);
      return base.callback({ code: value.code, state: value.state, authCookie: value.authCookie });
    },
    async authorize(input: { readonly sessionCookie: unknown; readonly csrf: unknown }) {
      return (await base.authorize(input)).session;
    },
    logout: (input: { readonly sessionCookie: unknown; readonly csrf: unknown }) =>
      base.logout(input),
    rotate: (input: { readonly sessionCookie: unknown; readonly csrf: unknown }) =>
      base.startStepUp({ ...input, postLoginPath: path }),
    async bootstrap(cookie: unknown) {
      const current = await discovery.bootstrap(cookie);
      if (current.recentMfaRequired || current.selectedBrandReference === null)
        return Object.freeze({ ...current, workspace: null });
      const selectedPath = `${path}/${current.selectedBrandReference}`;
      // This instance is used only for its existing actual current workspace
      // read. All login/callback/step-up operations remain on root base above.
      const selected = createPersistentBrandAdministrationBff({
        ...options,
        brandReference: current.selectedBrandReference,
        identity: {
          ...identity,
          configuration: { ...sourceConfiguration, allowedPostLoginPaths: [selectedPath] },
        },
      });
      const result = await selected.bootstrap(cookie);
      if (
        result.session.sessionReference !== current.session.sessionReference ||
        result.session.actor.actorReference !== current.session.actor.actorReference ||
        result.csrf !== current.csrf ||
        (result.workspace !== null &&
          result.workspace.selectedScope.brandReference !== current.selectedBrandReference)
      )
        return unavailable();
      return Object.freeze({ ...result, selectedBrandReference: current.selectedBrandReference });
    },
    discoveryBootstrap: discovery.discoveryBootstrap,
    list: discovery.list,
    select: discovery.select,
  });
}
