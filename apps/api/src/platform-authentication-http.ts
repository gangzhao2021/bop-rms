import express, { type Request, type Response, type Router } from "express";
import {
  BrowserSessionError,
  type PlatformBrowserSessionService,
  assertPlatformSessionCurrent,
  createAuthenticationSession,
  parseCanonicalInstant,
  parseExactHttpsUri,
  parsePlatformActor,
  parsePlatformSessionMfa,
  parseRawBrowserCredential,
  platformAuthorizationCookie,
  platformSessionCookie,
  readClosedRecord,
} from "@bop/identity";

export interface PlatformAuthenticationHttpOptions {
  readonly exactOrigin: string;
  readonly acceptedHost: string;
  readonly authorizationOrigin: string;
  readonly logoutUrl: string;
  readonly service: Pick<
    PlatformBrowserSessionService,
    "start" | "callback" | "bootstrap" | "startStepUp" | "logout"
  >;
  readonly clock: { now(): string };
}
export const platformAuthenticationRoutes = Object.freeze([
  "/platform/auth/login",
  "/platform/auth/callback",
  "/platform/auth/session",
  "/platform/auth/step-up",
  "/platform/auth/logout",
]);
const destination = "/platform/tenants";
const clearAuthorization =
  "__Host-bop-platform-auth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
class InvalidRequest extends Error {}
const unavailable = (): never => {
  throw new Error("PLATFORM_AUTHENTICATION_UNAVAILABLE");
};
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const rawHeaders = (request: Request, name: string): string[] => {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) values.push(request.rawHeaders[i + 1] ?? "");
  return values;
};
const header = (request: Request, name: string): string | null => {
  const values = rawHeaders(request, name);
  return values.length === 1 ? (values[0] ?? null) : null;
};
function cookie(request: Request, name: string) {
  const value = header(request, "cookie");
  if (!value || value.length > 4096) return denied();
  const matches = value
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${name}=`));
  if (matches.length !== 1) return denied();
  return parseRawBrowserCredential(matches[0]?.slice(name.length + 1));
}
function serializeCookie(
  value: unknown,
  expected: typeof platformAuthorizationCookie | typeof platformSessionCookie,
  clear: boolean,
) {
  const r = readClosedRecord(value, ["descriptor", "value", "clear"]),
    d = readClosedRecord(r.descriptor, [
      "name",
      "secure",
      "httpOnly",
      "sameSite",
      "path",
      "maxAgeSeconds",
    ]);
  if (
    d.name !== expected.name ||
    d.secure !== true ||
    d.httpOnly !== true ||
    d.sameSite !== "lax" ||
    d.path !== "/" ||
    d.maxAgeSeconds !== expected.maxAgeSeconds ||
    r.clear !== clear ||
    (clear && r.value !== "")
  )
    return unavailable();
  const credential = clear ? "" : parseRawBrowserCredential(r.value);
  return [
    `${expected.name}=${credential}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
    ...(clear
      ? ["Max-Age=0"]
      : expected.maxAgeSeconds === null
        ? []
        : [`Max-Age=${expected.maxAgeSeconds}`]),
  ].join("; ");
}
function session(value: unknown) {
  const r = readClosedRecord(value, [
      "sessionReference",
      "actor",
      "status",
      "policy",
      "version",
      "authenticatedAt",
      "createdAt",
      "lastSeenAt",
      "idleExpiresAt",
      "absoluteExpiresAt",
      "rotatedFromSessionReference",
      "revocationReason",
      "revokedAt",
    ]),
    p = readClosedRecord(r.policy, [
      "code",
      "maxActiveSessions",
      "idleTimeoutMinutes",
      "absoluteTimeoutMinutes",
    ]);
  const result = createAuthenticationSession({
    sessionReference: r.sessionReference,
    actor: r.actor,
    status: r.status,
    policyCode: p.code,
    maxActiveSessions: p.maxActiveSessions,
    idleTimeoutMinutes: p.idleTimeoutMinutes,
    absoluteTimeoutMinutes: p.absoluteTimeoutMinutes,
    version: r.version,
    authenticatedAt: r.authenticatedAt,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    idleExpiresAt: r.idleExpiresAt,
    absoluteExpiresAt: r.absoluteExpiresAt,
    rotatedFromSessionReference: r.rotatedFromSessionReference,
    revocationReason: r.revocationReason,
    revokedAt: r.revokedAt,
  });
  parsePlatformActor(result.actor);
  if (result.status !== "Active" || result.policy.code !== "Privileged") return unavailable();
  return result;
}
function fail(response: Response, error: unknown, callback = false) {
  if (callback) response.set("Set-Cookie", clearAuthorization);
  const status =
    callback || error instanceof BrowserSessionError
      ? 403
      : error instanceof InvalidRequest
        ? 400
        : 503;
  response.status(status).json({
    error:
      status === 403
        ? "request_denied"
        : status === 400
          ? "request_invalid"
          : "platform_authentication_unavailable",
  });
}
function requestRecord(value: unknown, keys: readonly string[]) {
  try {
    return readClosedRecord(value, keys);
  } catch {
    throw new InvalidRequest();
  }
}

/** Mounted only at /platform/auth. Authentication status supplies no application
 * permissions, tenant selection, support case, or template publication facts. */
export function createPlatformAuthenticationRouter(
  options: PlatformAuthenticationHttpOptions,
): Router {
  const origin = new URL(options.exactOrigin),
    providerOrigin = new URL(options.authorizationOrigin),
    logoutDestination = new URL(parseExactHttpsUri(options.logoutUrl)),
    logoutParameters = logoutDestination.searchParams;
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.exactOrigin ||
    origin.host !== options.acceptedHost ||
    providerOrigin.protocol !== "https:" ||
    providerOrigin.origin !== options.authorizationOrigin ||
    parseExactHttpsUri(options.logoutUrl) !== options.logoutUrl ||
    logoutDestination.origin !== options.authorizationOrigin ||
    logoutDestination.pathname !== "/logout" ||
    [...logoutParameters.keys()].length !== 2 ||
    logoutParameters.getAll("client_id").length !== 1 ||
    logoutParameters.getAll("logout_uri").length !== 1 ||
    !/^[A-Za-z0-9._~-]{1,255}$/u.test(logoutParameters.get("client_id") ?? "") ||
    logoutParameters.get("logout_uri") !== `${options.exactOrigin}${destination}`
  )
    return unavailable();
  const router = express.Router({ caseSensitive: true, strict: true }),
    service = options.service,
    clock = options.clock,
    now = clock.now,
    exactOrigin = options.exactOrigin,
    acceptedHost = options.acceptedHost,
    authorizationOrigin = options.authorizationOrigin,
    logoutUrl = options.logoutUrl;
  const start = service.start,
    callback = service.callback,
    bootstrap = service.bootstrap,
    startStepUp = service.startStepUp,
    logout = service.logout;
  if ([start, callback, bootstrap, startStepUp, logout, now].some((v) => typeof v !== "function"))
    return unavailable();
  const owned = new Set(platformAuthenticationRoutes.map((p) => p.slice("/platform/auth".length)));
  const check = () => {
    if (
      options.service !== service ||
      service.start !== start ||
      service.callback !== callback ||
      service.bootstrap !== bootstrap ||
      service.startStepUp !== startStepUp ||
      service.logout !== logout ||
      options.clock !== clock ||
      clock.now !== now ||
      options.exactOrigin !== exactOrigin ||
      options.acceptedHost !== acceptedHost ||
      options.authorizationOrigin !== authorizationOrigin ||
      options.logoutUrl !== logoutUrl
    )
      return unavailable();
  };
  router.use((request, response, next) => {
    if (!owned.has(request.path)) {
      next("router");
      return;
    }
    response.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    const isCallback = request.path === "/callback";
    try {
      check();
      const origins = rawHeaders(request, "origin"),
        sites = rawHeaders(request, "sec-fetch-site"),
        mutation = request.method === "POST";
      if (
        header(request, "host") !== acceptedHost ||
        origins.length > 1 ||
        sites.length !== 1 ||
        (origins.length === 1 && origins[0] !== exactOrigin) ||
        ["cookie", "x-bop-csrf", "content-type"].some(
          (name) => rawHeaders(request, name).length > 1,
        ) ||
        (mutation
          ? origins.length !== 1 || sites[0] !== "same-origin"
          : !(
              isCallback
                ? ["same-origin", "same-site", "cross-site", "none"]
                : ["same-origin", "none"]
            ).includes(sites[0] ?? ""))
      )
        return denied();
      if (request.originalUrl.length > 8192) throw new InvalidRequest();
      if (mutation) {
        requestRecord({ ...request.query }, []);
        if (
          !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(header(request, "content-type") ?? "")
        )
          throw new InvalidRequest();
      } else if (
        header(request, "transfer-encoding") !== null ||
        (header(request, "content-length") !== null && header(request, "content-length") !== "0")
      )
        throw new InvalidRequest();
      const expected = request.path === "/step-up" || request.path === "/logout" ? "POST" : "GET";
      if (request.method !== expected) {
        if (isCallback) response.set("Set-Cookie", clearAuthorization);
        response.set("Allow", expected).status(405).json({ error: "request_invalid" });
        return;
      }
      next();
    } catch (error) {
      fail(response, error, isCallback);
    }
  });
  router.use(express.json({ limit: "1kb", strict: true }));
  const authorization = (value: unknown) => {
    const r = readClosedRecord(value, ["authorizationUrl", "cookie"]),
      url = parseExactHttpsUri(r.authorizationUrl);
    if (new URL(url).origin !== authorizationOrigin) return unavailable();
    return { url, cookie: serializeCookie(r.cookie, platformAuthorizationCookie, false) };
  };
  router.get("/login", async (request, response) => {
    try {
      requestRecord({ ...request.query }, []);
      const result = authorization(await start.call(service, destination));
      check();
      response.set("Set-Cookie", result.cookie).redirect(303, result.url);
    } catch (error) {
      fail(response, error);
    }
  });
  router.get("/callback", async (request, response) => {
    try {
      const q = requestRecord({ ...request.query }, ["code", "state"]);
      if (typeof q.code !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(q.code)) return denied();
      const state = parseRawBrowserCredential(q.state),
        authCookie = cookie(request, platformAuthorizationCookie.name);
      const result = readClosedRecord(
        await callback.call(service, { code: q.code, state, authCookie }),
        ["postLoginPath", "session", "cookies"],
      );
      if (
        result.postLoginPath !== destination ||
        !Array.isArray(result.cookies) ||
        result.cookies.length !== 2 ||
        Object.keys(result.cookies).length !== 2
      )
        return unavailable();
      session(result.session);
      const cookies = [
        serializeCookie(result.cookies[0], platformAuthorizationCookie, true),
        serializeCookie(result.cookies[1], platformSessionCookie, false),
      ];
      check();
      response.set("Set-Cookie", cookies).redirect(303, destination);
    } catch (error) {
      fail(response, error, true);
    }
  });
  router.get("/session", async (request, response) => {
    try {
      requestRecord({ ...request.query }, []);
      const value = readClosedRecord(
          await bootstrap.call(service, cookie(request, platformSessionCookie.name)),
          ["session", "csrf", "recentMfa", "recentMfaRequired", "observedAt", "validUntil"],
        ),
        current = session(value.session),
        mfa = parsePlatformSessionMfa(value.recentMfa),
        observedAt = parseCanonicalInstant(value.observedAt),
        validUntil = parseCanonicalInstant(value.validUntil),
        at = parseCanonicalInstant(now.call(clock));
      assertPlatformSessionCurrent(current, mfa, at, false);
      if (
        typeof value.recentMfaRequired !== "boolean" ||
        at < observedAt ||
        at >= validUntil ||
        Date.parse(validUntil) > Date.parse(observedAt) + 5000 ||
        validUntil > current.idleExpiresAt ||
        validUntil > current.absoluteExpiresAt
      )
        return unavailable();
      check();
      response.json({
        authenticated: true,
        session: {
          sessionReference: current.sessionReference,
          actorReference: current.actor.actorReference,
          expiresAt:
            current.idleExpiresAt < current.absoluteExpiresAt
              ? current.idleExpiresAt
              : current.absoluteExpiresAt,
        },
        recentMfaRequired: at >= mfa.validUntil,
        csrf: parseRawBrowserCredential(value.csrf),
      });
    } catch (error) {
      fail(response, error);
    }
  });
  for (const mode of ["step-up", "logout"] as const)
    router.post(`/${mode}`, async (request, response) => {
      try {
        requestRecord(request.body, []);
        const input = {
          sessionCookie: cookie(request, platformSessionCookie.name),
          csrf: parseRawBrowserCredential(header(request, "x-bop-csrf")),
        };
        if (mode === "step-up") {
          const result = authorization(
            await startStepUp.call(service, { ...input, postLoginPath: destination }),
          );
          check();
          response
            .set("Set-Cookie", result.cookie)
            .json({ status: "step_up_required", authorizationUrl: result.url });
        } else {
          const result = readClosedRecord(await logout.call(service, input), [
            "status",
            "cookies",
            "browserLogoutUrl",
          ]);
          if (
            !Array.isArray(result.cookies) ||
            Object.keys(result.cookies).length !== result.cookies.length
          )
            return unavailable();
          if (
            result.status === "Unknown" &&
            result.cookies.length === 0 &&
            result.browserLogoutUrl === null
          )
            return unavailable();
          if (
            result.status !== "BrowserLogoutRequired" ||
            result.cookies.length !== 1 ||
            result.browserLogoutUrl !== logoutUrl
          )
            return unavailable();
          const mutation = serializeCookie(result.cookies[0], platformSessionCookie, true);
          check();
          response
            .set("Set-Cookie", mutation)
            .json({ status: "browser_logout_required", logoutUrl });
        }
      } catch (error) {
        fail(response, error);
      }
    });
  router.use((error: unknown, request: Request, response: Response, next: express.NextFunction) => {
    void next;
    if (request.path === "/callback") {
      fail(response, error, true);
      return;
    }
    const large =
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large";
    response.status(large ? 413 : 400).json({ error: "request_invalid" });
  });
  return router;
}
