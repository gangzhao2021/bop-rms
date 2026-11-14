import { Buffer } from "node:buffer";
import { once } from "node:events";
import { request as httpRequest, type Server, type IncomingHttpHeaders } from "node:http";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import {
  BrowserSessionError,
  createAuthenticationSession,
  createIdentityActor,
  parseCanonicalInstant,
  parsePlatformSessionMfa,
  parseRawBrowserCredential,
  platformAuthorizationCookie,
  platformSessionCookie,
} from "@bop/identity";
import {
  createPlatformAuthenticationRouter,
  platformAuthenticationRoutes,
  type PlatformAuthenticationHttpOptions,
} from "./platform-authentication-http.js";

// Real Express/router transport with controlled owning-service outputs. Actual
// owner composition is exercised by the runtime pair and separate native gate.
const id = (n: number) => `01902627-0011-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const credential = parseRawBrowserCredential(Buffer.alloc(32, 2).toString("base64url")),
  csrf = parseRawBrowserCredential(Buffer.alloc(32, 3).toString("base64url")),
  stateToken = parseRawBrowserCredential(Buffer.alloc(32, 4).toString("base64url"));
const logoutUrl =
  "https://identity.invalid/logout?client_id=synthetic-platform&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(1),
  accountKind: "Platform",
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
  idleExpiresAt: "2026-10-06T12:15:00.000Z",
  absoluteExpiresAt: "2026-10-06T20:00:00.000Z",
  rotatedFromSessionReference: null,
  revocationReason: null,
  revokedAt: null,
});
const mfa = parsePlatformSessionMfa({
  sessionReference: session.sessionReference,
  actorReference: id(1),
  method: "Totp",
  evidenceReference: id(3),
  authorizationTransactionReference: id(4),
  authenticatedAt: at,
  verifiedAt: "2026-10-06T11:59:00.000Z",
  validUntil: "2026-10-06T12:14:00.000Z",
});
const authorizing = {
  authorizationUrl: "https://identity.invalid/authorize",
  cookie: { descriptor: platformAuthorizationCookie, value: credential, clear: false as const },
};
const clearAuth = {
  descriptor: platformAuthorizationCookie,
  value: "" as const,
  clear: true as const,
};
const sessionMutation = {
  descriptor: platformSessionCookie,
  value: credential,
  clear: false as const,
};
const browserLogout = {
  status: "BrowserLogoutRequired" as const,
  browserLogoutUrl: logoutUrl,
  cookies: [{ descriptor: platformSessionCookie, value: "" as const, clear: true as const }],
};
const bootstrap = {
  session,
  csrf,
  recentMfa: mfa,
  recentMfaRequired: false,
  observedAt: parseCanonicalInstant(at),
  validUntil: parseCanonicalInstant(until),
};

function fixture() {
  const service = {
    start: vi.fn(async () => authorizing),
    callback: vi.fn(async () => ({
      postLoginPath: "/platform/tenants",
      session,
      cookies: [clearAuth, sessionMutation],
    })),
    bootstrap: vi.fn(async () => bootstrap),
    startStepUp: vi.fn(async () => authorizing),
    logout: vi.fn(
      async (): ReturnType<PlatformAuthenticationHttpOptions["service"]["logout"]> => browserLogout,
    ),
  } satisfies PlatformAuthenticationHttpOptions["service"];
  const time = { now: at };
  const options: PlatformAuthenticationHttpOptions = {
    exactOrigin: "https://platform.invalid",
    acceptedHost: "platform.invalid",
    authorizationOrigin: "https://identity.invalid",
    logoutUrl,
    service,
    clock: { now: () => time.now },
  };
  return { options, service, time };
}
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function serve(options: PlatformAuthenticationHttpOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use("/platform/auth", createPlatformAuthenticationRouter(options));
  app.use((_request, response) => {
    response.status(404).json({ error: "not_found" });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("synthetic listener absent");
  return `http://127.0.0.1:${address.port}`;
}
interface RequestOptions {
  method?: string;
  body?: string;
  headers?: readonly (readonly [string, string])[];
  omit?: readonly string[];
}
async function send(root: string, path: string, options: RequestOptions = {}) {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST"),
    overrides = options.headers ?? [],
    names = new Set(overrides.map(([name]) => name.toLowerCase()));
  const base: [string, string][] = [
    ["Host", "platform.invalid"],
    ["Sec-Fetch-Site", "same-origin"],
    ["Origin", "https://platform.invalid"],
    ["Cookie", `${platformSessionCookie.name}=${credential}`],
    ["X-Bop-CSRF", csrf],
  ];
  if (options.body !== undefined)
    base.push(
      ["Content-Type", "application/json"],
      ["Content-Length", String(Buffer.byteLength(options.body))],
    );
  const headers = [
    ...base.filter(
      ([name]) =>
        name !== undefined &&
        !names.has(name.toLowerCase()) &&
        !options.omit?.includes(name.toLowerCase()),
    ),
    ...overrides,
  ].flat();
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: unknown; text: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        `${root}/platform/auth${path}`,
        { method, headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown;
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body, text });
          });
        },
      );
      request.on("error", reject);
      request.end(options.body);
    },
  );
}
const callbackPath = `/callback?code=synthetic-code&state=${stateToken}`;
const callbackHeaders = [
  ["Cookie", `${platformAuthorizationCookie.name}=${credential}`],
  ["Sec-Fetch-Site", "cross-site"],
] as const;

it("accepts a same-site trusted Provider callback while refusing same-site mutations", async () => {
  const f = fixture(),
    root = await serve({
      ...f.options,
      exactOrigin: "https://platform.example.com",
      acceptedHost: "platform.example.com",
      authorizationOrigin: "https://login.example.com",
      logoutUrl:
        "https://login.example.com/logout?client_id=synthetic-platform&logout_uri=https%3A%2F%2Fplatform.example.com%2Fplatform%2Ftenants",
    });
  const callback = await send(root, callbackPath, {
    omit: ["origin"],
    headers: [
      ["Host", "platform.example.com"],
      ["Sec-Fetch-Site", "same-site"],
      ["Cookie", `${platformAuthorizationCookie.name}=${credential}`],
    ],
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.location).toBe("/platform/tenants");
  expect(f.service.callback).toHaveBeenCalledWith({
    code: "synthetic-code",
    state: stateToken,
    authCookie: credential,
  });
  for (const path of ["/step-up", "/logout"]) {
    const refused = await send(root, path, {
      body: "{}",
      headers: [
        ["Host", "platform.example.com"],
        ["Origin", "https://platform.example.com"],
        ["Sec-Fetch-Site", "same-site"],
      ],
    });
    expect(refused.status).toBe(403);
  }
  expect(f.service.startStepUp).not.toHaveBeenCalled();
  expect(f.service.logout).not.toHaveBeenCalled();
});
it("refuses nonclosed or misdirected fixed logout configuration before serving", () => {
  const f = fixture();
  for (const url of [
    logoutUrl.replace("/logout?", "/other?"),
    logoutUrl.replace("platform.invalid", "foreign.invalid"),
    `${logoutUrl}&client_id=another-client`,
    `${logoutUrl}&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants`,
    `${logoutUrl}&state=unexpected`,
    logoutUrl.replace("client_id=synthetic-platform", "client_id="),
    logoutUrl.replace("client_id=synthetic-platform", "client_id=invalid%20client"),
  ])
    expect(() => createPlatformAuthenticationRouter({ ...f.options, logoutUrl: url })).toThrow();
  expect(f.service.logout).not.toHaveBeenCalled();
});

it("bounds login/callback to fixed destinations and serializes only dedicated secure cookies", async () => {
  const f = fixture(),
    root = await serve(f.options),
    started = await send(root, "/login");
  expect(started.status).toBe(303);
  expect(started.headers.location).toBe(authorizing.authorizationUrl);
  expect(started.headers["cache-control"]).toBe("no-store");
  expect(started.headers["referrer-policy"]).toBe("no-referrer");
  expect(started.headers["set-cookie"]).toEqual([
    `__Host-bop-platform-auth=${credential}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  ]);
  expect(f.service.start).toHaveBeenCalledExactlyOnceWith("/platform/tenants");
  const result = await send(root, callbackPath, { headers: callbackHeaders, omit: ["origin"] });
  expect(result.status).toBe(303);
  expect(result.headers.location).toBe("/platform/tenants");
  expect(result.headers["set-cookie"]).toEqual([
    "__Host-bop-platform-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    `__Host-bop-platform=${credential}; Path=/; Secure; HttpOnly; SameSite=Lax`,
  ]);
  expect(f.service.callback).toHaveBeenCalledExactlyOnceWith({
    code: "synthetic-code",
    state: stateToken,
    authCookie: credential,
  });
});
it("returns only authenticated Session/Actor/expiry/CSRF and permits expired-MFA bootstrap for stepup", async () => {
  const f = fixture(),
    root = await serve(f.options),
    response = await send(root, "/session");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    authenticated: true,
    session: {
      sessionReference: session.sessionReference,
      actorReference: actor.actorReference,
      expiresAt: session.idleExpiresAt,
    },
    recentMfaRequired: false,
    csrf,
  });
  for (const secret of [
    mfa.evidenceReference,
    mfa.authorizationTransactionReference,
    "permission",
    "tokenBundle",
    "recentMfaAt",
    "template",
    "workspace",
  ])
    expect(response.text).not.toContain(secret);
  f.time.now = mfa.validUntil;
  const expired = {
    ...bootstrap,
    observedAt: mfa.validUntil,
    validUntil: parseCanonicalInstant("2026-10-06T12:14:05.000Z"),
    recentMfaRequired: true,
  };
  f.service.bootstrap.mockResolvedValueOnce(expired);
  expect((await send(root, "/session")).body).toMatchObject({
    authenticated: true,
    recentMfaRequired: true,
  });
  const step = await send(root, "/step-up", { body: "{}" });
  expect(step.status).toBe(200);
  expect(step.body).toEqual({
    status: "step_up_required",
    authorizationUrl: authorizing.authorizationUrl,
  });
  expect(step.headers.location).toBeUndefined();
  expect(step.headers["cache-control"]).toBe("no-store");
  expect(step.headers["set-cookie"]).toEqual([
    `__Host-bop-platform-auth=${credential}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
  ]);
  expect(f.service.startStepUp).toHaveBeenCalledExactlyOnceWith({
    sessionCookie: credential,
    csrf,
    postLoginPath: "/platform/tenants",
  });
});
it("requires browser logout without claiming completion and preserves Unknown retry cookies", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.service.logout.mockResolvedValueOnce({
    status: "Unknown",
    cookies: [],
    browserLogoutUrl: null,
  });
  const pending = await send(root, "/logout", { body: "{}" });
  expect(pending.status).toBe(503);
  expect(pending.headers["set-cookie"]).toBeUndefined();
  expect(pending.body).toEqual({ error: "platform_authentication_unavailable" });
  const result = await send(root, "/logout", { body: "{}" });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ status: "browser_logout_required", logoutUrl });
  expect(result.headers.location).toBeUndefined();
  expect(result.headers["set-cookie"]).toEqual([
    "__Host-bop-platform=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
  ]);
  expect(f.service.logout).toHaveBeenCalledWith({ sessionCookie: credential, csrf });
});
it("closes query/body inputs, blocks HEAD and wrong methods, and avoids intercepting other routes", async () => {
  const f = fixture(),
    root = await serve(f.options);
  expect((await send(root, "/login?returnTo=%2Fplatform%2Fother")).status).toBe(400);
  expect((await send(root, "/session?permission=Allow")).status).toBe(400);
  expect((await send(root, "/step-up?extra=1", { body: "{}" })).status).toBe(400);
  expect(
    (await send(root, "/step-up", { body: '{"postLoginPath":"/platform/other"}' })).status,
  ).toBe(400);
  expect((await send(root, "/logout", { body: '{"sessionCookie":"forged"}' })).status).toBe(400);
  expect((await send(root, "/login", { method: "HEAD" })).status).toBe(405);
  expect((await send(root, "/session", { method: "HEAD" })).status).toBe(405);
  expect((await send(root, "/logout")).status).toBe(405);
  expect((await send(root, "/login", { body: "{}" })).status).toBe(405);
  expect((await send(root, "/session/")).status).toBe(404);
  expect((await send(root, "/tenants", { headers: [["Host", "foreign.invalid"]] })).status).toBe(
    404,
  );
  for (const port of Object.values(f.service)) expect(port).not.toHaveBeenCalled();
  expect(platformAuthenticationRoutes).toEqual([
    "/platform/auth/login",
    "/platform/auth/callback",
    "/platform/auth/session",
    "/platform/auth/step-up",
    "/platform/auth/logout",
  ]);
});
it("rejects malformed and oversized JSON and wrong content type without invoking mutation ports", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const body of ["{", "[]", "null", '{"unexpected":true}'])
    expect((await send(root, "/step-up", { body })).status).toBe(400);
  expect(
    (await send(root, "/step-up", { body: JSON.stringify({ oversized: "x".repeat(1200) }) }))
      .status,
  ).toBe(413);
  expect(
    (await send(root, "/logout", { body: "{}", headers: [["Content-Type", "text/plain"]] })).status,
  ).toBe(400);
  expect(f.service.startStepUp).not.toHaveBeenCalled();
  expect(f.service.logout).not.toHaveBeenCalled();
});
it("enforces actual trusted host/origin, single security headers/cookies, and current CSRF", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const headers of [
    [["Host", "foreign.invalid"]],
    [["Origin", "https://foreign.invalid"]],
    [["Sec-Fetch-Site", "cross-site"]],
    [
      ["Origin", "https://platform.invalid"],
      ["Origin", "https://platform.invalid"],
    ],
    [
      ["Host", "platform.invalid"],
      ["Host", "platform.invalid"],
    ],
    [
      ["X-Bop-CSRF", csrf],
      ["X-Bop-CSRF", csrf],
    ],
    [
      ["Sec-Fetch-Site", "same-origin"],
      ["Sec-Fetch-Site", "same-origin"],
    ],
    [
      ["Cookie", `${platformSessionCookie.name}=${credential}`],
      ["Cookie", `${platformSessionCookie.name}=${credential}`],
    ],
    [
      [
        "Cookie",
        `${platformSessionCookie.name}=${credential}; ${platformSessionCookie.name}=${credential}`,
      ],
    ],
    [["Cookie", `__Host-bop-merchant=${credential}`]],
    [["X-Bop-CSRF", "invalid"]],
  ] satisfies [string, string][][]) {
    const response = await send(root, "/step-up", { body: "{}", headers });
    expect(response.status).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  for (const omitted of ["origin", "sec-fetch-site", "cookie", "x-bop-csrf"])
    expect((await send(root, "/logout", { body: "{}", omit: [omitted] })).status).toBe(403);
  expect(f.service.startStepUp).not.toHaveBeenCalled();
  expect(f.service.logout).not.toHaveBeenCalled();
});
it("clears ephemeral authorization cookies for every early callback refusal without consuming state", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const paths = [
    "/callback",
    `/callback?state=${stateToken}`,
    `${callbackPath}&state=${stateToken}`,
    `${callbackPath}&policyCode=Privileged`,
    `/callback?code[]=synthetic&state=${stateToken}`,
  ];
  for (const path of paths) {
    const response = await send(root, path, { headers: callbackHeaders, omit: ["origin"] });
    expect(response.status).toBe(403);
    expect(response.headers["set-cookie"]).toEqual([
      "__Host-bop-platform-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    ]);
    expect(response.body).toEqual({ error: "request_denied" });
  }
  const missingCookie = await send(root, callbackPath, { omit: ["cookie"] });
  expect(missingCookie.status).toBe(403);
  expect(missingCookie.headers["set-cookie"]).toHaveLength(1);
  const wrongHost = await send(root, callbackPath, {
    headers: [...callbackHeaders, ["Host", "foreign.invalid"]],
  });
  expect(wrongHost.status).toBe(403);
  expect(wrongHost.headers["set-cookie"]).toHaveLength(1);
  const head = await send(root, callbackPath, { method: "HEAD", headers: callbackHeaders });
  expect(head.status).toBe(405);
  expect(head.headers["set-cookie"]).toHaveLength(1);
  expect(f.service.callback).not.toHaveBeenCalled();
});
it("rejects untrusted Provider redirects and malformed service cookies before issuing them", async () => {
  const f = fixture(),
    root = await serve(f.options);
  for (const authorizationUrl of [
    "https://foreign.invalid/authorize",
    "//identity.invalid/authorize",
    "http://identity.invalid/authorize",
    "https://identity.invalid@foreign.invalid/authorize",
    "https://identity.invalid/authorize#secret",
  ]) {
    f.service.start.mockResolvedValueOnce({ ...authorizing, authorizationUrl });
    const response = await send(root, "/login");
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
    f.service.startStepUp.mockResolvedValueOnce({ ...authorizing, authorizationUrl });
    const step = await send(root, "/step-up", { body: "{}" });
    expect(step.status).toBeGreaterThanOrEqual(400);
    expect(step.headers.location).toBeUndefined();
    expect(step.headers["set-cookie"]).toBeUndefined();
    expect(step.body).not.toHaveProperty("authorizationUrl");
  }
  const invalid = {
    ...authorizing,
    cookie: { ...authorizing.cookie, descriptor: { ...platformAuthorizationCookie } },
  };
  Reflect.set(invalid.cookie.descriptor, "name", "__Host-bop-merchant");
  f.service.start.mockResolvedValueOnce(invalid);
  expect((await send(root, "/login")).headers["set-cookie"]).toBeUndefined();
  f.service.logout.mockResolvedValueOnce({
    ...browserLogout,
    browserLogoutUrl: "https://identity.invalid/logout?different=1",
  });
  const logout = await send(root, "/logout", { body: "{}" });
  expect(logout.status).toBe(503);
  expect(logout.headers["set-cookie"]).toBeUndefined();
});
it("hides malformed/stale/foreign Session packets, secret extras and dependency exceptions", async () => {
  const f = fixture(),
    root = await serve(f.options);
  const extra = { ...bootstrap, providerToken: "synthetic-sensitive-token" };
  f.service.bootstrap.mockResolvedValueOnce(extra);
  const hidden = await send(root, "/session");
  expect(hidden.status).toBe(503);
  expect(hidden.text).not.toContain(extra.providerToken);
  const wrong = { ...bootstrap, recentMfa: { ...mfa, sessionReference: session.sessionReference } };
  Reflect.set(wrong.recentMfa, "sessionReference", id(99));
  f.service.bootstrap.mockResolvedValueOnce(wrong);
  expect((await send(root, "/session")).status).toBe(403);
  f.time.now = until;
  expect((await send(root, "/session")).status).toBe(503);
  f.time.now = at;
  f.service.bootstrap.mockRejectedValueOnce(new Error("synthetic-sensitive-failure"));
  expect((await send(root, "/session")).body).toEqual({
    error: "platform_authentication_unavailable",
  });
  f.service.callback.mockRejectedValueOnce(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  const denied = await send(root, callbackPath, { headers: callbackHeaders });
  expect(denied.status).toBe(403);
  expect(denied.headers["set-cookie"]).toHaveLength(1);
  f.service.callback.mockResolvedValueOnce({
    postLoginPath: "/platform/other",
    session,
    cookies: [clearAuth, sessionMutation],
  });
  const redirected = await send(root, callbackPath, { headers: callbackHeaders });
  expect(redirected.status).toBe(403);
  expect(redirected.headers.location).toBeUndefined();
  expect(redirected.headers["set-cookie"]).toEqual([
    "__Host-bop-platform-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
  ]);
});
it("captures configured ports and fails closed if a service port is replaced during an awaited request", async () => {
  const f = fixture(),
    root = await serve(f.options);
  f.service.start.mockImplementationOnce(async () => {
    Reflect.set(
      f.service,
      "start",
      vi.fn(async () => authorizing),
    );
    return authorizing;
  });
  const response = await send(root, "/login");
  expect(response.status).toBe(503);
  expect(response.headers["set-cookie"]).toBeUndefined();
  expect(response.headers.location).toBeUndefined();
});
