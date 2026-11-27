import { beforeEach, expect, it, vi } from "vitest";
import {
  createPersistentBrandDiscoveryBff,
  type PersistentBrandDiscoveryBffOptions,
} from "./persistent-brand-discovery-bff.js";

// Actual BFF/transaction host; Identity and existing workspace are controlled
// factory boundaries here, not a substitute for encrypted-session native proof.
const ports = vi.hoisted(() => ({
  store: vi.fn(),
  services: [] as unknown[],
  start: vi.fn(),
  invitation: vi.fn(),
  callback: vi.fn(),
  authorize: vi.fn(),
  logout: vi.fn(),
  stepUp: vi.fn(),
  discovery: vi.fn(),
  bootstrap: vi.fn(),
  discoveryBootstrap: vi.fn(),
  list: vi.fn(),
  select: vi.fn(),
  workspace: vi.fn(),
  selectedBootstrap: vi.fn(),
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresWorkforceBrowserSessionStore: (options: unknown) => {
    ports.store(options);
    return options;
  },
  WorkforceBrowserSessionService: class {
    constructor(options: unknown) {
      ports.services.push(options);
    }
    startInvitation(value: unknown) {
      return ports.invitation(value);
    }
    start(value: unknown) {
      return ports.start(value);
    }
    callback(value: unknown) {
      return ports.callback(value);
    }
    authorize(value: unknown) {
      return ports.authorize(value);
    }
    logout(value: unknown) {
      return ports.logout(value);
    }
    startStepUp(value: unknown) {
      return ports.stepUp(value);
    }
  },
}));
vi.mock("./merchant-brand-discovery.js", async (original) => ({
  ...(await original<typeof import("./merchant-brand-discovery.js")>()),
  createMerchantBrandDiscovery: (options: unknown) => {
    ports.discovery(options);
    return {
      bootstrap: ports.bootstrap,
      discoveryBootstrap: ports.discoveryBootstrap,
      list: ports.list,
      select: ports.select,
    };
  },
}));
vi.mock("./persistent-brand-administration-bff.js", () => ({
  createPersistentBrandAdministrationBff: (options: unknown) => {
    ports.workspace(options);
    return { bootstrap: ports.selectedBootstrap };
  },
}));
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const path = "/app/organization/brands",
  at = "2026-10-01T10:00:00.000Z";
const current = (selectedBrandReference: string | null = null, recentMfaRequired = false) => ({
  session: { sessionReference: id(1), actor: { actorReference: id(2) } },
  csrf: "synthetic-csrf",
  recentMfaRequired,
  selectedBrandReference,
});
beforeEach(() => {
  vi.clearAllMocks();
  ports.services.length = 0;
  ports.start.mockResolvedValue({ authorizationUrl: "https://identity.invalid/authorize" });
  ports.callback.mockResolvedValue({ session: current().session });
  ports.authorize.mockResolvedValue({ session: current().session });
  ports.logout.mockResolvedValue({ status: "Unknown", cookies: [], browserLogoutUrl: null });
  ports.stepUp.mockResolvedValue({ authorizationUrl: "https://identity.invalid/authorize" });
  ports.bootstrap.mockReset().mockResolvedValue(current());
  ports.selectedBootstrap.mockReset().mockResolvedValue({
    ...current(id(10)),
    workspace: { selectedScope: { brandReference: id(10) } },
  });
});
function fixture(workforceOnboarding?: import("@bop/identity").WorkforceOnboardingBrowserPort) {
  const unused = (): never => {
    throw new Error("controlled unused identity port");
  };
  const unusedAsync = async (): Promise<never> => unused();
  let now = at,
    committed = 0;
  const options: PersistentBrandDiscoveryBffOptions = {
    now: () => now,
    currentActor: async () => {
      throw new Error("controlled unused port");
    },
    transactions: {
      async run<T>(
        work: (tx: { query: () => Promise<{ rows: readonly unknown[] }> }) => Promise<T>,
      ) {
        const result = await work({ query: async () => ({ rows: [] }) });
        committed++;
        return result;
      },
    },
    identity: {
      ...(workforceOnboarding ? { workforceOnboarding } : {}),
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
        allowedPostLoginPaths: [path, "/app"],
      },
    },
  };
  return {
    bff: createPersistentBrandDiscoveryBff(options),
    options,
    setNow: (value: string) => {
      now = value;
    },
    committed: () => committed,
  };
}
it("keeps login and step-up at the canonical list and never installs an automatic selection hook", async () => {
  const { bff } = fixture();
  expect(ports.workspace).not.toHaveBeenCalled();
  const store = ports.store.mock.calls[0]?.[0];
  expect(store.onSessionCreated).toBeUndefined();
  expect(store.allowedPostLoginPaths).toEqual([path]);
  await bff.start(path);
  expect(ports.start).toHaveBeenCalledWith(path);
  await expect(bff.start(`${path}/${id(10)}`)).rejects.toMatchObject({ reason: "Invalid" });
  await bff.rotate({ sessionCookie: "synthetic-cookie", csrf: "synthetic-csrf" });
  expect(ports.stepUp).toHaveBeenCalledWith({
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    postLoginPath: path,
  });
  expect(ports.select).not.toHaveBeenCalled();
});
it("accepts only the closed actual callback and preserves owner logout result", async () => {
  const { bff } = fixture();
  expect(() =>
    bff.callback({
      code: "code",
      state: "state",
      authCookie: "cookie",
      policyCode: "Standard",
    } as never),
  ).toThrow();
  expect(ports.callback).not.toHaveBeenCalled();
  await bff.callback({ code: "code", state: "state", authCookie: "cookie" });
  expect(ports.callback).toHaveBeenCalledWith({
    code: "code",
    state: "state",
    authCookie: "cookie",
  });
  expect(await bff.logout({ sessionCookie: "cookie", csrf: "csrf" })).toEqual({
    status: "Unknown",
    cookies: [],
    browserLogoutUrl: null,
  });
});
it("unselected or expired-MFA bootstrap does not resolve or manufacture a Brand workspace", async () => {
  const { bff } = fixture();
  expect(await bff.bootstrap("cookie")).toEqual({ ...current(), workspace: null });
  ports.bootstrap.mockResolvedValue(current(id(10), true));
  expect(await bff.bootstrap("cookie")).toEqual({ ...current(id(10), true), workspace: null });
  expect(ports.workspace).not.toHaveBeenCalled();
  expect(ports.select).not.toHaveBeenCalled();
});
it("selected workspace reuses actual existing BFF read without changing the root authentication profile", async () => {
  const { bff } = fixture();
  ports.bootstrap.mockResolvedValue(current(id(10)));
  const result = await bff.bootstrap("cookie");
  expect(result.workspace?.selectedScope.brandReference).toBe(id(10));
  expect(ports.workspace.mock.calls[0]?.[0].brandReference).toBe(id(10));
  expect(ports.workspace.mock.calls[0]?.[0].identity.configuration.allowedPostLoginPaths).toEqual([
    `${path}/${id(10)}`,
  ]);
  expect(ports.store.mock.calls[0]?.[0].allowedPostLoginPaths).toEqual([path]);
  await bff.rotate({ sessionCookie: "cookie", csrf: "csrf" });
  expect(ports.stepUp.mock.calls[0]?.[0].postLoginPath).toBe(path);
});
it("rejects a workspace answer from another actual Session/Actor or selection", async () => {
  const { bff } = fixture();
  ports.bootstrap.mockResolvedValue(current(id(10)));
  ports.selectedBootstrap.mockResolvedValue({
    ...current(id(10)),
    session: { sessionReference: id(9), actor: { actorReference: id(2) } },
    workspace: { selectedScope: { brandReference: id(10) } },
  });
  await expect(bff.bootstrap("cookie")).rejects.toMatchObject({ reason: "Unavailable" });
  ports.selectedBootstrap.mockResolvedValue({
    ...current(id(10)),
    workspace: { selectedScope: { brandReference: id(11) } },
  });
  await expect(bff.bootstrap("cookie")).rejects.toMatchObject({ reason: "Unavailable" });
});
it("delegates list/select and minimal discovery bootstrap only to the genuine discovery composition", async () => {
  const { bff } = fixture();
  const input = { sessionCookie: "cookie", csrf: "csrf", afterBrandReference: null };
  await bff.list(input);
  expect(ports.list).toHaveBeenCalledWith(input);
  const select = {
    sessionCookie: "cookie",
    csrf: "csrf",
    brandReference: id(10),
    expectedSelectedBrandReference: null,
  };
  await bff.select(select);
  expect(ports.select).toHaveBeenCalledWith(select);
  await bff.discoveryBootstrap("cookie");
  expect(ports.discoveryBootstrap).toHaveBeenCalledWith("cookie");
  expect(await bff.authorize({ sessionCookie: "cookie", csrf: "csrf" })).toEqual(current().session);
});
it("actual authentication transactions have original guard and refuse expiry or port drift", async () => {
  const f = fixture(),
    transactions = ports.store.mock.calls[0]?.[0].transactions;
  expect(await transactions.run(async () => "read")).toBe("read");
  expect(f.committed()).toBe(1);
  await expect(
    transactions.run(async () => {
      f.setNow("2026-10-01T10:00:05.000Z");
      return "late";
    }),
  ).rejects.toThrow();
  expect(f.committed()).toBe(1);
  f.setNow(at);
  Object.defineProperty(f.options, "currentActor", { value: async () => null });
  await expect(transactions.run(async () => "changed")).rejects.toThrow();
});
it("refuses a configuration that never allowed the canonical root login path", () => {
  const f = fixture();
  expect(() =>
    createPersistentBrandDiscoveryBff({
      ...f.options,
      identity: {
        ...f.options.identity,
        configuration: { ...f.options.identity.configuration, allowedPostLoginPaths: ["/app"] },
      },
    }),
  ).toThrow();
});

it("offers invitation start only when configured, pins actual ports and fixes root post-login path", async () => {
  const ordinary = fixture();
  expect(ordinary.bff.startInvitation).toBeUndefined();
  const unused = vi.fn(async (): Promise<never> => {
    throw new Error("Controlled owner port unused by forwarding test");
  });
  const onboarding = { resolveInvitation: unused, exchangeCode: unused, complete: unused },
    f = fixture(onboarding);
  const begin = f.bff.startInvitation;
  if (!begin) throw new Error("Missing configured invitation entry");
  ports.invitation.mockResolvedValue({ authorizationUrl: "https://identity.invalid/authorize" });
  await begin("A".repeat(43));
  expect(ports.invitation).toHaveBeenCalledExactlyOnceWith({
    secret: "A".repeat(43),
    postLoginPath: path,
  });
  expect(ports.select).not.toHaveBeenCalled();
  expect(unused).not.toHaveBeenCalled();
  expect(ports.services.at(-1)).toMatchObject({ workforceOnboarding: onboarding });
  Object.defineProperty(f.options.identity, "workforceOnboarding", {
    value: { ...onboarding },
    enumerable: true,
    configurable: true,
  });
  await expect(begin("A".repeat(43))).rejects.toThrow();
  expect(ports.invitation).toHaveBeenCalledTimes(1);
});
