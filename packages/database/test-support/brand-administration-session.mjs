import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL, URLSearchParams } from "node:url";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
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
  readClosedRecord,
  parseCanonicalInstant,
  parseRawBrowserCredential,
  parseWorkforceSessionMfa,
  parseExactHttpsUri,
  createPostgresBrowserBrandSessionSelectionStore,
} from "../../bop/identity/src/index.ts";
import {
  createFeatureControlAdministrationDefinition,
  createPostgresFeatureControlInitialDraftStore,
  createPostgresFeatureControlAdministrationMutationStore,
  executeFeatureControlAdministration,
} from "../../bop/feature-control/src/index.ts";
import { createPersistentBrandAdministrationBff } from "../../../apps/api/dist/persistent-brand-administration-bff.js";
import {
  createMerchantCurrentBrandScope,
  createMerchantCurrentBrandAdministrationScope,
} from "../../../apps/api/dist/merchant-current-brand-scope.js";
import { createMerchantBrandAdministrationRuntime } from "../../../apps/api/dist/merchant-brand-administration-runtime.js";
import { createMerchantBrandAdministrationRouter } from "../../../apps/api/dist/merchant-brand-administration-http.js";
import {
  parseBrandCatalogSourceRegister,
  brandCatalogSourceIntentDigest,
  parseBrandCatalogSourceCurrent,
  parseBrandCatalogSourceExact,
  parseBrandCatalogSourceReceipt,
  parseBrandCatalogSourceScope,
} from "../../rms/catalog/src/index.ts";

const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
const express = require("express");

const id = (n) => `01902525-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z";

/** InternalTest only. OIDC, currentActor, clock and ephemeral AES/HMAC keys are
 * local synthetic ports, not live Provider/identity evidence. BrowserSession,
 * encrypted persistence, 025 selection, actual Brand/null-Store contexts,
 * Membership, Permission, Feature administration/evaluation and Audit are real.
 * Default mode exercises the production BFF factory. catalogHttp mode additionally
 * exercises emitted runtime/router and actual HTTP start/callback/Catalog routes.
 * administrativeDraft mode uses real Draft identity with explicitly isolated
 * Membership/policy/Published Feature fixtures. It proves current admission,
 * not initial provisioning or Feature publication authority for a Draft Brand.
 * No mode proves live Provider, TLS, rendered UI or Brand discovery.
 */
export async function exerciseBrandAdministrationSession(
  context,
  { catalogHttp = false, administrativeDraft = false } = {},
) {
  assert.equal(catalogHttp && administrativeDraft, false);
  const admin = new pg.Client(context.clientConfig);
  const role = `brand_session_${context.runId}`;
  assert.match(role, /^[a-z0-9_]+$/u);
  const brand = id(1),
    author = id(2),
    reviewer = id(3),
    outsider = id(4),
    draftBrand = id(5);
  const from = new Date(Date.parse(at) - 60000).toISOString();
  const until = new Date(Date.parse(at) + 3600000).toISOString();
  const path = `/app/organization/brands/${brand}`;
  const key = randomBytes(32),
    pepper = randomBytes(32);
  let nextId = 1000,
    clockMs = Date.parse(at),
    stage = "Setup",
    identityPhase = "NotStarted",
    sqlState = "none",
    sqlAsset = "none",
    createdRole = false,
    injection,
    afterFeatureCommit;
  const identityTrace = [];
  let providerReached = false,
    sessionInsertReached = false,
    currentActorReached = false;
  function recordIdentityPhase(value) {
    identityPhase = value;
    providerReached ||= value === "ProviderExchange";
    sessionInsertReached ||= value === "SessionInsert";
    currentActorReached ||= value === "CurrentActor";
    identityTrace.push(value);
    if (identityTrace.length > 16) identityTrace.shift();
  }
  const reference = () => id(nextId++);
  const now = () => new Date(clockMs).toISOString();
  const actors = new Map(
    [author, reviewer, outsider].map((actorReference) => [
      actorReference,
      createIdentityActor({
        actorType: "User",
        actorReference,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: from,
        recentMfaAt: null,
      }),
    ]),
  );
  const suspendedActors = new Set();
  let suspendedActorReads = 0;
  const hasher = {
    hash: (value) => createHmac("sha256", pepper).update(value).digest("hex"),
    equals: (a, b) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex")),
  };
  const credentials = {
    generate: () => randomBytes(32).toString("base64url"),
    generateUuidV7: reference,
  };
  const envelopes = {
    async encrypt(plaintext, encryptionContext) {
      recordIdentityPhase("EnvelopeEncrypt");
      const nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(encryptionContext));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "ephemeral-brand-session-test-key",
        encryptionContext,
        ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url"),
      };
    },
    async decrypt(envelope, encryptionContext) {
      recordIdentityPhase("EnvelopeDecrypt");
      assert.ok(envelope.encryptionContext === encryptionContext);
      const raw = Buffer.from(envelope.ciphertext, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(encryptionContext));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plaintext = Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      recordIdentityPhase("EnvelopeDecrypted");
      if (encryptionContext.includes(":oidc:")) {
        recordIdentityPhase("AuthorizationJson");
        const secrets = JSON.parse(plaintext);
        recordIdentityPhase("AuthorizationClosedShape");
        readClosedRecord(secrets, ["profile", "nonce", "codeVerifier", "startedAt", "previous"]);
        recordIdentityPhase("AuthorizationProfile");
        assert.equal(secrets.profile, "WorkforceOidcV1");
        recordIdentityPhase("AuthorizationStartedAt");
        parseCanonicalInstant(secrets.startedAt);
        assert.ok(secrets.startedAt <= now());
        recordIdentityPhase("AuthorizationCredentials");
        parseRawBrowserCredential(secrets.nonce);
        parseRawBrowserCredential(secrets.codeVerifier);
        recordIdentityPhase(
          secrets.startedAt === now()
            ? "AuthorizationSecretsValidatedSameObservation"
            : "AuthorizationSecretsValidatedEarlierObservation",
        );
      }
      if (encryptionContext.includes(":session:")) {
        recordIdentityPhase("SessionJson");
        const secrets = JSON.parse(plaintext);
        recordIdentityPhase("SessionClosedShape");
        readClosedRecord(secrets, ["profile", "issuer", "clientId", "tokenBundle", "csrf", "mfa"]);
        recordIdentityPhase("SessionProfile");
        assert.equal(secrets.profile, "WorkforceBrowserSessionV1");
        recordIdentityPhase("SessionConfiguration");
        assert.equal(secrets.issuer, issuer);
        assert.equal(parseExactHttpsUri(secrets.issuer), issuer);
        assert.equal(secrets.clientId, clientId);
        recordIdentityPhase("SessionMfaProof");
        const mfa = parseWorkforceSessionMfa(secrets.mfa);
        assert.ok(mfa.authenticatedAt <= now());
        recordIdentityPhase("SessionCsrf");
        parseRawBrowserCredential(secrets.csrf);
        recordIdentityPhase("SessionSecretsValidated");
      }
      return plaintext;
    },
  };
  const featureRead = (sql) => sql.includes("FROM bop_feature_control.control_version v");
  const selectionInsert = (sql) =>
    sql.startsWith("INSERT INTO bop_identity.browser_brand_session_selection");
  const transactions = {
    async run(work) {
      const client = new pg.Client({
        ...context.clientConfig,
        connectionTimeoutMillis: 10000,
        query_timeout: 10000,
      });
      await client.connect();
      let sawFeature = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await client.query("SET LOCAL ROLE " + role);
        const tx = {
          async query(sql, values) {
            if (sql.startsWith("INSERT INTO bop_identity.authentication_session"))
              recordIdentityPhase("SessionInsert");
            else if (sql.includes("FROM bop_identity.authentication_session"))
              recordIdentityPhase("SessionRead");
            else if (selectionInsert(sql)) recordIdentityPhase("SelectionInsert");
            else if (sql.includes("FROM bop_membership.membership"))
              recordIdentityPhase("MembershipRead");
            else if (sql.includes("FROM bop_permission.")) recordIdentityPhase("PermissionRead");
            let result;
            try {
              result = await client.query(sql, [...values]);
            } catch (error) {
              sqlState = /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : "none";
              sqlAsset =
                /\b(bop_identity|bop_tenant|bop_membership|bop_permission|bop_feature_control|rms_catalog|platform_audit)\.[a-z_]+/u.exec(
                  sql,
                )?.[0] ?? "none";
              throw error;
            }
            sawFeature ||= featureRead(sql);
            if (injection?.matches(sql)) {
              const pending = injection;
              injection = undefined;
              pending.fired = true;
              // Controlled isolated-fixture writer, never application authority.
              // Same-transaction withdrawal models a later checkpoint and must
              // disappear together with any tentative Session/selection on failure.
              await client.query("RESET ROLE");
              try {
                const changed = await pending.change(client);
                if (changed !== undefined) assert.equal(changed.rowCount, 1);
                pending.changed = true;
              } finally {
                await client.query("SET LOCAL ROLE " + role);
              }
            }
            return result;
          },
        };
        const result = await work(tx);
        await client.query("COMMIT");
        if (sawFeature && afterFeatureCommit) {
          const next = afterFeatureCommit;
          afterFeatureCommit = undefined;
          next();
        }
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  const currentActor = async (_tx, who, authenticatedAt) => {
    recordIdentityPhase("CurrentActor");
    const actor = actors.get(who);
    assert.ok(actor);
    const suspended = suspendedActors.has(who);
    if (suspended) suspendedActorReads++;
    // IdentityActor represents usable Active identity only. Withdrawal changes
    // the synthetic directory state; the next owning read must reject it.
    return createIdentityActor({
      ...actor,
      authenticatedAt,
      verificationLevel: "SingleFactor",
      recentMfaAt: null,
      status: suspended ? "Suspended" : actor.status,
    });
  };
  const providerOrigin = "https://provider.example.test",
    issuer = `${providerOrigin}/`,
    clientId = "synthetic-brand-session";
  const logoutUrl = `${providerOrigin}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent("https://merchant.example.test/app/organization/brands")}`;
  const source = {
    identity: { hasher, envelopes, configuration: { environment: "synthetic", issuer, clientId } },
    transactions,
    currentActor,
    now,
  };
  const resolve = createMerchantCurrentBrandScope(source);
  function entry(who = author, target = brand) {
    let authorization,
      exchanges = 0,
      revocations = 0,
      logoutConfirmed = false;
    const authorizations = new Map();
    const targetPath = `/app/organization/brands/${target}`;
    const challenge = (value) => createHash("sha256").update(value).digest("base64url");
    const persistence = {
      ...source,
      brandReference: target,
      identity: {
        configuration: {
          issuer,
          clientId,
          redirectUri: "https://merchant.example.test/merchant/organization/brands/callback",
          environment: "synthetic",
          allowedPostLoginPaths: [targetPath],
        },
        credentials,
        hasher,
        envelopes,
        pkce: { challenge },
        provider: {
          async createAuthorizationUrl(input) {
            assert.equal(input.prompt, "login");
            assert.equal(input.requireTotp, true);
            authorization = input;
            authorizations.set(input.transactionReference, input);
            return "https://provider.example.test/authorize";
          },
          async exchangeCode(input) {
            recordIdentityPhase("ProviderExchange");
            const original = authorizations.get(input.transactionReference);
            assert.ok(original);
            assert.ok(input.nonce === original.nonce);
            assert.ok(challenge(input.codeVerifier) === original.codeChallenge);
            assert.ok(input.redirectUri === original.redirectUri);
            assert.equal(input.transactionReference, original.transactionReference);
            exchanges++;
            const authenticatedAt = now();
            const actual = createIdentityActor({
              ...actors.get(who),
              authenticatedAt,
              verificationLevel: "RecentMfa",
              recentMfaAt: authenticatedAt,
            });
            recordIdentityPhase("ProviderProofConstructed");
            return {
              actor: actual,
              tokenBundle: "synthetic-brand-token-bundle",
              totp: {
                method: "Totp",
                timestampPrecision: "Millisecond",
                evidenceReference: reference(),
                actorReference: who,
                issuer,
                clientId,
                authorizationTransactionReference: original.transactionReference,
                nonce: original.nonce,
                authenticatedAt,
                verifiedAt: authenticatedAt,
              },
            };
          },
          async revokeRefreshTokens(bundle) {
            assert.ok(bundle === "synthetic-brand-token-bundle");
            revocations++;
            return logoutConfirmed ? "confirmed" : "unknown";
          },
          createLogoutUrl() {
            return logoutUrl;
          },
        },
      },
    };
    const bff = createPersistentBrandAdministrationBff(persistence);
    return {
      bff,
      persistence,
      authorization: () => authorization,
      exchanges: () => exchanges,
      revocations: () => revocations,
      confirmLogout: () => {
        logoutConfirmed = true;
      },
      async stepUp(input, { proveCas = false } = {}) {
        const start = await bff.rotate(input);
        assert.equal(start.authorizationUrl, `${providerOrigin}/authorize`);
        const firstCallback = {
          code: credentials.generate(),
          state: authorization.state,
          authCookie: start.cookie.value,
        };
        let staleCallback;
        if (proveCas) {
          const second = await bff.rotate(input);
          staleCallback = {
            code: credentials.generate(),
            state: authorization.state,
            authCookie: second.cookie.value,
          };
        }
        const result = await bff.callback(firstCallback);
        if (staleCallback) {
          const before = await countState();
          await assert.rejects(bff.callback(staleCallback));
          assert.deepEqual(await countState(), before);
        }
        const cookie = result.cookies.find(
          (value) => !value.clear && value.descriptor.name === "__Host-bop-merchant",
        );
        assert.ok(cookie);
        return { session: result.session, cookie };
      },
      async prepare() {
        const start = await bff.start(targetPath);
        return {
          code: credentials.generate(),
          state: authorization.state,
          authCookie: start.cookie.value,
        };
      },
      async login() {
        const callback = await this.prepare();
        const result = await bff.callback(callback);
        assert.equal(result.postLoginPath, targetPath);
        assert.ok(result.cookies.some((cookie) => cookie.clear));
        const cookie = result.cookies.find((cookie) => !cookie.clear);
        assert.ok(cookie);
        return { actor: who, session: result.session, cookie: cookie.value, callback };
      },
    };
  }
  async function verifyStrongSessionProof(login, bff) {
    stage = "ActualEncryptedWorkforceSessionProof";
    const row = (
      await admin.query(
        "SELECT encrypted_secret,cipher_algorithm,key_reference,encryption_context FROM bop_identity.authentication_session WHERE session_id=$1",
        [login.session.sessionReference],
      )
    ).rows[0];
    const envelope = {
      algorithm: row.cipher_algorithm,
      keyReference: row.key_reference,
      ciphertext: row.encrypted_secret.toString("base64url"),
      encryptionContext: row.encryption_context,
    };
    const secrets = JSON.parse(await envelopes.decrypt(envelope, row.encryption_context));
    assert.equal(secrets.profile, "WorkforceBrowserSessionV1");
    assert.equal(secrets.mfa.sessionReference, login.session.sessionReference);
    assert.equal(secrets.mfa.actorReference, login.actor);
    assert.equal(secrets.mfa.authenticatedAt, login.session.authenticatedAt);
    const auth = (
      await admin.query(
        "SELECT consumed_at,created_at FROM bop_identity.oidc_authorization_transaction WHERE transaction_id=$1",
        [secrets.mfa.authorizationTransactionReference],
      )
    ).rows[0];
    assert.ok(auth?.consumed_at instanceof Date);
    assert.ok(auth.created_at.getTime() <= Date.parse(secrets.mfa.verifiedAt));
    const wrong = await envelopes.encrypt(
      JSON.stringify({ ...secrets, mfa: { ...secrets.mfa, sessionReference: reference() } }),
      row.encryption_context,
    );
    await admin.query(
      "UPDATE bop_identity.authentication_session SET encrypted_secret=$2 WHERE session_id=$1",
      [login.session.sessionReference, Buffer.from(wrong.ciphertext, "base64url")],
    );
    try {
      await assert.rejects(bff.bootstrap(login.cookie));
    } finally {
      await admin.query(
        "UPDATE bop_identity.authentication_session SET encrypted_secret=$2 WHERE session_id=$1",
        [login.session.sessionReference, row.encrypted_secret],
      );
    }
    assert.equal((await bff.bootstrap(login.cookie)).recentMfaRequired, false);
  }
  async function expireMfaWithoutExpiringSession(login, bff) {
    stage = "ExpiredSameSessionMfaBootstrap";
    const seen = new Date(Date.parse(login.session.authenticatedAt) + 840000).toISOString();
    const idle = new Date(Date.parse(seen) + 900000).toISOString();
    // Controlled genuine prior interactive activity, without changing encrypted proof.
    await admin.query(
      "UPDATE bop_identity.authentication_session SET last_seen_at=$2,idle_expires_at=$3 WHERE session_id=$1",
      [login.session.sessionReference, seen, idle],
    );
    clockMs = Date.parse(login.session.authenticatedAt) + 900000;
    const expired = await bff.bootstrap(login.cookie);
    assert.equal(expired.recentMfaRequired, true);
    assert.equal(expired.workspace, null);
    await assert.rejects(bff.authorize({ sessionCookie: login.cookie, csrf: expired.csrf }));
    return expired;
  }
  const countState = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM bop_identity.authentication_session) AS sessions,(SELECT count(*)::int FROM bop_identity.browser_brand_session_selection) AS selections,(SELECT count(*)::int FROM bop_tenant.store) AS stores,(SELECT count(*)::int FROM bop_membership.store_assignment) AS assignments,(SELECT count(*)::int FROM bop_identity.browser_session_selection) AS legacy_selections",
      )
    ).rows[0];
  const grantActions = [
    "organization.manage",
    "feature.control.change",
    "feature.control.approve",
    "feature.control.publish",
    "feature.control.activate",
    ...(catalogHttp ? ["catalog.manage"] : []),
  ];
  const membershipIds = new Map([
    [author, id(10)],
    [reviewer, id(11)],
  ]);
  const grants = new Map();
  const featureAction = {
    CreateDraft: "feature.control.change",
    Submit: "feature.control.change",
    Approve: "feature.control.approve",
    Publish: "feature.control.publish",
    Disable: "feature.control.activate",
  };
  async function authority(tx, login, action) {
    const current = await resolve(tx, login.cookie, login.session.sessionReference);
    assert.equal(current.context.scopeKind, "Brand");
    assert.equal(current.context.store, null);
    assert.equal(current.tenantReference, brand);
    const decision = await current.authorizeAction(action);
    assert.equal(decision.effect, "Allow");
    assert.equal(decision.scopeKind, "Brand");
    const databaseScope = (
      await tx.query(
        "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
        [],
      )
    ).rows[0];
    assert.deepEqual(databaseScope, { brand, store: "" });
    current.assertCurrent();
    return { current, decision };
  }
  const featureAuthority = (login) => ({
    async holdUntilTransactionCompletes(tx, request) {
      assert.equal(request.actorReference, login.actor);
      assert.equal(request.brandReference, brand);
      assert.equal(request.storeReference, null);
      const action = featureAction[request.operation];
      assert.ok(action);
      if (request.operation === "CreateDraft") assert.equal(request.action, action);
      await authority(tx, login, action);
    },
  });
  let definition;
  async function mutateFeature(operation, login, changes) {
    const next = createFeatureControlAdministrationDefinition({
      ...definition,
      ...changes,
      version: definition.version + 1,
    });
    const evaluated = await transactions.run((tx) =>
      authority(tx, login, featureAction[operation]),
    );
    definition = await executeFeatureControlAdministration(
      {
        tenantContext: evaluated.current.context,
        operation,
        expectedVersion: definition.version,
        idempotencyKey: reference(),
        current: definition,
        next,
        auditId: reference(),
        correlationId: reference(),
        sourceChannel: "API",
      },
      {
        authorization: {
          authorize: () =>
            transactions.run(
              async (tx) => (await authority(tx, login, featureAction[operation])).decision,
            ),
        },
        unitOfWork: createPostgresFeatureControlAdministrationMutationStore({
          brandReference: brand,
          storeReference: null,
          actorReference: login.actor,
          clock: { now },
          transactions,
          authority: featureAuthority(login),
          dependencies: {
            async withHeldCurrentPublicationEvidence(_tx, input, work) {
              assert.deepEqual(input.current.dependencies, []);
              assert.deepEqual(input.next.dependencies, []);
              return work();
            },
          },
        }),
      },
    );
  }
  async function rejectsAfter(matches, change, work) {
    const pending = { matches, change, fired: false, changed: false };
    injection = pending;
    try {
      await assert.rejects(work);
      assert.equal(pending.fired, true, "the intended current-fact checkpoint must execute");
      assert.equal(pending.changed, true, "a fixture mutation error is not withdrawal evidence");
    } finally {
      injection = undefined;
    }
  }
  async function catalogHttpJourney(authorEntry) {
    let configureCalls = 0,
      configurationIds = 0,
      catalogIds = 0;
    const runtime = createMerchantBrandAdministrationRuntime({
      persistence: authorEntry.persistence,
      exactOrigin: "https://merchant.example.test",
      acceptedHost: "merchant.example.test",
      authorizationOrigin: providerOrigin,
      logoutUrl,
      configuration: {
        configure() {
          configureCalls++;
          throw new Error("NATIVE_CONFIGURATION_SOURCE_UNAVAILABLE");
        },
        nextReference() {
          configurationIds++;
          throw new Error("NATIVE_CONFIGURATION_SOURCE_UNAVAILABLE");
        },
      },
      catalogSource: {
        nextReference(kind) {
          assert.ok(kind === "Source" || kind === "Audit");
          catalogIds++;
          return reference();
        },
      },
    });
    const app = express(),
      server = createServer(app);
    app.use("/merchant/organization/brands", createMerchantBrandAdministrationRouter(runtime));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const root = `http://127.0.0.1:${address.port}/merchant/organization/brands`;
    function request(route, { body, cookie, csrf, loseResponse = false } = {}) {
      return new Promise((resolve, reject) => {
        const encoded = body === undefined ? undefined : JSON.stringify(body);
        const req = httpRequest(
          root + route,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Host: "merchant.example.test",
              Origin: "https://merchant.example.test",
              "Sec-Fetch-Site": "same-origin",
              ...(cookie === undefined ? {} : { Cookie: cookie }),
              ...(csrf === undefined ? {} : { "X-BOP-CSRF": csrf }),
              ...(encoded === undefined
                ? {}
                : {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(encoded),
                  }),
            },
          },
          (response) => {
            if (loseResponse) {
              // Headers are emitted only after the actual owning transaction
              // COMMIT. Drop the connection before consuming any terminal body.
              response.destroy();
              req.destroy();
              reject(new Error("NATIVE_CATALOG_LOST_RESPONSE"));
              return;
            }
            const chunks = [];
            let bytes = 0;
            response.on("error", reject);
            response.on("data", (chunk) => {
              bytes += chunk.length;
              if (bytes > 65536) {
                response.destroy();
                reject(new Error("NATIVE_HTTP_RESPONSE_TOO_LARGE"));
              } else chunks.push(chunk);
            });
            response.on("end", () => {
              try {
                const text = Buffer.concat(chunks).toString("utf8");
                resolve({
                  status: response.statusCode,
                  headers: response.headers,
                  payload: response.headers["content-type"]?.startsWith("application/json")
                    ? JSON.parse(text)
                    : null,
                });
              } catch {
                reject(new Error("NATIVE_HTTP_RESPONSE_INVALID"));
              }
            });
          },
        );
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("NATIVE_HTTP_TIMEOUT")));
        req.end(encoded);
      });
    }
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_catalog.brand_catalog_source WHERE brand_id=$1) sources,(SELECT count(*)::int FROM rms_catalog.brand_catalog_source_operation WHERE brand_id=$1) operations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND action_code IN ('BRAND_CATALOG_SOURCE_REGISTERED','BRAND_CATALOG_SOURCE_ABANDONED')) audits",
          [brand],
        )
      ).rows[0];
    try {
      stage = "CatalogHttpMinimalRole";
      assert.deepEqual(await counts(), { sources: 0, operations: 0, audits: 0 });
      for (const table of ["brand_catalog_source", "brand_catalog_source_operation"]) {
        for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"])
          assert.equal(
            (
              await admin.query("SELECT has_table_privilege($1,$2,$3) allowed", [
                role,
                "rms_catalog." + table,
                privilege,
              ])
            ).rows[0].allowed,
            false,
          );
      }
      assert.equal(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'rms_catalog.product','SELECT') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      for (const signature of [
        "rms_catalog.brand_catalog_source_insert_guard()",
        "rms_catalog.brand_catalog_source_coherence_guard()",
      ])
        assert.equal(
          (
            await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
              role,
              signature,
            ])
          ).rows[0].allowed,
          false,
        );
      stage = "CatalogHttpActualStartCallback";
      const login = await request("/login");
      assert.equal(login.status, 303);
      assert.equal(login.headers.location, "https://provider.example.test/authorize");
      assert.equal(login.headers["cache-control"], "no-store");
      const authCookie = login.headers["set-cookie"]?.find((cookie) =>
        cookie.startsWith("__Host-bop-auth="),
      );
      assert.ok(authCookie);
      const callback = await request(
        "/callback?" +
          new URLSearchParams({
            code: credentials.generate(),
            state: authorEntry.authorization().state,
          }),
        { cookie: authCookie.split(";")[0] },
      );
      assert.equal(callback.status, 303);
      assert.equal(callback.headers.location, path);
      const merchantCookie = callback.headers["set-cookie"]?.find(
        (cookie) => cookie.startsWith("__Host-bop-merchant=") && !cookie.includes("Max-Age=0"),
      );
      assert.ok(merchantCookie);
      const cookie = merchantCookie.split(";")[0],
        session = await request("/session", { cookie });
      assert.equal(session.status, 200);
      assert.equal(session.payload.authenticated, true);
      const csrf = session.payload.csrf,
        scope = parseBrandCatalogSourceScope(session.payload.workspace.selectedScope),
        call = (mode, body, options = {}) =>
          request("/catalog-source/" + mode, {
            body: { brandReference: brand, ...body },
            cookie,
            csrf,
            ...options,
          });
      assert.deepEqual(scope, {
        tenantReference: brand,
        brandReference: brand,
        actorReference: author,
      });
      stage = "CatalogHttpCurrentAbsent";
      const absent = await call("current", {});
      assert.equal(absent.status, 200);
      assert.equal(parseBrandCatalogSourceCurrent(absent.payload, scope, now()).source, null);
      const deniedCsrf = await call("current", {}, { csrf: credentials.generate() });
      assert.equal(deniedCsrf.status, 403);
      const wrongBrand = await call("current", { brandReference: draftBrand });
      assert.equal(wrongBrand.status, 403);
      assert.equal(catalogIds, 0);
      stage = "CatalogHttpLatePermissionRollback";
      const rolledBackCommand = {
          operationReference: reference(),
          code: "ROLLBACK",
          label: "Synthetic rollback catalogue",
        },
        pending = {
          fired: false,
          changed: false,
          matches: (sql) =>
            sql.startsWith("INSERT INTO rms_catalog.brand_catalog_source_operation("),
          change: (client) =>
            client.query(
              "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1,updated_at=$2 WHERE grant_id=$1",
              [grants.get("catalog.manage"), now()],
            ),
        };
      injection = pending;
      try {
        const refused = await call("register", { command: rolledBackCommand });
        assert.equal(refused.status, 403);
        assert.equal(pending.fired, true);
        assert.equal(pending.changed, true);
      } finally {
        injection = undefined;
      }
      assert.deepEqual(await counts(), { sources: 0, operations: 0, audits: 0 });
      assert.equal(
        (
          await admin.query(
            "SELECT lifecycle FROM bop_permission.permission_grant WHERE grant_id=$1",
            [grants.get("catalog.manage")],
          )
        ).rows[0].lifecycle,
        "Active",
      );
      stage = "CatalogHttpRegisterLostResponse";
      const command = {
          operationReference: reference(),
          code: "CATALOGUE",
          label: "Synthetic Brand catalogue",
        },
        original = parseBrandCatalogSourceRegister({
          profile: "BrandCatalogSourceRegisterV1",
          ...scope,
          ...command,
        }),
        intentDigest = brandCatalogSourceIntentDigest(original);
      await assert.rejects(
        call("register", { command }, { loseResponse: true }),
        /NATIVE_CATALOG_LOST_RESPONSE/u,
      );
      assert.deepEqual(await counts(), { sources: 1, operations: 1, audits: 1 });
      const allocated = catalogIds;
      stage = "CatalogHttpOriginalResolveReplay";
      const resolved = await call("resolve", {
        original: { operationReference: command.operationReference, intentDigest },
      });
      assert.equal(resolved.status, 200);
      const receipt = parseBrandCatalogSourceReceipt(resolved.payload);
      assert.equal(receipt.outcome, "Committed");
      assert.deepEqual(receipt.originalCommand, original);
      assert.equal(receipt.intentDigest, intentDigest);
      assert.ok(receipt.source);
      const replay = await call("register", { command });
      assert.equal(replay.status, 200);
      assert.deepEqual(parseBrandCatalogSourceReceipt(replay.payload), receipt);
      assert.equal(catalogIds, allocated);
      assert.deepEqual(await counts(), { sources: 1, operations: 1, audits: 1 });
      const current = await call("current", {}),
        exact = await call("exact", { sourceReference: receipt.source.sourceReference });
      assert.equal(current.status, 200);
      assert.equal(exact.status, 200);
      assert.deepEqual(
        parseBrandCatalogSourceCurrent(current.payload, scope, now()).source,
        receipt.source,
      );
      assert.deepEqual(
        parseBrandCatalogSourceExact(exact.payload, scope, receipt.source.sourceReference, now())
          .source,
        receipt.source,
      );
      const missingExact = await call("exact", { sourceReference: reference() });
      assert.equal(missingExact.status, 200);
      assert.equal(missingExact.payload.source, null);
      stage = "CatalogHttpAbsentAbandonedFence";
      const lateCommand = {
          operationReference: reference(),
          code: "LATE_CATALOGUE",
          label: "Synthetic absent original",
        },
        lateIntent = brandCatalogSourceIntentDigest(
          parseBrandCatalogSourceRegister({
            profile: "BrandCatalogSourceRegisterV1",
            ...scope,
            ...lateCommand,
          }),
        );
      const abandonedResponse = await call("resolve", {
        original: { operationReference: lateCommand.operationReference, intentDigest: lateIntent },
      });
      assert.equal(abandonedResponse.status, 200);
      const abandoned = parseBrandCatalogSourceReceipt(abandonedResponse.payload);
      assert.equal(abandoned.outcome, "Abandoned");
      assert.equal(abandoned.source, null);
      assert.equal(abandoned.originalCommand, null);
      const abandonedIds = catalogIds;
      const recovered = await call("resolve", {
        original: { operationReference: lateCommand.operationReference, intentDigest: lateIntent },
      });
      assert.equal(recovered.status, 200);
      assert.deepEqual(recovered.payload, abandoned);
      const fenced = await call("register", { command: lateCommand });
      assert.equal(fenced.status, 409);
      assert.equal(catalogIds, abandonedIds);
      assert.deepEqual(await counts(), { sources: 1, operations: 2, audits: 2 });
      assert.equal(configureCalls, 0);
      assert.equal(configurationIds, 0);
      assert.deepEqual(await countState(), {
        sessions: 3,
        selections: 3,
        stores: 0,
        assignments: 0,
        legacy_selections: 0,
      });
      stage = "CatalogHttpStrongStepUpAndTruthfulLogout";
      const started = await request("/session/rotate", { body: {}, cookie, csrf });
      assert.equal(started.status, 200);
      assert.deepEqual(started.payload, {
        status: "step_up_required",
        authorizationUrl: `${providerOrigin}/authorize`,
      });
      const stepAuth = started.headers["set-cookie"]?.find((value) =>
        value.startsWith("__Host-bop-auth="),
      );
      assert.ok(stepAuth);
      const renewed = await request(
        "/callback?" +
          new URLSearchParams({
            code: credentials.generate(),
            state: authorEntry.authorization().state,
          }),
        { cookie: cookie + "; " + stepAuth.split(";")[0] },
      );
      assert.equal(renewed.status, 303);
      const nextCookie = renewed.headers["set-cookie"]?.find(
        (value) => value.startsWith("__Host-bop-merchant=") && !value.includes("Max-Age=0"),
      );
      assert.ok(nextCookie);
      const currentCookie = nextCookie.split(";")[0],
        nextBoot = await request("/session", { cookie: currentCookie });
      assert.equal(nextBoot.status, 200);
      assert.equal(nextBoot.payload.recentMfaRequired, false);
      assert.notEqual(nextBoot.payload.csrf, csrf);
      assert.equal((await request("/session", { cookie })).status, 403);
      const unknown = await request("/session/logout", {
        body: {},
        cookie: currentCookie,
        csrf: nextBoot.payload.csrf,
      });
      assert.equal(unknown.status, 200);
      assert.deepEqual(unknown.payload, { status: "logout_unknown" });
      assert.equal(unknown.headers["set-cookie"], undefined);
      assert.equal((await request("/session", { cookie: currentCookie })).status, 403);
      authorEntry.confirmLogout();
      const completed = await request("/session/logout", {
        body: {},
        cookie: currentCookie,
        csrf: nextBoot.payload.csrf,
      });
      assert.equal(completed.status, 200);
      assert.deepEqual(completed.payload, { status: "browser_logout_required", logoutUrl });
      assert.ok(
        completed.headers["set-cookie"]?.some(
          (value) => value.startsWith("__Host-bop-merchant=") && value.includes("Max-Age=0"),
        ),
      );
      assert.deepEqual(await countState(), {
        sessions: 4,
        selections: 4,
        stores: 0,
        assignments: 0,
        legacy_selections: 0,
      });
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
  async function administrativeDraftJourney() {
    const target = draftBrand,
      targetPath = `/app/organization/brands/${target}`,
      membership = reference(),
      permissionRole = reference(),
      permissionGrants = new Map(),
      administrativeActions = [
        "organization.manage",
        "publishing.draft.create",
        "publishing.review.submit",
        "publishing.review.approve",
        "publishing.release.publish",
        "publishing.release.archive",
      ];
    const draftEntry = entry(author, target),
      resolveAdministrative = createMerchantCurrentBrandAdministrationScope(source);
    stage = "DraftNoAuthorityNoSession";
    for (const candidate of [draftEntry, entry(outsider, target)]) {
      await assert.rejects(candidate.bff.callback(await candidate.prepare()));
      assert.equal((await countState()).sessions, 0);
      assert.equal((await countState()).selections, 0);
    }
    // Isolated controlled provisioning only: these rows are never a production
    // creation/initial-access source. The runtime must reconstruct all six
    // decisions from the owning persisted facts and the actual selected Actor.
    stage = "DraftControlledAuthorityFixture";
    await admin.query("INSERT INTO bop_permission.policy_state VALUES($1,$2,1,$3)", [
      target,
      reference(),
      from,
    ]);
    await admin.query(
      "INSERT INTO bop_membership.membership VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
      [membership, author, target, reference(), from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_draft_admin','Active',$3,$4,1,$3,$3)",
      [permissionRole, target, from, until],
    );
    await admin.query(
      "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
      [reference(), permissionRole, membership, author, target, from, until],
    );
    for (const [index, action] of administrativeActions.entries()) {
      const permission = index === 0 ? id(30) : id(50 + index),
        grant = reference();
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3) ON CONFLICT (permission_id) DO NOTHING",
        [permission, action, from],
      );
      await admin.query(
        "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
        [grant, permissionRole, permission, target, from, until],
      );
      permissionGrants.set(action, grant);
    }
    stage = "DraftMissingMembershipAndFuturePermission";
    const outsiderEntry = entry(outsider, target);
    await assert.rejects(outsiderEntry.bff.callback(await outsiderEntry.prepare()));
    await admin.query(
      "UPDATE bop_permission.permission_grant SET effective_from=$2 WHERE grant_id=$1",
      [permissionGrants.get("organization.manage"), new Date(clockMs + 1000).toISOString()],
    );
    await assert.rejects(draftEntry.bff.callback(await draftEntry.prepare()));
    assert.equal((await countState()).sessions, 0);
    assert.equal((await countState()).selections, 0);
    await admin.query(
      "UPDATE bop_permission.permission_grant SET effective_from=$2 WHERE grant_id=$1",
      [permissionGrants.get("organization.manage"), from],
    );
    stage = "DraftActualLogin";
    const login = await draftEntry.login();
    await verifyStrongSessionProof(login, draftEntry.bff);
    await assert.rejects(draftEntry.bff.callback(login.callback));
    const baseline = await countState();
    assert.deepEqual(baseline, {
      sessions: 1,
      selections: 1,
      stores: 0,
      assignments: 0,
      legacy_selections: 0,
    });
    assert.equal(login.session.policy.code, "Privileged");
    const persisted = (
      await admin.query(
        "SELECT encrypted_secret,session_selector_hash FROM bop_identity.authentication_session WHERE session_id=$1",
        [login.session.sessionReference],
      )
    ).rows[0];
    assert.ok(!persisted.encrypted_secret.includes(Buffer.from("synthetic-brand-token-bundle")));
    assert.ok(!persisted.encrypted_secret.includes(Buffer.from(login.cookie)));
    assert.equal(persisted.session_selector_hash.toString("hex"), hasher.hash(login.cookie));
    const selected = (
      await admin.query(
        "SELECT actor_id,brand_id FROM bop_identity.browser_brand_session_selection WHERE session_id=$1",
        [login.session.sessionReference],
      )
    ).rows[0];
    assert.deepEqual(selected, { actor_id: author, brand_id: target });
    stage = "DraftActualAdministrativeScope";
    await transactions.run(async (tx) => {
      const current = await resolveAdministrative(tx, login.cookie, login.session.sessionReference);
      assert.equal(current.context.profile, "BrandAdministrationContextV1");
      assert.equal(current.context.purposeCode, "BRAND_ADMINISTRATION");
      assert.equal(current.context.brand.lifecycle, "Draft");
      assert.equal(current.context.store, null);
      assert.equal("scopeKind" in current.context, false);
      assert.equal(current.tenantReference, target);
      const authority = await current.authorizeActionsWithValidity(administrativeActions);
      assert.deepEqual(
        authority.decisions.map((decision) => [
          decision.action,
          decision.effect,
          decision.scopeKind,
        ]),
        administrativeActions.map((action) => [action, "Allow", "Brand"]),
      );
      assert.ok(Date.parse(authority.validUntil) > clockMs);
      assert.ok(Date.parse(authority.validUntil) <= clockMs + 5000);
      const databaseScope = (
        await tx.query(
          "SELECT current_setting('bop.tenant_id',true) tenant,current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
          [],
        )
      ).rows[0];
      assert.deepEqual(databaseScope, { tenant: target, brand: target, store: "" });
      current.assertCurrent();
    });
    stage = "DraftOperationalScopeRefused";
    await assert.rejects(
      transactions.run((tx) => resolve(tx, login.cookie, login.session.sessionReference)),
    );
    await assert.rejects(
      transactions.run(async (tx) => {
        const current = await resolveAdministrative(
          tx,
          login.cookie,
          login.session.sessionReference,
        );
        await current.authorizeAction("catalog.manage");
      }),
    );
    stage = "DraftHiddenSelectionAndImmutableScope";
    await transactions.run(async (tx) => {
      const visible = async () =>
        (
          await tx.query(
            "SELECT count(*)::int n FROM bop_identity.browser_brand_session_selection",
            [],
          )
        ).rows[0].n;
      assert.equal(await visible(), 0);
      for (const [session, actor, count] of [
        [login.session.sessionReference, author, 1],
        [login.session.sessionReference, outsider, 0],
        [id(999), author, 0],
      ]) {
        await tx.query(
          "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
          [session, actor],
        );
        assert.equal(await visible(), count);
      }
      assert.equal(
        (await tx.query("SELECT count(*)::int n FROM bop_tenant.brand", [])).rows[0].n,
        0,
      );
      assert.equal(
        (await tx.query("SELECT count(*)::int n FROM bop_membership.membership", [])).rows[0].n,
        0,
      );
    });
    await assert.rejects(
      admin.query(
        "UPDATE bop_identity.browser_brand_session_selection SET brand_id=$2 WHERE session_id=$1",
        [login.session.sessionReference, brand],
      ),
      { code: "23514" },
    );
    stage = "DraftEmptyFeatureAdministrativeBaseline";
    const initialWorkspace = await draftEntry.bff.bootstrap(login.cookie);
    assert.equal(initialWorkspace.workspace.profile, "BrandAdministrationWorkspaceV1");
    assert.equal(initialWorkspace.workspace.brand.lifecycle, "Draft");
    assert.equal(initialWorkspace.workspace.navigation.length, 1);
    const feature = createFeatureControlAdministrationDefinition({
      controlId: reference(),
      key: "organization.brand.detail",
      description: "InternalTest existing Draft Brand detail definition",
      version: 1,
      ownerReference: author,
      purposeCode: "BRAND_ADMINISTRATION",
      scope: { kind: "Brand", brandReference: target, storeReference: null },
      source: "BrandOverride",
      defaultValue: "Disabled",
      configuredValue: "Enabled",
      lifecycle: "Published",
      temporary: false,
      effectiveFrom: from,
      effectiveUntil: null,
      reviewAt: until,
      expiresAt: null,
      dependencies: [],
      authoredByReference: author,
      approvedByReference: reviewer,
      approvalEvidenceReference: reference(),
      publicationReference: reference(),
    });
    // Persist a valid pre-existing published definition as isolated fixture data.
    // No feature mutation API or invented Draft publication authority is used.
    await admin.query(
      "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14,NULL,$15,$16,$17,$18,$19,'ConfigurationMetadata')",
      [
        feature.controlId,
        target,
        feature.key,
        feature.version,
        feature.description,
        feature.ownerReference,
        feature.purposeCode,
        feature.source,
        feature.defaultValue,
        feature.configuredValue,
        feature.lifecycle,
        feature.temporary,
        feature.effectiveFrom,
        feature.reviewAt,
        feature.authoredByReference,
        feature.approvedByReference,
        feature.approvalEvidenceReference,
        feature.publicationReference,
        now(),
      ],
    );
    stage = "DraftActualWorkspace";
    const bootstrap = () => draftEntry.bff.bootstrap(login.cookie),
      boot = await bootstrap();
    assert.deepEqual(boot.workspace.brand, {
      brandReference: target,
      label: "Synthetic Draft Brand",
      lifecycle: "Draft",
      version: 1,
    });
    assert.deepEqual(boot.workspace.selectedScope, {
      tenantReference: target,
      brandReference: target,
      actorReference: author,
    });
    assert.deepEqual(
      boot.workspace.navigation.map((item) => [item.screenId, item.href]),
      [["ORG-BRAND-DETAIL", targetPath]],
    );
    const denyReference = reference(),
      insertDeny = (client) =>
        client.query(
          "INSERT INTO bop_permission.permission_override VALUES($1,$2,$3,$4,NULL,'Deny','Active',$5,$6,$7,$8,1,$7,$7)",
          [denyReference, id(30), author, target, reference(), reference(), from, until],
        );
    for (const [name, change] of [
      ["Deny", insertDeny],
      [
        "Membership",
        (client) =>
          client.query(
            "UPDATE bop_membership.membership SET lifecycle='Suspended',version=version+1,updated_at=$2 WHERE membership_id=$1",
            [membership, now()],
          ),
      ],
      [
        "Session",
        (client) =>
          client.query(
            "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='RiskChange',revoked_at=$2,version=version+1 WHERE session_id=$1",
            [login.session.sessionReference, now()],
          ),
      ],
      [
        "Brand",
        (client) =>
          client.query(
            "UPDATE bop_tenant.brand SET lifecycle='Suspended',version=version+1,updated_at=$2 WHERE brand_id=$1",
            [target, now()],
          ),
      ],
      [
        "Feature",
        (client) =>
          client.query(
            "INSERT INTO bop_feature_control.control_version SELECT control_id,brand_id,store_id,control_key,control_version+1,description,owner_reference,purpose_code,source,default_value,'Disabled','Disabled',temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,$2,data_classification FROM bop_feature_control.control_version WHERE control_id=$1 AND control_version=1",
            [feature.controlId, now()],
          ),
      ],
    ]) {
      stage = "DraftWithdraw" + name + "BeforeCommit";
      await rejectsAfter(featureRead, change, bootstrap);
      assert.deepEqual(await countState(), baseline);
      assert.equal((await bootstrap()).workspace.brand.lifecycle, "Draft");
    }
    stage = "DraftWithdrawActorBeforeCommit";
    const reads = suspendedActorReads;
    try {
      await rejectsAfter(
        featureRead,
        async () => {
          suspendedActors.add(author);
        },
        bootstrap,
      );
      assert.ok(suspendedActorReads > reads);
    } finally {
      suspendedActors.delete(author);
    }
    stage = "DraftOriginalLease";
    try {
      await rejectsAfter(
        featureRead,
        async () => {
          clockMs += 5000;
        },
        bootstrap,
      );
    } finally {
      clockMs = Date.parse(at);
    }
    stage = "DraftNaturalGrantBoundary";
    const grantUntil = new Date(clockMs + 1000).toISOString();
    await admin.query(
      "UPDATE bop_permission.permission_grant SET effective_until=$2 WHERE grant_id=$1",
      [permissionGrants.get("organization.manage"), grantUntil],
    );
    try {
      await transactions.run(async (tx) => {
        const current = await resolveAdministrative(
          tx,
          login.cookie,
          login.session.sessionReference,
        );
        assert.equal(current.authorizationValidUntil(), grantUntil);
      });
      await rejectsAfter(
        featureRead,
        async () => {
          clockMs += 1000;
        },
        bootstrap,
      );
    } finally {
      clockMs = Date.parse(at);
      await admin.query(
        "UPDATE bop_permission.permission_grant SET effective_until=$2 WHERE grant_id=$1",
        [permissionGrants.get("organization.manage"), until],
      );
    }
    stage = "DraftLoginSelectionRollback";
    const retry = entry(author, target),
      callback = await retry.prepare();
    await rejectsAfter(selectionInsert, insertDeny, () => retry.bff.callback(callback));
    assert.deepEqual(await countState(), baseline);
    stage = "DraftRotationRollback";
    await rejectsAfter(selectionInsert, insertDeny, () =>
      draftEntry.stepUp({ sessionCookie: login.cookie, csrf: boot.csrf }),
    );
    assert.deepEqual(await countState(), baseline);
    assert.equal((await bootstrap()).session.status, "Active");
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM bop_permission.permission_override WHERE override_id=$1",
          [denyReference],
        )
      ).rows[0].n,
      0,
    );
    await expireMfaWithoutExpiringSession(login, draftEntry.bff);
    stage = "DraftActualRotation";
    const rotated = await draftEntry.stepUp(
      { sessionCookie: login.cookie, csrf: boot.csrf },
      { proveCas: true },
    );
    assert.notEqual(rotated.session.sessionReference, login.session.sessionReference);
    assert.ok(rotated.session.authenticatedAt > login.session.authenticatedAt);
    assert.equal(rotated.session.rotatedFromSessionReference, login.session.sessionReference);
    await assert.rejects(bootstrap);
    const rotatedBoot = await draftEntry.bff.bootstrap(rotated.cookie.value);
    assert.equal(rotatedBoot.workspace.brand.lifecycle, "Draft");
    assert.notEqual(rotatedBoot.csrf, boot.csrf);
    await assert.rejects(
      draftEntry.bff.authorize({ sessionCookie: rotated.cookie.value, csrf: boot.csrf }),
    );
    assert.equal(
      (
        await draftEntry.bff.authorize({
          sessionCookie: rotated.cookie.value,
          csrf: rotatedBoot.csrf,
        })
      ).sessionReference,
      rotated.session.sessionReference,
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT actor_id,brand_id FROM bop_identity.browser_brand_session_selection WHERE session_id=$1",
          [rotated.session.sessionReference],
        )
      ).rows[0],
      { actor_id: author, brand_id: target },
    );
    assert.deepEqual(await countState(), { ...baseline, sessions: 2, selections: 2 });
    stage = "DraftLogout";
    const logoutInput = { sessionCookie: rotated.cookie.value, csrf: rotatedBoot.csrf };
    assert.deepEqual(await draftEntry.bff.logout(logoutInput), {
      status: "Unknown",
      cookies: [],
      browserLogoutUrl: null,
    });
    assert.equal(draftEntry.revocations(), 1);
    draftEntry.confirmLogout();
    const completedLogout = await draftEntry.bff.logout(logoutInput);
    assert.equal(completedLogout.status, "BrowserLogoutRequired");
    assert.equal(completedLogout.browserLogoutUrl, logoutUrl);
    assert.equal(completedLogout.cookies[0]?.clear, true);
    await assert.rejects(draftEntry.bff.bootstrap(rotated.cookie.value));
    assert.deepEqual(
      (
        await admin.query(
          "SELECT status,revocation_reason FROM bop_identity.authentication_session WHERE session_id=$1",
          [rotated.session.sessionReference],
        )
      ).rows[0],
      { status: "Revoked", revocation_reason: "Logout" },
    );
    assert.equal(
      (await admin.query("SELECT lifecycle FROM bop_tenant.brand WHERE brand_id=$1", [target]))
        .rows[0].lifecycle,
      "Draft",
    );
    assert.deepEqual(await countState(), { ...baseline, sessions: 2, selections: 2 });
  }
  await admin.connect();
  try {
    await admin.query(
      "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT",
    );
    createdRole = true;
    await admin.query(
      "GRANT USAGE ON SCHEMA bop_identity,bop_tenant,bop_membership,bop_permission,bop_feature_control,platform_helpers,platform_audit TO " +
        role,
    );
    await admin.query(
      "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE ON bop_identity.oidc_authorization_transaction,bop_identity.authentication_session TO " +
        role,
    );
    // FOR SHARE needs a column UPDATE ACL; the immutable trigger still rejects
    // every UPDATE/DELETE and this role has no selection DELETE/TRUNCATE privilege.
    await admin.query(
      "GRANT SELECT,INSERT,UPDATE(session_id) ON bop_identity.browser_brand_session_selection TO " +
        role,
    );
    await admin.query("GRANT SELECT,UPDATE(version) ON bop_tenant.brand TO " + role);
    // PostgreSQL SHARE table locks need mutation privilege. This isolated owner
    // composition role is not an HTTP role; no Store or StoreAssignment privilege.
    await admin.query(
      "GRANT SELECT,UPDATE ON bop_membership.membership,bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override TO " +
        role,
    );
    await admin.query(
      "GRANT SELECT,INSERT ON bop_feature_control.control_version,bop_feature_control.control_dependency,bop_feature_control.control_operation,platform_audit.audit_record TO " +
        role,
    );
    await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
    if (catalogHttp) {
      await admin.query("GRANT USAGE ON SCHEMA rms_catalog TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.brand_catalog_source,rms_catalog.brand_catalog_source_operation TO " +
          role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION rms_catalog.brand_catalog_source_operation_admit(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO " +
          role,
      );
    }
    const forbidden = (
      await admin.query(
        "SELECT has_table_privilege($1,'bop_tenant.store','SELECT') AS stores,has_table_privilege($1,'bop_membership.store_assignment','SELECT') AS assignments,has_table_privilege($1,'bop_identity.browser_session_selection','SELECT') AS legacy_selection",
        [role],
      )
    ).rows[0];
    assert.deepEqual(forbidden, { stores: false, assignments: false, legacy_selection: false });
    await admin.query(
      "INSERT INTO bop_tenant.brand VALUES($1,'SYNTHETIC_NO_STORE','Synthetic no Store Brand','en-CA','CAD','Active',1,$2,$2),($3,'SYNTHETIC_DRAFT','Synthetic Draft Brand','en-CA','CAD','Draft',1,$2,$2)",
      [brand, from, draftBrand],
    );
    await admin.query("INSERT INTO bop_permission.policy_state VALUES($1,$2,1,$3)", [
      brand,
      id(20),
      from,
    ]);
    for (const [who, membership] of membershipIds) {
      const permissionRole = reference();
      await admin.query(
        "INSERT INTO bop_membership.membership VALUES($1,$2,$3,$4,'Active',$5,$6,1,$5,$5)",
        [membership, who, brand, reference(), from, until],
      );
      await admin.query(
        "INSERT INTO bop_permission.role VALUES($1,$2,NULL,$3,'Active',$4,$5,1,$4,$4)",
        [permissionRole, brand, "synthetic_brand_" + membership.slice(-4), from, until],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
        [reference(), permissionRole, membership, who, brand, from, until],
      );
      for (const [i, action] of grantActions.entries()) {
        const permission = id(30 + i),
          grant = reference();
        await admin.query(
          "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3) ON CONFLICT (permission_id) DO NOTHING",
          [permission, action, from],
        );
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
          [grant, permissionRole, permission, brand, from, until],
        );
        if (who === author) grants.set(action, grant);
      }
    }
    assert.deepEqual(await countState(), {
      sessions: 0,
      selections: 0,
      stores: 0,
      assignments: 0,
      legacy_selections: 0,
    });
    if (administrativeDraft) {
      await administrativeDraftJourney();
      return;
    }
    stage = "NoAuthorityNoSession";
    for (const candidate of [entry(outsider), entry(author, draftBrand), entry(author, id(99))]) {
      const input = await candidate.prepare();
      await assert.rejects(candidate.bff.callback(input));
      assert.equal((await countState()).sessions, 0);
      assert.equal((await countState()).selections, 0);
    }
    stage = "ActualLogin";
    const authorEntry = entry(),
      reviewerEntry = entry(reviewer);
    await assert.rejects(authorEntry.bff.start("/app"));
    const closed = await authorEntry.prepare();
    await assert.rejects(authorEntry.bff.callback({ ...closed, policyCode: "NamedKdsOperator" }));
    assert.equal(authorEntry.exchanges(), 0);
    const authorLogin = await authorEntry.login(),
      reviewerLogin = await reviewerEntry.login();
    await verifyStrongSessionProof(authorLogin, authorEntry.bff);
    await assert.rejects(authorEntry.bff.callback(authorLogin.callback));
    assert.equal(authorEntry.exchanges(), 1);
    assert.equal(authorLogin.session.policy.code, "Privileged");
    assert.deepEqual(await countState(), {
      sessions: 2,
      selections: 2,
      stores: 0,
      assignments: 0,
      legacy_selections: 0,
    });
    const secret = (
      await admin.query(
        "SELECT encrypted_secret,session_selector_hash FROM bop_identity.authentication_session WHERE session_id=$1",
        [authorLogin.session.sessionReference],
      )
    ).rows[0];
    assert.ok(!secret.encrypted_secret.includes(Buffer.from("synthetic-brand-token-bundle")));
    assert.ok(!secret.encrypted_secret.includes(Buffer.from(authorLogin.cookie)));
    assert.ok(secret.session_selector_hash.toString("hex") === hasher.hash(authorLogin.cookie));
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM bop_permission.permission_definition WHERE action_code='merchant.access'",
        )
      ).rows[0].n,
      0,
    );

    stage = "HiddenSelectionScope";
    const selection = createPostgresBrowserBrandSessionSelectionStore();
    await transactions.run(async (tx) => {
      const count = async () =>
        (
          await tx.query(
            "SELECT count(*)::int n FROM bop_identity.browser_brand_session_selection",
            [],
          )
        ).rows[0].n;
      const setScope = (session, actor) =>
        tx.query(
          "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
          [session, actor],
        );
      assert.equal(await count(), 0);
      assert.equal(
        (await tx.query("SELECT count(*)::int n FROM bop_tenant.brand", [])).rows[0].n,
        0,
      );
      assert.equal(
        (await tx.query("SELECT count(*)::int n FROM bop_membership.membership", [])).rows[0].n,
        0,
      );
      assert.deepEqual(await selection.read(tx, authorLogin.session, now()), {
        brandReference: brand,
      });
      assert.equal(await count(), 0, "the owner must restore pre-Tenant scope");
      for (const [session, actor, expected] of [
        [authorLogin.session.sessionReference, author, 1],
        [authorLogin.session.sessionReference, reviewer, 0],
        [id(999), author, 0],
        ["", author, 0],
        [authorLogin.session.sessionReference, "", 0],
      ]) {
        await setScope(session, actor);
        assert.equal(await count(), expected);
      }
      await setScope(reviewerLogin.session.sessionReference, reviewer);
      assert.deepEqual(await selection.read(tx, authorLogin.session, now()), {
        brandReference: brand,
      });
      const restored = (
        await tx.query(
          "SELECT current_setting('bop.identity_session_id',true) session,current_setting('bop.identity_actor_id',true) actor",
          [],
        )
      ).rows[0];
      assert.equal(restored.session, reviewerLogin.session.sessionReference);
      assert.equal(restored.actor, reviewer);
    });
    await assert.rejects(
      transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.identity_session_id',$1,true),set_config('bop.identity_actor_id',$2,true)",
          [reviewerLogin.session.sessionReference, reviewer],
        );
        await tx.query(
          "INSERT INTO bop_identity.browser_brand_session_selection VALUES($1,$2,$3,$4)",
          [id(999), author, brand, now()],
        );
      }),
      { code: "42501" },
    );
    await assert.rejects(
      admin.query(
        "UPDATE bop_identity.browser_brand_session_selection SET brand_id=$2 WHERE session_id=$1",
        [authorLogin.session.sessionReference, draftBrand],
      ),
      { code: "23514" },
    );
    await assert.rejects(
      admin.query("DELETE FROM bop_identity.browser_brand_session_selection WHERE session_id=$1", [
        authorLogin.session.sessionReference,
      ]),
      { code: "23514" },
    );
    sqlState = "none";
    sqlAsset = "none";

    stage = "ActiveEmptyFeatureAdministrativeBaseline";
    const initialWorkspace = await entry().bff.bootstrap(authorLogin.cookie);
    assert.equal(initialWorkspace.workspace.profile, "BrandAdministrationWorkspaceV1");
    assert.equal(initialWorkspace.workspace.brand.lifecycle, "Active");
    assert.equal(initialWorkspace.workspace.navigation.length, 1);
    stage = "PublishActualBrandFeature";
    definition = createFeatureControlAdministrationDefinition({
      controlId: reference(),
      key: "organization.brand.detail",
      description: "InternalTest no Store Brand detail",
      version: 1,
      ownerReference: author,
      purposeCode: "BRAND_CAPABILITY_EVALUATION",
      scope: { kind: "Brand", brandReference: brand, storeReference: null },
      source: "BrandOverride",
      defaultValue: "Disabled",
      configuredValue: "Enabled",
      lifecycle: "Draft",
      temporary: false,
      effectiveFrom: from,
      effectiveUntil: null,
      reviewAt: until,
      expiresAt: null,
      dependencies: [],
      authoredByReference: author,
      approvedByReference: null,
      approvalEvidenceReference: null,
      publicationReference: null,
    });
    definition = await createPostgresFeatureControlInitialDraftStore({
      brandReference: brand,
      storeReference: null,
      actorReference: author,
      clock: { now },
      transactions,
      authority: featureAuthority(authorLogin),
    }).createDraft({
      definition,
      idempotencyKey: reference(),
      audit: {
        auditId: reference(),
        brandId: brand,
        actor: { type: "User", reference: author },
        actionCode: "FEATURE_CONTROL_SAVEDRAFT",
        targetType: "FeatureControl",
        targetId: definition.controlId,
        reasonCode: definition.purposeCode,
        correlationId: reference(),
        occurredAt: now(),
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "FEATURE_CONTROL_AUDIT",
        retentionPolicyVersion: 1,
      },
    });
    await mutateFeature("Submit", authorLogin, { lifecycle: "PendingApproval" });
    await mutateFeature("Approve", reviewerLogin, {
      lifecycle: "Approved",
      approvedByReference: reviewer,
      approvalEvidenceReference: reference(),
    });
    await mutateFeature("Publish", authorLogin, {
      lifecycle: "Published",
      publicationReference: reference(),
    });
    if (catalogHttp) {
      // Reuse genuine encrypted Session/IAM/Feature setup. The mode-specific
      // HTTP journey does not repeat the default Session withdrawal inventory.
      await catalogHttpJourney(authorEntry);
      return;
    }
    stage = "CurrentBrandWorkspace";
    const boot = await entry().bff.bootstrap(authorLogin.cookie);
    assert.equal(boot.workspace.profile, "BrandAdministrationWorkspaceV1");
    assert.deepEqual(boot.workspace.selectedScope, {
      tenantReference: brand,
      brandReference: brand,
      actorReference: author,
    });
    assert.equal(boot.workspace.brand.label, "Synthetic no Store Brand");
    assert.equal(boot.workspace.brand.version, 1);
    assert.deepEqual(
      boot.workspace.navigation.map((item) => [item.screenId, item.href]),
      [["ORG-BRAND-DETAIL", path]],
    );
    await assert.rejects(
      authorEntry.bff.authorize({
        sessionCookie: authorLogin.cookie,
        csrf: credentials.generate(),
      }),
    );
    assert.equal(
      (await authorEntry.bff.authorize({ sessionCookie: authorLogin.cookie, csrf: boot.csrf }))
        .sessionReference,
      authorLogin.session.sessionReference,
    );

    const revokeGrant = (client) =>
      client.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1,updated_at=$2 WHERE grant_id=$1",
        [grants.get("organization.manage"), now()],
      );
    stage = "LoginSelectionRollback";
    const baseline = await countState();
    const failedLogin = entry(),
      failedCallback = await failedLogin.prepare();
    await rejectsAfter(selectionInsert, revokeGrant, () =>
      failedLogin.bff.callback(failedCallback),
    );
    assert.deepEqual(await countState(), baseline);
    assert.equal((await entry().bff.bootstrap(authorLogin.cookie)).workspace.navigation.length, 1);
    stage = "LoginLeaseRollback";
    const expiredLogin = entry(),
      expiredCallback = await expiredLogin.prepare();
    try {
      await rejectsAfter(
        selectionInsert,
        async () => {
          clockMs += 5000;
        },
        () => expiredLogin.bff.callback(expiredCallback),
      );
    } finally {
      clockMs = Date.parse(at);
    }
    assert.deepEqual(await countState(), baseline);

    stage = "CurrentAuthorityLocks";
    const editor = new pg.Client(context.clientConfig);
    await editor.connect();
    try {
      await transactions.run(async (tx) => {
        await authority(tx, authorLogin, "organization.manage");
        for (const [sql, values] of [
          [
            "UPDATE bop_identity.authentication_session SET version=version+1 WHERE session_id=$1",
            [authorLogin.session.sessionReference],
          ],
          ["UPDATE bop_tenant.brand SET version=version+1 WHERE brand_id=$1", [brand]],
          [
            "UPDATE bop_membership.membership SET version=version+1 WHERE membership_id=$1",
            [membershipIds.get(author)],
          ],
          [
            "UPDATE bop_permission.permission_grant SET version=version+1 WHERE grant_id=$1",
            [grants.get("organization.manage")],
          ],
        ]) {
          await editor.query("BEGIN");
          try {
            await editor.query("SET LOCAL lock_timeout='100ms'");
            await assert.rejects(editor.query(sql, values), { code: "55P03" });
          } finally {
            await editor.query("ROLLBACK");
          }
        }
      });
    } finally {
      await editor.end();
    }

    stage = "CurrentFactWithdrawal";
    const withdrawals = [
      [
        "Session",
        (client) =>
          client.query(
            "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='RiskChange',revoked_at=$2,version=version+1 WHERE session_id=$1",
            [authorLogin.session.sessionReference, now()],
          ),
      ],
      [
        "Brand",
        (client) =>
          client.query(
            "UPDATE bop_tenant.brand SET lifecycle='Suspended',version=version+1,updated_at=$2 WHERE brand_id=$1",
            [brand, now()],
          ),
      ],
      [
        "Membership",
        (client) =>
          client.query(
            "UPDATE bop_membership.membership SET lifecycle='Suspended',version=version+1,updated_at=$2 WHERE membership_id=$1",
            [membershipIds.get(author), now()],
          ),
      ],
      ["Permission", revokeGrant],
      [
        "Feature",
        (client) =>
          client.query(
            "INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) SELECT control_id,brand_id,store_id,control_key,control_version+1,description,owner_reference,purpose_code,source,default_value,'Disabled','Disabled',temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,$3,data_classification FROM bop_feature_control.control_version WHERE control_id=$1 AND control_version=$2",
            [definition.controlId, definition.version, now()],
          ),
      ],
    ];
    for (const [name, change] of withdrawals) {
      stage = "Withdraw" + name + "BeforeCommit";
      await rejectsAfter(featureRead, change, () => entry().bff.bootstrap(authorLogin.cookie));
      assert.deepEqual(await countState(), baseline);
      assert.equal(
        (await entry().bff.bootstrap(authorLogin.cookie)).workspace.navigation.length,
        1,
      );
    }
    stage = "WithdrawCurrentActorBeforeCommit";
    const activeAuthor = actors.get(author);
    const readsBeforeWithdrawal = suspendedActorReads;
    try {
      await rejectsAfter(
        featureRead,
        async () => {
          suspendedActors.add(author);
        },
        () => entry().bff.bootstrap(authorLogin.cookie),
      );
      assert.ok(suspendedActorReads > readsBeforeWithdrawal);
    } finally {
      suspendedActors.delete(author);
    }
    stage = "ChangedCurrentActorBeforeCommit";
    try {
      await rejectsAfter(
        featureRead,
        async () => {
          actors.set(author, actors.get(reviewer));
        },
        () => entry().bff.bootstrap(authorLogin.cookie),
      );
    } finally {
      actors.set(author, activeAuthor);
    }
    stage = "OriginalLease";
    try {
      await rejectsAfter(
        featureRead,
        async () => {
          clockMs += 5000;
        },
        () => entry().bff.bootstrap(authorLogin.cookie),
      );
    } finally {
      // Each request gets a fresh synthetic clock origin; never rewind an active lease.
      clockMs = Date.parse(at);
    }
    stage = "PostCommitDelay";
    afterFeatureCommit = () => {
      clockMs += 6000;
    };
    try {
      assert.equal(
        (await entry().bff.bootstrap(authorLogin.cookie)).workspace.navigation.length,
        1,
      );
      assert.equal(afterFeatureCommit, undefined);
    } finally {
      clockMs = Date.parse(at);
      afterFeatureCommit = undefined;
    }
    stage = "RotationRollback";
    await rejectsAfter(selectionInsert, revokeGrant, () =>
      authorEntry.stepUp({ sessionCookie: authorLogin.cookie, csrf: boot.csrf }),
    );
    assert.deepEqual(await countState(), baseline);
    assert.equal((await entry().bff.bootstrap(authorLogin.cookie)).session.status, "Active");
    await expireMfaWithoutExpiringSession(authorLogin, authorEntry.bff);
    stage = "ActualRotation";
    const rotated = await authorEntry.stepUp(
      {
        sessionCookie: authorLogin.cookie,
        csrf: boot.csrf,
      },
      { proveCas: true },
    );
    assert.ok(rotated.session.sessionReference !== authorLogin.session.sessionReference);
    assert.ok(rotated.session.authenticatedAt > authorLogin.session.authenticatedAt);
    assert.equal(rotated.session.rotatedFromSessionReference, authorLogin.session.sessionReference);
    await assert.rejects(entry().bff.bootstrap(authorLogin.cookie));
    const rotatedBoot = await entry().bff.bootstrap(rotated.cookie.value);
    assert.ok(rotatedBoot.csrf !== boot.csrf);
    await assert.rejects(
      entry().bff.authorize({ sessionCookie: rotated.cookie.value, csrf: boot.csrf }),
    );
    assert.equal(
      (await entry().bff.authorize({ sessionCookie: rotated.cookie.value, csrf: rotatedBoot.csrf }))
        .sessionReference,
      rotated.session.sessionReference,
    );
    const selected = (
      await admin.query(
        "SELECT actor_id,brand_id FROM bop_identity.browser_brand_session_selection WHERE session_id=$1",
        [rotated.session.sessionReference],
      )
    ).rows[0];
    assert.deepEqual(selected, { actor_id: author, brand_id: brand });
    assert.deepEqual(await countState(), { ...baseline, sessions: 3, selections: 3 });
    stage = "PublishedFeatureWithdrawal";
    const currentLogin = { actor: author, session: rotated.session, cookie: rotated.cookie.value };
    await mutateFeature("Disable", currentLogin, {
      lifecycle: "Disabled",
      configuredValue: "Disabled",
    });
    assert.deepEqual((await entry().bff.bootstrap(rotated.cookie.value)).workspace.navigation, []);
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM platform_audit.audit_record WHERE target_type='FeatureControl'",
        )
      ).rows[0].n,
      5,
    );
    stage = "Logout";
    const logoutInput = { sessionCookie: rotated.cookie.value, csrf: rotatedBoot.csrf };
    assert.deepEqual(await authorEntry.bff.logout(logoutInput), {
      status: "Unknown",
      cookies: [],
      browserLogoutUrl: null,
    });
    assert.equal(authorEntry.revocations(), 1);
    await assert.rejects(entry().bff.bootstrap(rotated.cookie.value));
    authorEntry.confirmLogout();
    const completedLogout = await authorEntry.bff.logout(logoutInput);
    assert.equal(completedLogout.status, "BrowserLogoutRequired");
    assert.equal(completedLogout.browserLogoutUrl, logoutUrl);
    assert.equal(completedLogout.cookies[0]?.clear, true);
    const loggedOut = (
      await admin.query(
        "SELECT status,revocation_reason FROM bop_identity.authentication_session WHERE session_id=$1",
        [rotated.session.sessionReference],
      )
    ).rows[0];
    assert.deepEqual(loggedOut, { status: "Revoked", revocation_reason: "Logout" });
    assert.deepEqual(await countState(), { ...baseline, sessions: 3, selections: 3 });
  } catch {
    // Only bounded fixed phases; never retain or expose the caught error.
    throw new Error(
      `BRAND_ADMINISTRATION_SESSION_FAILED stage=${stage} identityPhase=${identityPhase} trace=${identityTrace.join(",")} providerReached=${providerReached} sessionInsertReached=${sessionInsertReached} currentActorReached=${currentActorReached} SQLSTATE=${sqlState} asset=${sqlAsset}`,
    );
  } finally {
    if (createdRole) {
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
    }
    await admin.end();
  }
}
