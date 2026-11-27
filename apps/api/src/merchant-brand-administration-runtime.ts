import {
  createCognitoWorkforceIdentity,
  parseExactHttpsUri,
  readClosedRecord,
  parseOpaqueUuidV7,
  type CognitoWorkforceIdentityOptions,
  type WorkforceBrowserSessionServiceOptions,
} from "@bop/identity";
import { isAbsolute, normalize } from "node:path";
import {
  createCognitoWorkforceOnboardingBrowser,
  type CognitoWorkforceOnboardingBrowserOptions,
} from "./workforce-onboarding-browser.js";
import { parseBrandReference } from "@bop/tenant";
import {
  createMerchantCategoryTransactions,
  registerMerchantTransactionBeforeCommit,
} from "./merchant-category-transactions.js";
import {
  createPersistentBrandAdministrationBff,
  type PersistentBrandAdministrationBffOptions,
} from "./persistent-brand-administration-bff.js";
import {
  createMerchantBrandConfigurationOrdinary,
  type MerchantBrandConfigurationOrdinaryOptions,
} from "./merchant-brand-configuration-ordinary.js";
import { createPersistentBrandDiscoveryBff } from "./persistent-brand-discovery-bff.js";
import { createMerchantBrandLifecycleOrdinary } from "./merchant-brand-lifecycle-ordinary.js";
import { createMerchantBrandConfigurationReferences } from "./merchant-brand-configuration-references.js";
import type { MerchantBrandAdministrationHttpOptions } from "./merchant-brand-administration-http.js";
import {
  createMerchantBrandCatalogSource,
  type MerchantBrandCatalogSourceOptions,
} from "./merchant-brand-catalog-source.js";

export interface MerchantBrandAdministrationRuntimeOptions {
  readonly persistence: Omit<PersistentBrandAdministrationBffOptions, "brandReference"> & {
    /** Omit for authenticated discovery and deliberate selection. */
    readonly brandReference?: string;
  };
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly authorizationOrigin: string;
  readonly logoutUrl: string;
  readonly configuration?: Pick<
    MerchantBrandConfigurationOrdinaryOptions,
    "configure" | "nextReference"
  >;
  readonly catalogSource: Pick<MerchantBrandCatalogSourceOptions, "nextReference">;
}
export interface MerchantBrandOnboardingConfiguration {
  readonly environmentReference: string;
  readonly files: CognitoWorkforceOnboardingBrowserOptions["files"];
  readonly acceptanceRoleName: string;
}
export interface CognitoMerchantBrandAdministrationRuntimeOptions {
  readonly identity: Pick<
    CognitoWorkforceIdentityOptions,
    "configuration" | "clock" | "hasher" | "envelopes"
  > & {
    readonly credentials: WorkforceBrowserSessionServiceOptions["credentials"];
    readonly pkce: WorkforceBrowserSessionServiceOptions["pkce"];
  };
  readonly transactions: PersistentBrandAdministrationBffOptions["transactions"];
  readonly onboarding?: MerchantBrandOnboardingConfiguration;
  readonly brandReference?: string;
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly configuration?: NonNullable<MerchantBrandAdministrationRuntimeOptions["configuration"]>;
  readonly catalogSource: MerchantBrandAdministrationRuntimeOptions["catalogSource"];
}
const unavailable = (): never => {
  throw new Error("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
};
function readConfiguration(
  options: Pick<MerchantBrandAdministrationRuntimeOptions, "configuration">,
) {
  if (!Object.hasOwn(options, "configuration")) return undefined;
  const configuration = options.configuration;
  readClosedRecord(configuration, ["configure", "nextReference"]);
  if (
    typeof configuration?.configure !== "function" ||
    typeof configuration.nextReference !== "function"
  )
    return unavailable();
  return configuration;
}
function readOnboarding(
  options: Pick<CognitoMerchantBrandAdministrationRuntimeOptions, "onboarding">,
) {
  if (!Object.hasOwn(options, "onboarding")) return undefined;
  const input = readClosedRecord(options.onboarding, [
      "environmentReference",
      "files",
      "acceptanceRoleName",
    ]),
    files = readClosedRecord(input.files, [
      "planPath",
      "approvalPath",
      "approvalTrustPath",
      "relationshipPath",
      "relationshipTrustPath",
    ]);
  const path = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      value.length > 4096 ||
      value.includes("\0") ||
      !isAbsolute(value) ||
      normalize(value) !== value
    )
      return unavailable();
    return value;
  };
  if (
    typeof input.acceptanceRoleName !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(input.acceptanceRoleName)
  )
    return unavailable();
  const captured = Object.freeze({
    planPath: path(files.planPath),
    approvalPath: path(files.approvalPath),
    approvalTrustPath: path(files.approvalTrustPath),
    relationshipPath: path(files.relationshipPath),
    relationshipTrustPath: path(files.relationshipTrustPath),
  });
  if (new Set(Object.values(captured)).size !== 5) return unavailable();
  return Object.freeze({
    environmentReference: parseOpaqueUuidV7(input.environmentReference, "ACTOR_REFERENCE_INVALID"),
    files: captured,
    acceptanceRoleName: input.acceptanceRoleName,
  });
}
function assertDestinations(input: {
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly authorizationOrigin: string;
  readonly logoutUrl: string;
  readonly redirectUri: string;
  readonly clientId: string;
}) {
  const origin = new URL(input.exactOrigin),
    provider = new URL(input.authorizationOrigin),
    logout = new URL(parseExactHttpsUri(input.logoutUrl)),
    parameters = logout.searchParams;
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.exactOrigin ||
    origin.host !== input.acceptedHost ||
    provider.protocol !== "https:" ||
    provider.origin !== input.authorizationOrigin ||
    input.redirectUri !== `${input.exactOrigin}/merchant/organization/brands/callback` ||
    typeof input.clientId !== "string" ||
    input.clientId.length === 0 ||
    logout.href !== input.logoutUrl ||
    logout.origin !== input.authorizationOrigin ||
    logout.pathname !== "/logout" ||
    [...parameters.keys()].length !== 2 ||
    parameters.getAll("client_id").length !== 1 ||
    parameters.getAll("logout_uri").length !== 1 ||
    parameters.get("client_id") !== input.clientId ||
    parameters.get("logout_uri") !== `${input.exactOrigin}/app/organization/brands`
  )
    return unavailable();
}

/** Fixed production startup: actual Identity owns Provider verification and
 * Workforce account reads. The API supplies its genuine transaction host only. */
export function createCognitoMerchantBrandAdministrationRuntime(
  options: CognitoMerchantBrandAdministrationRuntimeOptions,
): MerchantBrandAdministrationHttpOptions {
  try {
    readClosedRecord(options, [
      "identity",
      "transactions",
      ...(Object.hasOwn(options, "onboarding") ? ["onboarding"] : []),
      ...(Object.hasOwn(options, "brandReference") ? ["brandReference"] : []),
      "exactOrigin",
      "acceptedHost",
      ...(Object.hasOwn(options, "configuration") ? ["configuration"] : []),
      "catalogSource",
    ]);
    readClosedRecord(options.identity, [
      "configuration",
      "clock",
      "hasher",
      "envelopes",
      "credentials",
      "pkce",
    ]);
    const identity = options.identity,
      c = identity.configuration;
    readClosedRecord(c, [
      "environment",
      "issuer",
      "clientId",
      "clientSecret",
      "managedLoginOrigin",
      "redirectUri",
      "logoutReturnUri",
    ]);
    const brandReference = Object.hasOwn(options, "brandReference")
        ? String(parseBrandReference(options.brandReference))
        : null,
      logout = new URL("/logout", c.managedLoginOrigin);
    logout.searchParams.set("client_id", c.clientId);
    logout.searchParams.set("logout_uri", c.logoutReturnUri);
    assertDestinations({
      exactOrigin: options.exactOrigin,
      acceptedHost: options.acceptedHost,
      authorizationOrigin: c.managedLoginOrigin,
      logoutUrl: logout.href,
      redirectUri: c.redirectUri,
      clientId: c.clientId,
    });
    const configuration = readConfiguration(options),
      onboarding = readOnboarding(options);
    if (onboarding && brandReference !== null) return unavailable();
    readClosedRecord(options.catalogSource, ["nextReference"]);
    if (typeof options.catalogSource.nextReference !== "function") return unavailable();
    const host = createMerchantCategoryTransactions(options.transactions),
      actual = createCognitoWorkforceIdentity({
        configuration: c,
        transactions: host.transactions,
        registerBeforeCommit: registerMerchantTransactionBeforeCommit,
        clock: identity.clock,
        hasher: identity.hasher,
        envelopes: identity.envelopes,
        nextEvidenceReference: identity.credentials.generateUuidV7.bind(identity.credentials),
      });
    const allowedPostLoginPaths = Object.freeze([
      brandReference === null
        ? "/app/organization/brands"
        : `/app/organization/brands/${brandReference}`,
    ]);
    const workforceOnboarding = onboarding
      ? createCognitoWorkforceOnboardingBrowser({
          // The onboarding owner installs its final original-proof checks on
          // this physical transaction host, without a later outer IAM guard.
          transactions: options.transactions,
          configuration: c,
          clock: identity.clock,
          hasher: identity.hasher,
          envelopes: identity.envelopes,
          nextReference: identity.credentials.generateUuidV7.bind(identity.credentials),
          ...onboarding,
          allowedPostLoginPaths,
        })
      : undefined;
    const logoutUrl = actual.provider.createLogoutUrl();
    if (logoutUrl !== logout.href) return unavailable();
    return createMerchantBrandAdministrationRuntime({
      exactOrigin: options.exactOrigin,
      acceptedHost: options.acceptedHost,
      authorizationOrigin: c.managedLoginOrigin,
      logoutUrl,
      ...(configuration ? { configuration } : {}),
      catalogSource: options.catalogSource,
      persistence: {
        ...(brandReference === null ? {} : { brandReference }),
        transactions: actual.transactions,
        currentActor: actual.currentActor,
        now: identity.clock.now.bind(identity.clock),
        identity: {
          configuration: {
            environment: c.environment,
            issuer: c.issuer,
            clientId: c.clientId,
            redirectUri: c.redirectUri,
            allowedPostLoginPaths,
          },
          provider: actual.provider,
          ...(workforceOnboarding ? { workforceOnboarding } : {}),
          credentials: identity.credentials,
          pkce: identity.pkce,
          hasher: identity.hasher,
          envelopes: identity.envelopes,
        },
      },
    });
  } catch {
    return unavailable();
  }
}

/** Explicit startup composition. Identity configuration must register the exact
 * dedicated callback; no Store selection or template/permission facts are seeded. */
export function createMerchantBrandAdministrationRuntime(
  options: MerchantBrandAdministrationRuntimeOptions,
): MerchantBrandAdministrationHttpOptions {
  try {
    readClosedRecord(options, [
      "persistence",
      "exactOrigin",
      "acceptedHost",
      "authorizationOrigin",
      "logoutUrl",
      ...(Object.hasOwn(options, "configuration") ? ["configuration"] : []),
      "catalogSource",
    ]);
    const persistence = options.persistence;
    assertDestinations({
      exactOrigin: options.exactOrigin,
      acceptedHost: options.acceptedHost,
      authorizationOrigin: options.authorizationOrigin,
      logoutUrl: options.logoutUrl,
      redirectUri: persistence.identity.configuration.redirectUri,
      clientId: persistence.identity.configuration.clientId,
    });
    let configured = readConfiguration(options);
    readClosedRecord(options.catalogSource, ["nextReference"]);
    if (typeof options.catalogSource.nextReference !== "function") return unavailable();
    if (!configured) {
      const now = persistence.now,
        credentials = persistence.identity.credentials,
        allocate = credentials.generateUuidV7;
      if (typeof now !== "function" || typeof allocate !== "function") return unavailable();
      configured = {
        configure: createMerchantBrandConfigurationReferences({ now: now.bind(persistence) }),
        nextReference: allocate.bind(credentials),
      };
    }
    const brandReference = Object.hasOwn(persistence, "brandReference")
        ? String(parseBrandReference(persistence.brandReference))
        : null,
      discovery = brandReference === null ? createPersistentBrandDiscoveryBff(persistence) : null,
      service =
        discovery ??
        createPersistentBrandAdministrationBff(
          persistence as PersistentBrandAdministrationBffOptions,
        );
    const configuration = createMerchantBrandConfigurationOrdinary({
      persistence,
      authentication: service,
      configure: configured.configure,
      nextReference: configured.nextReference,
    });
    const catalogSource = createMerchantBrandCatalogSource({
      persistence,
      authentication: service,
      nextReference: options.catalogSource.nextReference,
    });
    const credentials = persistence.identity.credentials;
    const lifecycle = createMerchantBrandLifecycleOrdinary({
      persistence,
      authentication: service,
      nextReference: credentials.generateUuidV7.bind(credentials),
    });
    return Object.freeze({
      brandReference,
      ...(discovery === null ? {} : { discovery }),
      exactOrigin: options.exactOrigin,
      acceptedHost: options.acceptedHost,
      authorizationOrigin: options.authorizationOrigin,
      logoutUrl: options.logoutUrl,
      service,
      configuration,
      catalogSource,
      lifecycle,
      clock: Object.freeze({ now: persistence.now.bind(persistence) }),
    });
  } catch {
    return unavailable();
  }
}
