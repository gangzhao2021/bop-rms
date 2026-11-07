import { beforeEach, expect, it, vi } from "vitest";
import {
  BrowserSessionError,
  createAuthenticationSession,
  createIdentityActor,
} from "@bop/identity";
import {
  createBrand,
  createBrandAdministrationContext,
  transitionBrand,
  type Brand,
  type BrandLifecycleAdministrationRecordedOperation,
  type BrandLifecycleAdministrationStoreOptions,
} from "@bop/tenant";
import {
  createMerchantBrandLifecycleOrdinary,
  type MerchantBrandLifecycleOrdinaryOptions,
} from "./merchant-brand-lifecycle-ordinary.js";

// Controlled owner persistence/Identity/Feature boundaries, actual Tenant service
// and actual API host. This suite does not claim PostgreSQL or Provider evidence.
const ports = vi.hoisted(() => ({
  authorized: vi.fn(),
  strong: vi.fn(),
  authority: vi.fn(),
  policy: vi.fn(),
  selected: vi.fn(),
  owner: vi.fn(),
  audit: vi.fn(),
  capability: vi.fn(),
  finalized: vi.fn(),
  events: [] as string[],
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresWorkforceBrowserSessionStore: (options: unknown) => options,
  WorkforceBrowserSessionService: class {
    constructor(
      readonly options: {
        store: { transactions: { run(work: (tx: unknown) => Promise<unknown>): Promise<unknown> } };
      },
    ) {}
    authorize(input: unknown) {
      return this.options.store.transactions.run((tx) => ports.authorized(tx, input));
    }
  },
  createPostgresCurrentWorkforceBrowserSessionSource: () => ports.strong,
  createPostgresBrowserBrandSessionSelectionStore: () => ({ read: ports.selected }),
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresBrandLifecycleAdministrationStore: (options: unknown) => ports.owner(options),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresCurrentBrandAdministrationPermissionPolicySource: (tx: unknown) => ports.policy(tx),
}));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: (...args: unknown[]) => ports.audit(...args),
}));
vi.mock("./merchant-current-brand-scope.js", () => ({
  readMerchantCurrentBrandAdministrationAuthority: (...args: unknown[]) => ports.authority(...args),
}));
vi.mock("./merchant-brand-administration-capability.js", () => ({
  merchantBrandAdministrationCapabilityRequiredFields: ["key"],
  createMerchantCurrentBrandAdministrationCapability: (options: unknown) =>
    ports.capability(options),
}));
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  until = "2026-10-06T10:00:05.000Z";
const actor = createIdentityActor({
  actorReference: id(1),
  actorType: "User",
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
const sessionInput = {
  sessionReference: id(2),
  actor,
  status: "Active",
  policyCode: "Privileged",
  maxActiveSessions: 2,
  idleTimeoutMinutes: 15,
  absoluteTimeoutMinutes: 480,
  version: 1,
  authenticatedAt: at,
  createdAt: at,
  lastSeenAt: at,
  idleExpiresAt: "2026-10-06T10:15:00.000Z",
  absoluteExpiresAt: "2026-10-06T18:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
};
const session = createAuthenticationSession(sessionInput),
  strong = createAuthenticationSession({
    ...sessionInput,
    actor: createIdentityActor({ ...actor, verificationLevel: "RecentMfa", recentMfaAt: at }),
  });
const mfa = {
  sessionReference: id(2),
  actorReference: id(1),
  method: "Totp",
  evidenceReference: id(3),
  authorizationTransactionReference: id(4),
  authenticatedAt: at,
  verifiedAt: at,
  validUntil: "2026-10-06T10:15:00.000Z",
};
const draft = () =>
  createBrand({
    brandReference: id(10),
    code: "SYNTHETIC",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Draft",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
const credentials = { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" };
const command = () => ({
  brandReference: id(10),
  action: "ActivateBrand",
  expectedBrandVersion: 1,
  operationReference: id(11),
});
let now: string,
  current: Brand,
  records: Map<string, BrandLifecycleAdministrationRecordedOperation>,
  denied: boolean,
  disabled: boolean,
  auditCount: number,
  afterWrite: (() => void) | undefined,
  beforeCapabilityGuard: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  ports.events.length = 0;
  now = at;
  current = draft();
  records = new Map();
  denied = false;
  disabled = false;
  auditCount = 0;
  afterWrite = undefined;
  beforeCapabilityGuard = undefined;
  ports.authorized.mockReset().mockImplementation(async (_tx, input) => {
    ports.events.push("session");
    if (input.csrf !== credentials.csrf) throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    return { session, recentMfa: mfa, validUntil: until, observedAt: at };
  });
  ports.strong.mockReset().mockResolvedValue(strong);
  ports.selected.mockReset().mockResolvedValue({ brandReference: id(10) });
  ports.policy.mockReset().mockImplementation(() => {
    let identity: string | undefined,
      poisoned = false;
    return {
      async authorizeActionsWithRoles(input: {
        administrationContext: ReturnType<typeof createBrandAdministrationContext>;
        membership: unknown;
      }) {
        // Model the public owner's complete Actor/Brand/Membership pin, which
        // deliberately does not admit a changed Brand on an existing source.
        const next = JSON.stringify([
          input.administrationContext.actor,
          input.administrationContext.brand,
          input.membership,
        ]);
        if (poisoned || (identity !== undefined && identity !== next)) {
          poisoned = true;
          throw new Error("controlled immutable administrative context");
        }
        identity = next;
      },
    };
  });
  ports.authority
    .mockReset()
    .mockImplementation(async (_tx, _session, brand, observedAt, _actions, policy) => {
      ports.events.push("iam");
      if (brand !== current.brandReference) throw new Error("controlled wrong target");
      const context = createBrandAdministrationContext(strong.actor, current, observedAt);
      await policy.authorizeActionsWithRoles({
        administrationContext: context,
        membership: {
          membershipReference: id(7),
          actorReference: id(1),
          brandReference: id(10),
          version: 1,
        },
      });
      return {
        context,
        decisions: [
          {
            action: "organization.manage",
            scopeKind: "Brand",
            effect: denied ? "Deny" : "Allow",
            policySnapshotReference: id(8),
            policyVersion: 1,
          },
        ],
        validUntil: until,
      };
    });
  ports.audit.mockReset().mockImplementation(async () => {
    auditCount++;
  });
  ports.owner
    .mockReset()
    .mockImplementation((options: BrandLifecycleAdministrationStoreOptions) => {
      type Operation = BrandLifecycleAdministrationRecordedOperation["operation"];
      const run = <T>(
        work: (tx: Parameters<typeof options.authorize>[0]) => Promise<T>,
        operation: Operation | null = null,
      ) =>
        options.transactions.run(async (tx) => {
          ports.events.push("owner-fence");
          await options.authorize(tx, operation);
          const value = await work(tx);
          await options.authorize(tx, operation);
          return value;
        });
      return {
        resolveRecordedOperation: (reference: string) =>
          run(async () => {
            const result = records.get(reference) ?? null;
            if (
              result &&
              (result.actorReference !== options.binding.actorReference ||
                result.purposeCode !== options.binding.purposeCode)
            )
              throw new Error("controlled bound original denial");
            return result;
          }),
        resolveOperation: (reference: string) =>
          run(async () => records.get(reference)?.operation ?? null),
        loadBrand: () => run(async () => current),
        commit: (
          input: Parameters<
            ReturnType<
              typeof import("@bop/tenant").createPostgresBrandLifecycleAdministrationStore
            >["commit"]
          >[0],
        ) =>
          run(async (tx) => {
            if (current.version !== input.expectedBrandVersion)
              throw new Error("controlled stale write");
            const expected = transitionBrand(
              current,
              current.version,
              input.operation.command === "ActivateBrand" ? "Active" : "Archived",
              input.audit.occurredAt,
            );
            expect(input.operation.artifact).toEqual(expected);
            current = expected;
            records.set(String(input.operation.operationReference), {
              operation: input.operation,
              actorReference: String(input.audit.actorReference),
              purposeCode: "BRAND_ADMINISTRATION",
              auditReference: String(input.audit.auditReference),
              occurredAt: String(input.audit.occurredAt),
            });
            afterWrite?.();
            await options.appendAudit(tx, input);
            return input.operation;
          }, input.operation),
      };
    });
  ports.capability.mockReset().mockImplementation((options) => {
    let sealed = false;
    const hold = async () => {
      if (disabled) throw new Error("controlled Disabled");
      await options.holdCurrentBrandAdministrationAuthority(options.transaction, {
        scope: options.scope,
        permission: "organization.manage",
        purposeCode: "BRAND_ADMINISTRATION",
        requiredFields: ["key"],
        observedAt: at,
        validUntil: options.originalValidUntil,
      });
    };
    return {
      async holdUntilCommit() {
        await hold();
        await options.registerBeforeCommit(
          options.transaction,
          async () => {
            beforeCapabilityGuard?.();
            await hold();
          },
          () => {
            sealed = true;
          },
        );
      },
      leaseDeadline: () => options.originalValidUntil,
      assertFinalized() {
        expect(sealed).toBe(true);
        ports.finalized();
      },
    };
  });
});
function fixture(controls: { beforeGuards?: () => void; afterCommit?: () => void } = {}) {
  const unused = (): never => {
      throw new Error("controlled unused port");
    },
    unusedAsync = async (): Promise<never> => unused();
  let commits = 0,
    rollbacks = 0;
  const nextReference = vi.fn(() => id(12)),
    authentication = { authorize: vi.fn(async () => session) };
  const options: MerchantBrandLifecycleOrdinaryOptions = {
    authentication,
    nextReference,
    persistence: {
      now: () => now,
      currentActor: async () => actor,
      transactions: {
        async run<T>(
          work: (tx: {
            query<Row = Record<string, unknown>>(
              sql: string,
              values: readonly unknown[],
            ): Promise<{ rows: readonly Row[]; rowCount: number | null }>;
          }) => Promise<T>,
        ) {
          const before = current,
            prior = new Map(records),
            beforeAudit = auditCount;
          try {
            const value = await work({ query: async () => ({ rows: [], rowCount: 0 }) });
            commits++;
            controls.afterCommit?.();
            return value;
          } catch {
            current = before;
            records = prior;
            auditCount = beforeAudit;
            rollbacks++;
            // Concrete Identity deliberately sanitizes cross-layer exceptions.
            throw new BrowserSessionError("BROWSER_SESSION_DENIED");
          }
        },
      },
      identity: {
        configuration: {
          environment: "synthetic",
          issuer: "https://identity.invalid",
          clientId: "synthetic",
          redirectUri: "https://merchant.invalid/callback",
          allowedPostLoginPaths: ["/app/organization/brands"],
        },
        provider: {
          createAuthorizationUrl: unusedAsync,
          exchangeCode: unusedAsync,
          revokeRefreshTokens: unusedAsync,
          createLogoutUrl: unused,
        },
        credentials: { generate: unused, generateUuidV7: unused },
        hasher: { hash: unused, equals: unused },
        envelopes: { encrypt: unusedAsync, decrypt: unusedAsync },
        pkce: { challenge: unused },
      },
    },
  };
  // Run the late hook from an actual owning guard, never by replacing the host.
  beforeCapabilityGuard = controls.beforeGuards;
  return {
    service: createMerchantBrandLifecycleOrdinary(options),
    options,
    nextReference,
    authentication,
    commits: () => commits,
    rollbacks: () => rollbacks,
  };
}
it("activates actual Draft through the owner service and holds only the exact transition", async () => {
  const f = fixture();
  expect(await f.service.execute({ ...credentials, command: command() })).toEqual({
    profile: "MerchantBrandLifecycleReceiptV1",
    actorReference: id(1),
    brandReference: id(10),
    action: "ActivateBrand",
    operationReference: id(11),
    expectedBrandVersion: 1,
    status: "Applied",
    lifecycle: "Active",
    version: 2,
    occurredAt: at,
  });
  expect(current.lifecycle).toBe("Active");
  expect(records.size).toBe(1);
  expect(auditCount).toBe(1);
  expect(ports.events.indexOf("owner-fence")).toBeLessThan(ports.events.indexOf("iam"));
  expect(ports.events.indexOf("session")).toBeLessThan(ports.events.indexOf("owner-fence"));
  expect(f.nextReference).toHaveBeenCalledOnce();
  expect(ports.policy.mock.calls.length).toBeGreaterThan(1);
  expect(new Set(ports.policy.mock.calls.map(([tx]) => tx)).size).toBe(1);
  expect(f.commits()).toBe(1);
  expect(ports.finalized).toHaveBeenCalledOnce();
});
it("requires fresh public Policy sources across the exact owning Brand transition", async () => {
  const createPolicy = ports.policy.getMockImplementation();
  if (!createPolicy) throw new Error("Expected controlled Policy factory");
  const shared = createPolicy();
  ports.policy.mockReturnValue(shared);
  const f = fixture();
  await expect(f.service.execute({ ...credentials, command: command() })).rejects.toMatchObject({
    reason: "Unavailable",
  });
  expect(current).toEqual(draft());
  expect(records.size).toBe(0);
  expect(auditCount).toBe(0);
  expect(f.rollbacks()).toBe(1);
  ports.policy.mockImplementation(createPolicy);
  expect(await f.service.execute({ ...credentials, command: command() })).toMatchObject({
    status: "Applied",
    lifecycle: "Active",
    version: 2,
  });
  expect(f.commits()).toBe(1);
});
it("archives and then replays original activation without allocating or rewriting", async () => {
  const f = fixture();
  await f.service.execute({ ...credentials, command: command() });
  await f.service.execute({
    ...credentials,
    command: {
      ...command(),
      action: "ArchiveBrand",
      expectedBrandVersion: 2,
      operationReference: id(13),
    },
  });
  expect(current.lifecycle).toBe("Archived");
  expect(current.version).toBe(3);
  f.nextReference.mockClear();
  expect(await f.service.execute({ ...credentials, command: command() })).toMatchObject({
    status: "AlreadyApplied",
    lifecycle: "Active",
    version: 2,
    occurredAt: at,
  });
  expect(f.nextReference).not.toHaveBeenCalled();
  expect(records.size).toBe(2);
  expect(auditCount).toBe(2);
  expect(current.lifecycle).toBe("Archived");
});
it("reports only permanent stale/lifecycle Conflict after guarded read-only COMMIT", async () => {
  current = createBrand({ ...draft(), lifecycle: "Active", version: 2 });
  const f = fixture();
  await expect(f.service.execute({ ...credentials, command: command() })).rejects.toMatchObject({
    reason: "Conflict",
  });
  await expect(
    f.service.execute({ ...credentials, command: { ...command(), expectedBrandVersion: 2 } }),
  ).rejects.toMatchObject({ reason: "Conflict" });
  expect(f.commits()).toBe(2);
  expect(f.rollbacks()).toBe(0);
  expect(records.size).toBe(0);
  expect(f.nextReference).not.toHaveBeenCalled();
});
it("future expected version and changed original intent remain unknown", async () => {
  const f = fixture();
  await expect(
    f.service.execute({ ...credentials, command: { ...command(), expectedBrandVersion: 2 } }),
  ).rejects.toMatchObject({ reason: "Unavailable" });
  await f.service.execute({ ...credentials, command: command() });
  await expect(
    f.service.execute({ ...credentials, command: { ...command(), action: "ArchiveBrand" } }),
  ).rejects.toMatchObject({ reason: "Unavailable" });
  expect(records.size).toBe(1);
  expect(current.lifecycle).toBe("Active");
  expect(auditCount).toBe(1);
});
it("refuses CSRF, selection and closed client authority before owning mutation", async () => {
  const f = fixture();
  await expect(
    f.service.execute({ ...credentials, command: { ...command(), actorReference: id(1) } }),
  ).rejects.toMatchObject({ reason: "Invalid" });
  await expect(
    f.service.execute({ ...credentials, csrf: "wrong", command: command() }),
  ).rejects.toThrow();
  ports.selected.mockResolvedValue(null);
  await expect(f.service.execute({ ...credentials, command: command() })).rejects.toThrow();
  expect(ports.owner).not.toHaveBeenCalled();
  expect(f.nextReference).not.toHaveBeenCalled();
});
it.each(["Permission", "Feature", "Session", "Selection", "Clock", "UnrelatedBrand", "Audit"])(
  "rolls back when %s fails after actual transition",
  async (leaf) => {
    const f = fixture();
    afterWrite = () => {
      if (leaf === "Permission") denied = true;
      if (leaf === "Feature") disabled = true;
      if (leaf === "Session")
        ports.strong.mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
      if (leaf === "Selection") ports.selected.mockResolvedValue({ brandReference: id(20) });
      if (leaf === "Clock") now = until;
      if (leaf === "UnrelatedBrand")
        current = createBrand({ ...current, displayName: "Unexpected change" });
      if (leaf === "Audit") ports.audit.mockRejectedValue(new Error("controlled Audit failure"));
    };
    await expect(f.service.execute({ ...credentials, command: command() })).rejects.toThrow();
    expect(current).toEqual(draft());
    expect(records.size).toBe(0);
    expect(auditCount).toBe(0);
    expect(f.rollbacks()).toBe(1);
  },
);
it("later guard expiry refuses COMMIT while delayed committed reply performs no clock reads", async () => {
  const late = fixture({
    beforeGuards() {
      now = until;
    },
  });
  await expect(late.service.execute({ ...credentials, command: command() })).rejects.toThrow();
  expect(late.commits()).toBe(0);
  now = at;
  const f = fixture({
    afterCommit() {
      now = "2026-10-06T10:01:00.000Z";
    },
  });
  expect(await f.service.execute({ ...credentials, command: command() })).toMatchObject({
    status: "Applied",
  });
});
