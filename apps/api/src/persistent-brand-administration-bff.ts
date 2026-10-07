import {
  WorkforceBrowserSessionService,
  createPostgresWorkforceBrowserSessionStore,
  type WorkforceBrowserSessionServiceOptions,
  readClosedRecord,
} from "@bop/identity";
import { parseBrandReference, parseCanonicalInstant } from "@bop/tenant";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantBrandAdministrationSessionSelection } from "./merchant-brand-session-selection.js";
import { createMerchantCurrentBrandAdministrationScope } from "./merchant-current-brand-scope.js";
import {
  createMerchantCurrentBrandAdministrationCapability,
  merchantBrandAdministrationCapabilityRequiredFields,
} from "./merchant-brand-administration-capability.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type Persistence = Parameters<typeof createPostgresWorkforceBrowserSessionStore>[0];
export type PersistentBrandAdministrationBffOptions = Pick<
  PersistentMerchantBffOptions,
  "transactions" | "currentActor" | "now"
> & {
  readonly identity: Omit<WorkforceBrowserSessionServiceOptions, "store" | "now">;
  /** Server-bound requested resource. Actual owning Brand and IAM are resolved
   * for this target; absence never falls back to a first membership. */
  readonly brandReference: string;
};
const denied = (): never => {
  throw new Error("BRAND_ADMINISTRATION_BFF_UNAVAILABLE");
};

/** Administrative Brand entry preserves its current lifecycle. Existing Store
 * admission stays operational; creation and discovery have separate authority. */
export function createPersistentBrandAdministrationBff(
  options: PersistentBrandAdministrationBffOptions,
) {
  // Invitations enter through unselected discovery, then the user explicitly
  // selects the activated Brand. This fixed path requires its selection hook.
  if (options.identity.workforceOnboarding !== undefined) return denied();
  const brand = parseBrandReference(options.brandReference),
    now = options.now.bind(options);
  const path = `/app/organization/brands/${brand}`;
  if (!options.identity.configuration.allowedPostLoginPaths.includes(path)) return denied();
  const configuration = Object.freeze({
    ...options.identity.configuration,
    allowedPostLoginPaths: Object.freeze([path]),
  });
  const host = createMerchantCategoryTransactions(options.transactions);
  // Identity also uses short read/OIDC transactions without a selection write.
  // These carry a clock/query guard; only the new-session hook establishes IAM.
  const transactions: Persistence["transactions"] = {
    async run(work) {
      return host.transactions.run(async (tx) => {
        const query = tx.query,
          started = parseCanonicalInstant(now());
        const until = new Date(Date.parse(started) + 5000).toISOString();
        let latest: string = started,
          failed = false;
        const check = () => {
          const at = parseCanonicalInstant(now());
          if (failed || tx.query !== query || at < latest || at >= until) {
            failed = true;
            return denied();
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
        const result = await work(tx);
        check();
        return result;
      });
    },
  };
  const base = new WorkforceBrowserSessionService({
    ...options.identity,
    configuration,
    now,
    store: createPostgresWorkforceBrowserSessionStore({
      transactions,
      now,
      currentActor: options.currentActor.bind(options),
      environment: configuration.environment,
      issuer: configuration.issuer,
      clientId: configuration.clientId,
      envelopes: options.identity.envelopes,
      hasher: options.identity.hasher,
      redirectUri: configuration.redirectUri,
      allowedPostLoginPaths: configuration.allowedPostLoginPaths,
      async onSessionCreated(tx, record) {
        const hook = createMerchantBrandAdministrationSessionSelection({
          source: options,
          brandReference: brand,
          previousSessionReference: record.session.rotatedFromSessionReference,
          registerBeforeCommit: (actual, guard, final) =>
            host.registerBeforeCommit(
              actual as Parameters<typeof host.registerBeforeCommit>[0],
              guard,
              final,
            ),
        });
        await hook(tx, record);
      },
    }),
  });
  const resolve = createMerchantCurrentBrandAdministrationScope(options);
  async function workspace(cookie: unknown, expectedSession: string) {
    let finalize: (() => void) | undefined;
    const result = await host.transactions.run(async (tx) => {
      const observedAt = parseCanonicalInstant(now());
      const validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
      const current = await resolve(tx, cookie, expectedSession, validUntil);
      if (current.context.brand.brandReference !== brand) return denied();
      const scope = Object.freeze({
        tenantReference: current.tenantReference,
        brandReference: String(brand),
        actorReference: String(current.actorReference),
      });
      const capability = createMerchantCurrentBrandAdministrationCapability({
        mode: "Navigation",
        transaction: tx,
        scope,
        clock: { now },
        originalObservedAt: observedAt,
        originalValidUntil: validUntil,
        registerBeforeCommit: host.registerBeforeCommit,
        async holdCurrentBrandAdministrationAuthority(transaction, input) {
          if (
            transaction !== tx ||
            input.scope.tenantReference !== scope.tenantReference ||
            input.scope.brandReference !== scope.brandReference ||
            input.scope.actorReference !== scope.actorReference ||
            input.permission !== "organization.manage" ||
            input.purposeCode !== "BRAND_ADMINISTRATION" ||
            input.observedAt < observedAt ||
            input.observedAt > now() ||
            input.validUntil > validUntil ||
            input.requiredFields.length !==
              merchantBrandAdministrationCapabilityRequiredFields.length ||
            input.requiredFields.some(
              (field, index) =>
                field !== merchantBrandAdministrationCapabilityRequiredFields[index],
            )
          )
            return denied();
          const result = await current.authorizeActionsWithValidity(["organization.manage"]);
          const permission = result.decisions[0];
          if (!permission || permission.effect !== "Allow") return denied();
          return Object.freeze({
            scope,
            administrationContext: result.context,
            permission,
            validUntil: result.validUntil,
          });
        },
      });
      const visible = await capability.holdForNavigation();
      await host.registerBeforeCommit(
        tx,
        async () => {
          if ((await current.authorizeAction("organization.manage")).effect !== "Allow")
            return denied();
        },
        current.assertCurrent,
      );
      finalize = () => {
        capability.assertFinalized();
      };
      return Object.freeze({
        profile: "BrandAdministrationWorkspaceV1" as const,
        selectedScope: scope,
        brand: Object.freeze({
          brandReference: String(brand),
          label: current.context.brand.displayName,
          lifecycle: current.context.brand.lifecycle,
          version: current.context.brand.version,
        }),
        navigation: Object.freeze(
          visible
            ? [
                Object.freeze({
                  screenId: "ORG-BRAND-DETAIL" as const,
                  label: "Brand",
                  href: path,
                  permission: "organization.manage",
                }),
              ]
            : [],
        ),
      });
    });
    if (!finalize) return denied();
    finalize();
    return result;
  }
  return Object.freeze({
    start: (requestedPath: unknown) =>
      requestedPath === path
        ? base.start(requestedPath)
        : Promise.reject(new Error("BRAND_ADMINISTRATION_BFF_UNAVAILABLE")),
    async callback(input: {
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
    async bootstrap(cookie: unknown) {
      const current = await base.bootstrap(cookie);
      return Object.freeze({
        ...current,
        workspace: current.recentMfaRequired
          ? null
          : await workspace(cookie, current.session.sessionReference),
      });
    },
    rotate: (input: { readonly sessionCookie: unknown; readonly csrf: unknown }) =>
      base.startStepUp({ ...input, postLoginPath: path }),
  });
}
