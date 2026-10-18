import {
  assertSessionUsable,
  createIdentityActor,
  createPostgresBrowserBrandSessionSelectionStore,
  createPostgresCurrentWorkforceBrowserSessionRecordSource,
  type BrowserSessionRecord,
  parseSessionReference,
  parseCanonicalInstant as parseIdentityInstant,
  type AuthenticationSession,
  type createPostgresBrowserSessionStore,
  type OidcAuthorizationTransaction,
} from "@bop/identity";
import { parseBrandReference, parseCanonicalInstant } from "@bop/tenant";
import {
  createPostgresCurrentBrandAdministrationPermissionPolicySource,
  createPostgresTransactionCurrentPermissionPolicySource,
} from "@bop/permission";
import {
  readMerchantCurrentBrandAdministrationAuthority,
  readMerchantCurrentBrandAuthority,
  type MerchantCurrentBrandOptions,
  type MerchantCurrentBrandAdministrationOptions,
} from "./merchant-current-brand-scope.js";

type Hook = NonNullable<
  Parameters<typeof createPostgresBrowserSessionStore>[0]["onSessionCreated"]
>;
export type BrandSelectionCommitGuard = (
  tx: OidcAuthorizationTransaction,
  check: () => Promise<void>,
  final: () => void,
) => Promise<void>;
const denied = (): never => {
  throw new Error("MERCHANT_BRAND_SESSION_SELECTION_DENIED");
};

/** Bound to one explicit requested Brand. Runs only for the genuine new Identity
 * session in its original transaction, including rotation; never copies an old
 * cookie's Actor or writes an inferred first Membership/Store selection. */
export interface MerchantBrandSessionSelectionOptions {
  readonly source: MerchantCurrentBrandOptions;
  readonly brandReference: string;
  readonly previousSessionReference: string | null;
  readonly registerBeforeCommit: BrandSelectionCommitGuard;
}
type SelectionAuthority = Pick<
  Awaited<ReturnType<typeof readMerchantCurrentBrandAuthority>>,
  "decisions" | "validUntil"
> & { readonly context: { readonly brand: { readonly version: number } } };
type SelectionAuthorityReader = (
  session: AuthenticationSession,
  brandReference: string,
  observedAt: string,
) => Promise<SelectionAuthority>;

export function createMerchantBrandSessionSelection(
  options: MerchantBrandSessionSelectionOptions,
): Hook {
  return createBrandSessionSelection(options, (tx) => {
    const policy = createPostgresTransactionCurrentPermissionPolicySource(tx);
    return (session, brand, at) =>
      readMerchantCurrentBrandAuthority(tx, session, brand, at, ["organization.manage"], policy);
  });
}

/** A requested administrative Brand keeps its real lifecycle. Selection still
 * requires current owning Membership and permission and grants no initial role. */
export function createMerchantBrandAdministrationSessionSelection(
  options: Omit<MerchantBrandSessionSelectionOptions, "source"> & {
    readonly source: MerchantCurrentBrandAdministrationOptions;
  },
): Hook {
  const identity = options.source.identity,
    configuration = identity.configuration,
    configurationIdentity = JSON.stringify(configuration),
    envelopes = identity.envelopes;
  return createBrandSessionSelection(
    options,
    (tx) => {
      const policy = createPostgresCurrentBrandAdministrationPermissionPolicySource(tx);
      return (session, brand, at) =>
        readMerchantCurrentBrandAdministrationAuthority(
          tx,
          session,
          brand,
          at,
          ["organization.manage"],
          policy,
        );
    },
    (now) => {
      if (
        options.source.identity !== identity ||
        identity.configuration !== configuration ||
        JSON.stringify(configuration) !== configurationIdentity ||
        identity.envelopes !== envelopes
      )
        return denied();
      const read = createPostgresCurrentWorkforceBrowserSessionRecordSource({
        hasher: identity.hasher,
        envelopes,
        configuration: {
          environment: configuration.environment,
          issuer: configuration.issuer,
          clientId: configuration.clientId,
        },
        now,
        currentActor: (...args) => options.source.currentActor.call(options.source, ...args),
      });
      return async (tx, record) => {
        if (
          options.source.identity !== identity ||
          identity.configuration !== configuration ||
          JSON.stringify(configuration) !== configurationIdentity ||
          identity.envelopes !== envelopes
        )
          return denied();
        return read(tx, record);
      };
    },
    () => {
      if (
        options.source.identity !== identity ||
        identity.configuration !== configuration ||
        JSON.stringify(configuration) !== configurationIdentity ||
        identity.envelopes !== envelopes
      )
        return denied();
    },
  );
}

function createBrandSessionSelection(
  options: MerchantBrandSessionSelectionOptions,
  reader: (tx: OidcAuthorizationTransaction) => SelectionAuthorityReader,
  strongSession?: (
    now: () => string,
  ) => (
    tx: OidcAuthorizationTransaction,
    record: BrowserSessionRecord,
  ) => Promise<AuthenticationSession>,
  checkStrongIdentity?: () => void,
): Hook {
  const source = options.source,
    clock = source.now,
    actorPort = source.currentActor;
  const brandReference = parseBrandReference(options.brandReference);
  const previous =
    options.previousSessionReference === null
      ? null
      : parseSessionReference(options.previousSessionReference);
  const register = options.registerBeforeCommit;
  return async (tx, record) => {
    const session = record.session,
      original = tx.query;
    let latest: string = parseCanonicalInstant(clock.call(source));
    let until = new Date(Date.parse(latest) + 5000).toISOString(),
      failed = false,
      active = false;
    const check = () => {
      checkStrongIdentity?.();
      const at = parseCanonicalInstant(clock.call(source));
      if (
        failed ||
        source.now !== clock ||
        source.currentActor !== actorPort ||
        options.registerBeforeCommit !== register ||
        tx.query !== original ||
        at < latest ||
        at >= until
      ) {
        failed = true;
        return denied();
      }
      latest = at;
      return at;
    };
    const retain = (value: string | null) => {
      if (value !== null && parseCanonicalInstant(value) < until) until = value;
      check();
    };
    const selection = createPostgresBrowserBrandSessionSelectionStore();
    const readAuthority = reader(tx);
    const readStrongSession = strongSession?.(check);
    let expectedBrandVersion: number | undefined;
    const authorize = async (): Promise<AuthenticationSession> => {
      try {
        if (active) return denied();
        active = true;
        const at = check();
        assertSessionUsable(session, at);
        if (
          session.rotatedFromSessionReference !== previous ||
          session.actor.actorReference === null ||
          session.sessionReference === previous
        )
          return denied();
        const strong = readStrongSession ? await readStrongSession(tx, record) : undefined;
        const actor =
          strong?.actor ??
          createIdentityActor(
            await actorPort.call(
              source,
              tx,
              session.actor.actorReference,
              session.authenticatedAt,
              parseIdentityInstant(at),
            ),
          );
        if (
          actor.actorReference !== session.actor.actorReference ||
          actor.authenticatedAt !== session.authenticatedAt ||
          actor.actorType !== "User" ||
          actor.accountKind !== "Workforce" ||
          actor.status !== "Active" ||
          actor.authenticationMethod !== "Oidc"
        )
          return denied();
        retain(session.idleExpiresAt);
        retain(session.absoluteExpiresAt);
        const current = strong ?? Object.freeze({ ...session, actor });
        if (strong) {
          if (strong.actor.recentMfaAt === null) return denied();
          retain(new Date(Date.parse(strong.actor.recentMfaAt) + 900000).toISOString());
        }
        const result = await readAuthority(current, brandReference, check());
        retain(result.validUntil);
        if (
          result.decisions[0]?.effect !== "Allow" ||
          (expectedBrandVersion !== undefined &&
            result.context.brand.version !== expectedBrandVersion)
        )
          return denied();
        expectedBrandVersion = result.context.brand.version;
        check();
        return current;
      } catch {
        failed = true;
        return denied();
      } finally {
        active = false;
      }
    };
    try {
      const current = await authorize();
      await selection.write(tx, current, { brandReference }, check());
      const verify = async () => {
        try {
          const fresh = await authorize();
          const selected = await selection.read(tx, fresh, check());
          if (selected?.brandReference !== brandReference) return denied();
          check();
        } catch {
          failed = true;
          return denied();
        }
      };
      await verify();
      await register(tx, verify, () => {
        check();
      });
      check();
    } catch {
      failed = true;
      return denied();
    }
  };
}
