import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantBrandAdministrationRuntime,
  createCognitoMerchantBrandAdministrationRuntime,
  type CognitoMerchantBrandAdministrationRuntimeOptions,
  type MerchantBrandAdministrationRuntimeOptions,
} from "./merchant-brand-administration-runtime.js";
import type { CognitoWorkforceIdentityOptions } from "@bop/identity";
import type { MerchantBrandConfigurationOrdinaryOptions } from "./merchant-brand-configuration-ordinary.js";
import { registerMerchantTransactionBeforeCommit } from "./merchant-category-transactions.js";
const ports = vi.hoisted(() => ({
  service: Object.freeze({ authorize: vi.fn() }),
  ordinary: Object.freeze({ current: vi.fn() }),
  bff: vi.fn(),
  discovery: vi.fn(),
  discoveryService: Object.freeze({
    authorize: vi.fn(),
    discoveryBootstrap: vi.fn(),
    list: vi.fn(),
    select: vi.fn(),
  }),
  configure: vi.fn(),
  catalog: vi.fn(),
  lifecycle: vi.fn(),
  lifecycleService: Object.freeze({ execute: vi.fn() }),
  concrete: vi.fn(),
  onboarding: vi.fn(),
  onboardingPort: Object.freeze({
    resolveInvitation: vi.fn(),
    exchangeCode: vi.fn(),
    complete: vi.fn(),
  }),
  references: vi.fn(),
  referenceConfigure: vi.fn(),
}));
vi.mock("./workforce-onboarding-browser.js", () => ({
  createCognitoWorkforceOnboardingBrowser: (options: unknown) => {
    ports.onboarding(options);
    return ports.onboardingPort;
  },
}));
vi.mock("./merchant-brand-configuration-references.js", () => ({
  createMerchantBrandConfigurationReferences: (options: unknown) => {
    ports.references(options);
    return ports.referenceConfigure;
  },
}));
vi.mock("@bop/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bop/identity")>();
  return { ...actual, createCognitoWorkforceIdentity: ports.concrete };
});
vi.mock("./persistent-brand-discovery-bff.js", () => ({
  createPersistentBrandDiscoveryBff: (options: unknown) => {
    ports.discovery(options);
    return ports.discoveryService;
  },
}));
vi.mock("./persistent-brand-administration-bff.js", () => ({
  createPersistentBrandAdministrationBff: (options: unknown) => {
    ports.bff(options);
    return ports.service;
  },
}));
vi.mock("./merchant-brand-configuration-ordinary.js", () => ({
  createMerchantBrandConfigurationOrdinary: (options: unknown) => {
    ports.configure(options);
    return ports.ordinary;
  },
}));
vi.mock("./merchant-brand-catalog-source.js", () => ({
  createMerchantBrandCatalogSource: (options: unknown) => {
    ports.catalog(options);
    return ports.ordinary;
  },
}));
vi.mock("./merchant-brand-lifecycle-ordinary.js", () => ({
  createMerchantBrandLifecycleOrdinary: (options: unknown) => {
    ports.lifecycle(options);
    return ports.lifecycleService;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  ports.concrete.mockReset();
});
const authorizationOrigin = "https://identity.example.test",
  logoutUrl = `${authorizationOrigin}/logout?client_id=syntheticclient&logout_uri=https%3A%2F%2Fmerchant.invalid%2Fapp%2Forganization%2Fbrands`;
function fixture() {
  // Construction seam only: neither mocked factory is Session/IAM evidence.
  const options = {
    exactOrigin: "https://merchant.invalid",
    acceptedHost: "merchant.invalid",
    authorizationOrigin,
    logoutUrl,
    persistence: {
      brandReference: "01902421-1013-7000-8000-000000000001",
      identity: {
        configuration: {
          clientId: "syntheticclient",
          redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
        },
        credentials: { generate: vi.fn(), generateUuidV7: vi.fn() },
      },
      now: () => "2026-10-06T12:00:00.000Z",
    },
    configuration: { configure: vi.fn(), nextReference: vi.fn() },
    catalogSource: { nextReference: vi.fn() },
  } as unknown as MerchantBrandAdministrationRuntimeOptions & {
    configuration: NonNullable<MerchantBrandAdministrationRuntimeOptions["configuration"]>;
  };
  return options;
}
it("composes the actual configured noStore service and ordinary adapter without invoking source qualification", () => {
  const options = fixture(),
    result = createMerchantBrandAdministrationRuntime(options);
  expect(ports.bff).toHaveBeenCalledWith(options.persistence);
  expect(ports.configure).toHaveBeenCalledWith({
    persistence: options.persistence,
    authentication: ports.service,
    ...options.configuration,
  });
  expect(result.service).toBe(ports.service);
  expect(result.configuration).toBe(ports.ordinary);
  expect(result.lifecycle).toBe(ports.lifecycleService);
  expect(ports.lifecycle).toHaveBeenCalledWith(
    expect.objectContaining({
      persistence: options.persistence,
      authentication: ports.service,
      nextReference: expect.any(Function),
    }),
  );
  expect(ports.catalog).toHaveBeenCalledWith({
    persistence: options.persistence,
    authentication: ports.service,
    nextReference: options.catalogSource.nextReference,
  });
  expect(options.catalogSource.nextReference).not.toHaveBeenCalled();
  expect(result.brandReference).toBe(options.persistence.brandReference);
  expect(result.clock.now()).toBe(options.persistence.now());
  expect(result.authorizationOrigin).toBe(authorizationOrigin);
  expect(result.logoutUrl).toBe(logoutUrl);
  expect(options.configuration.configure).not.toHaveBeenCalled();
  expect(options.configuration.nextReference).not.toHaveBeenCalled();
  expect(ports.references).not.toHaveBeenCalled();
  expect(Object.isFrozen(result)).toBe(true);
});
it.each(["http", "host", "callback", "missingSources"])(
  "refuses incompatible startup %s before constructing identity",
  (kind) => {
    const original = fixture();
    const options =
      kind === "http"
        ? { ...original, exactOrigin: "http://merchant.invalid" }
        : kind === "host"
          ? { ...original, acceptedHost: "other.invalid" }
          : kind === "callback"
            ? {
                ...original,
                persistence: {
                  ...original.persistence,
                  identity: {
                    ...original.persistence.identity,
                    configuration: {
                      ...original.persistence.identity.configuration,
                      redirectUri: "https://merchant.invalid/merchant/callback",
                    },
                  },
                },
              }
            : { ...original, configuration: undefined };
    expect(() =>
      createMerchantBrandAdministrationRuntime(
        options as MerchantBrandAdministrationRuntimeOptions,
      ),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
    expect(ports.bff).not.toHaveBeenCalled();
  },
);

it.each([
  { authorizationOrigin: "http://identity.example.test" },
  { authorizationOrigin: `${authorizationOrigin}/managed` },
  {
    logoutUrl:
      "https://foreign.invalid/logout?client_id=syntheticclient&logout_uri=https%3A%2F%2Fmerchant.invalid%2Fapp%2Forganization%2Fbrands",
  },
  { logoutUrl: logoutUrl.replace("/logout?", "/other?") },
  { logoutUrl: logoutUrl.replace("client_id=syntheticclient", "client_id=other") },
  { logoutUrl: `${logoutUrl}&client_id=syntheticclient` },
  { logoutUrl: `${logoutUrl}&arbitrary=extra` },
  { logoutUrl: `${logoutUrl}#fragment` },
  { logoutUrl: logoutUrl.replace("%2Fbrands", "%2Fstores") },
])(
  "rejects incompatible trusted Provider destinations before constructing transport %j",
  (patch) => {
    expect(() => createMerchantBrandAdministrationRuntime({ ...fixture(), ...patch })).toThrow(
      "BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE",
    );
    expect(ports.bff).not.toHaveBeenCalled();
  },
);

function concreteFixture() {
  const base = fixture(),
    events: string[] = [],
    query = vi.fn(async () => ({ rows: [] })),
    driver = { query },
    rawRun = vi.fn(),
    run = async <T>(work: (tx: typeof driver) => Promise<T>): Promise<T> => {
      rawRun();
      events.push("begin");
      try {
        const value = await work(driver);
        events.push("commit");
        return value;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
    options: CognitoMerchantBrandAdministrationRuntimeOptions = {
      identity: {
        configuration: {
          environment: "synthetic",
          issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
          clientId: "syntheticclient",
          clientSecret: "synthetic-only-secret",
          managedLoginOrigin: authorizationOrigin,
          redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
          logoutReturnUri: "https://merchant.invalid/app/organization/brands",
        },
        clock: { now: () => "2026-10-06T12:00:00.000Z" },
        hasher: { hash: vi.fn(), equals: vi.fn() },
        envelopes: { encrypt: vi.fn(), decrypt: vi.fn() },
        credentials: { generate: vi.fn(), generateUuidV7: vi.fn() },
        pkce: { challenge: vi.fn() },
      },
      transactions: { run },
      brandReference: "01902421-1013-7000-8000-000000000001",
      exactOrigin: base.exactOrigin,
      acceptedHost: base.acceptedHost,
      configuration: base.configuration,
      catalogSource: base.catalogSource,
    };
  ports.concrete.mockImplementation((input: CognitoWorkforceIdentityOptions) => ({
    provider: { createLogoutUrl: () => logoutUrl },
    transactions: input.transactions,
    currentActor: vi.fn(),
  }));
  return { options, events, driver, query, rawRun };
}

it("composes concrete Workforce Identity with the actual API host and live transaction locator", async () => {
  // Controlled factory boundary: this proves composition, not OIDC/IAM native acceptance.
  const f = concreteFixture(),
    result = createCognitoMerchantBrandAdministrationRuntime(f.options),
    identity = ports.concrete.mock.calls[0]?.[0] as CognitoWorkforceIdentityOptions;
  expect(identity.configuration).toBe(f.options.identity.configuration);
  expect(identity.registerBeforeCommit).toBe(registerMerchantTransactionBeforeCommit);
  expect(identity.transactions).not.toBe(f.options.transactions);
  expect(Object.keys(identity)).toEqual([
    "configuration",
    "transactions",
    "registerBeforeCommit",
    "clock",
    "hasher",
    "envelopes",
    "nextEvidenceReference",
  ]);
  expect(f.rawRun).not.toHaveBeenCalled();
  await identity.transactions.run(async (tx) => {
    expect(tx).not.toBe(f.driver);
    await identity.registerBeforeCommit(
      tx,
      async () => {
        f.events.push("guard");
      },
      () => {
        f.events.push("seal");
      },
    );
    await tx.query("SELECT controlled_transport", []);
  });
  expect(f.events).toEqual(["begin", "guard", "seal", "commit"]);
  expect(f.query).toHaveBeenCalledExactlyOnceWith("SELECT controlled_transport", []);
  const persistence = ports.bff.mock
    .calls[0]?.[0] as MerchantBrandAdministrationRuntimeOptions["persistence"];
  expect(persistence.identity.configuration).toEqual({
    environment: "synthetic",
    issuer: f.options.identity.configuration.issuer,
    clientId: "syntheticclient",
    redirectUri: f.options.identity.configuration.redirectUri,
    allowedPostLoginPaths: [`/app/organization/brands/${f.options.brandReference}`],
  });
  expect(persistence.identity).not.toHaveProperty("configuration.clientSecret");
  expect(result.authorizationOrigin).toBe(authorizationOrigin);
  expect(result.logoutUrl).toBe(logoutUrl);
  expect(JSON.stringify(result)).not.toContain("synthetic-only-secret");
  expect(f.options.identity.credentials.generateUuidV7).not.toHaveBeenCalled();
});

it("composes concrete Workforce discovery with a root return path and no automatic Brand", () => {
  const f = concreteFixture();
  const { brandReference: omitted, ...options } = f.options;
  void omitted;
  const result = createCognitoMerchantBrandAdministrationRuntime(options);
  const persistence = ports.discovery.mock
    .calls[0]?.[0] as MerchantBrandAdministrationRuntimeOptions["persistence"];
  expect(result.brandReference).toBeNull();
  expect(result.service).toBe(ports.discoveryService);
  expect(result.discovery).toBe(ports.discoveryService);
  expect(persistence).not.toHaveProperty("brandReference");
  expect(persistence.identity.configuration.allowedPostLoginPaths).toEqual([
    "/app/organization/brands",
  ]);
  expect(ports.bff).not.toHaveBeenCalled();
  expect(f.rawRun).not.toHaveBeenCalled();
  expect(options.identity.credentials.generateUuidV7).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("synthetic-only-secret");
});

it.each([undefined, null, "", "not-a-brand"])(
  "rejects an explicit malformed concrete Brand %s before constructing Identity",
  (brandReference) => {
    const f = concreteFixture();
    Reflect.set(f.options, "brandReference", brandReference);
    expect(() => createCognitoMerchantBrandAdministrationRuntime(f.options)).toThrow(
      "BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE",
    );
    expect(ports.concrete).not.toHaveBeenCalled();
    expect(ports.discovery).not.toHaveBeenCalled();
    expect(f.rawRun).not.toHaveBeenCalled();
  },
);

it.each(["host", "origin", "callback", "logout", "provider-origin", "brand", "sources"])(
  "rejects invalid concrete %s configuration before Identity or transport construction",
  (invalid) => {
    const f = concreteFixture();
    if (invalid === "host") Reflect.set(f.options, "acceptedHost", "foreign.invalid");
    if (invalid === "origin") Reflect.set(f.options, "exactOrigin", "http://merchant.invalid");
    if (invalid === "callback")
      Reflect.set(
        f.options.identity.configuration,
        "redirectUri",
        "https://merchant.invalid/merchant/callback",
      );
    if (invalid === "logout")
      Reflect.set(
        f.options.identity.configuration,
        "logoutReturnUri",
        "https://merchant.invalid/app/stores",
      );
    if (invalid === "provider-origin")
      Reflect.set(
        f.options.identity.configuration,
        "managedLoginOrigin",
        "https://identity.example.test/path",
      );
    if (invalid === "brand") Reflect.set(f.options, "brandReference", "invalid");
    if (invalid === "sources") Reflect.set(f.options, "configuration", undefined);
    expect(() => createCognitoMerchantBrandAdministrationRuntime(f.options)).toThrow(
      "BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE",
    );
    expect(ports.concrete).not.toHaveBeenCalled();
    expect(ports.bff).not.toHaveBeenCalled();
    expect(f.rawRun).not.toHaveBeenCalled();
  },
);

it("refuses verdict/transport overrides and an inconsistent owning Provider logout destination", () => {
  const f = concreteFixture();
  for (const extra of [
    { provider: {} },
    { currentActor: vi.fn() },
    { registerBeforeCommit: vi.fn() },
    { http: vi.fn() },
  ])
    expect(() =>
      createCognitoMerchantBrandAdministrationRuntime({ ...f.options, ...extra }),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
  expect(ports.concrete).not.toHaveBeenCalled();
  ports.concrete.mockReturnValue({ provider: { createLogoutUrl: () => `${logoutUrl}&extra=1` } });
  expect(() => createCognitoMerchantBrandAdministrationRuntime(f.options)).toThrow(
    "BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE",
  );
  expect(ports.bff).not.toHaveBeenCalled();
});

it.each(["Explicit", "Cognito"])(
  "defaults %s startup to concrete owning references with captured clock and allocator receivers",
  (kind) => {
    const explicit = fixture(),
      concrete = concreteFixture();
    const options = kind === "Explicit" ? explicit : concrete.options;
    const clockOwner = kind === "Explicit" ? explicit.persistence : concrete.options.identity.clock;
    const credentials =
      kind === "Explicit"
        ? explicit.persistence.identity.credentials
        : concrete.options.identity.credentials;
    const expectedNow = "2026-10-06T12:00:00.000Z",
      expectedId = "01902421-1013-7000-8000-000000000090";
    const now = vi.fn(function (this: object) {
      expect(this).toBe(clockOwner);
      return expectedNow;
    });
    const allocate = vi.fn(function (this: object) {
      expect(this).toBe(credentials);
      return expectedId;
    });
    Reflect.set(clockOwner, "now", now);
    Reflect.set(credentials, "generateUuidV7", allocate);
    Reflect.deleteProperty(options, "configuration");
    const result =
      kind === "Explicit"
        ? createMerchantBrandAdministrationRuntime(explicit)
        : createCognitoMerchantBrandAdministrationRuntime(concrete.options);
    expect(result.configuration).toBe(ports.ordinary);
    expect(ports.references).toHaveBeenCalledTimes(1);
    expect(now).not.toHaveBeenCalled();
    expect(allocate).not.toHaveBeenCalled();
    expect(ports.referenceConfigure).not.toHaveBeenCalled();
    expect(ports.service.authorize).not.toHaveBeenCalled();
    expect(concrete.rawRun).not.toHaveBeenCalled();
    const referenceOptions = ports.references.mock.calls[0]?.[0] as { now: () => string };
    const ordinary = ports.configure.mock
      .calls[0]?.[0] as MerchantBrandConfigurationOrdinaryOptions;
    expect(ordinary.configure).toBe(ports.referenceConfigure);
    expect(referenceOptions.now.call({})).toBe(expectedNow);
    expect(ordinary.nextReference.call({}, "Audit")).toBe(expectedId);
    expect(ordinary.nextReference.call({}, "Lifecycle")).toBe(expectedId);
    expect(allocate).toHaveBeenCalledTimes(2);
    // Binding retains the captured functions; neither a foreign receiver nor a
    // later replacement selects a different clock/allocator implementation.
    Reflect.set(clockOwner, "now", () => {
      throw new Error("replaced clock");
    });
    Reflect.set(credentials, "generateUuidV7", () => {
      throw new Error("replaced allocator");
    });
    expect(referenceOptions.now()).toBe(expectedNow);
    expect(ordinary.nextReference("Mutation")).toBe(expectedId);
  },
);

it.each(["Explicit", "Cognito"])(
  "rejects malformed explicit %s configuration rather than falling back",
  (kind) => {
    for (const bad of [
      undefined,
      null,
      {},
      { configure: vi.fn() },
      { configure: vi.fn(), nextReference: vi.fn(), source: {} },
    ]) {
      const explicit = fixture(),
        concrete = concreteFixture();
      Reflect.set(kind === "Explicit" ? explicit : concrete.options, "configuration", bad);
      expect(() =>
        kind === "Explicit"
          ? createMerchantBrandAdministrationRuntime(explicit)
          : createCognitoMerchantBrandAdministrationRuntime(concrete.options),
      ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
    }
    expect(ports.references).not.toHaveBeenCalled();
    expect(ports.bff).not.toHaveBeenCalled();
    expect(ports.concrete).not.toHaveBeenCalled();
  },
);

it.each(["clock", "allocator", "catalogue"])(
  "refuses a default startup missing its actual %s port without allocating or authorizing",
  (kind) => {
    const options = fixture();
    Reflect.deleteProperty(options, "configuration");
    if (kind === "clock") Reflect.set(options.persistence, "now", undefined);
    if (kind === "allocator")
      Reflect.set(options.persistence.identity.credentials, "generateUuidV7", undefined);
    if (kind === "catalogue") Reflect.deleteProperty(options, "catalogSource");
    expect(() => createMerchantBrandAdministrationRuntime(options)).toThrow(
      "BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE",
    );
    expect(ports.references).not.toHaveBeenCalled();
    expect(ports.bff).not.toHaveBeenCalled();
    expect(ports.service.authorize).not.toHaveBeenCalled();
  },
);

it.each(["Explicit", "Cognito"])(
  "keeps %s startup closed and refuses optional configuration accessors without evaluating them",
  (kind) => {
    const explicit = fixture(),
      concrete = concreteFixture(),
      read = vi.fn();
    const options = kind === "Explicit" ? explicit : concrete.options;
    Object.defineProperty(options, "configuration", { enumerable: true, get: read });
    expect(() =>
      kind === "Explicit"
        ? createMerchantBrandAdministrationRuntime(explicit)
        : createCognitoMerchantBrandAdministrationRuntime(concrete.options),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
    expect(read).not.toHaveBeenCalled();
    const cleanExplicit = fixture(),
      cleanConcrete = concreteFixture().options;
    const clean = kind === "Explicit" ? cleanExplicit : cleanConcrete;
    Reflect.deleteProperty(clean, "configuration");
    Reflect.set(clean, "references", {});
    expect(() =>
      kind === "Explicit"
        ? createMerchantBrandAdministrationRuntime(cleanExplicit)
        : createCognitoMerchantBrandAdministrationRuntime(cleanConcrete),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
    expect(ports.references).not.toHaveBeenCalled();
    expect(ports.bff).not.toHaveBeenCalled();
  },
);

it("composes unselected discovery without a Brand identifier or source reads", () => {
  const previous = fixture();
  const { brandReference: omitted, ...persistence } = previous.persistence;
  void omitted;
  const options = { ...previous, persistence };
  const result = createMerchantBrandAdministrationRuntime(options);
  expect(result.brandReference).toBeNull();
  expect(result.service).toBe(ports.discoveryService);
  expect(result.discovery).toBe(ports.discoveryService);
  expect(ports.discovery).toHaveBeenCalledWith(persistence);
  expect(ports.bff).not.toHaveBeenCalled();
  expect(ports.configure).toHaveBeenCalledWith(
    expect.objectContaining({ authentication: ports.discoveryService, persistence }),
  );
  expect(ports.catalog).toHaveBeenCalledWith(
    expect.objectContaining({ authentication: ports.discoveryService, persistence }),
  );
  expect(options.catalogSource.nextReference).not.toHaveBeenCalled();
});
it.each([undefined, null, "", "not-a-brand"])(
  "refuses explicitly malformed discovery target %s",
  (brandReference) => {
    const previous = fixture();
    expect(() =>
      createMerchantBrandAdministrationRuntime({
        ...previous,
        persistence: { ...previous.persistence, brandReference },
      } as MerchantBrandAdministrationRuntimeOptions),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
    expect(ports.discovery).not.toHaveBeenCalled();
    expect(ports.bff).not.toHaveBeenCalled();
  },
);

function onboardingConfiguration() {
  return {
    environmentReference: "01902421-1013-7000-8000-000000000099",
    acceptanceRoleName: "controlled_acceptance",
    files: {
      planPath: "/private/tmp/controlled-plan.json",
      approvalPath: "/private/tmp/controlled-approval.json",
      approvalTrustPath: "/private/tmp/controlled-approval-trust.json",
      relationshipPath: "/private/tmp/controlled-relationship.json",
      relationshipTrustPath: "/private/tmp/controlled-relationship-trust.json",
    },
  };
}
it("constructs directory onboarding lazily on the physical commit host", () => {
  const f = concreteFixture(),
    configuration = onboardingConfiguration(),
    now = vi.fn(() => "2026-10-06T12:00:00.000Z");
  const { brandReference: ignored, ...withoutBrand } = f.options;
  void ignored;
  const options = {
    ...withoutBrand,
    onboarding: configuration,
    identity: { ...f.options.identity, clock: { now } },
  };
  createCognitoMerchantBrandAdministrationRuntime(options);
  const input = ports.onboarding.mock.calls[0]?.[0];
  expect(input).toMatchObject({
    ...configuration,
    configuration: options.identity.configuration,
    clock: options.identity.clock,
    hasher: options.identity.hasher,
    envelopes: options.identity.envelopes,
    allowedPostLoginPaths: ["/app/organization/brands"],
  });
  const actual = ports.concrete.mock.results[0]?.value;
  expect(input.transactions).toBe(options.transactions);
  expect(input.transactions).not.toBe(actual.transactions);
  const persistence = ports.discovery.mock.calls[0]?.[0];
  expect(persistence.identity.workforceOnboarding).toBe(ports.onboardingPort);
  expect(now).not.toHaveBeenCalled();
  expect(f.rawRun).not.toHaveBeenCalled();
  expect(options.identity.credentials.generateUuidV7).not.toHaveBeenCalled();
  vi.mocked(options.identity.credentials.generateUuidV7).mockImplementation(function (
    this: unknown,
  ) {
    expect(this).toBe(options.identity.credentials);
    return "01902421-1013-7000-8000-000000000098";
  });
  expect(input.nextReference()).toBe("01902421-1013-7000-8000-000000000098");
});
it("rejects preselected Brand onboarding before constructing an invitation source", () => {
  const f = concreteFixture();
  expect(() =>
    createCognitoMerchantBrandAdministrationRuntime({
      ...f.options,
      onboarding: onboardingConfiguration(),
    }),
  ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
  expect(ports.onboarding).not.toHaveBeenCalled();
  expect(ports.concrete).not.toHaveBeenCalled();
});
it("leaves onboarding absent for ordinary login and uses root-only path for configured discovery", () => {
  const f = concreteFixture();
  createCognitoMerchantBrandAdministrationRuntime(f.options);
  expect(ports.onboarding).not.toHaveBeenCalled();
  expect(ports.bff.mock.calls[0]?.[0].identity).not.toHaveProperty("workforceOnboarding");
  const { brandReference: ignored, ...withoutBrand } = f.options;
  void ignored;
  createCognitoMerchantBrandAdministrationRuntime({
    ...withoutBrand,
    onboarding: onboardingConfiguration(),
  });
  expect(ports.onboarding.mock.calls[0]?.[0].allowedPostLoginPaths).toEqual([
    "/app/organization/brands",
  ]);
  expect(ports.discovery.mock.calls[0]?.[0].identity.workforceOnboarding).toBe(
    ports.onboardingPort,
  );
});
it.each(["undefined", "extra", "environment", "role", "path", "sharedPath", "filesExtra"])(
  "rejects malformed explicit onboarding %s before constructing concrete source",
  (kind) => {
    const f = concreteFixture(),
      valid = onboardingConfiguration();
    const bad =
      kind === "undefined"
        ? undefined
        : kind === "extra"
          ? { ...valid, approved: true }
          : kind === "environment"
            ? { ...valid, environmentReference: "wrong" }
            : kind === "role"
              ? { ...valid, acceptanceRoleName: "owner;SQL" }
              : kind === "path"
                ? { ...valid, files: { ...valid.files, planPath: "relative.json" } }
                : kind === "sharedPath"
                  ? { ...valid, files: { ...valid.files, approvalPath: valid.files.planPath } }
                  : { ...valid, files: { ...valid.files, extra: "bad" } };
    expect(() =>
      Reflect.apply(createCognitoMerchantBrandAdministrationRuntime, undefined, [
        { ...f.options, onboarding: bad },
      ]),
    ).toThrow("BRAND_ADMINISTRATION_RUNTIME_UNAVAILABLE");
    expect(ports.concrete).not.toHaveBeenCalled();
    expect(ports.onboarding).not.toHaveBeenCalled();
    expect(f.rawRun).not.toHaveBeenCalled();
  },
);
