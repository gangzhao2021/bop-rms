import { beforeEach, expect, it, vi } from "vitest";
import {
  createAuthenticationSession,
  createIdentityActor,
  BrowserSessionError,
} from "@bop/identity";
import { createBrand, createBrandAdministrationContext } from "@bop/tenant";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantBrandDiscovery,
  type MerchantBrandDiscoveryPersistence,
} from "./merchant-brand-discovery.js";

// Controlled owner boundaries test API composition/real host guards. They are
// not PostgreSQL, encrypted Session, Provider or owning Feature acceptance.
const ports = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  authorize: vi.fn(),
  strong: vi.fn(),
  memberships: vi.fn(),
  authority: vi.fn(),
  selectionRead: vi.fn(),
  selectionWrite: vi.fn(),
  capability: vi.fn(),
  stores: [] as unknown[],
  memberFinal: vi.fn(),
  capabilityFinal: vi.fn(),
  selected: null as string | null,
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresWorkforceBrowserSessionStore: (options: unknown) => {
    ports.stores.push(options);
    return options;
  },
  WorkforceBrowserSessionService: class {
    constructor(
      readonly options: {
        store: { transactions: { run(work: (tx: unknown) => Promise<unknown>): Promise<unknown> } };
      },
    ) {}
    bootstrap(cookie: unknown) {
      return this.options.store.transactions.run(async (tx) => ports.bootstrap(tx, cookie));
    }
    authorize(input: unknown) {
      return this.options.store.transactions.run(async (tx) => ports.authorize(tx, input));
    }
  },
  createPostgresCurrentWorkforceBrowserSessionSource: () => ports.strong,
  createPostgresBrowserBrandSessionSelectionStore: () => ({
    read: ports.selectionRead,
    write: ports.selectionWrite,
  }),
}));
vi.mock("@bop/membership", async (original) => ({
  ...(await original<typeof import("@bop/membership")>()),
  createPostgresMembershipBrandDiscoverySource: (options: unknown) => ports.memberships(options),
}));
vi.mock("@bop/permission", async (original) => ({
  ...(await original<typeof import("@bop/permission")>()),
  createPostgresCurrentBrandAdministrationPermissionPolicySource: () => ({}),
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
const at = "2026-10-01T10:00:00.000Z",
  until = "2026-10-01T10:00:05.000Z";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(1),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
const session = createAuthenticationSession({
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
  idleExpiresAt: "2026-10-01T10:15:00.000Z",
  absoluteExpiresAt: "2026-10-01T18:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
const { policy: _policy, ...sessionFields } = session;
void _policy;
const strong = createAuthenticationSession({
  ...sessionFields,
  policyCode: session.policy.code,
  maxActiveSessions: session.policy.maxActiveSessions,
  idleTimeoutMinutes: session.policy.idleTimeoutMinutes,
  absoluteTimeoutMinutes: session.policy.absoluteTimeoutMinutes,
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
  validUntil: "2026-10-01T10:15:00.000Z",
};
const packet = () => ({
  session,
  csrf: "synthetic-csrf",
  recentMfa: mfa,
  recentMfaRequired: false,
  observedAt: at,
  validUntil: until,
});
const brand = (n: number) =>
  createBrand({
    brandReference: id(n),
    code: `BRAND_${n}`,
    displayName: `Synthetic Brand ${n}`,
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: n === 10 ? "Draft" : "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
const credentials = { sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" };
let candidateIds: string[],
  denied: Set<string>,
  hidden: Set<string>,
  now: string,
  memberDeadline: string,
  hasMore: boolean,
  failFeature: boolean,
  afterCapabilityGuard: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  ports.stores.length = 0;
  ports.selected = null;
  candidateIds = [id(10), id(11)];
  denied = new Set();
  hidden = new Set();
  now = at;
  memberDeadline = until;
  hasMore = false;
  failFeature = false;
  afterCapabilityGuard = undefined;
  ports.bootstrap.mockReset().mockImplementation(async () => packet());
  ports.authorize.mockReset().mockImplementation(async (_tx, input) => {
    if (input.csrf !== credentials.csrf) throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    return packet();
  });
  ports.strong.mockReset().mockResolvedValue(strong);
  ports.selectionRead
    .mockReset()
    .mockImplementation(async () =>
      ports.selected === null ? null : { brandReference: ports.selected },
    );
  ports.selectionWrite.mockReset().mockImplementation(async (_tx, _session, input) => {
    ports.selected = input.brandReference;
    return input;
  });
  ports.authority.mockReset().mockImplementation(async (_tx, _session, reference, observedAt) => ({
    context: createBrandAdministrationContext(
      strong.actor,
      brand(Number(reference.slice(-12))),
      observedAt,
    ),
    decisions: [
      {
        effect: denied.has(reference) ? "Deny" : "Allow",
        action: "organization.manage",
        scopeKind: "Brand",
        policySnapshotReference: id(5),
        policyVersion: 1,
      },
    ],
    validUntil: until,
  }));
  ports.memberships.mockReset().mockImplementation((options) => {
    let sealed = false;
    return {
      async holdPage(request: { afterBrandReference: string | null; limit: number }) {
        const hold = () =>
          options.authority.holdUntilTransactionCompletes(options.transaction, {
            actorReference: id(1),
            purposeCode: "BRAND_DISCOVERY",
            observedAt: at,
            validUntil: options.originalValidUntil,
          });
        await hold();
        await options.registerBeforeCommit(options.transaction, hold, () => {
          sealed = true;
        });
        return {
          profile: "MembershipBrandDiscoveryPageV1",
          actorReference: id(1),
          purposeCode: "BRAND_DISCOVERY",
          ...request,
          brandReferences: candidateIds,
          hasMore,
          nextAfterBrandReference: hasMore ? candidateIds.at(-1) : null,
          observedAt: at,
          validUntil: memberDeadline,
        };
      },
      assertFinalized() {
        expect(sealed).toBe(true);
        ports.memberFinal();
      },
    };
  });
  ports.capability.mockReset().mockImplementation((options) => {
    let sealed = false,
      visible: boolean;
    const read = async () => {
      if (failFeature) throw new Error("controlled unavailable source");
      await options.holdCurrentBrandAdministrationAuthority(options.transaction, {
        scope: options.scope,
        permission: "organization.manage",
        purposeCode: "BRAND_ADMINISTRATION",
        requiredFields: ["key"],
        observedAt: at,
        validUntil: options.originalValidUntil,
      });
      return !hidden.has(`${options.scope.brandReference}:${options.screen}`);
    };
    return {
      async holdForNavigation() {
        visible = await read();
        await options.registerBeforeCommit(
          options.transaction,
          async () => {
            expect(await read()).toBe(visible);
            afterCapabilityGuard?.();
          },
          () => {
            sealed = true;
          },
        );
        return visible;
      },
      leaseDeadline: () => options.originalValidUntil,
      assertFinalized() {
        expect(sealed).toBe(true);
        ports.capabilityFinal();
      },
    };
  });
});
function fixture(
  controls: {
    beforeGuards?: () => void;
    afterCommit?: () => void;
    missingRegistration?: boolean;
    sanitizeFailures?: boolean;
  } = {},
) {
  const unused = (): never => {
    throw new Error("controlled unused identity port");
  };
  const unusedAsync = async (): Promise<never> => unused();
  let committed = 0,
    rolledBack = 0;
  const raw = {
    async run<T>(
      work: (tx: { query: () => Promise<{ rows: readonly unknown[] }> }) => Promise<T>,
    ): Promise<T> {
      const prior = ports.selected;
      try {
        const answer = await work({ query: async () => ({ rows: [] }) });
        committed++;
        controls.afterCommit?.();
        return answer;
      } catch (error) {
        ports.selected = prior;
        rolledBack++;
        if (controls.sanitizeFailures) throw new BrowserSessionError("BROWSER_SESSION_DENIED");
        throw error;
      }
    },
  };
  const host = createMerchantCategoryTransactions(raw),
    original = host.registerBeforeCommit;
  let registrations = 0;
  const source: MerchantBrandDiscoveryPersistence = {
    transactions: raw,
    now: () => now,
    currentActor: async () => actor,
    identity: {
      credentials: { generate: unused, generateUuidV7: unused },
      hasher: { hash: unused, equals: unused },
      envelopes: { encrypt: unusedAsync, decrypt: unusedAsync },
      pkce: { challenge: unused },
      provider: {
        createAuthorizationUrl: unusedAsync,
        exchangeCode: unusedAsync,
        revokeRefreshTokens: unusedAsync,
        createLogoutUrl: unused,
      },
      configuration: {
        environment: "synthetic",
        issuer: "https://identity.invalid",
        clientId: "synthetic",
        redirectUri: "https://merchant.invalid/callback",
        allowedPostLoginPaths: ["/app/organization/brands"],
      },
    },
  };
  const service = createMerchantBrandDiscovery({
    source,
    transactions: host.transactions,
    registerBeforeCommit: async (tx, guard, final) => {
      if (controls.missingRegistration) return;
      const first = registrations++ === 0;
      await original(
        tx,
        async () => {
          if (first) controls.beforeGuards?.();
          await guard();
        },
        final,
      );
    },
  });
  return { service, source, committed: () => committed, rolledBack: () => rolledBack };
}
it("discovers real candidate metadata with no selection, Store, config locales or authority leakage", async () => {
  const f = fixture(),
    result = await f.service.list({ ...credentials, afterBrandReference: null });
  expect(result).toEqual({
    profile: "MerchantBrandDiscoveryV1",
    actorReference: id(1),
    afterBrandReference: null,
    items: [10, 11].map((n) => ({
      brandReference: id(n),
      code: `BRAND_${n}`,
      displayName: `Synthetic Brand ${n}`,
      lifecycle: n === 10 ? "Draft" : "Active",
      defaultLocale: "en-CA",
      version: 1,
    })),
    hasMore: false,
    nextAfterBrandReference: null,
    observedAt: at,
    validUntil: until,
  });
  const tx = ports.bootstrap.mock.calls[0]?.[0];
  expect(ports.strong.mock.calls.every((call) => call[0] === tx)).toBe(true);
  expect(ports.authority.mock.calls.every((call) => call[0] === tx)).toBe(true);
  expect(ports.memberships.mock.calls[0]?.[0].transaction).toBe(tx);
  expect(ports.selectionWrite).not.toHaveBeenCalled();
  expect(f.committed()).toBe(1);
  expect(ports.memberFinal).toHaveBeenCalledOnce();
  expect(ports.capabilityFinal).toHaveBeenCalledTimes(2);
});
it("retains the actual scanned cursor on a fully permission-trimmed empty page", async () => {
  candidateIds = Array.from({ length: 20 }, (_, i) => id(10 + i));
  denied = new Set(candidateIds);
  hasMore = true;
  const answer = await fixture().service.list({ ...credentials, afterBrandReference: id(9) });
  expect(answer.items).toEqual([]);
  expect(answer.hasMore).toBe(true);
  expect(answer.nextAfterBrandReference).toBe(id(29));
  expect(ports.capability).not.toHaveBeenCalled();
});
it("omits only explicit Deny or Disabled; unavailable Feature fails the whole query", async () => {
  denied.add(id(10));
  hidden.add(`${id(11)}:List`);
  expect(
    (await fixture().service.list({ ...credentials, afterBrandReference: null })).items,
  ).toEqual([]);
  failFeature = true;
  await expect(
    fixture().service.list({ ...credentials, afterBrandReference: null }),
  ).rejects.toMatchObject({ reason: "Unavailable" });
});
it("preserves the shortest original Membership deadline", async () => {
  memberDeadline = "2026-10-01T10:00:02.000Z";
  expect(
    (await fixture().service.list({ ...credentials, afterBrandReference: null })).validUntil,
  ).toBe(memberDeadline);
});
it("reads actual selection with expired MFA but refuses sensitive list and select", async () => {
  ports.selected = id(10);
  ports.bootstrap.mockResolvedValue({ ...packet(), recentMfaRequired: true });
  ports.authorize.mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  const f = fixture();
  expect(await f.service.discoveryBootstrap(credentials.sessionCookie)).toEqual({
    authenticated: true,
    actorReference: id(1),
    selectedBrandReference: id(10),
    csrf: credentials.csrf,
    recentMfaRequired: true,
  });
  await expect(f.service.list({ ...credentials, afterBrandReference: null })).rejects.toMatchObject(
    { reason: "Denied" },
  );
  await expect(
    f.service.select({
      ...credentials,
      brandReference: id(10),
      expectedSelectedBrandReference: null,
    }),
  ).rejects.toMatchObject({ reason: "Denied" });
  expect(ports.memberships).not.toHaveBeenCalled();
  expect(ports.selectionWrite).not.toHaveBeenCalled();
});
it("CSRF refusal precedes discovery or selection and malformed input never reaches owners", async () => {
  const f = fixture();
  await expect(
    f.service.list({ ...credentials, csrf: "wrong", afterBrandReference: null }),
  ).rejects.toMatchObject({ reason: "Denied" });
  await expect(
    f.service.list({ ...credentials, afterBrandReference: null, actorReference: id(1) } as never),
  ).rejects.toMatchObject({ reason: "Invalid" });
  expect(ports.memberships).not.toHaveBeenCalled();
  expect(ports.selectionWrite).not.toHaveBeenCalled();
});
it("selects only after actual list and detail qualification, and confirms same-target lost reply", async () => {
  const f = fixture(),
    input = { ...credentials, brandReference: id(10), expectedSelectedBrandReference: null };
  const receipt = await f.service.select(input);
  expect(receipt).toEqual({
    actorReference: id(1),
    brandReference: id(10),
    href: `/app/organization/brands/${id(10)}`,
  });
  expect(ports.capability.mock.calls.map((call) => call[0].screen)).toEqual(["List", "Detail"]);
  expect(await f.service.select(input)).toEqual(receipt);
  expect(ports.selected).toBe(id(10));
});
it("immutable different selection and absent expected-selection conflict never write", async () => {
  ports.selected = id(11);
  const f = fixture({ sanitizeFailures: true });
  await expect(
    f.service.select({
      ...credentials,
      brandReference: id(10),
      expectedSelectedBrandReference: id(11),
    }),
  ).rejects.toMatchObject({ reason: "SelectionConflict" });
  ports.selected = null;
  await expect(
    f.service.select({
      ...credentials,
      brandReference: id(10),
      expectedSelectedBrandReference: id(11),
    }),
  ).rejects.toMatchObject({ reason: "SelectionConflict" });
  expect(ports.selectionWrite).not.toHaveBeenCalled();
  expect(ports.capability).not.toHaveBeenCalled();
  expect(f.committed()).toBe(2);
  expect(f.rolledBack()).toBe(0);
});
it("does not report an observed conflict when current selection changes before COMMIT", async () => {
  ports.selected = id(11);
  const f = fixture({
    sanitizeFailures: true,
    beforeGuards() {
      ports.selected = null;
    },
  });
  await expect(
    f.service.select({
      ...credentials,
      brandReference: id(10),
      expectedSelectedBrandReference: id(11),
    }),
  ).rejects.toMatchObject({ reason: "Unavailable" });
  expect(f.committed()).toBe(0);
  expect(f.rolledBack()).toBe(1);
  expect(ports.selected).toBe(id(11));
  expect(ports.selectionWrite).not.toHaveBeenCalled();
});
it("detail-disabled target cannot be selected even when visible in the list", async () => {
  hidden.add(`${id(10)}:Detail`);
  await expect(
    fixture().service.select({
      ...credentials,
      brandReference: id(10),
      expectedSelectedBrandReference: null,
    }),
  ).rejects.toMatchObject({ reason: "Denied" });
  expect(ports.selectionWrite).not.toHaveBeenCalled();
});
it.each(["Session", "Permission", "Brand", "Selection", "Clock"])(
  "refuses late %s drift and rolls back actual selection",
  async (mode) => {
    const f = fixture({
      beforeGuards() {
        if (mode === "Session")
          ports.bootstrap.mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
        if (mode === "Permission") denied.add(id(10));
        if (mode === "Brand")
          ports.authority.mockImplementation(async () => ({
            context: createBrandAdministrationContext(
              strong.actor,
              createBrand({ ...brand(10), version: 2 }),
              at,
            ),
            decisions: [
              {
                effect: "Allow",
                action: "organization.manage",
                scopeKind: "Brand",
                policySnapshotReference: id(5),
                policyVersion: 1,
              },
            ],
            validUntil: until,
          }));
        if (mode === "Selection") ports.selected = id(11);
        if (mode === "Clock") now = until;
      },
    });
    await expect(
      f.service.select({
        ...credentials,
        brandReference: id(10),
        expectedSelectedBrandReference: null,
      }),
    ).rejects.toThrow();
    expect(f.committed()).toBe(0);
    expect(f.rolledBack()).toBe(1);
    expect(ports.selected).toBe(null);
  },
);
it("a later child guard cannot exhaust the original lease before the final seal", async () => {
  afterCapabilityGuard = () => {
    now = until;
  };
  const f = fixture();
  await expect(f.service.list({ ...credentials, afterBrandReference: null })).rejects.toThrow();
  expect(f.committed()).toBe(0);
});
it("missing host registration and authority source failure refuse rather than return empty", async () => {
  await expect(
    fixture({ missingRegistration: true }).service.discoveryBootstrap(credentials.sessionCookie),
  ).rejects.toThrow();
  ports.authority.mockRejectedValue(new Error("controlled source failure"));
  await expect(
    fixture().service.list({ ...credentials, afterBrandReference: null }),
  ).rejects.toMatchObject({ reason: "Unavailable" });
});
it("port replacement is refused, while delayed COMMIT reply has only pure final assertions", async () => {
  const f = fixture({
    beforeGuards() {
      Object.defineProperty(f.source, "now", { value: () => at });
    },
  });
  await expect(f.service.list({ ...credentials, afterBrandReference: null })).rejects.toThrow();
  const delayed = fixture({
    afterCommit() {
      now = "2026-10-01T10:01:00.000Z";
    },
  });
  expect(
    (await delayed.service.list({ ...credentials, afterBrandReference: null })).items,
  ).toHaveLength(2);
});
