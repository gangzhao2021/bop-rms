import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import pg from "pg";
import {
  createIdentityActor,
  createPostgresBrowserSessionStore,
  createPostgresCurrentPlatformBrowserSessionSource,
  createPostgresPlatformBrowserSessionStore,
  PlatformBrowserSessionService,
} from "../../bop/identity/src/index.ts";
import { createApiRuntimeLogger, createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { verifyPlatformPermissionPersistence } from "./platform-permission-persistence.mjs";
import { verifyPlatformActorDirectoryPersistence } from "./platform-actor-directory-persistence.mjs";
import { verifyPlatformTemplatePublishingPersistence } from "./platform-template-publishing-persistence.mjs";

const id = (n) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
/** Real isolated PG, minimum nonowner ACL, production stores/service/current source and
 * AES-GCM envelopes. Provider, directory, TOTP attestations and clock are controlled
 * substitutes; this proves local persistence behavior, not live OIDC/TOTP acceptance. */
export async function verifyPlatformBrowserSession(context) {
  const admin = new pg.Client(context.clientConfig),
    client = new pg.Client(context.clientConfig);
  const role = `bop_platform_session_${context.runId}`;
  await admin.connect();
  await client.connect();
  try {
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_identity,platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid) TO ${role}`);
    await admin.query(
      `GRANT SELECT,INSERT,UPDATE ON bop_identity.authentication_session,bop_identity.oidc_authorization_transaction TO ${role}`,
    );
    const acl = await admin.query(
      `SELECT rol.superuser,rol.bypassrls,pg_get_userbyid(c.relowner)<>$1 AS nonowner,has_table_privilege($1,'bop_identity.authentication_session','DELETE') AS deletes,has_table_privilege($1,'bop_identity.authentication_session','TRUNCATE') AS truncates,has_table_privilege($1,'bop_identity.browser_session_selection','SELECT') AS store_selection FROM (SELECT rolsuper AS superuser,rolbypassrls AS bypassrls FROM pg_roles WHERE rolname=$1) rol CROSS JOIN pg_class c WHERE c.oid='bop_identity.authentication_session'::regclass`,
      [role],
    );
    assert.deepEqual(acl.rows, [
      {
        superuser: false,
        bypassrls: false,
        nonowner: true,
        deletes: false,
        truncates: false,
        store_selection: false,
      },
    ]);
    const initial = (
      await admin.query(
        `SELECT to_char((date_trunc('milliseconds',clock_timestamp())-interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`,
      )
    ).rows[0].at;
    // Keep the explicitly controlled expiry/step-up clock in the real database's
    // past, so later Permission/Audit writes preserve their no-future invariant.
    let at = initial,
      counter = 20,
      active = true,
      withdrawAfterInsert = false,
      expireAfterInsert = false,
      reusedProofReference = null,
      duplicateNextInsert = null,
      databaseFailure = null,
      advanceActorClock = false,
      refreshRevocationConfirmed = true,
      lag = 0;
    const key = randomBytes(32),
      pepper = randomBytes(32);
    const requests = [],
      queries = [];
    const configuration = {
      environment: "synthetic",
      issuer: "https://identity.invalid/",
      clientId: "synthetic-platform",
      redirectUri: "https://platform.invalid/platform/callback",
      allowedPostLoginPaths: ["/platform/tenants"],
    };
    const credentials = {
      generate: () => randomBytes(32).toString("base64url"),
      generateUuidV7: () => id(counter++),
    };
    const hasher = {
      hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
      equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
    };
    const envelopes = {
      async encrypt(plaintext, encryptionContext) {
        const iv = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(encryptionContext));
        const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        return {
          algorithm: "SYNTHETIC_AES_256_GCM",
          keyReference: "ephemeral-native-platform",
          ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url"),
          encryptionContext,
        };
      },
      async decrypt(envelope, encryptionContext) {
        assert.equal(envelope.encryptionContext, encryptionContext);
        const bytes = Buffer.from(envelope.ciphertext, "base64url"),
          decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(encryptionContext));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
          "utf8",
        );
      },
    };
    const actor = (
      reference,
      authenticatedAt,
      verificationLevel = "SingleFactor",
      recentMfaAt = null,
    ) =>
      createIdentityActor({
        actorType: "User",
        actorReference: reference,
        accountKind: "Platform",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel,
        authenticatedAt,
        recentMfaAt,
      });
    const transactions = {
      async run(work) {
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
          const result = await work({
            query: async (sql, values) => {
              queries.push(sql);
              let parameters = [...values];
              if (
                duplicateNextInsert !== null &&
                sql.startsWith("INSERT INTO bop_identity.authentication_session")
              ) {
                parameters[0] = duplicateNextInsert;
                duplicateNextInsert = null;
              }
              try {
                return await client.query(sql, parameters);
              } catch (error) {
                databaseFailure = error.code;
                throw error;
              }
            },
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    };
    const options = {
      ...configuration,
      transactions,
      envelopes,
      hasher,
      now: () => at,
      currentActor: async (_tx, reference, authenticatedAt) => {
        if (!active) throw new Error("Controlled directory Actor withdrawal");
        if (advanceActorClock) {
          advanceActorClock = false;
          at = new Date(Date.parse(at) + 5000).toISOString();
        }
        return actor(reference, authenticatedAt);
      },
      onSessionCreated: async () => {
        if (withdrawAfterInsert) active = false;
        if (expireAfterInsert) at = new Date(Date.parse(at) + 5000).toISOString();
      },
    };
    const store = createPostgresPlatformBrowserSessionStore(options);
    const provider = {
      async createAuthorizationUrl(request) {
        requests.push(request);
        return "https://identity.invalid/authorize";
      },
      async exchangeCode(request) {
        const challenge = requests.at(-1);
        assert(challenge);
        assert.equal(request.nonce, challenge.nonce);
        assert.equal(
          createHash("sha256").update(request.codeVerifier).digest("base64url"),
          challenge.codeChallenge,
        );
        const verifiedAt = new Date(Date.parse(at) - lag).toISOString();
        const evidenceReference = reusedProofReference ?? id(counter++);
        reusedProofReference = null;
        return {
          actor: actor(id(1), at, "RecentMfa", verifiedAt),
          tokenBundle: "synthetic-native-platform-token-bundle",
          totp: {
            method: "Totp",
            timestampPrecision: "Millisecond",
            evidenceReference,
            actorReference: id(1),
            issuer: request.issuer,
            clientId: request.clientId,
            nonce: request.nonce,
            authorizationTransactionReference: request.transactionReference,
            authenticatedAt: at,
            verifiedAt,
          },
        };
      },
      async revokeRefreshTokens() {
        return refreshRevocationConfirmed ? "confirmed" : "unknown";
      },
      createLogoutUrl() {
        return "https://identity.invalid/logout?client_id=synthetic-platform&logout_uri=https%3A%2F%2Fplatform.invalid%2Fplatform%2Ftenants";
      },
    };
    const service = () =>
      new PlatformBrowserSessionService({
        configuration,
        store,
        provider,
        credentials,
        hasher,
        envelopes,
        pkce: { challenge: (value) => createHash("sha256").update(value).digest("base64url") },
        now: () => at,
      });
    const currentSource = createPostgresCurrentPlatformBrowserSessionSource(options);
    const current = (cookie) => transactions.run((tx) => currentSource(tx, cookie));
    const callback = async (started) => {
      const request = requests.at(-1);
      assert(request);
      return service().callback({
        code: credentials.generate(),
        state: request.state,
        authCookie: started.cookie.value,
      });
    };
    const cookieOf = (result) => {
      const cookie = result.cookies.find(
        (value) => !value.clear && value.descriptor.name === "__Host-bop-platform",
      );
      assert(cookie);
      return cookie.value;
    };
    const persisted = async (reference) =>
      (
        await admin.query(
          "SELECT status,version,revocation_reason,authenticated_at,rotated_from_session_id,encryption_context,encrypted_secret FROM bop_identity.authentication_session WHERE session_id=$1",
          [reference],
        )
      ).rows[0];
    const sessionCount = async () =>
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM bop_identity.authentication_session WHERE actor_id=$1",
          [id(1)],
        )
      ).rows[0].count;
    const setOffset = (offset) => {
      at = new Date(Date.parse(initial) + offset).toISOString();
    };
    const denied = { code: "BROWSER_SESSION_DENIED" };

    const started = await service().start("/platform/tenants");
    const challenge = requests.at(-1);
    assert.equal(challenge.prompt, "login");
    assert.equal(challenge.requireTotp, true);
    await assert.rejects(
      createPostgresBrowserSessionStore(options).consumeAuthorizationTransaction({
        stateSelectorHash: hasher.hash(challenge.state),
        authCookieSelectorHash: hasher.hash(started.cookie.value),
        consumedAt: at,
      }),
      denied,
    );
    const first = await callback(started),
      firstCookie = cookieOf(first),
      bootstrap = await service().bootstrap(firstCookie);
    assert.equal(first.session.actor.accountKind, "Platform");
    assert.equal(first.session.policy.code, "Privileged");
    assert.equal(bootstrap.recentMfa.sessionReference, first.session.sessionReference);
    assert.equal(
      bootstrap.recentMfa.authorizationTransactionReference,
      challenge.transactionReference,
    );
    assert.equal(bootstrap.recentMfa.verifiedAt, initial);
    assert.deepEqual(
      first.cookies.map((cookie) => cookie.descriptor.name),
      ["__Host-bop-platform-auth", "__Host-bop-platform"],
    );
    await assert.rejects(callback(started), denied);
    const encrypted = await persisted(first.session.sessionReference);
    assert(encrypted.encryption_context.includes(":platform-session:"));
    assert.equal(
      encrypted.encrypted_secret.includes(Buffer.from("synthetic-native-platform-token-bundle")),
      false,
    );
    const oidc = await admin.query(
      "SELECT encryption_context,encrypted_secret FROM bop_identity.oidc_authorization_transaction WHERE transaction_id=$1",
      [challenge.transactionReference],
    );
    assert(oidc.rows[0].encryption_context.includes(":platform-oidc:"));
    const packet = await current(firstCookie);
    assert.equal(Date.parse(packet.validUntil) - Date.parse(packet.observedAt), 5000);
    assert.equal(Object.hasOwn(packet, "brandReference"), false);
    assert.equal(
      /tokenBundle|csrf|brandReference|storeReference/u.test(JSON.stringify(packet)),
      false,
    );
    assert(queries.some((sql) => sql.endsWith("FOR SHARE")));
    await assert.rejects(
      createPostgresBrowserSessionStore(options).resolveSession(hasher.hash(firstCookie)),
      denied,
    );
    await assert.rejects(
      service().authorize({ sessionCookie: firstCookie, csrf: credentials.generate() }),
      denied,
    );

    setOffset(60_000);
    const step = await service().startStepUp({
      sessionCookie: firstCookie,
      csrf: bootstrap.csrf,
      postLoginPath: "/platform/tenants",
    });
    const second = await callback(step),
      secondCookie = cookieOf(second),
      secondBootstrap = await service().bootstrap(secondCookie);
    assert.equal(second.session.authenticatedAt, at);
    assert.notEqual(second.session.authenticatedAt, first.session.authenticatedAt);
    assert.equal(second.session.rotatedFromSessionReference, first.session.sessionReference);
    assert.equal((await persisted(first.session.sessionReference)).status, "Revoked");
    await assert.rejects(service().bootstrap(firstCookie), denied);
    assert.equal(
      (await current(secondCookie)).recentMfa.sessionReference,
      second.session.sessionReference,
    );
    assert.notEqual(
      secondBootstrap.recentMfa.evidenceReference,
      bootstrap.recentMfa.evidenceReference,
    );
    assert.notEqual(
      secondBootstrap.recentMfa.authorizationTransactionReference,
      bootstrap.recentMfa.authorizationTransactionReference,
    );

    for (const failure of ["insert", "Actor withdrawn", "original lease expired", "old proof"]) {
      const before = await sessionCount();
      const originalAt = at;
      const next = await service().startStepUp({
        sessionCookie: secondCookie,
        csrf: secondBootstrap.csrf,
        postLoginPath: "/platform/tenants",
      });
      // Collide with a different persisted Session, preserving the no-self-rotation CHECK.
      if (failure === "insert") duplicateNextInsert = first.session.sessionReference;
      else if (failure === "Actor withdrawn") withdrawAfterInsert = true;
      else if (failure === "original lease expired") expireAfterInsert = true;
      else reusedProofReference = secondBootstrap.recentMfa.evidenceReference;
      await assert.rejects(callback(next), denied);
      if (failure === "insert") assert.equal(databaseFailure, "23505");
      else if (failure === "Actor withdrawn") assert.equal(active, false);
      else if (failure === "original lease expired")
        assert.equal(Date.parse(at) - Date.parse(originalAt), 5000);
      active = true;
      withdrawAfterInsert = false;
      expireAfterInsert = false;
      at = originalAt;
      assert.equal(await sessionCount(), before);
      const original = await persisted(second.session.sessionReference);
      assert.equal(original.status, "Active");
      assert.equal(original.version, second.session.version);
      assert.equal(
        (await current(secondCookie)).session.sessionReference,
        second.session.sessionReference,
      );
    }
    const readAt = at;
    advanceActorClock = true;
    await assert.rejects(current(secondCookie), denied);
    assert.equal(Date.parse(at) - Date.parse(readAt), 5000);
    at = readAt;
    await admin.query(
      "UPDATE bop_identity.authentication_session SET authenticated_at=authenticated_at+interval '1 microsecond',created_at=created_at+interval '1 microsecond',last_seen_at=last_seen_at+interval '1 microsecond' WHERE session_id=$1",
      [second.session.sessionReference],
    );
    await assert.rejects(current(secondCookie), denied);
    await admin.query(
      "UPDATE bop_identity.authentication_session SET authenticated_at=$2,created_at=$3,last_seen_at=$4 WHERE session_id=$1",
      [
        second.session.sessionReference,
        second.session.authenticatedAt,
        second.session.createdAt,
        second.session.lastSeenAt,
      ],
    );
    assert.equal(
      (await current(secondCookie)).session.sessionReference,
      second.session.sessionReference,
    );

    // Proof precedes callback by one minute, so its business expiry is earlier than idle expiry.
    setOffset(120_000);
    const freshStart = await service().start("/platform/tenants");
    setOffset(240_000);
    lag = 60_000;
    const delayed = await callback(freshStart),
      delayedCookie = cookieOf(delayed);
    setOffset(1_080_000 - 2000);
    assert.equal(
      (await current(delayedCookie)).validUntil,
      new Date(Date.parse(initial) + 1_080_000).toISOString(),
    );
    setOffset(1_080_000);
    const expired = await service().bootstrap(delayedCookie);
    assert.equal(expired.recentMfaRequired, true);
    await assert.rejects(current(delayedCookie), denied);
    await assert.rejects(
      service().authorize({ sessionCookie: delayedCookie, csrf: expired.csrf }),
      denied,
    );
    lag = 0;
    const recoveredStart = await service().startStepUp({
      sessionCookie: delayedCookie,
      csrf: expired.csrf,
      postLoginPath: "/platform/tenants",
    });
    const recovered = await callback(recoveredStart),
      recoveredCookie = cookieOf(recovered);
    const recoveredBootstrap = await service().bootstrap(recoveredCookie);
    assert.equal((await current(recoveredCookie)).recentMfa.verifiedAt, at);
    assert.equal(
      (await service().authorize({ sessionCookie: recoveredCookie, csrf: recoveredBootstrap.csrf }))
        .session.sessionReference,
      recovered.session.sessionReference,
    );
    await assert.rejects(service().bootstrap(delayedCookie), denied);
    assert.equal((await persisted(delayed.session.sessionReference)).status, "Revoked");
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM bop_identity.browser_session_selection WHERE actor_id=$1",
          [id(1)],
        )
      ).rows[0].count,
      0,
    );

    // Compose the actual server entry with the same minimum-role persistence;
    // only the already-declared external Provider/directory ports are synthetic.
    const logs = [];
    const runtime = createApiServerRuntime({
      port: 0,
      logger: createApiRuntimeLogger({ write: (message) => logs.push(String(message)) }),
      platformAuthenticationRuntime: {
        identity: {
          configuration: {
            ...configuration,
            redirectUri: "https://platform.invalid/platform/auth/callback",
          },
          provider,
          credentials,
          hasher,
          envelopes,
          pkce: { challenge: (value) => createHash("sha256").update(value).digest("base64url") },
        },
        transactions,
        currentActor: options.currentActor,
        now: () => at,
        exactOrigin: "https://platform.invalid",
        acceptedHost: "platform.invalid",
        authorizationOrigin: "https://identity.invalid",
        logoutUrl: provider.createLogoutUrl(),
      },
    });
    await runtime.listen();
    try {
      const address = runtime.server.address();
      assert(address && typeof address !== "string");
      const origin = `http://127.0.0.1:${address.port}`;
      const send = (
        path,
        { method = "GET", cookie = null, csrf = null, site = "same-origin" } = {},
      ) =>
        new Promise((resolve, reject) => {
          const request = httpRequest(
            `${origin}${path}`,
            {
              method,
              headers: {
                host: "platform.invalid",
                origin: "https://platform.invalid",
                "sec-fetch-site": site,
                ...(cookie === null ? {} : { cookie }),
                ...(csrf === null ? {} : { "x-bop-csrf": csrf }),
                ...(method === "POST" ? { "content-type": "application/json" } : {}),
              },
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("error", reject);
              response.on("end", () =>
                resolve({ status: response.statusCode, headers: response.headers, body }),
              );
            },
          );
          request.on("error", reject);
          request.end(method === "POST" ? "{}" : undefined);
        });
      const cookieHeader = (response, name) => {
        const values = response.headers["set-cookie"] ?? [];
        const match = values.find((value) => value.startsWith(`${name}=`));
        assert(match);
        assert.match(match, /; Path=\/; Secure; HttpOnly; SameSite=Lax/u);
        return match.split(";")[0];
      };
      const login = await send("/platform/auth/login");
      assert.equal(login.status, 303);
      assert.equal(login.headers.location, "https://identity.invalid/authorize");
      const originalAuthCookie = cookieHeader(login, "__Host-bop-platform-auth");
      const callbackPath = `/platform/auth/callback?code=${encodeURIComponent("synthetic/code\\value")}&state=${requests.at(-1).state}`;
      const signedIn = await send(callbackPath, { cookie: originalAuthCookie, site: "cross-site" });
      assert.equal(signedIn.status, 303);
      assert.equal(signedIn.headers.location, "/platform/tenants");
      const sessionCookie = cookieHeader(signedIn, "__Host-bop-platform");
      const replay = await send(callbackPath, { cookie: originalAuthCookie, site: "cross-site" });
      assert.equal(replay.status, 403);
      assert.match(cookieHeader(replay, "__Host-bop-platform-auth"), /=$/u);
      const currentHttp = await send("/platform/auth/session", { cookie: sessionCookie });
      assert.equal(currentHttp.status, 200);
      assert.equal(currentHttp.headers["cache-control"], "no-store");
      const publicSession = JSON.parse(currentHttp.body);
      assert.deepEqual(Object.keys(publicSession).sort(), [
        "authenticated",
        "csrf",
        "recentMfaRequired",
        "session",
      ]);
      assert.equal(publicSession.authenticated, true);
      assert.equal(publicSession.recentMfaRequired, false);
      assert.equal(publicSession.session.actorReference, id(1));
      assert.equal(
        /tokenBundle|recentMfaAt|evidenceReference|permission|brandReference|storeReference/u.test(
          currentHttp.body,
        ),
        false,
      );
      assert.equal((await send("/platform/tenants", { cookie: sessionCookie })).status, 404);
      const beforeInvalidStep = await sessionCount();
      assert.equal(
        (
          await send("/platform/auth/step-up", {
            method: "POST",
            cookie: sessionCookie,
            csrf: credentials.generate(),
          })
        ).status,
        403,
      );
      assert.equal(await sessionCount(), beforeInvalidStep);
      at = new Date(Date.parse(at) + 1000).toISOString();
      const httpStep = await send("/platform/auth/step-up", {
        method: "POST",
        cookie: sessionCookie,
        csrf: publicSession.csrf,
      });
      assert.equal(httpStep.status, 200);
      assert.equal(httpStep.headers.location, undefined);
      assert.deepEqual(JSON.parse(httpStep.body), {
        status: "step_up_required",
        authorizationUrl: "https://identity.invalid/authorize",
      });
      const stepCookie = cookieHeader(httpStep, "__Host-bop-platform-auth");
      const stepped = await send(
        `/platform/auth/callback?code=${credentials.generate()}&state=${requests.at(-1).state}`,
        { cookie: stepCookie, site: "cross-site" },
      );
      assert.equal(stepped.status, 303);
      const nextCookie = cookieHeader(stepped, "__Host-bop-platform");
      assert.notEqual(nextCookie, sessionCookie);
      assert.equal((await persisted(publicSession.session.sessionReference)).status, "Revoked");
      assert.equal((await send("/platform/auth/session", { cookie: sessionCookie })).status, 403);
      const nextBootstrap = await send("/platform/auth/session", { cookie: nextCookie });
      assert.equal(nextBootstrap.status, 200);
      const nextPublic = JSON.parse(nextBootstrap.body);
      await verifyPlatformPermissionPersistence(context, {
        actorReference: nextPublic.session.actorReference,
        now: () => at,
        currentIdentity: (tx) => currentSource(tx, nextCookie.slice(nextCookie.indexOf("=") + 1)),
      });
      refreshRevocationConfirmed = false;
      const unknown = await send("/platform/auth/logout", {
        method: "POST",
        cookie: nextCookie,
        csrf: nextPublic.csrf,
      });
      assert.equal(unknown.status, 503);
      assert.equal(unknown.headers["set-cookie"], undefined);
      assert.equal((await persisted(nextPublic.session.sessionReference)).status, "Revoked");
      assert.equal((await send("/platform/auth/session", { cookie: nextCookie })).status, 403);
      refreshRevocationConfirmed = true;
      const logout = await send("/platform/auth/logout", {
        method: "POST",
        cookie: nextCookie,
        csrf: nextPublic.csrf,
      });
      assert.equal(logout.status, 200);
      assert.deepEqual(JSON.parse(logout.body), {
        status: "browser_logout_required",
        logoutUrl: provider.createLogoutUrl(),
      });
      assert.match(cookieHeader(logout, "__Host-bop-platform"), /=$/u);
      assert.equal(
        logs.some(
          (line) =>
            line.includes("synthetic-native-platform-token-bundle") ||
            line.includes(publicSession.csrf) ||
            line.includes(nextPublic.csrf) ||
            line.includes(requests.at(-1).state),
        ),
        false,
      );
    } finally {
      await runtime.shutdown("SIGTERM");
    }
    await verifyPlatformActorDirectoryPersistence(context, { now: () => at, hasher, envelopes });
    await verifyPlatformTemplatePublishingPersistence(context, {
      now: () => at,
      hasher,
      envelopes,
    });
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}
