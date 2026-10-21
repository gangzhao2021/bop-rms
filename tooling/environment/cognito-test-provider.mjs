import process from "node:process";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { URL, URLSearchParams } from "node:url";

/**
 * TEST-ONLY (WP-2423 DEC-COGNITO-STORE-STAFF): a local stand-in for the Amazon Cognito user pool
 * the Store staff sign-in uses, so the sign-in, invitation and step-up paths run end to end with
 * no AWS call. It serves what the real adapters reach:
 *
 *   GET  /<pool>/.well-known/jwks.json      signing keys (RS256)
 *   GET  /oauth2/authorize                  a plain managed-login stand-in page
 *   POST /oauth2/authorize                  sign in (email, password, authenticator code)
 *   POST /oauth2/token                      authorization code + PKCE + client secret (Basic)
 *   POST /oauth2/revoke                     refresh token revocation
 *   GET  /logout                            managed-login sign-out
 *   POST /  (X-Amz-Target AWSCognitoIdentityProviderService.AdminCreateUser | AdminGetUser |
 *            AdminDeleteUser | GetUserPoolMfaConfig | DescribeUserPool)   the admin API, AWS JSON 1.1
 *
 * Invitation "emails" are kept in memory (`invitations`), never sent. Faults can be injected per
 * endpoint (`fail("token", "status-500")`, `"hang"`, `"invalid-json"`; `fail("admin:<Op>", …)`),
 * and token claims changed for the next sign-in (`nextClaims`). Tokens have the real user-pool
 * shape by default (no `acr`/`amr`; `tokenShape: "acr-amr"` adds them), and the pool's MFA
 * settings answer as required authenticator-app MFA unless `setPoolMfa` says otherwise. It refuses
 * to start in a production process.
 */
const managedLoginOriginDefault = "https://bop-test-only.auth.ca-central-1.amazoncognito.com";
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const challenge = (verifier) => createHash("sha256").update(verifier).digest("base64url");
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/**
 * The pool MFA settings the stand-in reports: `on-totp` (required, authenticator app only — what
 * the runbook sets up), `optional`, `off`, `sms` (text-message MFA also on), `email`,
 * `passwordless` (one-time-password or passkey first sign-in factors), `remembered-devices`
 * (remembered devices skip MFA).
 */
export const testPoolMfaModes = Object.freeze([
  "on-totp",
  "optional",
  "off",
  "sms",
  "email",
  "passwordless",
  "remembered-devices",
]);
const poolMfaAnswer = (pool, mode) => {
  const mfa = {
    MfaConfiguration: mode === "optional" ? "OPTIONAL" : mode === "off" ? "OFF" : "ON",
    SoftwareTokenMfaConfiguration: { Enabled: mode !== "off" },
    ...(mode === "sms"
      ? { SmsMfaConfiguration: { SmsAuthenticationMessage: "TEST-ONLY {####}" } }
      : {}),
    ...(mode === "email" ? { EmailMfaConfiguration: { Subject: "TEST-ONLY" } } : {}),
    WebAuthnConfiguration: { UserVerification: "preferred" },
  };
  const described = {
    UserPool: {
      Id: pool,
      MfaConfiguration: mfa.MfaConfiguration,
      Policies: {
        SignInPolicy: {
          AllowedFirstAuthFactors:
            mode === "passwordless" ? ["PASSWORD", "EMAIL_OTP", "WEB_AUTHN"] : ["PASSWORD"],
        },
      },
      ...(mode === "remembered-devices"
        ? {
            DeviceConfiguration: {
              ChallengeRequiredOnNewDevice: true,
              DeviceOnlyRememberedOnUserPrompt: false,
            },
          }
        : {}),
    },
  };
  return { mfa, described };
};

export async function startCognitoTestProvider({
  pool = "ca-central-1_TestOnly",
  clientId = "testonlystaffclient",
  clientSecret = "test-only-client-secret",
  managedLoginOrigin = managedLoginOriginDefault,
  callbackUrls = [],
  https = null,
  tokenShape = "cognito",
  poolMfa = "on-totp",
} = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("TEST_ONLY");
  const issuer = "https://cognito-idp.ca-central-1.amazonaws.com/" + pool;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-only-" + randomBytes(4).toString("hex");
  const users = new Map(); // username -> user
  const codes = new Map(); // code -> grant
  const invitations = [];
  const revoked = [];
  const calls = [];
  const faults = new Map(); // endpoint -> [mode]
  let nextClaims = null;
  let shape = tokenShape,
    poolMode = poolMfa;
  const setShape = (value) => {
    if (value !== "cognito" && value !== "acr-amr") throw new Error("TEST_ONLY_TOKEN_SHAPE");
    shape = value;
  };
  const setPoolMode = (value) => {
    if (!testPoolMfaModes.includes(value)) throw new Error("TEST_ONLY_POOL_MFA");
    poolMode = value;
  };
  setShape(tokenShape);
  setPoolMode(poolMfa);
  const fault = (endpoint) => {
    const queue = faults.get(endpoint);
    return queue?.length ? queue.shift() : null;
  };
  const attributes = (user) => [
    { Name: "sub", Value: user.sub },
    { Name: "email", Value: user.email },
    ...(user.emailVerified ? [{ Name: "email_verified", Value: "true" }] : []),
    ...Object.entries(user.custom).map(([Name, Value]) => ({ Name, Value })),
  ];
  const userRecord = (user) => ({
    Username: user.username,
    Enabled: user.enabled,
    UserStatus: user.status,
    UserCreateDate: user.createdAt / 1000,
    UserLastModifiedDate: user.modifiedAt / 1000,
  });
  const byEmail = (email) =>
    [...users.values()].find((user) => user.email === String(email).toLowerCase());
  const jwt = (claims) => {
    const body = `${encode({ alg: "RS256", kid, typ: "JWT" })}.${encode(claims)}`;
    return (
      body + "." + sign("RSA-SHA256", Buffer.from(body), keys.privateKey).toString("base64url")
    );
  };
  const awsError = (response, type, message) => {
    response.writeHead(400, {
      "content-type": "application/x-amz-json-1.1",
      "x-amzn-errortype": type,
    });
    response.end(JSON.stringify({ __type: type, message }));
  };
  const json = (response, status, value, type = "application/json") => {
    const body = JSON.stringify(value);
    response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body) });
    response.end(body);
  };
  const readBody = (request) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });

  /** Signs a person in at the managed-login stand-in; returns the callback location or an error. */
  function authorize(query, form) {
    if (
      query.get("client_id") !== clientId ||
      query.get("response_type") !== "code" ||
      query.get("code_challenge_method") !== "S256" ||
      !query.get("code_challenge") ||
      !query.get("state") ||
      !query.get("nonce") ||
      (callbackUrls.length > 0 && !callbackUrls.includes(query.get("redirect_uri")))
    )
      return { error: "invalid_request" };
    const user = byEmail(form.email);
    if (!user || !user.enabled) return { error: "Incorrect username or password." };
    if (user.status === "FORCE_CHANGE_PASSWORD") {
      // First sign-in: the temporary password, a new password and authenticator set-up.
      if (form.password !== user.temporaryPassword || !form.newPassword)
        return { error: "Incorrect username or password." };
      user.password = form.newPassword;
      user.status = "CONFIRMED";
      user.modifiedAt = Date.now();
    } else if (form.password !== user.password) return { error: "Incorrect username or password." };
    if (!/^[0-9]{6}$/u.test(String(form.code ?? "")) || fault("totp") === "reject")
      return { error: "Invalid code." };
    // Cognito authorization codes are UUIDs (not this app's 43-character credentials).
    const code = randomUUID();
    codes.set(code, {
      username: user.username,
      redirectUri: query.get("redirect_uri"),
      nonce: query.get("nonce"),
      challenge: query.get("code_challenge"),
      authTime: Math.floor(Date.now() / 1000),
    });
    const location = new URL(query.get("redirect_uri"));
    location.searchParams.set("code", code);
    location.searchParams.set("state", query.get("state"));
    return { location: location.href };
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const target = request.headers["x-amz-target"];
    calls.push({ method: request.method, path: url.pathname, target: target ?? null });
    try {
      if (request.method === "GET" && url.pathname === `/${pool}/.well-known/jwks.json`) {
        if (fault("jwks") === "status-500") return json(response, 500, {});
        return json(response, 200, {
          keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }],
        });
      }
      if (url.pathname === "/oauth2/authorize" && request.method === "GET") {
        const fields = [...url.searchParams]
          .map(
            ([name, value]) =>
              `<input type="hidden" name="q_${escapeHtml(name)}" value="${escapeHtml(value)}">`,
          )
          .join("");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return response.end(
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>TEST-ONLY sign-in</title><main><h1>TEST-ONLY sign-in stand-in</h1><form method="post" action="/oauth2/authorize">${fields}<label>Email <input name="email" type="email" required></label><label>Password <input name="password" type="password" required></label><label>New password (first sign-in) <input name="newPassword" type="password"></label><label>Authenticator code <input name="code" inputmode="numeric" required></label><button type="submit">Sign in</button></form></main></html>`,
        );
      }
      if (url.pathname === "/oauth2/authorize" && request.method === "POST") {
        const form = new URLSearchParams(await readBody(request));
        const query = new URLSearchParams();
        for (const [name, value] of form)
          if (name.startsWith("q_")) query.set(name.slice(2), value);
        const result = authorize(query, Object.fromEntries(form));
        if (result.error) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          return response.end(result.error);
        }
        response.writeHead(302, { location: result.location });
        return response.end();
      }
      if (url.pathname === "/oauth2/token" && request.method === "POST") {
        const mode = fault("token");
        if (mode === "hang") return undefined;
        if (mode === "status-500") return json(response, 500, { error: "server_error" });
        if (mode === "invalid-json") {
          response.writeHead(200, { "content-type": "application/json" });
          return response.end("{");
        }
        const basic = Buffer.from(
          String(request.headers.authorization ?? "").replace(/^Basic /u, ""),
          "base64",
        ).toString("utf8");
        const decode = (value) => decodeURIComponent(value.replace(/\+/gu, " "));
        const [id, secret] = basic.split(":").map(decode);
        if (id !== clientId || secret !== clientSecret)
          return json(response, 401, { error: "invalid_client" });
        const form = new URLSearchParams(await readBody(request));
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (
          form.get("grant_type") !== "authorization_code" ||
          !grant ||
          grant.redirectUri !== form.get("redirect_uri") ||
          challenge(form.get("code_verifier") ?? "") !== grant.challenge
        )
          return json(response, 400, { error: "invalid_grant" });
        const user = users.get(grant.username);
        const now = Math.floor(Date.now() / 1000);
        const common = {
          iss: issuer,
          sub: user.sub,
          auth_time: grant.authTime,
          iat: now,
          exp: now + 3600,
          // Real user-pool tokens carry no acr/amr; "acr-amr" is the older expected shape.
          ...(shape === "acr-amr" ? { acr: "urn:cognito:loa:4", amr: ["pwd", "otp", "mfa"] } : {}),
          ...(nextClaims?.common ?? {}),
        };
        const id_token = jwt({
          ...common,
          token_use: "id",
          aud: clientId,
          nonce: grant.nonce,
          email: user.email,
          email_verified: user.emailVerified,
          "cognito:username": user.username,
          ...(nextClaims?.id ?? {}),
        });
        const access_token = jwt({
          ...common,
          token_use: "access",
          client_id: clientId,
          scope: "openid",
          username: user.username,
          ...(nextClaims?.access ?? {}),
        });
        nextClaims = null;
        return json(response, 200, {
          id_token,
          access_token,
          refresh_token: "test-only-refresh-" + randomBytes(16).toString("hex"),
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/oauth2/revoke" && request.method === "POST") {
        revoked.push(new URLSearchParams(await readBody(request)).get("token"));
        response.writeHead(200);
        return response.end();
      }
      if (url.pathname === "/logout" && request.method === "GET") {
        response.writeHead(302, { location: url.searchParams.get("logout_uri") ?? "/" });
        return response.end();
      }
      if (request.method === "POST" && typeof target === "string") {
        const operation = target.replace("AWSCognitoIdentityProviderService.", "");
        const mode = fault("admin:" + operation);
        if (mode === "hang") return undefined;
        if (mode === "status-500") return awsError(response, "InternalErrorException", "TEST-ONLY");
        const input = JSON.parse((await readBody(request)) || "{}");
        if (input.UserPoolId !== pool)
          return awsError(response, "ResourceNotFoundException", "pool");
        if (operation === "GetUserPoolMfaConfig" || operation === "DescribeUserPool") {
          const answer = poolMfaAnswer(pool, poolMode);
          return json(
            response,
            200,
            operation === "GetUserPoolMfaConfig" ? answer.mfa : answer.described,
            "application/x-amz-json-1.1",
          );
        }
        const user = users.get(input.Username);
        if (operation === "AdminCreateUser") {
          if (input.MessageAction === "RESEND") {
            if (!user) return awsError(response, "UserNotFoundException", "User does not exist.");
            if (user.status !== "FORCE_CHANGE_PASSWORD")
              return awsError(response, "UnsupportedUserStateException", "state");
            user.temporaryPassword = "Tmp-" + randomBytes(6).toString("hex");
            user.modifiedAt = Date.now();
            invitations.push({
              username: user.username,
              email: user.email,
              temporaryPassword: user.temporaryPassword,
              resent: true,
            });
            return json(
              response,
              200,
              { User: { ...userRecord(user), Attributes: attributes(user) } },
              "application/x-amz-json-1.1",
            );
          }
          if (user) return awsError(response, "UsernameExistsException", "User already exists");
          const values = new Map(
            (input.UserAttributes ?? []).map((item) => [item.Name, item.Value]),
          );
          const email = String(values.get("email") ?? "").toLowerCase();
          const verified = values.get("email_verified") === "true";
          if (verified && byEmail(email)?.emailVerified)
            return awsError(
              response,
              "AliasExistsException",
              "An account with the email already exists.",
            );
          const created = {
            username: input.Username,
            sub: randomUUID(),
            email,
            emailVerified: verified,
            custom: Object.fromEntries([...values].filter(([name]) => name.startsWith("custom:"))),
            enabled: true,
            status: "FORCE_CHANGE_PASSWORD",
            temporaryPassword: "Tmp-" + randomBytes(6).toString("hex"),
            password: null,
            createdAt: Date.now(),
            modifiedAt: Date.now(),
          };
          users.set(created.username, created);
          invitations.push({
            username: created.username,
            email,
            temporaryPassword: created.temporaryPassword,
            resent: false,
          });
          if (mode === "lost-reply")
            return awsError(response, "InternalErrorException", "TEST-ONLY");
          return json(
            response,
            200,
            { User: { ...userRecord(created), Attributes: attributes(created) } },
            "application/x-amz-json-1.1",
          );
        }
        if (operation === "AdminGetUser") {
          if (!user) return awsError(response, "UserNotFoundException", "User does not exist.");
          return json(
            response,
            200,
            { ...userRecord(user), UserAttributes: attributes(user) },
            "application/x-amz-json-1.1",
          );
        }
        if (operation === "AdminDeleteUser") {
          if (!user) return awsError(response, "UserNotFoundException", "User does not exist.");
          users.delete(user.username);
          return json(response, 200, {}, "application/x-amz-json-1.1");
        }
        return awsError(response, "InvalidParameterException", "unsupported");
      }
      response.writeHead(404);
      return response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      return response.end();
    }
  }
  const sockets = new Set();
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      server.once("error", reject);
    });
  const server = createServer((request, response) => void handle(request, response));
  const port = await listen(server);
  let secure = null,
    securePort = null;
  if (https !== null) {
    secure = createHttpsServer(
      { key: https.key, cert: https.cert },
      (request, response) => void handle(request, response),
    );
    securePort = await listen(secure);
  }
  return Object.freeze({
    pool,
    issuer,
    clientId,
    clientSecret,
    managedLoginOrigin,
    origin: `http://127.0.0.1:${port}`,
    browserOrigin: securePort === null ? null : `https://127.0.0.1:${securePort}`,
    users,
    invitations,
    revoked,
    calls,
    /** Queues a fault for the next request to an endpoint ("token", "jwks", "totp", "admin:<Op>"). */
    fail(endpoint, mode) {
      faults.set(endpoint, [...(faults.get(endpoint) ?? []), mode]);
    },
    /** Changes claims of the next issued tokens ({ common, id, access }). */
    setNextClaims(claims) {
      nextClaims = claims;
    },
    /** "cognito" (real user-pool tokens, no acr/amr) or "acr-amr" (both claims present). */
    setTokenShape: setShape,
    /** What the pool MFA admin calls report from now on (one of `testPoolMfaModes`). */
    setPoolMfa: setPoolMode,
    /**
     * Signs in at the stand-in like a browser would: from the authorization URL the app redirected
     * to (any origin), with the person's email, password (or temporary password plus a new one on
     * the first sign-in) and an authenticator code. Returns the app callback URL or throws.
     */
    signIn(authorizationUrl, { email, password, newPassword, code = "123456" }) {
      const query = new URL(authorizationUrl).searchParams;
      const result = authorize(query, { email, password, newPassword, code });
      if (result.error) throw new Error("TEST_PROVIDER_SIGN_IN_REFUSED: " + result.error);
      return result.location;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      if (secure !== null) await new Promise((resolve) => secure.close(() => resolve()));
    },
  });
}
