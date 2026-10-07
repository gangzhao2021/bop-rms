import { beforeEach, expect, it, vi } from "vitest";
import {
  BrowserSessionError,
  createAuthenticationSession,
  createIdentityActor,
  parseSelectorHash,
} from "@bop/identity";
import {
  BrandConfigurationOperationError,
  createBrand,
  createBrandAdministrationContext,
} from "@bop/tenant";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  brandCatalogSourceRequiredFields,
  brandCatalogSourceIntentDigest,
  parseBrandCatalogSourceRegister,
  parseBrandCatalogSourceReceipt,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  type BrandAdministrationCatalogSourceStoreOptions,
  parseBrandCatalogSourceScope,
  parseBrandCatalogSourceResolve,
} from "@rms/catalog";
import { merchantBrandAdministrationCapabilityRequiredFields } from "./merchant-brand-administration-capability.js";
import {
  createMerchantBrandCatalogSource,
  type MerchantBrandCatalogSourceOptions,
} from "./merchant-brand-catalog-source.js";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), owner: vi.fn(), capability: vi.fn() }));
vi.mock("./merchant-current-brand-scope.js", () => ({
  createMerchantCurrentBrandAdministrationScope: () => mocks.scope,
}));
vi.mock("./merchant-brand-administration-capability.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./merchant-brand-administration-capability.js")>();
  return { ...actual, createMerchantCurrentBrandAdministrationCapability: mocks.capability };
});
vi.mock("@rms/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/catalog")>();
  return { ...actual, createPostgresBrandAdministrationCatalogSourceStore: mocks.owner };
});
const id = (n: number) => `01902607-2421-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const scope = { tenantReference: id(2), brandReference: id(2), actorReference: id(3) };
const parsedScope = parseBrandCatalogSourceScope(scope);
const command = () => ({
  operationReference: id(10),
  code: "CATALOGUE",
  label: "Controlled Catalogue",
});
beforeEach(() => vi.resetAllMocks());

/** Controlled public Session/currentScope/Feature/Catalog boundaries. Real closed
 * parsers, transaction host and public Audit writer run; actual encrypted noStore
 * Session/IAM/PG/API composition remains a separate native workflow gate. */
function fixture(lifecycle = "Draft") {
  mocks.owner.mockClear();
  mocks.scope.mockClear();
  mocks.capability.mockClear();
  const actor = createIdentityActor({
    actorType: "User",
    actorReference: id(3),
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "RecentMfa",
    authenticatedAt: at,
    recentMfaAt: at,
  });
  const brand = createBrand({
    brandReference: id(2),
    code: "BRAND",
    displayName: "Controlled Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle,
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const session = createAuthenticationSession({
    sessionReference: id(6),
    actor,
    status: "Active",
    policyCode: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 720,
    version: 1,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: "2026-10-06T12:30:00.000Z",
    absoluteExpiresAt: "2026-10-07T00:00:00.000Z",
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  const state = {
    clock: at,
    deadline: until,
    allowed: true,
    catalogAllowed: true,
    feature: true,
    commits: 0,
    replay: true,
    abandoned: false,
    absent: false,
    lateGuard: false,
    withdrawAtGuard: false,
    withdrawSourceAtGuard: false,
    sourceDenied: false,
    expireAfterCommit: false,
    auditUnavailable: false,
  };
  const events: string[] = [];
  const permission = vi.fn(async (actions: readonly string[]) => {
    if (state.sourceDenied) throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
    return {
      context: createBrandAdministrationContext(actor, brand, state.clock),
      validUntil: state.deadline,
      decisions: actions.map((action) => {
        const allowed = state.allowed && (action !== "catalog.manage" || state.catalogAllowed);
        return {
          effect: allowed ? ("Allow" as const) : ("Deny" as const),
          reason: allowed ? ("ROLE_PERMISSION" as const) : ("DEFAULT_DENY" as const),
          source: allowed ? ("RolePermission" as const) : ("DefaultDeny" as const),
          action: parseBusinessAction(action),
          scopeKind: "Brand" as const,
          policySnapshotReference: parsePolicyReference(id(20)),
          policyVersion: parsePolicyVersion(1),
          audit: {
            effect: allowed ? ("Allow" as const) : ("Deny" as const),
            reason: allowed ? ("ROLE_PERMISSION" as const) : ("DEFAULT_DENY" as const),
            source: allowed ? ("RolePermission" as const) : ("DefaultDeny" as const),
          },
        };
      }),
    };
  });
  const current = {
    tenantReference: scope.tenantReference,
    actorReference: actor.actorReference,
    context: createBrandAdministrationContext(actor, brand, at),
    sessionReference: session.sessionReference,
    authorizeActionsWithValidity: permission,
    assertCurrent() {
      if (state.clock >= until) throw new Error("Controlled expired current authority");
    },
  };
  mocks.scope.mockResolvedValue(current);
  const query = vi.fn(async (sql: string, _values: readonly unknown[]) => {
    void _values;
    events.push(sql);
    if (state.auditUnavailable && sql.startsWith("INSERT INTO platform_audit.audit_record"))
      throw new Error("Controlled Audit unavailable");
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: "1", previous_hash: null, recorded_at: state.clock }] };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: "2" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const input = {
    sessionCookie: "controlled-cookie",
    csrf: "controlled-csrf",
    expectedBrandReference: scope.brandReference,
  };
  const original = parseBrandCatalogSourceRegister({
    ...command(),
    ...scope,
    profile: "BrandCatalogSourceRegisterV1",
  });
  const identity = {
    profile: "BrandCatalogSourceRegisteredIdentityV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    sourceReference: id(30),
    code: original.code,
    label: original.label,
    registeredByReference: scope.actorReference,
    operationReference: original.operationReference,
    auditReference: id(31),
    registeredAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const receipt = parseBrandCatalogSourceReceipt({
    profile: "BrandCatalogSourceReceiptV1",
    ...scope,
    operationReference: original.operationReference,
    intentDigest: brandCatalogSourceIntentDigest(original),
    outcome: "Committed",
    originalCommand: original,
    source: identity,
    auditReference: id(31),
    occurredAt: at,
  });
  const currentPacket = parseBrandCatalogSourceCurrent(
    {
      profile: "BrandCatalogSourceCurrentV1",
      ...scope,
      source: identity,
      observedAt: at,
      validUntil: until,
      publicationStatus: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
    },
    parsedScope,
    at,
  );
  let ownerOptions: BrandAdministrationCatalogSourceStoreOptions | undefined;
  mocks.capability.mockImplementation(
    (
      options: Parameters<
        typeof import("./merchant-brand-administration-capability.js").createMerchantCurrentBrandAdministrationCapability
      >[0],
    ) => {
      const hold = async () => {
        if (!state.feature)
          throw new BrandConfigurationOperationError("BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE");
        await options.holdCurrentBrandAdministrationAuthority(options.transaction, {
          scope: options.scope,
          permission: "organization.manage",
          purposeCode: "BRAND_ADMINISTRATION",
          requiredFields: merchantBrandAdministrationCapabilityRequiredFields,
          observedAt: at,
          validUntil: state.deadline,
        });
      };
      return {
        async holdUntilCommit() {
          await hold();
          await options.registerBeforeCommit(options.transaction, hold, () => {
            options.clock.now();
          });
        },
        leaseDeadline: () => state.deadline,
        assertFinalized: () => {
          events.push("feature-finalized");
          return state.deadline;
        },
      };
    },
  );
  mocks.owner.mockImplementation((options: BrandAdministrationCatalogSourceStoreOptions) => {
    ownerOptions = options;
    const admit = async () => {
      const hold = () =>
        options.authority.holdUntilTransactionCompletes(options.transaction, {
          ...parsedScope,
          permission: "organization.manage",
          purposeCode: "BRAND_ADMINISTRATION",
          mode: "Read",
          requiredFields: brandCatalogSourceRequiredFields,
          original: null,
          observedAt: at,
          validUntil: state.deadline,
        });
      await hold();
      await options.registerBeforeCommit(
        options.transaction,
        async () => {
          await hold();
          if (state.lateGuard) state.clock = until;
          if (state.withdrawAtGuard) state.allowed = false;
          if (state.withdrawSourceAtGuard) state.sourceDenied = true;
        },
        () => {
          options.clock.now();
        },
      );
    };
    return {
      async current() {
        await admit();
        return currentPacket;
      },
      async exact(reference: string) {
        await admit();
        return parseBrandCatalogSourceExact(
          {
            ...currentPacket,
            profile: "BrandCatalogSourceExactV1",
            requestedSourceReference: reference,
            source: reference === id(30) ? identity : null,
          },
          parsedScope,
          reference,
          at,
        );
      },
      async register(value: unknown) {
        await admit();
        const parsed = parseBrandCatalogSourceRegister(value);
        events.push("original-arbitrated");
        if (
          parsed.operationReference !== original.operationReference ||
          parsed.label !== original.label
        )
          throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
        if (state.abandoned) throw new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
        if (!state.replay) {
          const sourceReference = options.nextReference("Source"),
            auditReference = options.nextReference("Audit");
          await options.appendAudit(options.transaction, {
            ...parsedScope,
            purposeCode: "BRAND_CATALOG_SOURCE",
            mode: "Register",
            operationReference: original.operationReference,
            intentDigest: receipt.intentDigest,
            sourceReference,
            auditReference,
            occurredAt: at,
          });
          return parseBrandCatalogSourceReceipt({
            ...receipt,
            auditReference,
            source: { ...identity, sourceReference, auditReference },
          });
        }
        return receipt;
      },
      async resolve(value: unknown) {
        await admit();
        const parsed = parseBrandCatalogSourceResolve(value);
        events.push("original-arbitrated");
        if (state.absent) {
          const auditReference = options.nextReference("Audit");
          await options.appendAudit(options.transaction, {
            ...parsedScope,
            purposeCode: "BRAND_CATALOG_SOURCE",
            mode: "Abandon",
            operationReference: parsed.operationReference,
            intentDigest: parsed.intentDigest,
            sourceReference: null,
            auditReference,
            occurredAt: at,
          });
          return parseBrandCatalogSourceReceipt({
            ...receipt,
            operationReference: parsed.operationReference,
            intentDigest: parsed.intentDigest,
            outcome: "Abandoned",
            originalCommand: null,
            source: null,
            auditReference,
          });
        }
        if (!state.abandoned) return receipt;
        return parseBrandCatalogSourceReceipt({
          ...receipt,
          outcome: "Abandoned",
          originalCommand: null,
          source: null,
        });
      },
      assertFinalized: () => {
        events.push("owner-finalized");
      },
    };
  });
  const authenticate = vi.fn(async () => session),
    next = vi.fn((kind: "Source" | "Audit") => {
      events.push(`allocated-${kind}`);
      return id(kind === "Source" ? 90 : 91);
    });
  const options: MerchantBrandCatalogSourceOptions = {
    persistence: {
      identity: {
        hasher: { hash: () => parseSelectorHash("a".repeat(64)), equals: (a, b) => a === b },
        configuration: {
          environment: "synthetic",
          issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
          clientId: "syntheticworkforce",
          redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
          allowedPostLoginPaths: ["/app/organization/brands"],
        },
        envelopes: {
          async encrypt() {
            throw new Error("Controlled currentScope bypasses encrypted storage");
          },
          async decrypt() {
            throw new Error("Controlled currentScope bypasses encrypted storage");
          },
        },
      },
      currentActor: async () => actor,
      now: () => state.clock,
      transactions: {
        async run(work) {
          const output = await work({ query });
          state.commits++;
          if (state.expireAfterCommit) state.clock = until;
          return output;
        },
      },
    },
    authentication: { authorize: authenticate },
    nextReference: next,
  };
  const adapter = createMerchantBrandCatalogSource(options);
  return {
    adapter,
    input,
    original,
    receipt,
    currentPacket,
    state,
    current,
    permission,
    options,
    events,
    query,
    authenticate,
    next,
    ownerOptions: () => ownerOptions,
  };
}

it("returns actual owner current/exact packets with actual noStore administrative permission and explicit absence", async () => {
  const f = fixture();
  expect(await f.adapter.current(f.input)).toBe(f.currentPacket);
  expect((await f.adapter.exact({ ...f.input, sourceReference: id(30) })).source).toEqual(
    f.receipt.source,
  );
  expect((await f.adapter.exact({ ...f.input, sourceReference: id(99) })).source).toBeNull();
  expect(f.permission).toHaveBeenCalledWith(["organization.manage"]);
  expect(f.next).not.toHaveBeenCalled();
  expect(f.state.commits).toBe(3);
});
it("refuses browser Actor/Tenant/profile/qualification before authentication or source effects", async () => {
  for (const extra of [
    { actorReference: id(77) },
    { tenantReference: id(77) },
    { profile: "Forged" },
    { publicationStatus: "Published" },
  ]) {
    const f = fixture();
    await expect(
      f.adapter.register({ ...f.input, command: { ...command(), ...extra } }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(mocks.owner).not.toHaveBeenCalled();
  }
  const f = fixture(),
    getter = vi.fn(() => command());
  await expect(
    f.adapter.register(
      Object.defineProperty({ ...f.input }, "command", { enumerable: true, get: getter }),
    ),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
});
it("derives original identity server-side and recovers Committed/Abandoned without allocation or Audit", async () => {
  const f = fixture();
  expect(await f.adapter.register({ ...f.input, command: command() })).toBe(f.receipt);
  expect(
    await f.adapter.resolve({
      ...f.input,
      original: { operationReference: id(10), intentDigest: f.receipt.intentDigest },
    }),
  ).toBe(f.receipt);
  f.state.abandoned = true;
  expect(
    (
      await f.adapter.resolve({
        ...f.input,
        original: { operationReference: id(10), intentDigest: f.receipt.intentDigest },
      })
    ).outcome,
  ).toBe("Abandoned");
  await expect(f.adapter.register({ ...f.input, command: command() })).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  expect(f.next).not.toHaveBeenCalled();
  expect(
    f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO platform_audit.audit_record")),
  ).toBe(false);
});
it("allows only the owner to allocate after arbitration and uses the real public Audit writer", async () => {
  const f = fixture();
  f.state.replay = false;
  await f.adapter.register({ ...f.input, command: command() });
  expect(f.events).toContain("original-arbitrated");
  expect(f.events.indexOf("original-arbitrated")).toBeLessThan(
    f.events.indexOf("allocated-Source"),
  );
  expect(f.next.mock.calls.map(([kind]) => kind)).toEqual(["Source", "Audit"]);
  expect(
    f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO platform_audit.audit_record")),
  ).toBe(true);
  expect(
    f.query.mock.calls.find(([sql]) =>
      sql.startsWith("INSERT INTO platform_audit.audit_record"),
    )?.[1][2],
  ).toBeNull();
  const before = f.next.mock.calls.length;
  await expect(
    f.adapter.register({ ...f.input, command: { ...command(), label: "Changed" } }),
  ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  expect(f.next).toHaveBeenCalledTimes(before);
});
it("resolves a true absent original with only Audit allocation and no reconstructed command or source", async () => {
  const f = fixture();
  f.state.absent = true;
  const result = await f.adapter.resolve({
    ...f.input,
    original: { operationReference: id(40), intentDigest: "sha256:" + "a".repeat(64) },
  });
  expect(result).toMatchObject({
    outcome: "Abandoned",
    operationReference: id(40),
    intentDigest: "sha256:" + "a".repeat(64),
    originalCommand: null,
    source: null,
  });
  expect(f.next.mock.calls.map(([kind]) => kind)).toEqual(["Audit"]);
  expect(
    f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO platform_audit.audit_record")),
  ).toBe(true);
});
it("maps genuine Session/scope mismatch and owner organization.manage denial before effects", async () => {
  for (const boundary of ["Session", "Scope", "PermissionSource", "Organization", "Brand"]) {
    const f = fixture();
    if (boundary === "Session")
      f.authenticate.mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
    if (boundary === "Scope")
      mocks.scope.mockRejectedValue(new Error("BRAND_SERVICE_PERMISSION_DENIED"));
    if (boundary === "PermissionSource")
      f.permission.mockRejectedValue(new Error("BRAND_SERVICE_PERMISSION_DENIED"));
    if (boundary === "Organization") f.state.allowed = false;
    if (boundary === "Brand") f.input.expectedBrandReference = id(77);
    await expect(f.adapter.current(f.input)).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.next).not.toHaveBeenCalled();
    expect(f.state.commits).toBe(0);
  }
});
it("refuses Feature withdrawal, late permission withdrawal and a later guard consuming the original lease", async () => {
  for (const boundary of ["Feature", "Permission", "Source", "Expiry"]) {
    const f = fixture();
    if (boundary === "Feature") f.state.feature = false;
    if (boundary === "Permission") f.state.withdrawAtGuard = true;
    if (boundary === "Source") f.state.withdrawSourceAtGuard = true;
    if (boundary === "Expiry") f.state.lateGuard = true;
    await expect(f.adapter.current(f.input)).rejects.toMatchObject({
      code:
        boundary === "Permission" || boundary === "Source"
          ? "CATALOG_PERMISSION_DENIED"
          : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.state.commits).toBe(0);
    expect(f.events).not.toContain("owner-finalized");
  }
});
it("refuses authentication consuming the original five-second window before owner admission", async () => {
  const f = fixture();
  const session = await f.authenticate();
  f.authenticate.mockImplementation(async () => {
    f.state.clock = until;
    return session;
  });
  await expect(f.adapter.register({ ...f.input, command: command() })).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(mocks.owner).not.toHaveBeenCalled();
  expect(f.next).not.toHaveBeenCalled();
  expect(f.state.commits).toBe(0);
});
it("rolls back a new registration when the real Audit writer fails", async () => {
  const f = fixture();
  f.state.replay = false;
  f.state.auditUnavailable = true;
  await expect(f.adapter.register({ ...f.input, command: command() })).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.next.mock.calls.map(([kind]) => kind)).toEqual(["Source", "Audit"]);
  expect(f.state.commits).toBe(0);
  expect(f.events).not.toContain("owner-finalized");
});
it("retains shortest actual lease, refuses captured port drift and keeps afterCOMMIT assertion pure", async () => {
  const f = fixture();
  f.state.deadline = "2026-10-06T12:00:01.000Z";
  await f.adapter.current(f.input);
  expect(f.ownerOptions()?.originalValidUntil).toBe(f.state.deadline);
  const changed = fixture();
  changed.options.authentication.authorize = async () => {
    throw new Error("Controlled replaced port");
  };
  await expect(changed.adapter.current(changed.input)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(mocks.owner).not.toHaveBeenCalled();
  const pure = fixture();
  pure.state.expireAfterCommit = true;
  expect(await pure.adapter.current(pure.input)).toBe(pure.currentPacket);
  expect(pure.events.slice(-2)).toEqual(["owner-finalized", "feature-finalized"]);
});

it.each(["Draft", "Active"])(
  "registers only Catalogue identity under %s organization.manage without catalog.manage",
  async (lifecycle) => {
    const f = fixture(lifecycle);
    f.state.catalogAllowed = false;
    expect((await f.adapter.register({ ...f.input, command: command() })).outcome).toBe(
      "Committed",
    );
    expect(
      f.permission.mock.calls.every(
        ([requested]) => requested.length === 1 && requested[0] === "organization.manage",
      ),
    ).toBe(true);
    expect(f.ownerOptions()?.authority).toBeDefined();
  },
);
