import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createIdentityActor,
  createPostgresBrowserSessionStore,
  createPostgresCurrentPlatformBrowserSessionSource,
  createPostgresPlatformBrowserSessionStore,
  parseCanonicalInstant,
  parseRawBrowserCredential,
  parseSelectorHash,
  PlatformBrowserSessionService,
  type BrowserCredentialGeneratorPort,
  type BrowserCredentialHasherPort,
  type OidcAuthorizationTransaction,
  type PlatformOidcProviderPort,
  type SessionEnvelopeCryptoPort,
} from "../index.js";

const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const initial = "2026-09-10T10:00:00.000Z";
const configuration = {
  environment: "synthetic",
  issuer: "https://identity.invalid/",
  clientId: "synthetic-platform",
  redirectUri: "https://platform.invalid/platform/callback",
  allowedPostLoginPaths: ["/platform/tenants"],
};
type Row = Record<string, unknown>;
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : NaN);

/** Controlled local Provider, directory, clock and SQL runner. AES-GCM and the owning
 * production Session/OIDC stores are real; this is not deployed Provider evidence. */
function fixture() {
  let at = initial,
    activeActor = true,
    actorKind = "Platform",
    counter = 1,
    uuid = 20,
    nonce = 1,
    proofCounter = 200,
    lag = 0,
    failInsert = false,
    withdrawAfterInsert = false,
    logoutConfirmed = true,
    logoutUrl =
      "https://identity.invalid/logout?client_id=synthetic-platform&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Fsigned-out";
  let authorizations = new Map<string, Row>(),
    sessions = new Map<string, Row>();
  const requests: Parameters<PlatformOidcProviderPort["createAuthorizationUrl"]>[0][] = [];
  const patch: {
    exchange?: (
      value: Awaited<ReturnType<PlatformOidcProviderPort["exchangeCode"]>>,
    ) => Awaited<ReturnType<PlatformOidcProviderPort["exchangeCode"]>>;
  } = {};
  const credentials: BrowserCredentialGeneratorPort = {
    generate: () => parseRawBrowserCredential(Buffer.alloc(32, counter++).toString("base64url")),
    generateUuidV7: () => id(uuid++),
  };
  const hasher: BrowserCredentialHasherPort = {
    hash: (value) =>
      parseSelectorHash(createHmac("sha256", Buffer.alloc(32, 51)).update(value).digest("hex")),
    equals: (a, b) => a === b,
  };
  const key = Buffer.alloc(32, 43);
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(plaintext, encryptionContext) {
      const iv = Buffer.alloc(12, nonce++),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(encryptionContext));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "synthetic-ephemeral-only",
        ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url"),
        encryptionContext,
      };
    },
    async decrypt(envelope, context) {
      if (context !== envelope.encryptionContext) throw new Error("synthetic AAD mismatch");
      const packed = Buffer.from(envelope.ciphertext, "base64url"),
        decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(packed.subarray(12, 28));
      return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
  const currentActor = vi.fn(
    async (_tx: OidcAuthorizationTransaction, reference: string, authenticatedAt: string) => {
      if (!activeActor) throw new Error("synthetic withdrawn actor");
      return createIdentityActor({
        actorType: "User",
        actorReference: reference,
        accountKind: actorKind,
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      });
    },
  );
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.startsWith("LOCK TABLE")) return { rows: [] };
    if (sql.startsWith("INSERT INTO bop_identity.oidc_authorization_transaction")) {
      authorizations.set(String(values[1]), {
        transaction_id: values[0],
        state_selector_hash: Buffer.from(String(values[1]), "hex"),
        auth_cookie_selector_hash: Buffer.from(String(values[2]), "hex"),
        encrypted_secret: values[3],
        cipher_algorithm: values[4],
        key_reference: values[5],
        encryption_context: values[6],
        redirect_uri: values[7],
        post_login_path: values[8],
        created_at: new Date(String(values[9])),
        expires_at: new Date(String(values[10])),
        consumed_at: null,
        version: 1,
      });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE bop_identity.oidc_authorization_transaction")) {
      const row = authorizations.get(String(values[0]));
      if (
        !row ||
        Buffer.from(row.auth_cookie_selector_hash as Uint8Array).toString("hex") !== values[1] ||
        row.consumed_at !== null ||
        ms(row.created_at) > Date.parse(String(values[2])) ||
        ms(row.expires_at) <= Date.parse(String(values[2]))
      )
        return { rows: [] };
      row.consumed_at = new Date(String(values[2]));
      row.version = 2;
      return { rows: [row] };
    }
    if (sql.startsWith("SELECT * FROM bop_identity.authentication_session")) {
      const row = sessions.get(String(values[0]));
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith("SELECT session_id,created_at")) {
      return {
        rows: [...sessions.values()]
          .filter(
            (r) =>
              r.actor_id === values[0] &&
              r.status === "Active" &&
              ms(r.idle_expires_at) > Date.parse(String(values[1])) &&
              ms(r.absolute_expires_at) > Date.parse(String(values[1])),
          )
          .sort((a, b) => ms(a.created_at) - ms(b.created_at))
          .map((r) => ({ ...r, exact_created_at: true })),
      };
    }
    if (sql.startsWith("INSERT INTO bop_identity.authentication_session")) {
      if (failInsert) throw new Error("synthetic insertion failure");
      sessions.set(String(values[2]), {
        session_id: values[0],
        actor_id: values[1],
        session_selector_hash: Buffer.from(String(values[2]), "hex"),
        csrf_selector_hash: Buffer.from(String(values[3]), "hex"),
        policy_code: values[4],
        status: "Active",
        encrypted_secret: values[5],
        cipher_algorithm: values[6],
        key_reference: values[7],
        encryption_context: values[8],
        authenticated_at: new Date(String(values[9])),
        created_at: new Date(String(values[10])),
        last_seen_at: new Date(String(values[11])),
        idle_expires_at: new Date(String(values[12])),
        absolute_expires_at: new Date(String(values[13])),
        rotated_from_session_id: values[14],
        version: values[15],
        revocation_reason: null,
        revoked_at: null,
      });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE bop_identity.authentication_session SET status='Revoked'")) {
      const row = [...sessions.values()].find((r) => r.session_id === values[0]);
      if (!row) throw new Error("synthetic row missing");
      row.status = "Revoked";
      row.version = Number(row.version) + 1;
      row.revocation_reason = sql.includes("ConcurrentLimit")
        ? "ConcurrentLimit"
        : sql.includes("RiskChange")
          ? "RiskChange"
          : values[1];
      row.revoked_at = new Date(String(values[sql.includes("revocation_reason=$2") ? 2 : 1]));
      return { rows: [] };
    }
    throw new Error("unexpected synthetic SQL");
  });
  const tx: OidcAuthorizationTransaction = { query };
  const transactions = {
    async run<T>(work: (tx: OidcAuthorizationTransaction) => Promise<T>): Promise<T> {
      const beforeSessions = structuredClone(sessions),
        beforeAuthorizations = structuredClone(authorizations);
      try {
        return await work(tx);
      } catch (error) {
        sessions = beforeSessions;
        authorizations = beforeAuthorizations;
        throw error;
      }
    },
  };
  const options = {
    ...configuration,
    transactions,
    now: () => at,
    envelopes,
    hasher,
    currentActor,
    onSessionCreated: async () => {
      if (withdrawAfterInsert) activeActor = false;
    },
  };
  const store = createPostgresPlatformBrowserSessionStore(options);
  const provider: PlatformOidcProviderPort = {
    createAuthorizationUrl: vi.fn(async (request) => {
      requests.push(request);
      return "https://identity.invalid/authorize";
    }),
    exchangeCode: vi.fn(async (request) => {
      const authenticatedAt = parseCanonicalInstant(at),
        verifiedAt = parseCanonicalInstant(new Date(Date.parse(at) - lag).toISOString());
      const result = {
        actor: createIdentityActor({
          actorType: "User",
          actorReference: id(1),
          accountKind: "Platform",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "RecentMfa",
          authenticatedAt,
          recentMfaAt: verifiedAt,
        }),
        tokenBundle: "synthetic-provider-token-bundle",
        totp: {
          method: "Totp" as const,
          timestampPrecision: "Millisecond" as const,
          evidenceReference: id(proofCounter++),
          actorReference: id(1),
          issuer: request.issuer,
          clientId: request.clientId,
          nonce: request.nonce,
          authorizationTransactionReference: request.transactionReference,
          authenticatedAt,
          verifiedAt,
        },
      };
      return patch.exchange ? patch.exchange(result) : result;
    }),
    revokeRefreshTokens: vi.fn(async () => (logoutConfirmed ? "confirmed" : "unknown")),
    createLogoutUrl: vi.fn(() => logoutUrl),
  };
  const service = new PlatformBrowserSessionService({
    configuration,
    store,
    provider,
    credentials,
    hasher,
    envelopes,
    pkce: { challenge: (v) => createHash("sha256").update(v).digest("base64url") },
    now: () => at,
  });
  const readCurrent = createPostgresCurrentPlatformBrowserSessionSource(options);
  const callback = async (authCookie: string) => {
    const request = requests.at(-1);
    if (!request) throw new Error("synthetic request missing");
    return service.callback({ code: "synthetic-code", state: request.state, authCookie });
  };
  const login = async () => {
    const started = await service.start("/platform/tenants"),
      result = await callback(started.cookie.value),
      cookie = result.cookies[1]?.value;
    if (!cookie) throw new Error("synthetic cookie missing");
    return { result, cookie, bootstrap: await service.bootstrap(cookie) };
  };
  return {
    service,
    store,
    provider,
    requests,
    options,
    tx,
    query,
    envelopes,
    hasher,
    patch,
    callback,
    login,
    current: (cookie: unknown) => readCurrent(tx, cookie),
    rows: () => [...sessions.values()],
    authorizations: () => [...authorizations.values()],
    clock: (value: string) => {
      at = value;
    },
    lag: (value: number) => {
      lag = value;
    },
    withdraw: () => {
      activeActor = false;
    },
    workforce: () => {
      actorKind = "Workforce";
    },
    failInsert: () => {
      failInsert = true;
    },
    withdrawAfterInsert: () => {
      withdrawAfterInsert = true;
    },
    logoutUnknown: () => {
      logoutConfirmed = false;
    },
    logoutConfirmed: () => {
      logoutConfirmed = true;
    },
    logoutUrl: (value: string) => {
      logoutUrl = value;
    },
  };
}

describe("Platform encrypted browser Session", () => {
  it.each([
    {
      startedAt: "2026-09-10T10:00:00.999Z",
      signedAt: initial,
      callbackAt: "2026-09-10T10:00:01.000Z",
    },
    {
      startedAt: "2026-09-10T10:00:00.500Z",
      signedAt: "2026-09-10T10:00:01.000Z",
      callbackAt: "2026-09-10T10:00:01.200Z",
    },
  ])(
    "accepts genuine second precision overlapping or following request start %j",
    async (times) => {
      const f = fixture();
      f.clock(times.startedAt);
      const started = await f.service.start("/platform/tenants");
      f.clock(times.callbackAt);
      f.patch.exchange = (result) => ({
        ...result,
        actor: createIdentityActor({
          ...result.actor,
          authenticatedAt: times.signedAt,
          recentMfaAt: times.signedAt,
        }),
        totp: {
          ...result.totp,
          timestampPrecision: "Second",
          authenticatedAt: parseCanonicalInstant(times.signedAt),
          verifiedAt: parseCanonicalInstant(times.signedAt),
        },
      });
      const result = await f.callback(started.cookie.value),
        bootstrap = await f.service.bootstrap(result.cookies[1]?.value);
      expect(result.session.authenticatedAt).toBe(times.signedAt);
      expect(bootstrap.recentMfa.verifiedAt).toBe(times.signedAt);
      expect(bootstrap.recentMfa.validUntil).toBe(
        new Date(Date.parse(times.signedAt) + 900_000).toISOString(),
      );
      expect(bootstrap.recentMfa).not.toHaveProperty("timestampPrecision");
      expect(result.session).not.toHaveProperty("timestampPrecision");
    },
  );
  it.each([
    {
      precision: "Second",
      startedAt: initial,
      verifiedAt: "2026-09-10T09:59:59.000Z",
      authenticatedAt: "2026-09-10T09:59:59.000Z",
      callbackAt: initial,
    },
    {
      precision: "Second",
      startedAt: "2026-09-10T10:00:01.000Z",
      verifiedAt: initial,
      authenticatedAt: initial,
      callbackAt: "2026-09-10T10:00:01.000Z",
    },
    {
      precision: "Second",
      startedAt: "2026-09-10T10:00:00.500Z",
      verifiedAt: "2026-09-10T10:00:01.000Z",
      authenticatedAt: "2026-09-10T10:00:01.000Z",
      callbackAt: "2026-09-10T10:00:00.800Z",
    },
    {
      precision: "Second",
      startedAt: initial,
      verifiedAt: "2026-09-10T10:00:00.001Z",
      authenticatedAt: "2026-09-10T10:00:00.001Z",
      callbackAt: "2026-09-10T10:00:00.800Z",
    },
    {
      precision: "Second",
      startedAt: initial,
      verifiedAt: initial,
      authenticatedAt: "2026-09-10T10:00:01.000Z",
      callbackAt: "2026-09-10T10:00:01.200Z",
    },
    {
      precision: "Millisecond",
      startedAt: "2026-09-10T10:00:00.500Z",
      verifiedAt: initial,
      authenticatedAt: initial,
      callbackAt: "2026-09-10T10:00:00.800Z",
    },
    {
      precision: "Unknown",
      startedAt: initial,
      verifiedAt: initial,
      authenticatedAt: initial,
      callbackAt: initial,
    },
    {
      precision: null,
      startedAt: initial,
      verifiedAt: initial,
      authenticatedAt: initial,
      callbackAt: initial,
    },
  ])("refuses stale, future, fabricated or mismatched proof precision %j", async (times) => {
    const f = fixture();
    f.clock(times.startedAt);
    const started = await f.service.start("/platform/tenants");
    f.clock(times.callbackAt);
    f.patch.exchange = (result) => {
      const changed = {
        ...result,
        actor: createIdentityActor({
          ...result.actor,
          authenticatedAt: times.authenticatedAt,
          recentMfaAt: times.verifiedAt,
        }),
        totp: {
          ...result.totp,
          authenticatedAt: parseCanonicalInstant(times.authenticatedAt),
          verifiedAt: parseCanonicalInstant(times.verifiedAt),
        },
      };
      if (times.precision === null) Reflect.deleteProperty(changed.totp, "timestampPrecision");
      else Reflect.set(changed.totp, "timestampPrecision", times.precision);
      return changed;
    };
    await expect(f.callback(started.cookie.value)).rejects.toThrow("request denied");
    expect(f.rows()).toHaveLength(0);
  });
  it("uses dedicated cookies/AAD, actual Platform Actor, fixed privileged policy and same-session TOTP", async () => {
    const f = fixture(),
      { result, cookie, bootstrap } = await f.login();
    expect(f.requests[0]).toMatchObject({
      prompt: "login",
      requireTotp: true,
      codeChallengeMethod: "S256",
    });
    expect(result.cookies.map((c) => c.descriptor.name)).toEqual([
      "__Host-bop-platform-auth",
      "__Host-bop-platform",
    ]);
    expect(result.session.actor).toMatchObject({
      accountKind: "Platform",
      verificationLevel: "SingleFactor",
    });
    expect("rotateSession" in f.store).toBe(false);
    expect(result.session.policy).toMatchObject({
      code: "Privileged",
      maxActiveSessions: 2,
      idleTimeoutMinutes: 15,
      absoluteTimeoutMinutes: 480,
    });
    expect(bootstrap.recentMfa.sessionReference).toBe(result.session.sessionReference);
    expect(bootstrap.recentMfa.validUntil).toBe("2026-09-10T10:15:00.000Z");
    expect(f.rows()[0]?.encryption_context).toContain(":platform-session:");
    expect(f.authorizations()[0]?.encryption_context).toContain(":platform-oidc:");
    const packet = await f.current(cookie);
    expect(packet.validUntil).toBe("2026-09-10T10:00:05.000Z");
    expect(JSON.stringify(packet)).not.toMatch(/tokenBundle|csrf|synthetic-provider-token-bundle/u);
    expect(f.query.mock.calls.some(([sql]) => sql.endsWith("FOR SHARE"))).toBe(true);
    expect(
      f.query.mock.calls.some(([sql]) =>
        sql.includes("authenticated_at=date_trunc('milliseconds',authenticated_at)"),
      ),
    ).toBe(true);
    await expect(
      createPostgresBrowserSessionStore(f.options).resolveSession(
        f.hasher.hash(parseRawBrowserCredential(cookie)),
      ),
    ).rejects.toThrow("request denied");
  });
  it("consumes OIDC once, rejects public policy injection, and never calls provider for invalid callback shape", async () => {
    const f = fixture(),
      started = await f.service.start("/platform/tenants"),
      request = f.requests[0];
    if (!request) throw new Error("synthetic request missing");
    await expect(
      f.service.callback({
        code: "synthetic",
        state: request.state,
        authCookie: started.cookie.value,
        policyCode: "Privileged",
      }),
    ).rejects.toThrow("request denied");
    expect(f.provider.exchangeCode).not.toHaveBeenCalled();
    await f.callback(started.cookie.value);
    await expect(f.callback(started.cookie.value)).rejects.toThrow("request denied");
    expect(f.provider.exchangeCode).toHaveBeenCalledTimes(1);
  });
  it.each([
    "no proof",
    "nonce",
    "issuer",
    "client",
    "Actor",
    "transaction",
    "enrollment",
    "before challenge",
    "future",
  ])("refuses %s as fresh TOTP evidence", async (kind) => {
    const f = fixture();
    f.patch.exchange = (r) => {
      if (kind === "no proof") return Object.assign(r, { totp: undefined });
      const changes: Record<string, unknown> =
        kind === "nonce"
          ? { nonce: "z".repeat(43) }
          : kind === "issuer"
            ? { issuer: "https://foreign.invalid/" }
            : kind === "client"
              ? { clientId: "foreign-client" }
              : kind === "Actor"
                ? { actorReference: id(9) }
                : kind === "transaction"
                  ? { authorizationTransactionReference: id(9) }
                  : kind === "enrollment"
                    ? { method: "TotpEnrolled" }
                    : kind === "before challenge"
                      ? { verifiedAt: "2026-09-10T09:59:00.000Z" }
                      : { verifiedAt: "2026-09-10T10:01:00.000Z" };
      Object.assign(r.totp, changes);
      return r;
    };
    const started = await f.service.start("/platform/tenants");
    await expect(f.callback(started.cookie.value)).rejects.toThrow("request denied");
    expect(f.rows()).toHaveLength(0);
  });
  it("replaces old Session and actual authentication time atomically after a fresh challenge", async () => {
    const f = fixture(),
      old = await f.login();
    f.clock("2026-09-10T10:01:00.000Z");
    const start = await f.service.startStepUp({
      sessionCookie: old.cookie,
      csrf: old.bootstrap.csrf,
      postLoginPath: "/platform/tenants",
    });
    const next = await f.callback(start.cookie.value),
      cookie = next.cookies[1]?.value;
    expect(next.session.authenticatedAt).toBe("2026-09-10T10:01:00.000Z");
    expect(next.session.rotatedFromSessionReference).toBe(old.result.session.sessionReference);
    expect(f.rows().find((r) => r.session_id === old.result.session.sessionReference)?.status).toBe(
      "Revoked",
    );
    await expect(f.service.bootstrap(old.cookie)).rejects.toThrow("request denied");
    const current = await f.current(cookie);
    expect(current.recentMfa.sessionReference).toBe(next.session.sessionReference);
    expect(current.recentMfa.authorizationTransactionReference).not.toBe(
      old.bootstrap.recentMfa.authorizationTransactionReference,
    );
  });
  it.each(["insert", "Actor withdrawn"])(
    "rolls old revocation back when %s fails before commit",
    async (failure) => {
      const f = fixture(),
        old = await f.login();
      const start = await f.service.startStepUp({
        sessionCookie: old.cookie,
        csrf: old.bootstrap.csrf,
        postLoginPath: "/platform/tenants",
      });
      if (failure === "insert") f.failInsert();
      else f.withdrawAfterInsert();
      await expect(f.callback(start.cookie.value)).rejects.toThrow("request denied");
      expect(f.rows()).toHaveLength(1);
      expect(f.rows()[0]?.status).toBe("Active");
      expect(f.rows()[0]?.version).toBe(1);
    },
  );
  it("allows expired MFA bootstrap and fresh stepup, but refuses current authority and actions", async () => {
    const f = fixture(),
      start = await f.service.start("/platform/tenants");
    f.clock("2026-09-10T10:02:00.000Z");
    f.lag(60_000);
    const first = await f.callback(start.cookie.value),
      cookie = first.cookies[1]?.value;
    f.clock("2026-09-10T10:15:58.000Z");
    expect((await f.current(cookie)).validUntil).toBe("2026-09-10T10:16:00.000Z");
    f.clock("2026-09-10T10:16:00.000Z");
    const bootstrap = await f.service.bootstrap(cookie);
    expect(bootstrap.recentMfaRequired).toBe(true);
    await expect(f.current(cookie)).rejects.toThrow("request denied");
    await expect(
      f.service.authorize({ sessionCookie: cookie, csrf: bootstrap.csrf }),
    ).rejects.toThrow("request denied");
    f.lag(0);
    const step = await f.service.startStepUp({
      sessionCookie: cookie,
      csrf: bootstrap.csrf,
      postLoginPath: "/platform/tenants",
    });
    const next = await f.callback(step.cookie.value);
    expect((await f.current(next.cookies[1]?.value)).recentMfa.verifiedAt).toBe(
      "2026-09-10T10:16:00.000Z",
    );
  });
  it("denies reused old proof, cross-Actor callback and wrong CSRF", async () => {
    const f = fixture(),
      old = await f.login();
    await expect(
      f.service.startStepUp({
        sessionCookie: old.cookie,
        csrf: "z".repeat(43),
        postLoginPath: "/platform/tenants",
      }),
    ).rejects.toThrow("request denied");
    const start = await f.service.startStepUp({
      sessionCookie: old.cookie,
      csrf: old.bootstrap.csrf,
      postLoginPath: "/platform/tenants",
    });
    f.patch.exchange = (r) => ({
      ...r,
      totp: { ...r.totp, evidenceReference: old.bootstrap.recentMfa.evidenceReference },
    });
    await expect(f.callback(start.cookie.value)).rejects.toThrow("request denied");
    expect(f.rows()[0]?.status).toBe("Active");
    const second = await f.service.startStepUp({
      sessionCookie: old.cookie,
      csrf: old.bootstrap.csrf,
      postLoginPath: "/platform/tenants",
    });
    f.patch.exchange = (r) => ({
      ...r,
      actor: createIdentityActor({ ...r.actor, actorReference: id(9) }),
      totp: { ...r.totp, actorReference: id(9) },
    });
    await expect(f.callback(second.cookie.value)).rejects.toThrow("request denied");
  });
  it("revokes locally before refresh retries and requires browser logout after server confirmation", async () => {
    const f = fixture(),
      old = await f.login();
    f.logoutUnknown();
    expect(await f.service.logout({ sessionCookie: old.cookie, csrf: old.bootstrap.csrf })).toEqual(
      { status: "Unknown", cookies: [], browserLogoutUrl: null },
    );
    await expect(f.current(old.cookie)).rejects.toThrow();
    await expect(f.service.bootstrap(old.cookie)).rejects.toThrow();
    await expect(
      f.service.authorize({ sessionCookie: old.cookie, csrf: old.bootstrap.csrf }),
    ).rejects.toThrow();
    expect(f.provider.createLogoutUrl).not.toHaveBeenCalled();
    expect(f.rows()[0]?.status).toBe("Revoked");
    f.logoutConfirmed();
    const result = await f.service.logout({ sessionCookie: old.cookie, csrf: old.bootstrap.csrf });
    expect(result.status).toBe("BrowserLogoutRequired");
    expect(result.browserLogoutUrl).toBe(
      "https://identity.invalid/logout?client_id=synthetic-platform&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Fsigned-out",
    );
    expect(f.provider.createLogoutUrl).toHaveBeenCalledWith();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cookies)).toBe(true);
    expect(Object.keys(result).sort()).toEqual(["browserLogoutUrl", "cookies", "status"]);
    expect(f.provider.revokeRefreshTokens).toHaveBeenCalledTimes(2);
    expect(result.cookies[0]).toMatchObject({
      descriptor: { name: "__Host-bop-platform" },
      value: "",
      clear: true,
    });
  });
  it.each([
    "http://identity.invalid/logout",
    "https://user:secret@identity.invalid/logout",
    "https://identity.invalid/logout#credential",
  ])(
    "rejects unsafe browser logout URL %s after local revocation without a clear-cookie result",
    async (url) => {
      const f = fixture(),
        old = await f.login();
      f.logoutUrl(url);
      await expect(
        f.service.logout({ sessionCookie: old.cookie, csrf: old.bootstrap.csrf }),
      ).rejects.toThrow("request denied");
      expect(f.rows()[0]?.status).toBe("Revoked");
      await expect(f.current(old.cookie)).rejects.toThrow("request denied");
      expect(f.provider.revokeRefreshTokens).toHaveBeenCalledTimes(1);
    },
  );
  it("enforces two current privileged Sessions and revokes the oldest", async () => {
    const f = fixture(),
      first = await f.login();
    f.clock("2026-09-10T10:00:01.000Z");
    await f.login();
    f.clock("2026-09-10T10:00:02.000Z");
    await f.login();
    expect(f.rows().filter((r) => r.status === "Active")).toHaveLength(2);
    await expect(f.current(first.cookie)).rejects.toThrow();
    expect(f.rows()[0]?.revocation_reason).toBe("ConcurrentLimit");
  });
  it.each(["revoked", "Workforce", "ciphertext", "AAD", "policy"])(
    "refuses actual current %s drift",
    async (drift) => {
      const f = fixture(),
        old = await f.login(),
        row = f.rows()[0];
      if (!row) throw new Error("synthetic row missing");
      if (drift === "revoked") f.withdraw();
      if (drift === "Workforce") f.workforce();
      if (drift === "ciphertext") row.encrypted_secret = Buffer.alloc(50, 17);
      if (drift === "AAD")
        row.encryption_context = String(row.encryption_context).replace(
          "platform-session",
          "session",
        );
      if (drift === "policy") row.policy_code = "WorkforceStandard";
      await expect(f.current(old.cookie)).rejects.toThrow("request denied");
    },
  );
  it("refuses original transaction replacement and expiry during current-Actor reread", async () => {
    const f = fixture(),
      old = await f.login(),
      original = f.options.currentActor;
    original.mockImplementationOnce(async (_tx, reference, authenticatedAt) => {
      f.tx.query = async () => ({ rows: [] });
      return createIdentityActor({
        actorType: "User",
        actorReference: reference,
        accountKind: "Platform",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      });
    });
    await expect(f.current(old.cookie)).rejects.toThrow("request denied");
    const g = fixture(),
      next = await g.login();
    g.options.currentActor.mockImplementationOnce(async (_tx, reference, authenticatedAt) => {
      g.clock("2026-09-10T10:00:05.000Z");
      return createIdentityActor({
        actorType: "User",
        actorReference: reference,
        accountKind: "Platform",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt,
        recentMfaAt: null,
      });
    });
    await expect(g.current(next.cookie)).rejects.toThrow("request denied");
  });
});
