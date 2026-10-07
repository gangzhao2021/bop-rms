import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { createInternalBrandAdministrationRuntime } from "../../../tooling/environment/brand-administration-runtime.mjs";
import { openBrandStartupBrowser } from "./brand-administration-startup-browser.mjs";

const execute = promisify(execFile);
const prefix = "/merchant/organization/brands";

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Actual private-installation loader, emitted server, TLS and ordinary owners.
 * The existing independently approved native producer supplies all business and
 * identity rows. Only self-signed TLS and outbound Cognito facts are synthetic;
 * no Provider verdict, currentActor, evaluator, Brand or Store is injected. */
export async function exerciseBrandAdministrationStartup(
  f,
  {
    context,
    plan,
    workforce,
    merchant,
    participantState,
    existingCookie,
    challenge,
    cookie,
    verifySaved,
    withProviderCallback,
    issuer,
    clientId,
    managedLoginOrigin,
    clientSecret,
  },
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bop-brand-startup-native-")));
  const actorReference = plan.recipients[0].actorReference,
    brandReference = plan.brand.brandReference,
    sensitive = [];
  let runtime,
    browser,
    primaryError,
    primaryFailed = false,
    cleanupFailed = false;
  const previousRead = participantState.onWorkforceRead;
  const connections = async () =>
    Number(
      (
        await f.admin.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1 AND usename=$2",
          [context.clientConfig.database, merchant.role],
        )
      ).rows[0].n,
    );
  const writes = async () =>
    (
      await f.admin.query(
        `SELECT
    (SELECT count(*)::int FROM bop_identity.authentication_session) sessions,
    (SELECT count(*)::int FROM bop_identity.browser_brand_session_selection) selections`,
        [],
      )
    ).rows[0];
  const business = async () =>
    (
      await f.admin.query(
        `SELECT
    (SELECT count(*)::int FROM bop_tenant.brand) brands,
    (SELECT count(*)::int FROM bop_tenant.store) stores,
    (SELECT count(*)::int FROM bop_membership.membership) memberships,
    (SELECT count(*)::int FROM bop_membership.store_assignment) assignments,
    (SELECT count(*)::int FROM bop_permission.permission_grant) grants,
    (SELECT count(*)::int FROM bop_tenant.brand_configuration_authoring_revision) configurations,
    (SELECT count(*)::int FROM bop_publishing.publishing_mutation_record) publications`,
        [],
      )
    ).rows[0];
  try {
    f.mark("Ordinary executable startup uses private existing keys and minimum Merchant role");
    await chmod(directory, 0o700);
    const port = await availablePort(),
      origin = `https://127.0.0.1:${port}`,
      host = `127.0.0.1:${port}`,
      privateFile = (name, value) =>
        writeFile(join(directory, name), value, { mode: 0o600, flag: "wx" });
    assert(typeof existingCookie === "string", "EXISTING_REAL_SESSION_REQUIRED");
    assert.match(merchant.password, /^[a-f0-9]{64}$/u);
    await privateFile(
      "installation.json",
      JSON.stringify({
        schemaVersion: 1,
        environment: "InternalTest",
        database: context.clientConfig.database,
        port: Number(context.clientConfig.port),
        roles: { api: merchant.role, worker: f.role },
      }),
    );
    await privateFile("api-password", merchant.password);
    await privateFile(
      "workforce-credentials.json",
      await readFile(join(f.directory, "workforce-credentials.json")),
    );
    await privateFile("client-secret", clientSecret);
    const keyFile = join(directory, "tls-key.pem"),
      certificateFile = join(directory, "tls-certificate.pem");
    try {
      await execute(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-sha256",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=BOP-RMS Synthetic InternalTest",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-addext",
          "basicConstraints=critical,CA:FALSE",
          "-addext",
          "keyUsage=critical,digitalSignature,keyEncipherment",
          "-addext",
          "extendedKeyUsage=serverAuth",
          "-keyout",
          keyFile,
          "-out",
          certificateFile,
        ],
        { timeout: 30000, maxBuffer: 65536 },
      );
    } catch {
      throw new Error("SYNTHETIC_STARTUP_TLS_UNAVAILABLE");
    }
    await chmod(keyFile, 0o600);
    await chmod(certificateFile, 0o600);
    const certificate = await readFile(certificateFile);
    await privateFile(
      "brand-administration.json",
      JSON.stringify({
        schemaVersion: 1,
        environment: "InternalTest",
        database: context.clientConfig.database,
        exactOrigin: origin,
        workforce: {
          environment: workforce.configuration.environment,
          issuer,
          clientId,
          managedLoginOrigin,
          clientSecretFile: "client-secret",
          credentialsFile: "workforce-credentials.json",
        },
        tls: { keyFile: "tls-key.pem", certificateFile: "tls-certificate.pem" },
      }),
    );
    const beforeBusiness = await business(),
      actualBrand = (
        await f.admin.query(
          "SELECT lifecycle,version::int FROM bop_tenant.brand WHERE brand_id=$1",
          [brandReference],
        )
      ).rows[0];
    assert(actualBrand, "EXISTING_ACTUAL_BRAND_REQUIRED");
    assert.equal(beforeBusiness.stores, 0);
    assert.equal(beforeBusiness.assignments, 0);
    const send = (
      path,
      {
        method = "GET",
        cookie: credential,
        csrf,
        site = "same-origin",
        body = {},
        requestHost = host,
      } = {},
    ) =>
      new Promise((resolve, reject) => {
        const request = httpsRequest(
          origin + path,
          {
            method,
            ca: certificate,
            rejectUnauthorized: true,
            // Verify the actual loopback TLS endpoint even when the HTTP Host
            // is deliberately invalid; an IP endpoint has no DNS SNI name.
            servername: "",
            agent: false,
            headers: {
              host: requestHost,
              origin,
              "sec-fetch-site": site,
              ...(credential === undefined ? {} : { cookie: credential }),
              ...(csrf === undefined ? {} : { "x-bop-csrf": csrf }),
              ...(method === "POST" ? { "content-type": "application/json" } : {}),
            },
          },
          (response) => {
            response.on("error", reject);
            if (response.socket.encrypted !== true || response.socket.authorized !== true) {
              response.destroy(new Error("ACTUAL_VERIFIED_TLS_REQUIRED"));
              return;
            }
            let bytes = 0,
              content = "";
            response.setEncoding("utf8");
            response.on("data", (part) => {
              bytes += Buffer.byteLength(part);
              if (bytes > 8 * 1024 * 1024) response.destroy(new Error("STARTUP_RESPONSE_LIMIT"));
              else content += part;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode, headers: response.headers, body: content }),
            );
          },
        );
        request.on("error", reject);
        request.setTimeout(15000, () => request.destroy(new Error("STARTUP_REQUEST_TIMEOUT")));
        request.end(method === "POST" ? JSON.stringify(body) : undefined);
      });
    const current = async (browserCookie) => {
      const response = await send(`${prefix}/session`, { cookie: browserCookie });
      assert.equal(response.status, 200, "ACTUAL_STARTUP_CURRENT_REQUIRED");
      const value = JSON.parse(response.body);
      assert(value.authenticated === true && value.recentMfaRequired === false);
      assert(
        value.workspace.selectedScope.actorReference === actorReference,
        "ACTUAL_STARTUP_ACTOR_REQUIRED",
      );
      assert(
        value.workspace.selectedScope.brandReference === brandReference,
        "ACTUAL_STARTUP_SELECTION_REQUIRED",
      );
      assert(value.workspace.brand.brandReference === brandReference);
      assert.equal(value.workspace.brand.lifecycle, actualBrand.lifecycle);
      assert.equal(value.workspace.brand.version, actualBrand.version);
      assert.equal(response.headers["cache-control"], "no-store");
      return value;
    };
    runtime = await createInternalBrandAdministrationRuntime({ directory, port });
    await runtime.listen();
    f.mark("Actual TLS serves the production Merchant build and true database readiness");
    const root = await send("/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, "/app/organization/brands");
    const index = await send("/app/organization/brands");
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"], /^text\/html/u);
    const assets = [
      ...new Set(
        [...index.body.matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9_-]+\.(?:js|css))"/gu)].map(
          (match) => match[1],
        ),
      ),
    ];
    assert(
      assets.some((value) => value.endsWith(".js")),
      "ACTUAL_MERCHANT_ENTRY_ASSET_REQUIRED",
    );
    for (const asset of assets) {
      const response = await send(asset);
      assert.equal(response.status, 200);
      assert(response.body.length > 0);
      assert.match(response.headers["content-type"], /^text\/(?:javascript|css)/u);
    }
    const ready = await send("/ready");
    assert.equal(ready.status, 200);
    assert.equal(JSON.parse(ready.body).status, "ready");
    assert.equal(JSON.parse(ready.body).dependencies.database.status, "ready");
    await current(existingCookie);
    await verifySaved(existingCookie, actorReference, brandReference);

    await withProviderCallback(origin, async () => {
      f.mark("Executable TLS login creates a genuine unselected Session and explicit choice");
      const before = await writes(),
        login = await send(`${prefix}/login`);
      assert.equal(login.status, 303);
      const auth = challenge(login),
        callback = await send(auth.path, auth);
      assert.equal(callback.status, 303);
      assert.equal(callback.headers.location, "/app/organization/brands");
      const browserCookie = cookie(callback, "__Host-bop-merchant"),
        saved = await verifySaved(browserCookie, actorReference, null);
      const initial = await send(`${prefix}/discovery/session`, { cookie: browserCookie });
      assert.equal(initial.status, 200);
      const body = JSON.parse(initial.body);
      assert(body.authenticated === true && body.actorReference === actorReference);
      assert.equal(body.selectedBrandReference, null);
      assert(body.csrf === saved.secrets.csrf, "ACTUAL_STARTUP_CSRF_REQUIRED");
      sensitive.push(browserCookie, body.csrf, auth.cookie);
      assert.deepEqual(await writes(), {
        sessions: before.sessions + 1,
        selections: before.selections,
      });
      assert.equal((await send(`${prefix}/session`, { cookie: browserCookie })).status, 409);
      const request = { method: "POST", cookie: browserCookie, csrf: body.csrf };
      const list = await send(`${prefix}/discovery/list`, {
        ...request,
        body: { afterBrandReference: null },
      });
      assert.equal(list.status, 200);
      const listed = JSON.parse(list.body);
      assert(listed.actorReference === actorReference);
      assert.deepEqual(
        listed.items.map((item) => item.brandReference),
        [brandReference],
      );
      assert.equal(listed.items[0].lifecycle, actualBrand.lifecycle);
      const selection = { brandReference, expectedSelectedBrandReference: null };
      const beforeDenied = await writes();
      assert.equal(
        (
          await send(`${prefix}/discovery/select`, {
            ...request,
            requestHost: "untrusted.invalid",
            body: selection,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await send(`${prefix}/discovery/select`, {
            ...request,
            csrf: "wrong-csrf",
            body: selection,
          })
        ).status,
        403,
      );
      assert.deepEqual(await writes(), beforeDenied);
      f.mark(
        "Executable runtime rechecks actual SDK status after an initially enabled observation",
      );
      let observations = 0;
      const disabledBefore = participantState.disabledMemberCalls;
      participantState.onWorkforceRead = async () => {
        if (previousRead) await previousRead();
        if (++observations === 2) participantState.membersEnabled = false;
      };
      try {
        const refused = await send(`${prefix}/discovery/select`, { ...request, body: selection });
        assert.notEqual(refused.status, 200);
        assert(observations >= 2, "ACTUAL_LATE_SDK_OBSERVATION_REQUIRED");
        assert(
          participantState.disabledMemberCalls > disabledBefore,
          "ACTUAL_DISABLED_SDK_REQUIRED",
        );
        assert.deepEqual(await writes(), beforeDenied);
      } finally {
        participantState.onWorkforceRead = previousRead;
        participantState.membersEnabled = true;
      }
      browser = await openBrandStartupBrowser({
        origin,
        browserCookie,
        brandReference,
        displayName: listed.items[0].displayName,
        lifecycle: actualBrand.lifecycle,
        version: actualBrand.version,
      });
      assert.equal(browser.selected.status, 200);
      // Resolve the same already-persisted choice; this must not add another
      // selection or Session. All original owning packet assertions remain.
      const selected = await send(`${prefix}/discovery/select`, { ...request, body: selection });
      assert.equal(selected.status, 200);
      const selectedBody = JSON.parse(selected.body);
      assert(
        selectedBody.actorReference === actorReference &&
          selectedBody.brandReference === brandReference,
      );
      assert(selectedBody.href === `/app/organization/brands/${brandReference}`);
      await verifySaved(browserCookie, actorReference, brandReference);
      const selectedCurrent = await current(browserCookie);
      assert(selectedCurrent.csrf === body.csrf);
      assert.deepEqual(await writes(), {
        sessions: before.sessions + 1,
        selections: before.selections + 1,
      });
      f.mark("Executable shutdown closes its pool and restart retains the same encrypted Session");
      await runtime.shutdown("SIGTERM");
      assert.equal(runtime.server.listening, false);
      assert.equal(await connections(), 0, "STARTUP_POOL_MUST_CLOSE");
      runtime = await createInternalBrandAdministrationRuntime({ directory, port });
      await runtime.listen();
      await browser.verifyRestored();
      const restored = await current(browserCookie);
      assert(restored.csrf === body.csrf, "STABLE_PRIVATE_KEYS_MUST_RETAIN_SESSION");
      await verifySaved(browserCookie, actorReference, brandReference);
      assert.deepEqual(await writes(), {
        sessions: before.sessions + 1,
        selections: before.selections + 1,
      });
    });
    assert.deepEqual(await business(), beforeBusiness);
  } catch (error) {
    primaryFailed = true;
    primaryError = error;
  } finally {
    participantState.onWorkforceRead = previousRead;
    participantState.membersEnabled = true;
    try {
      if (browser) await browser.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (runtime) await runtime.shutdown("SIGTERM");
    } catch {
      cleanupFailed = true;
    }
    try {
      if ((await connections()) !== 0) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw new Error("BRAND_STARTUP_NATIVE_CLEANUP_UNAVAILABLE");
  return sensitive;
}
