import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ provider: vi.fn(), status: vi.fn(), source: vi.fn() }));
vi.mock("../infrastructure/cognito-platform-provider.js", () => ({
  createCognitoPlatformProvider: ports.provider,
}));
vi.mock("../infrastructure/cognito-platform-subject-status.js", () => ({
  createCognitoPlatformSubjectStatus: ports.status,
}));
vi.mock("../infrastructure/persistence/platform-actor-directory-store.js", () => ({
  createPostgresPlatformActorDirectorySource: ports.source,
}));
import {
  createCognitoPlatformIdentity,
  type CognitoPlatformIdentityOptions,
} from "../infrastructure/cognito-platform-identity.js";
import type {
  PlatformActorDirectorySourceOptions,
  PlatformActorDirectoryTransaction,
} from "../infrastructure/persistence/platform-actor-directory-store.js";
import type { CognitoPlatformProviderOptions } from "../infrastructure/cognito-platform-provider.js";

const original = "2026-10-06T10:00:00.100Z";
const actor = Object.freeze({
  actorType: "User",
  actorReference: "01902627-0300-7000-8000-000000000001",
  accountKind: "Platform",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: original,
  recentMfaAt: null,
});
beforeEach(() => vi.resetAllMocks());
function fixture() {
  let at = original;
  let skipFinal = false;
  const tx: PlatformActorDirectoryTransaction = { query: vi.fn() };
  const guards: { guard: () => Promise<void>; seal: () => void }[] = [];
  const remote = vi.fn();
  ports.status.mockReturnValue({ readCurrentProviderSubject: remote });
  ports.provider.mockImplementation((options: CognitoPlatformProviderOptions) => ({
    resolve: options.resolveVerifiedSubject,
  }));
  const options: CognitoPlatformIdentityOptions = {
    configuration: {
      environment: "synthetic",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
      clientId: "syntheticclient",
      clientSecret: "synthetic-only-secret",
      managedLoginOrigin: "https://identity.example.test",
      redirectUri: "https://app.example.test/platform/auth/callback",
      logoutReturnUri: "https://app.example.test/platform/tenants",
    },
    transactions: {
      async run<T>(work: (tx: PlatformActorDirectoryTransaction) => Promise<T>) {
        const result = await work(tx);
        for (const g of guards.splice(0)) {
          await g.guard();
          if (!skipFinal) g.seal();
        }
        at = "2026-10-06T10:00:06.000Z";
        return result;
      },
    },
    registerBeforeCommit: async (actual, guard, seal) => {
      expect(actual).toBe(tx);
      guards.push({ guard, seal });
    },
    clock: { now: () => at },
    hasher: { hash: vi.fn(), equals: vi.fn() },
    envelopes: { encrypt: vi.fn(), decrypt: vi.fn() },
    nextEvidenceReference: vi.fn(),
  };
  ports.source.mockImplementation((input: PlatformActorDirectorySourceOptions) => {
    let finalized = false;
    const read = async () => {
      await input.registerBeforeCommit(
        tx,
        async () => undefined,
        () => {
          finalized = true;
        },
      );
      return actor;
    };
    return {
      resolveVerifiedSubject: vi.fn(read),
      currentActor: vi.fn(read),
      assertFinalized() {
        if (!finalized) throw new Error("DIRECTORY_NOT_FINALIZED");
      },
    };
  });
  return {
    options,
    tx,
    remote,
    setSkipFinal: () => {
      skipFinal = true;
    },
  };
}
describe("concrete Cognito Platform Identity composition", () => {
  it("resolves the verified subject on the actual host transaction, then only checks its final seal after COMMIT", async () => {
    const f = fixture();
    createCognitoPlatformIdentity(f.options);
    const call = ports.provider.mock.calls[0];
    if (!call) throw new Error("Expected concrete Provider construction");
    const providerOptions = call[0] as CognitoPlatformProviderOptions;
    const input = {
      issuer: f.options.configuration.issuer,
      clientId: f.options.configuration.clientId,
      subject: "opaque-synthetic-subject",
      authenticatedAt: original,
      observedAt: original,
    };
    expect(await providerOptions.resolveVerifiedSubject(input)).toBe(actor);
    expect(ports.source).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: f.tx,
        originalObservedAt: original,
        originalValidUntil: "2026-10-06T10:00:05.100Z",
        readCurrentProviderSubject: f.remote,
      }),
    );
    expect(ports.status).toHaveBeenCalledWith({
      userPoolId: "ca-central-1_Synthetic",
      clock: f.options.clock,
    });
    expect(providerOptions).not.toHaveProperty("http");
  });
  it("rejects a host that omits the real final guard", async () => {
    const f = fixture();
    f.setSkipFinal();
    const identity = createCognitoPlatformIdentity(f.options);
    await expect(
      identity.transactions.run((tx) =>
        identity.currentActor(tx, actor.actorReference, original, original),
      ),
    ).rejects.toThrow("DIRECTORY_NOT_FINALIZED");
  });
  it("never accepts a foreign or no-longer-borrowed transaction for a Session Actor read", async () => {
    const f = fixture();
    const identity = createCognitoPlatformIdentity(f.options);
    expect(() => identity.currentActor(f.tx, actor.actorReference, original, original)).toThrow();
    await identity.transactions.run(async (tx) => {
      expect(() =>
        identity.currentActor({ query: tx.query }, actor.actorReference, original, original),
      ).toThrow();
    });
    expect(() => identity.currentActor(f.tx, actor.actorReference, original, original)).toThrow();
    expect(ports.source).not.toHaveBeenCalled();
  });
  it("refuses replacement of the actual host run port", async () => {
    const f = fixture();
    const identity = createCognitoPlatformIdentity(f.options);
    f.options.transactions.run = vi.fn();
    await expect(identity.transactions.run(async () => undefined)).rejects.toThrow();
    expect(ports.source).not.toHaveBeenCalled();
  });
});
