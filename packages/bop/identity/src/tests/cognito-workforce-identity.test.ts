import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ provider: vi.fn(), source: vi.fn() }));
vi.mock("../infrastructure/cognito-workforce-provider.js", () => ({
  createCognitoWorkforceProvider: ports.provider,
}));
vi.mock("../infrastructure/persistence/workforce-authentication-source.js", () => ({
  createPostgresWorkforceAuthenticationSource: ports.source,
}));
import { createIdentityActor } from "../contracts/identity-actor.js";
import {
  createCognitoWorkforceIdentity,
  type CognitoWorkforceIdentityOptions,
} from "../infrastructure/cognito-workforce-identity.js";
import type { CognitoWorkforceProviderOptions } from "../infrastructure/cognito-workforce-provider.js";
import type { WorkforceAuthenticationSourceOptions } from "../infrastructure/persistence/workforce-authentication-source.js";
import type { CurrentWorkforceAccountTransaction as Transaction } from "../infrastructure/persistence/current-workforce-account-source.js";

// These composition tests control the two owning factories and host transport.
// They do not replace the separate signed-token/SDK/SQL native acceptance proof.
const original = "2026-10-06T10:00:00.100Z",
  deadline = "2026-10-06T10:00:05.100Z",
  denied = { code: "BROWSER_SESSION_DENIED" },
  actor = createIdentityActor({
    actorType: "User",
    actorReference: "01902627-0300-7000-8000-000000000001",
    accountKind: "Workforce",
    status: "Active",
    authenticationMethod: "Oidc",
    verificationLevel: "SingleFactor",
    authenticatedAt: original,
    recentMfaAt: null,
  });
beforeEach(() => vi.resetAllMocks());
function fixture() {
  interface HostState {
    phase: "Work" | "Checks" | "Final" | "Closed";
    failed: boolean;
    readonly guards: { guard: () => Promise<void>; seal: () => void }[];
  }
  const states = new WeakMap<Transaction, HostState>(),
    transactions: Transaction[] = [],
    events: string[] = [],
    queries = vi.fn<(sql: string, values: readonly unknown[]) => Promise<{ rows: never[] }>>(
      async () => ({ rows: [] }),
    );
  let at = original,
    skipAsync = false,
    skipFinal = false,
    skipSourceFinal = false,
    clockThrows = false,
    delayReply = false,
    failSource = false,
    failedSourceGuard = false,
    sourceSeals = 0,
    sourceReadHook: () => Promise<void> = async () => undefined,
    hostEntryHook: () => void = () => undefined,
    beforeGuards: () => void = () => undefined;
  async function runHost<T>(
    work: (tx: Transaction) => Promise<T>,
    parent?: Transaction,
  ): Promise<T> {
    const state: HostState = { phase: "Work", failed: false, guards: [] },
      tx: Transaction = {
        async query(sql, values) {
          if (state.phase === "Closed" || state.phase === "Final" || state.failed)
            throw new Error("HOST_CLOSED");
          return parent ? parent.query(sql, values) : queries(sql, values);
        },
      };
    states.set(tx, state);
    transactions.push(tx);
    events.push(parent ? "begin-wrapper" : "begin");
    try {
      hostEntryHook();
      const result = await work(tx);
      if (!state.guards.length || state.failed) throw new Error("HOST_MISSING_GUARD");
      beforeGuards();
      state.phase = "Checks";
      if (!skipAsync) for (const item of state.guards) await item.guard();
      state.phase = "Final";
      if (!skipFinal)
        for (const [index, item] of state.guards.entries()) {
          if (!skipSourceFinal || index === 0) item.seal();
        }
      if (state.failed) throw new Error("HOST_FAILED");
      events.push(parent ? "sealed-wrapper" : "commit");
      if (delayReply && !parent) {
        at = "2026-10-06T10:01:00.000Z";
        clockThrows = true;
      }
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    } finally {
      state.phase = "Closed";
    }
  }
  const register: WorkforceAuthenticationSourceOptions["registerBeforeCommit"] = async (
    tx,
    guard,
    seal,
  ) => {
    const state = states.get(tx);
    if (!state) throw new Error("FOREIGN_TRANSACTION");
    if (state.phase !== "Work") {
      state.failed = true;
      throw new Error("HOST_NOT_WORKING");
    }
    state.guards.push({ guard, seal });
    events.push("registered");
  };
  const options: CognitoWorkforceIdentityOptions = {
    configuration: {
      environment: "synthetic",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
      clientId: "syntheticclient",
      clientSecret: "synthetic-only-secret",
      managedLoginOrigin: "https://identity.example.test",
      redirectUri: "https://app.example.test/merchant/organization/brands/callback",
      logoutReturnUri: "https://app.example.test/app/organization/brands",
    },
    transactions: { run: runHost },
    registerBeforeCommit: register,
    clock: {
      now() {
        if (clockThrows) throw new Error("POST_COMMIT_CLOCK");
        return at;
      },
    },
    hasher: { hash: vi.fn(), equals: vi.fn() },
    envelopes: { encrypt: vi.fn(), decrypt: vi.fn() },
    nextEvidenceReference: vi.fn(),
  };
  ports.provider.mockReturnValue(Object.freeze({ controlledProvider: true }));
  ports.source.mockImplementation((input: WorkforceAuthenticationSourceOptions) => {
    let registered = false,
      poisoned = false,
      finalized = false;
    const check = () => {
      if (
        poisoned ||
        input.clock.now() < input.originalObservedAt ||
        input.clock.now() >= input.originalValidUntil
      )
        throw new Error("SOURCE_DENIED");
    };
    const read = async () => {
      try {
        if (!registered) {
          registered = true;
          await input.registerBeforeCommit(
            input.transaction,
            async () => {
              check();
              if (failedSourceGuard) throw new Error("SOURCE_WITHDRAWN");
            },
            () => {
              check();
              finalized = true;
              sourceSeals++;
            },
          );
        }
        check();
        await input.transaction.query("SELECT owning_workforce_account", []);
        await sourceReadHook();
        if (failSource) throw new Error("PRIVATE_SOURCE_FAILURE");
        check();
        return actor;
      } catch (error) {
        poisoned = true;
        throw error;
      }
    };
    return {
      resolveVerifiedSubject: vi.fn(read),
      currentActor: vi.fn(read),
      assertFinalized() {
        if (!finalized || poisoned) throw new Error("SOURCE_NOT_FINALIZED");
      },
    };
  });
  const identity = createCognitoWorkforceIdentity(options),
    read = (tx: Transaction) =>
      identity.currentActor(tx, String(actor.actorReference), original, at),
    resolve = () => {
      const providerOptions = ports.provider.mock.calls[0]?.[0] as CognitoWorkforceProviderOptions;
      return providerOptions.resolveVerifiedSubject({
        issuer: options.configuration.issuer,
        clientId: options.configuration.clientId,
        subject: "opaque-synthetic-subject",
        authenticatedAt: original,
        observedAt: original,
      });
    };
  return {
    identity,
    options,
    transactions,
    events,
    queries,
    runHost,
    read,
    resolve,
    wrapHost: <T>(tx: Transaction, work: (wrapped: Transaction) => Promise<T>) => runHost(work, tx),
    time: (value: string) => {
      at = value;
    },
    skipAsync: () => {
      skipAsync = true;
    },
    skipFinal: () => {
      skipFinal = true;
    },
    delayReply: () => {
      delayReply = true;
    },
    skipSourceFinal: () => {
      skipSourceFinal = true;
    },
    failSource: () => {
      failSource = true;
    },
    failSourceGuard: () => {
      failedSourceGuard = true;
    },
    onRead: (hook: typeof sourceReadHook) => {
      sourceReadHook = hook;
    },
    onHostEntry: (hook: typeof hostEntryHook) => {
      hostEntryHook = hook;
    },
    beforeGuards: (hook: typeof beforeGuards) => {
      beforeGuards = hook;
    },
    sourceSeals: () => sourceSeals,
  };
}

describe("concrete Cognito Workforce Identity composition", () => {
  it("constructs the concrete Provider and maps already verified claims on a registered actual transaction", async () => {
    const f = fixture();
    expect(await f.resolve()).toBe(actor);
    expect(Object.keys(ports.provider.mock.calls[0]?.[0] as object)).toEqual([
      "configuration",
      "clock",
      "nextEvidenceReference",
      "resolveVerifiedSubject",
    ]);
    expect(ports.source).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: f.transactions[0],
        originalObservedAt: original,
        originalValidUntil: deadline,
        configuration: {
          environment: "synthetic",
          issuer: f.options.configuration.issuer,
          clientIds: ["syntheticclient"],
        },
      }),
    );
    expect(f.events).toEqual(["begin", "registered", "registered", "commit"]);
    expect(f.sourceSeals()).toBe(1);
    expect(Object.keys(f.identity)).toEqual(["provider", "transactions", "currentActor"]);
  });
  it("retains the signed observation across real transaction acquisition delay", async () => {
    const f = fixture();
    f.onHostEntry(() => f.time("2026-10-06T10:00:00.200Z"));
    expect(await f.resolve()).toBe(actor);
    expect(ports.source.mock.calls[0]?.[0]).toMatchObject({
      originalObservedAt: original,
      originalValidUntil: deadline,
    });
  });
  it("borrows a genuine independently wrapped host, caches only its exact admitted handle and seals it", async () => {
    const f = fixture();
    await f.runHost(async (tx) => {
      expect(await f.read(tx)).toBe(actor);
      expect(await f.read(tx)).toBe(actor);
    });
    expect(ports.source).toHaveBeenCalledTimes(1);
    expect(f.sourceSeals()).toBe(1);
    const tx = f.transactions[0];
    if (!tx) throw new Error("missing transaction");
    const calls = f.queries.mock.calls.length;
    await expect(f.read(tx)).rejects.toMatchObject(denied);
    expect(f.queries).toHaveBeenCalledTimes(calls);
  });
  it("guards its own outer transaction even when all reads use a separate nested wrapper", async () => {
    const f = fixture();
    const value = await f.identity.transactions.run(async (outer) =>
      f.wrapHost(outer, async (inner) => {
        expect(inner).not.toBe(outer);
        return f.read(inner);
      }),
    );
    expect(value).toBe(actor);
    expect(ports.source).toHaveBeenCalledTimes(1);
    expect(ports.source.mock.calls[0]?.[0].transaction).toBe(f.transactions[1]);
    expect(f.events).toEqual([
      "begin",
      "registered",
      "begin-wrapper",
      "registered",
      "registered",
      "sealed-wrapper",
      "commit",
    ]);
    expect(f.queries).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign, copied and never-admitted closed handles before source creation or SQL", async () => {
    const f = fixture(),
      foreign = { query: vi.fn() };
    await expect(f.read(foreign)).rejects.toMatchObject(denied);
    await f.identity.transactions.run(async (tx) => {
      await expect(f.read({ query: tx.query })).rejects.toMatchObject(denied);
    });
    const closed = f.transactions[0];
    if (!closed) throw new Error("missing transaction");
    await expect(f.read(closed)).rejects.toMatchObject(denied);
    expect(ports.source).not.toHaveBeenCalled();
    expect(f.queries).not.toHaveBeenCalled();
  });
  it.each(["async", "final"])("rejects a runner that omits its %s host guard", async (missing) => {
    const f = fixture();
    if (missing === "async") f.skipAsync();
    else f.skipFinal();
    await expect(f.identity.transactions.run(f.read)).rejects.toMatchObject(denied);
  });
  it("uses only pure state/source seals after the committed reply is delayed", async () => {
    const f = fixture();
    f.delayReply();
    expect(await f.identity.transactions.run(f.read)).toBe(actor);
    expect(f.events.at(-1)).toBe("commit");
    expect(f.sourceSeals()).toBe(1);
  });
  it("requires the actual source seal in addition to its composition guard", async () => {
    const f = fixture();
    f.skipSourceFinal();
    await expect(f.identity.transactions.run(f.read)).rejects.toMatchObject(denied);
    expect(f.sourceSeals()).toBe(0);
  });
  it("poisons the actual transaction when callers catch an owning source failure", async () => {
    const f = fixture();
    f.failSource();
    await expect(
      f.runHost(async (tx) => {
        await expect(f.read(tx)).rejects.toMatchObject(denied);
      }),
    ).rejects.toThrow();
    expect(f.events.at(-1)).toBe("rollback");
  });
  it("registers refusal before a source constructor failure or malformed first observation", async () => {
    const f = fixture();
    ports.source.mockImplementation(() => {
      throw new Error("private construction failure");
    });
    await expect(
      f.runHost(async (tx) => {
        await expect(f.read(tx)).rejects.toMatchObject(denied);
      }),
    ).rejects.toThrow();
    expect(f.events).toEqual(["begin", "registered", "rollback"]);
    const malformed = fixture();
    await expect(
      malformed.runHost(async (tx) => {
        await expect(
          malformed.identity.currentActor(tx, String(actor.actorReference), original, "invalid"),
        ).rejects.toMatchObject(denied);
      }),
    ).rejects.toThrow();
    expect(malformed.events).toEqual(["begin", "registered", "rollback"]);
  });
  it.each(["clock", "query", "configuration", "register", "hasher", "evidence"])(
    "refuses captured %s drift at the real before-COMMIT guard",
    async (port) => {
      const f = fixture();
      await expect(
        f.identity.transactions.run(async (tx) => {
          await f.read(tx);
          f.beforeGuards(() => {
            if (port === "clock") f.time(deadline);
            if (port === "query") tx.query = vi.fn();
            if (port === "configuration")
              Reflect.set(f.options.configuration, "clientId", "changed");
            if (port === "register") Reflect.set(f.options, "registerBeforeCommit", vi.fn());
            if (port === "hasher") f.options.hasher.hash = vi.fn();
            if (port === "evidence") Reflect.set(f.options, "nextEvidenceReference", vi.fn());
          });
        }),
      ).rejects.toMatchObject(denied);
      expect(f.events.at(-1)).toBe("rollback");
    },
  );
  it("keeps a finite guard without an account read and rejects late source withdrawal", async () => {
    const empty = fixture();
    empty.beforeGuards(() => empty.time(deadline));
    await expect(empty.identity.transactions.run(async () => "prepared")).rejects.toMatchObject(
      denied,
    );
    expect(empty.events.at(-1)).toBe("rollback");
    const source = fixture();
    source.failSourceGuard();
    await expect(source.identity.transactions.run(source.read)).rejects.toMatchObject(denied);
    expect(source.events.at(-1)).toBe("rollback");
  });
  it("refuses a replaced run port before invoking it or doing SQL", async () => {
    const f = fixture(),
      replacement = vi.fn();
    f.options.transactions.run = replacement;
    await expect(f.identity.transactions.run(f.read)).rejects.toMatchObject(denied);
    expect(replacement).not.toHaveBeenCalled();
    expect(f.queries).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("rollback");
  });
  it("poisons a caught callback failure and an original deadline consumed by later nested work", async () => {
    const f = fixture();
    await expect(
      f.identity.transactions.run(async () => {
        throw new Error("private work failure");
      }),
    ).rejects.toMatchObject(denied);
    expect(f.events.at(-1)).toBe("rollback");
    const nested = fixture();
    await expect(
      nested.identity.transactions.run(async (outer) => {
        await nested.wrapHost(outer, nested.read);
        nested.time(deadline);
      }),
    ).rejects.toMatchObject(denied);
    expect(nested.events.at(-1)).toBe("rollback");
  });
  it("requires one owning runner callback and poisons a swallowed duplicate invocation", async () => {
    const f = fixture(),
      repeated = createCognitoWorkforceIdentity({
        ...f.options,
        transactions: {
          run: (work) =>
            f.runHost(async (tx) => {
              const result = await work(tx);
              await expect(work(tx)).rejects.toMatchObject(denied);
              return result;
            }),
        },
      });
    await expect(repeated.transactions.run(async () => "prepared")).rejects.toMatchObject(denied);
    expect(f.events.at(-1)).toBe("rollback");
    const skipped = createCognitoWorkforceIdentity({
      ...f.options,
      transactions: {
        async run<T>(): Promise<T> {
          throw new Error("HOST_CALLBACK_NOT_RUN");
        },
      },
    });
    await expect(skipped.transactions.run(async () => "prepared")).rejects.toMatchObject(denied);
  });
  it("closes production configuration against transport, directory or Provider-verdict overrides", () => {
    const f = fixture();
    for (const extra of [
      { http: vi.fn() },
      { currentActor: vi.fn() },
      { provider: {} },
      { readCurrentProviderSubject: vi.fn() },
      { resolveVerifiedSubject: vi.fn() },
    ])
      expect(() => createCognitoWorkforceIdentity({ ...f.options, ...extra })).toThrow();
    expect(() =>
      createCognitoWorkforceIdentity({
        ...f.options,
        configuration: {
          ...f.options.configuration,
          accountKind: "Platform",
        },
      } as never),
    ).toThrow();
  });
});
