import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { vi } from "vitest";
import { createCognitoMerchantBrandAdministrationRuntime } from "../../../apps/api/src/merchant-brand-administration-runtime.ts";
import { createApiRuntimeLogger, createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { exerciseBrandDiscovery } from "./brand-discovery.mjs";
import { exerciseBrandAdministrationStartup } from "./brand-administration-startup.mjs";
import {
  createInitialBrandMerchantTransactions,
  exerciseInitialBrandConfiguration,
} from "./brand-initial-configuration.mjs";

/** The initialized Brand, immutable account binding, accepted invitation, six
 * permission actions and Membership are real preceding owner writes. Only the
 * outbound Cognito HTTP/SDK facts, RSA keys and clock are controlled InternalTest
 * boundaries. Both installed token verifiers, actual API host, encrypted Session,
 * selection, current IAM and empty Feature-definition read run unchanged. */
export async function exerciseInitialBrandWorkforceLogin(
  f,
  { context, plan, workforce, boundAccount, participantState, publishedTemplate },
) {
  const actorReference = plan.recipients[0].actorReference,
    brandReference = plan.brand.brandReference,
    origin = "https://merchant.invalid",
    prefix = "/merchant/organization/brands",
    target = `/app/organization/brands/${brandReference}`,
    issuer = workforce.configuration.issuer,
    clientId = workforce.configuration.clientIds[0],
    providerOrigin = "https://synthetic-workforce.auth.ca-central-1.amazoncognito.com",
    clientSecret = "synthetic-only-confidential-client-secret";
  assert.equal(workforce.configuration.clientIds.length, 1);
  assert.equal(boundAccount.binding.actorReference, actorReference);
  assert.notEqual(
    boundAccount.binding.originalMembershipReference,
    plan.recipients[0].membershipReference,
  );
  f.mark("Concrete Workforce login minimum privileges");
  f.state.lastSqlState = null;
  const merchant = await createInitialBrandMerchantTransactions(f, context);
  const acl = (
    await f.admin.query(
      `SELECT
    has_table_privilege($1,'bop_identity.workforce_account_binding','SELECT') AS binding_read,
    has_table_privilege($1,'bop_identity.workforce_account_binding','INSERT') AS binding_write,
    has_table_privilege($1,'bop_tenant.store','SELECT') AS store_read,
    has_table_privilege($1,'bop_membership.store_assignment','SELECT') AS assignment_read,
    has_table_privilege($1,'bop_identity.browser_session_selection','SELECT') AS legacy_selection,
    has_table_privilege($1,'bop_feature_control.control_version','INSERT') AS feature_write,
    has_column_privilege($1,'bop_identity.authentication_session','actor_id','UPDATE') AS session_actor_write,
    has_column_privilege($1,'bop_identity.authentication_session','encrypted_secret','UPDATE') AS session_secret_write`,
      [merchant.role],
    )
  ).rows[0];
  assert.deepEqual(acl, {
    binding_read: false,
    binding_write: false,
    store_read: false,
    assignment_read: false,
    legacy_selection: false,
    feature_write: false,
    session_actor_write: false,
    session_secret_write: false,
  });
  const counts = async () =>
    (
      await f.admin.query(
        `SELECT
    (SELECT count(*)::int FROM bop_identity.authentication_session WHERE actor_id=$1) AS sessions,
    (SELECT count(*)::int FROM bop_identity.browser_brand_session_selection WHERE actor_id=$1) AS selections,
    (SELECT count(*)::int FROM bop_tenant.store) AS stores,
    (SELECT count(*)::int FROM bop_membership.store_assignment) AS assignments,
    (SELECT count(*)::int FROM bop_feature_control.control_version) AS feature_versions,
    (SELECT count(*)::int FROM bop_feature_control.control_dependency) AS feature_dependencies`,
        [actorReference],
      )
    ).rows[0];
  const baseline = await counts();
  assert.deepEqual(baseline, {
    sessions: 0,
    selections: 0,
    stores: 0,
    assignments: 0,
    feature_versions: 0,
    feature_dependencies: 0,
  });
  const idKey = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    accessKey = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    codes = new Map(),
    wireCalls = { jwks: 0, token: 0, revoke: 0 },
    logs = [];
  let sequence = 95000,
    confirmed = false,
    server,
    featureReads = 0,
    authenticationScopes = 0;
  let expectedCallbackUri = `${origin}${prefix}/callback`,
    tokenNow = () => f.state.now;
  // Only the controlled outbound Provider changes its trusted callback and
  // issuance clock while the real executable runtime uses its own wall clock.
  const withProviderCallback = async (startupOrigin, work) => {
    assert.match(startupOrigin, /^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u);
    const previousCallback = expectedCallbackUri,
      previousClock = tokenNow;
    expectedCallbackUri = `${startupOrigin}${prefix}/callback`;
    tokenNow = () => new Date().toISOString();
    try {
      return await work();
    } finally {
      expectedCallbackUri = previousCallback;
      tokenNow = previousClock;
    }
  };
  const reference = () => `0190ed60-0041-7000-8000-${(++sequence).toString(16).padStart(12, "0")}`,
    credential = () => randomBytes(32).toString("base64url"),
    encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url"),
    jwt = (claims, use) => {
      const value = `${encode({ alg: "RS256", kid: `workforce-native-${use}`, typ: "JWT" })}.${encode(claims)}`;
      return `${value}.${sign("RSA-SHA256", Buffer.from(value), use === "id" ? idKey.privateKey : accessKey.privateKey).toString("base64url")}`;
    };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    if (String(url) === `${issuer}/.well-known/jwks.json`) {
      assert.equal(init.method ?? "GET", "GET");
      wireCalls.jwks++;
      return globalThis.Response.json({
        keys: [
          {
            ...idKey.publicKey.export({ format: "jwk" }),
            alg: "RS256",
            kid: "workforce-native-id",
            use: "sig",
          },
          {
            ...accessKey.publicKey.export({ format: "jwk" }),
            alg: "RS256",
            kid: "workforce-native-access",
            use: "sig",
          },
        ],
      });
    }
    assert.equal(init.method, "POST");
    const header = new globalThis.Headers(init.headers).get("authorization");
    assert(header?.startsWith("Basic "), "CONCRETE_CLIENT_AUTH_REQUIRED");
    const client = Buffer.from(header.slice(6), "base64")
      .toString()
      .split(":")
      .map(decodeURIComponent);
    assert(client[0] === clientId && client[1] === clientSecret, "CONCRETE_CLIENT_AUTH_MISMATCH");
    const body = new globalThis.URLSearchParams(String(init.body));
    if (String(url) === `${providerOrigin}/oauth2/revoke`) {
      wireCalls.revoke++;
      assert.equal(body.get("token_type_hint"), "refresh_token");
      assert(
        body.get("token")?.startsWith("synthetic-workforce-refresh-"),
        "REFRESH_TOKEN_BINDING_REQUIRED",
      );
      return new globalThis.Response(null, { status: confirmed ? 200 : 503 });
    }
    assert.equal(String(url), `${providerOrigin}/oauth2/token`);
    wireCalls.token++;
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("redirect_uri"), expectedCallbackUri);
    const code = codes.get(body.get("code"));
    assert(code && !code.used, "ONE_TIME_NATIVE_CODE_REQUIRED");
    assert.equal(code.redirectUri, expectedCallbackUri);
    code.used = true;
    assert.equal(
      createHash("sha256").update(body.get("code_verifier")).digest("base64url"),
      code.challenge,
    );
    const second = Math.floor(Date.parse(tokenNow()) / 1000),
      common = {
        iss: issuer,
        sub: code.subject,
        auth_time: second,
        iat: second,
        exp: second + 3600,
        acr: "urn:cognito:loa:4",
        amr: ["pwd", "otp", "mfa"],
      };
    return globalThis.Response.json({
      id_token: jwt({ ...common, token_use: "id", aud: clientId, nonce: code.nonce }, "id"),
      access_token: jwt(
        { ...common, token_use: "access", client_id: clientId, scope: "openid" },
        "access",
      ),
      refresh_token: `synthetic-workforce-refresh-${wireCalls.token}`,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid",
    });
  });
  let restored = false;
  const restore = () => {
    if (!restored) {
      restored = true;
      fetch.mockRestore();
    }
  };
  f.cleanup.push(restore);
  const previousAfterQuery = f.state.afterQuery,
    previousMemberCalls = participantState.memberCalls;
  f.state.afterQuery = async (input) => {
    if (input.sql.includes("FROM bop_feature_control.control_version v")) featureReads++;
    if (
      input.sql.includes("bop.workforce_account_purpose") &&
      input.values.includes("WORKFORCE_AUTHENTICATION")
    )
      authenticationScopes++;
    if (previousAfterQuery) await previousAfterQuery(input);
  };
  let primaryError,
    primaryFailed = false,
    cleanupError;
  try {
    // Preserve the parent's controlled past clock: signed authentication is
    // genuinely verified against the library wall clock within its fresh window.
    // Do not consume the parent's past-time margin for later real Audit writes.
    assert(
      Date.parse(f.state.now) <= Date.now() && Date.now() - Date.parse(f.state.now) < 300000,
      "CONTROLLED_AUTHENTICATION_CLOCK_OUTSIDE_FRESH_WINDOW",
    );
    const runtimeOptions = {
      identity: {
        configuration: {
          environment: workforce.configuration.environment,
          issuer,
          clientId,
          clientSecret,
          managedLoginOrigin: providerOrigin,
          redirectUri: `${origin}${prefix}/callback`,
          logoutReturnUri: `${origin}/app/organization/brands`,
        },
        clock: f.clock,
        hasher: workforce.hasher,
        envelopes: workforce.envelopes,
        credentials: { generate: credential, generateUuidV7: reference },
        pkce: { challenge: (value) => createHash("sha256").update(value).digest("base64url") },
      },
      transactions: merchant.transactions,
      brandReference,
      exactOrigin: origin,
      acceptedHost: "merchant.invalid",
      // Omit configuration to exercise the ordinary runtime's concrete owning
      // Catalogue and Published Platform Template sources.
      catalogSource: { nextReference: reference },
    };
    const runtime = createCognitoMerchantBrandAdministrationRuntime(runtimeOptions);
    server = createApiServerRuntime({
      port: 0,
      brandAdministration: runtime,
      logger: createApiRuntimeLogger({ write: (message) => logs.push(String(message)) }),
    });
    await server.listen();
    const address = server.server.address();
    assert(address && typeof address !== "string");
    let base = `http://127.0.0.1:${address.port}`;
    const send = (path, { method = "GET", cookie, csrf, site = "same-origin", body = {} } = {}) =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          `${base}${path}`,
          {
            method,
            headers: {
              host: "merchant.invalid",
              origin,
              "sec-fetch-site": site,
              ...(cookie === undefined ? {} : { cookie }),
              ...(csrf === undefined ? {} : { "x-bop-csrf": csrf }),
              ...(method === "POST" ? { "content-type": "application/json" } : {}),
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (part) => {
              body += part;
            });
            res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
          },
        );
        req.on("error", reject);
        req.end(method === "POST" ? JSON.stringify(body) : undefined);
      });
    const cookie = (response, name) => {
      const field = response.headers["set-cookie"]?.find((value) => value.startsWith(`${name}=`));
      assert(field, "EXPECTED_SECURE_COOKIE");
      assert.match(field, /; Path=\/; Secure; HttpOnly; SameSite=Lax/u);
      return field.split(";")[0];
    };
    const challenge = (response, subject = boundAccount.command.subject) => {
      const authorizationUrl =
          response.status === 303
            ? response.headers.location
            : JSON.parse(response.body).authorizationUrl,
        url = new globalThis.URL(authorizationUrl),
        params = url.searchParams;
      assert.equal(url.origin + url.pathname, `${providerOrigin}/oauth2/authorize`);
      assert.equal(params.get("client_id"), clientId);
      assert.equal(params.get("redirect_uri"), expectedCallbackUri);
      for (const [key, value] of Object.entries({
        response_type: "code",
        scope: "openid",
        identity_provider: "COGNITO",
        prompt: "login",
        max_age: "0",
        acr_values: "urn:cognito:loa:4",
        code_challenge_method: "S256",
      }))
        assert.equal(params.get(key), value);
      const code = credential(),
        state = params.get("state");
      assert(
        state && params.get("nonce") && params.get("code_challenge"),
        "AUTHORIZATION_BINDING_REQUIRED",
      );
      codes.set(code, {
        subject,
        nonce: params.get("nonce"),
        challenge: params.get("code_challenge"),
        redirectUri: expectedCallbackUri,
        used: false,
      });
      return {
        path: `${prefix}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        cookie: cookie(response, "__Host-bop-auth"),
        site: "cross-site",
      };
    };
    const sessionRow = async (browserCookie) =>
      (
        await f.admin.query(
          `SELECT * FROM bop_identity.authentication_session
      WHERE session_selector_hash=decode($1,'hex')`,
          [workforce.hasher.hash(browserCookie.slice(browserCookie.indexOf("=") + 1))],
        )
      ).rows[0];
    const verifySaved = async (
      browserCookie,
      expectedActor = actorReference,
      expectedBrand = brandReference,
    ) => {
      const row = await sessionRow(browserCookie);
      assert(row, "ACTUAL_ENCRYPTED_SESSION_REQUIRED");
      assert.equal(row.actor_id, expectedActor);
      assert.equal(row.policy_code, "Privileged");
      assert(Buffer.isBuffer(row.encrypted_secret));
      const plaintext = await workforce.envelopes.decrypt(
          {
            algorithm: row.cipher_algorithm,
            keyReference: row.key_reference,
            ciphertext: row.encrypted_secret.toString("base64url"),
            encryptionContext: row.encryption_context,
          },
          row.encryption_context,
        ),
        secrets = JSON.parse(plaintext);
      assert.equal(secrets.profile, "WorkforceBrowserSessionV1");
      assert.equal(secrets.issuer, issuer);
      assert.equal(secrets.clientId, clientId);
      assert.equal(secrets.mfa.actorReference, expectedActor);
      assert.equal(secrets.mfa.sessionReference, row.session_id);
      assert.equal(secrets.mfa.authenticatedAt, row.authenticated_at.toISOString());
      assert.equal(Date.parse(secrets.mfa.validUntil), Date.parse(secrets.mfa.verifiedAt) + 900000);
      const authorization = (
        await f.admin.query(
          "SELECT created_at,consumed_at FROM bop_identity.oidc_authorization_transaction WHERE transaction_id=$1",
          [secrets.mfa.authorizationTransactionReference],
        )
      ).rows[0];
      assert(authorization?.consumed_at instanceof Date, "ACTUAL_ONE_TIME_AUTHORIZATION_REQUIRED");
      assert(
        Date.parse(secrets.mfa.verifiedAt) + 1000 > authorization.created_at.getTime(),
        "SIGNED_SECOND_CHALLENGE_BINDING_REQUIRED",
      );
      assert.equal(row.encrypted_secret.includes(Buffer.from(secrets.csrf)), false);
      assert.equal(
        row.encrypted_secret.includes(Buffer.from("synthetic-workforce-refresh-")),
        false,
      );
      const selection = (
        await f.admin.query(
          "SELECT actor_id,brand_id FROM bop_identity.browser_brand_session_selection WHERE session_id=$1",
          [row.session_id],
        )
      ).rows[0];
      if (expectedBrand === null) assert.equal(selection, undefined);
      else assert.deepEqual(selection, { actor_id: expectedActor, brand_id: expectedBrand });
      return { row, secrets };
    };
    f.mark("Concrete Workforce challenge and signed callback");
    const login = await send(`${prefix}/login`);
    assert.equal(login.status, 303);
    const original = challenge(login),
      signedIn = await send(original.path, original);
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.location, target);
    const firstCookie = cookie(signedIn, "__Host-bop-merchant"),
      first = await verifySaved(firstCookie);
    assert.deepEqual(await counts(), { ...baseline, sessions: 1, selections: 1 });
    const replay = await send(original.path, original);
    assert.equal(replay.status, 403);
    assert.match(cookie(replay, "__Host-bop-auth"), /=$/u);
    f.mark("Concrete Workforce Draft workspace and empty owning Feature read");
    const current = await send(`${prefix}/session`, { cookie: firstCookie });
    assert.equal(current.status, 200);
    assert.equal(current.headers["cache-control"], "no-store");
    const currentBody = JSON.parse(current.body);
    assert.deepEqual(Object.keys(currentBody).sort(), [
      "authenticated",
      "csrf",
      "recentMfaRequired",
      "workspace",
    ]);
    assert.equal(currentBody.authenticated, true);
    assert.equal(currentBody.recentMfaRequired, false);
    assert.deepEqual(currentBody.workspace, {
      profile: "BrandAdministrationWorkspaceV1",
      selectedScope: { tenantReference: brandReference, brandReference, actorReference },
      brand: { brandReference, label: plan.brand.displayName, lifecycle: "Draft", version: 1 },
      navigation: [
        {
          screenId: "ORG-BRAND-DETAIL",
          label: "Brand",
          href: target,
          permission: "organization.manage",
        },
      ],
    });
    assert.equal(currentBody.csrf, first.secrets.csrf);
    assert.equal(
      /tokenBundle|refreshToken|evidenceReference|storeReference/u.test(current.body),
      false,
    );
    assert.equal((await send("/merchant/session", { cookie: firstCookie })).status, 404);
    f.mark("Concrete Workforce wrong signed subject has no Session or selection");
    const wrongStart = await send(`${prefix}/login`),
      wrong = challenge(wrongStart, "opaque-native-unbound-workforce"),
      rejected = await send(wrong.path, wrong);
    assert.equal(rejected.status, 403);
    assert.match(cookie(rejected, "__Host-bop-auth"), /=$/u);
    assert.deepEqual(await counts(), { ...baseline, sessions: 1, selections: 1 });
    f.mark("Concrete Workforce current SDK withdrawal");
    participantState.membersEnabled = false;
    try {
      assert.equal((await send(`${prefix}/session`, { cookie: firstCookie })).status, 403);
    } finally {
      participantState.membersEnabled = true;
    }
    assert.deepEqual(await counts(), { ...baseline, sessions: 1, selections: 1 });
    assert.equal((await send(`${prefix}/session`, { cookie: firstCookie })).status, 200);
    f.mark("Concrete Workforce fresh challenge creates actual replacement Session");
    const nextTime = Math.max(
      Date.parse(f.state.now) + 1000,
      first.row.created_at.getTime() + 1000,
    );
    await wait(Math.max(0, nextTime - Date.now()));
    f.state.now = new Date(nextTime).toISOString();
    const step = await send(`${prefix}/session/rotate`, {
      method: "POST",
      cookie: firstCookie,
      csrf: currentBody.csrf,
    });
    assert.equal(step.status, 200);
    assert.equal(JSON.parse(step.body).status, "step_up_required");
    assert.equal(step.headers.location, undefined);
    const nextChallenge = challenge(step),
      replaced = await send(nextChallenge.path, nextChallenge);
    assert.equal(replaced.status, 303);
    const nextCookie = cookie(replaced, "__Host-bop-merchant"),
      next = await verifySaved(nextCookie);
    assert(nextCookie !== firstCookie, "ACTUAL_NEW_SESSION_COOKIE_REQUIRED");
    assert.notEqual(next.row.session_id, first.row.session_id);
    assert.equal(next.row.rotated_from_session_id, first.row.session_id);
    assert.notEqual(
      next.secrets.mfa.authorizationTransactionReference,
      first.secrets.mfa.authorizationTransactionReference,
    );
    assert.notEqual(next.secrets.mfa.evidenceReference, first.secrets.mfa.evidenceReference);
    assert.equal((await sessionRow(firstCookie)).status, "Revoked");
    assert.equal((await send(`${prefix}/session`, { cookie: firstCookie })).status, 403);
    const nextResponse = await send(`${prefix}/session`, { cookie: nextCookie });
    assert.equal(nextResponse.status, 200);
    const nextBody = JSON.parse(nextResponse.body);
    assert.equal(nextBody.workspace.brand.lifecycle, "Draft");
    assert.deepEqual(await counts(), { ...baseline, sessions: 2, selections: 2 });
    f.mark("Second initialized Workforce recipient has a genuine independent Session");
    const reviewerStart = await send(`${prefix}/login`),
      reviewerChallenge = challenge(reviewerStart, boundAccount.reviewer.command.subject),
      reviewerCallback = await send(reviewerChallenge.path, reviewerChallenge);
    assert.equal(reviewerCallback.status, 303);
    const reviewerCookie = cookie(reviewerCallback, "__Host-bop-merchant"),
      reviewerSaved = await verifySaved(
        reviewerCookie,
        boundAccount.reviewer.binding.actorReference,
      ),
      reviewerCurrent = await send(`${prefix}/session`, { cookie: reviewerCookie });
    assert.equal(reviewerCurrent.status, 200);
    const reviewerBody = JSON.parse(reviewerCurrent.body);
    assert.equal(
      reviewerBody.workspace.selectedScope.actorReference,
      boundAccount.reviewer.binding.actorReference,
    );
    assert.notEqual(reviewerSaved.row.session_id, next.row.session_id);
    assert.equal(reviewerBody.csrf, reviewerSaved.secrets.csrf);
    await exerciseInitialBrandConfiguration(f, {
      send,
      author: { actorReference, cookie: nextCookie, csrf: nextBody.csrf },
      reviewer: {
        actorReference: boundAccount.reviewer.binding.actorReference,
        cookie: reviewerCookie,
        csrf: reviewerBody.csrf,
      },
      brandReference,
      publishedTemplate,
      nextReference: reference,
      participantState,
    });
    f.mark("Concrete Workforce Unknown logout retains CSRF for genuine retry");
    const input = { method: "POST", cookie: nextCookie, csrf: nextBody.csrf };
    const unknown = await send(`${prefix}/session/logout`, input);
    assert.equal(unknown.status, 200);
    assert.deepEqual(JSON.parse(unknown.body), { status: "logout_unknown" });
    assert.equal(unknown.headers["set-cookie"], undefined);
    assert.equal((await sessionRow(nextCookie)).status, "Revoked");
    assert.equal((await send(`${prefix}/session`, { cookie: nextCookie })).status, 403);
    const attempts = wireCalls.revoke;
    assert.equal(
      (await send(`${prefix}/session/logout`, { ...input, csrf: credential() })).status,
      403,
    );
    assert.equal(wireCalls.revoke, attempts);
    confirmed = true;
    const logout = await send(`${prefix}/session/logout`, input);
    assert.equal(logout.status, 200);
    assert.deepEqual(JSON.parse(logout.body), {
      status: "browser_logout_required",
      logoutUrl: runtime.logoutUrl,
    });
    assert.match(cookie(logout, "__Host-bop-merchant"), /=$/u);
    assert.equal(wireCalls.revoke, attempts + 1);
    assert(wireCalls.jwks > 0);
    assert.equal(wireCalls.token, 4);
    assert(featureReads > 0, "ACTUAL_EMPTY_FEATURE_READ_REQUIRED");
    assert(authenticationScopes > 0, "ACTUAL_WORKFORCE_AUTHENTICATION_SCOPE_REQUIRED");
    assert(
      participantState.memberCalls > previousMemberCalls,
      "ACTUAL_CURRENT_SDK_STATUS_REQUIRED",
    );
    assert.deepEqual(await counts(), { ...baseline, sessions: 2, selections: 2 });
    const reviewerLogout = await send(`${prefix}/session/logout`, {
      method: "POST",
      cookie: reviewerCookie,
      csrf: reviewerBody.csrf,
    });
    assert.equal(reviewerLogout.status, 200);
    assert.equal(JSON.parse(reviewerLogout.body).status, "browser_logout_required");
    assert.equal((await sessionRow(reviewerCookie)).status, "Revoked");
    assert.equal(
      (
        await f.admin.query("SELECT lifecycle FROM bop_tenant.brand WHERE brand_id=$1", [
          brandReference,
        ])
      ).rows[0].lifecycle,
      "Draft",
    );
    f.mark("Ordinary root directory runtime retains fixed-Brand compatibility");
    await server.shutdown("SIGTERM");
    const { brandReference: fixedBrand, ...directoryOptions } = runtimeOptions;
    assert.equal(fixedBrand, brandReference);
    const directoryRuntime = createCognitoMerchantBrandAdministrationRuntime(directoryOptions);
    server = createApiServerRuntime({
      port: 0,
      brandAdministration: directoryRuntime,
      logger: createApiRuntimeLogger({ write: (message) => logs.push(String(message)) }),
    });
    await server.listen();
    const directoryAddress = server.server.address();
    assert(directoryAddress && typeof directoryAddress !== "string");
    base = `http://127.0.0.1:${directoryAddress.port}`;
    const discoverySecrets = await exerciseBrandDiscovery(f, {
      context,
      plan,
      merchantRole: merchant.role,
      send,
      challenge,
      cookie,
      verifySaved,
      participantState,
      reviewerSubject: boundAccount.reviewer.command.subject,
      allocationCount: () => sequence,
    });
    const startupSecrets = await exerciseBrandAdministrationStartup(f, {
      context,
      plan,
      workforce,
      merchant,
      participantState,
      existingCookie: discoverySecrets[0],
      challenge,
      cookie,
      verifySaved,
      withProviderCallback,
      issuer,
      clientId,
      managedLoginOrigin: providerOrigin,
      clientSecret,
    });
    for (const forbidden of [
      clientSecret,
      ...discoverySecrets,
      ...startupSecrets,
      firstCookie,
      nextCookie,
      currentBody.csrf,
      nextBody.csrf,
      boundAccount.command.subject,
      boundAccount.reviewer.command.subject,
      reviewerCookie,
      reviewerBody.csrf,
      "synthetic-workforce-refresh-",
      ...codes.keys(),
      ...[...codes.values()].map((value) => value.nonce),
    ])
      assert.equal(
        logs.some((line) => line.includes(forbidden)),
        false,
        "NATIVE_HTTP_LOG_SECRET_LEAK",
      );
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  } finally {
    participantState.membersEnabled = true;
    f.state.afterQuery = previousAfterQuery;
    try {
      if (server?.server.listening) await server.shutdown("SIGTERM");
    } catch (error) {
      cleanupError = error;
    } finally {
      try {
        restore();
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  if (primaryFailed) throw primaryError;
  if (cleanupError) throw cleanupError;
}
