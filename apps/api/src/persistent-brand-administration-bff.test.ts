import { createBrand, createBrandAdministrationContext } from "@bop/tenant";
import {
  createIdentityActor,
  createAuthenticationSession,
  createBrowserSessionRecord,
  parseSelectorHash,
} from "@bop/identity";
import { beforeEach, expect, it, vi } from "vitest";
import { createPersistentBrandAdministrationBff } from "./persistent-brand-administration-bff.js";
const ports = vi.hoisted(() => ({
  services: [] as unknown[],
  selections: [] as { previousSessionReference: string | null }[],
  resolve: vi.fn(),
  capability: vi.fn(),
  check: vi.fn(),
  final: vi.fn(),
  callback: vi.fn(),
  invitation: vi.fn(),
  stepUp: vi.fn(),
  logout: vi.fn(),
  expiredMfa: false,
  visible: true,
  missing: false,
  session: { sessionReference: "" },
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresWorkforceBrowserSessionStore: (options: unknown) => options,
  WorkforceBrowserSessionService: class {
    constructor(options: unknown) {
      ports.services.push(options);
    }
    startInvitation(value: unknown) {
      return ports.invitation(value);
    }
    async start(path: unknown) {
      return { path };
    }
    async callback(input: unknown) {
      ports.callback(input);
      return { session: ports.session };
    }
    async bootstrap() {
      return {
        session: ports.session,
        csrf: "synthetic-csrf",
        recentMfaRequired: ports.expiredMfa,
      };
    }
    async authorize(input: { csrf: unknown }) {
      if (input.csrf !== "synthetic-csrf") throw new Error("CSRF denied");
      return { session: ports.session };
    }
    async startStepUp(input: { csrf: unknown }) {
      if (input.csrf !== "synthetic-csrf") throw new Error("CSRF denied");
      ports.stepUp(input);
      return { authorizationUrl: "https://identity.invalid/authorize", cookie: { clear: false } };
    }
    async logout() {
      return ports.logout();
    }
  },
}));
vi.mock("./merchant-brand-session-selection.js", () => ({
  createMerchantBrandAdministrationSessionSelection: (options: {
    previousSessionReference: string | null;
  }) => {
    ports.selections.push(options);
    return async () => undefined;
  },
}));
vi.mock("./merchant-current-brand-scope.js", () => ({
  createMerchantCurrentBrandAdministrationScope: () => ports.resolve,
}));
vi.mock("./merchant-brand-administration-capability.js", () => ({
  merchantBrandAdministrationCapabilityRequiredFields: ["key"],
  createMerchantCurrentBrandAdministrationCapability: (options: unknown) =>
    ports.capability(options),
}));
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z",
  until = "2026-09-10T10:00:05.000Z";
const path = `/app/organization/brands/${id(3)}`;
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
const context = createBrandAdministrationContext(
  actor,
  createBrand({
    brandReference: id(3),
    code: "SYNTHETIC",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 7,
    createdAt: at,
    updatedAt: at,
  }),
  at,
);
beforeEach(() => {
  vi.clearAllMocks();
  ports.services.length = 0;
  ports.selections.length = 0;
  ports.check.mockReset();
  ports.visible = true;
  ports.missing = false;
  ports.expiredMfa = false;
  ports.logout.mockReturnValue({ status: "Unknown", cookies: [], browserLogoutUrl: null });
  ports.session = { sessionReference: id(2) };
  ports.resolve.mockResolvedValue({
    tenantReference: id(3),
    context,
    actorReference: id(1),
    authorizeActionsWithValidity: async () => ({
      context,
      decisions: [{ effect: "Allow", scopeKind: "Brand", action: "organization.manage" }],
      validUntil: until,
    }),
    authorizeAction: async () => ({ effect: "Allow" }),
    assertCurrent: ports.check,
  });
  ports.capability.mockImplementation((options) => ({
    async holdForNavigation() {
      if (ports.missing) throw new Error("feature unavailable");
      const request = {
        scope: options.scope,
        permission: "organization.manage",
        purposeCode: "BRAND_ADMINISTRATION",
        requiredFields: ["key"],
        observedAt: at,
        validUntil: until,
      };
      await options.holdCurrentBrandAdministrationAuthority(options.transaction, request);
      await options.registerBeforeCommit(
        options.transaction,
        async () => {
          await options.holdCurrentBrandAdministrationAuthority(options.transaction, request);
        },
        ports.check,
      );
      return ports.visible;
    },
    assertFinalized: ports.final,
  }));
});
function fixture(
  afterCommit?: () => void,
  workforceOnboarding?: import("@bop/identity").WorkforceOnboardingBrowserPort,
) {
  return createPersistentBrandAdministrationBff({
    brandReference: id(3),
    now: () => at,
    transactions: {
      run: async (work) => {
        const result = await work({ query: async () => ({ rows: [] }) });
        afterCommit?.();
        return result;
      },
    },
    currentActor: async () => actor,
    identity: {
      configuration: { allowedPostLoginPaths: [path] },
      ...(workforceOnboarding ? { workforceOnboarding } : {}),
    } as never,
  });
}
it("uses the real configured capability boundary and emits only selected Brand detail navigation", async () => {
  const bff = fixture(),
    result = await bff.bootstrap("synthetic-cookie");
  expect(freshWorkspace(result).selectedScope).toEqual({
    tenantReference: id(3),
    brandReference: id(3),
    actorReference: id(1),
  });
  expect(freshWorkspace(result).brand).toEqual({
    brandReference: id(3),
    label: "Synthetic Brand",
    lifecycle: "Active",
    version: 7,
  });
  expect(freshWorkspace(result).navigation).toEqual([
    { screenId: "ORG-BRAND-DETAIL", label: "Brand", href: path, permission: "organization.manage" },
  ]);
  expect("storeReference" in freshWorkspace(result).selectedScope).toBe(false);
  expect(ports.final).toHaveBeenCalledOnce();
});
it("keeps Disabled hidden and Missing unavailable without a default Enabled value", async () => {
  const bff = fixture();
  ports.visible = false;
  expect(freshWorkspace(await bff.bootstrap("synthetic-cookie")).navigation).toEqual([]);
  ports.missing = true;
  await expect(bff.bootstrap("synthetic-cookie")).rejects.toThrow();
});
it("narrows the post-login target and rejects an absent or unrelated target", async () => {
  const bff = fixture();
  await expect(bff.start("/app")).rejects.toThrow();
  expect(await bff.start(path)).toEqual({ path });
  expect(() => createPersistentBrandAdministrationBff({ brandReference: "" } as never)).toThrow();
});
it("starts genuine fixed-path step-up rather than locally rotating a Session", async () => {
  const bff = fixture();
  await expect(bff.rotate({ sessionCookie: "synthetic-cookie", csrf: "bad" })).rejects.toThrow();
  expect(ports.services).toHaveLength(1);
  await bff.rotate({ sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" });
  expect(ports.stepUp).toHaveBeenCalledWith({
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    postLoginPath: path,
  });
  expect(ports.selections).toHaveLength(0);
});

it("does not expose another selected Brand from the same authenticated browser", async () => {
  ports.resolve.mockResolvedValue({ context: { brand: { brandReference: id(9) } } });
  await expect(fixture().bootstrap("synthetic-cookie")).rejects.toThrow();
  expect(ports.capability).not.toHaveBeenCalled();
});
it("uses pure post-COMMIT finalization without rerunning current authority after a delayed reply", async () => {
  let committed = false;
  ports.check.mockImplementation(() => {
    if (committed) throw new Error("clock expired after commit");
  });
  expect(
    freshWorkspace(
      await fixture(() => {
        committed = true;
      }).bootstrap("synthetic-cookie"),
    ).navigation,
  ).toHaveLength(1);
  expect(ports.final).toHaveBeenCalledOnce();
});
it("refuses caller-selected internal Session policy before invoking the Identity callback", async () => {
  const bff = fixture();
  const input = {
    code: "synthetic-code",
    state: "synthetic-state",
    authCookie: "synthetic-cookie",
  };
  await expect(
    bff.callback({ ...input, policyCode: "NamedKdsOperator" } as never),
  ).rejects.toThrow();
  expect(ports.callback).not.toHaveBeenCalled();
  await bff.callback(input);
  expect(ports.callback).toHaveBeenCalledWith(input);
});

it.each(["Draft", "Suspended", "Archived"] as const)(
  "reports the real %s lifecycle from administrative admission",
  async (lifecycle) => {
    const current = createBrandAdministrationContext(
      actor,
      createBrand({ ...context.brand, lifecycle }),
      at,
    );
    ports.resolve.mockResolvedValue({
      tenantReference: id(3),
      context: current,
      actorReference: id(1),
      authorizeActionsWithValidity: async () => ({
        context: current,
        decisions: [{ effect: "Allow", scopeKind: "Brand", action: "organization.manage" }],
        validUntil: until,
      }),
      authorizeAction: async () => ({ effect: "Allow" }),
      assertCurrent: ports.check,
    });
    const result = await fixture().bootstrap("synthetic-cookie");
    expect(freshWorkspace(result).brand.lifecycle).toBe(lifecycle);
    expect(freshWorkspace(result).brand.version).toBe(7);
    expect(ports.final).toHaveBeenCalledOnce();
  },
);

function freshWorkspace(result: Awaited<ReturnType<ReturnType<typeof fixture>["bootstrap"]>>) {
  if (!result.workspace) throw new Error("Expected fresh workspace");
  return result.workspace;
}
it("keeps expired MFA bootstrap readable without loading Brand authority", async () => {
  ports.expiredMfa = true;
  const result = await fixture().bootstrap("synthetic-cookie");
  expect(result.recentMfaRequired).toBe(true);
  expect(result.workspace).toBeNull();
  expect(ports.resolve).not.toHaveBeenCalled();
  expect(ports.capability).not.toHaveBeenCalled();
});
it("returns accurate Unknown logout without reauthorizing locally revoked Session", async () => {
  const bff = fixture();
  expect(await bff.logout({ sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" })).toEqual({
    status: "Unknown",
    cookies: [],
    browserLogoutUrl: null,
  });
  expect(ports.logout).toHaveBeenCalledOnce();
});

it("uses the genuine replacement record predecessor to create each selection hook on one service", async () => {
  fixture();
  const configured = ports.services[0];
  if (
    !configured ||
    typeof configured !== "object" ||
    !("store" in configured) ||
    !configured.store ||
    typeof configured.store !== "object" ||
    !("onSessionCreated" in configured.store) ||
    typeof configured.store.onSessionCreated !== "function"
  )
    throw new Error("Missing controlled store hook");
  const session = createAuthenticationSession({
    sessionReference: id(30),
    actor,
    status: "Active",
    policyCode: "Privileged",
    maxActiveSessions: 2,
    idleTimeoutMinutes: 15,
    absoluteTimeoutMinutes: 480,
    version: 2,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: "2026-09-10T10:15:00.000Z",
    absoluteExpiresAt: "2026-09-10T18:00:00.000Z",
    rotatedFromSessionReference: id(2),
    revocationReason: null,
    revokedAt: null,
  });
  const record = createBrowserSessionRecord({
    session,
    sessionSelectorHash: parseSelectorHash("a".repeat(64)),
    csrfSelectorHash: parseSelectorHash("b".repeat(64)),
    encryptedSecrets: {
      algorithm: "SYNTHETIC_AES_256_GCM",
      keyReference: "synthetic",
      ciphertext: "A".repeat(43),
      encryptionContext: `synthetic:session:${id(30)}:${id(1)}`,
    },
  });
  await configured.store.onSessionCreated({ query: async () => ({ rows: [] }) }, record);
  expect(ports.selections.map((entry) => entry.previousSessionReference)).toEqual([id(2)]);
  expect(ports.services).toHaveLength(1);
});

it("rejects invitation configuration on the fixed Brand entry before any selection or authentication", () => {
  expect(fixture()).not.toHaveProperty("startInvitation");
  const unused = vi.fn(async (): Promise<never> => {
      throw new Error("Controlled owner port unused by forwarding test");
    }),
    onboarding = { resolveInvitation: unused, exchangeCode: unused, complete: unused };
  expect(() => fixture(undefined, onboarding)).toThrow("BRAND_ADMINISTRATION_BFF_UNAVAILABLE");
  expect(ports.invitation).not.toHaveBeenCalled();
  expect(ports.resolve).not.toHaveBeenCalled();
  expect(ports.selections).toHaveLength(0);
});
