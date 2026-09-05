import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { URL } from "node:url";
import { it } from "vitest";
import pg from "pg";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import {
  fixture,
  id,
  now,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createCustomerEntryComposition } from "../../../apps/api/src/customer-entry-composition.ts";
import { CustomerEntryHandler } from "../../../apps/api/src/customer-entry.ts";
import { createApiRuntimeLogger, createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { browserCheck, withCustomerEntryBrowser } from "../test-support/customer-entry-browser.mjs";

const { Client, Pool } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };

async function expectCounts(admin, expected) {
  const result = await admin.query(`SELECT
    (SELECT count(*)::integer FROM bop_identity.guest_session) AS sessions,
    (SELECT count(*)::integer FROM bop_identity.guest_session_operation) AS operations`);
  browserCheck(
    result.rows[0].sessions === expected && result.rows[0].operations === expected,
    "WP2215_PERSISTED_COUNTS_MISMATCH",
  );
}

async function checkBrowserPrivacy(page, credentials = []) {
  const privacy = await page.evaluate(async () => {
    const cachedUrls = [];
    for (const name of await globalThis.caches.keys()) {
      const cache = await globalThis.caches.open(name);
      for (const request of await cache.keys()) cachedUrls.push(request.url);
    }
    return {
      cookie: globalThis.document.cookie,
      html: globalThis.document.documentElement.outerHTML,
      localLength: globalThis.localStorage.length,
      sessionLength: globalThis.sessionStorage.length,
      databaseCount: (await globalThis.indexedDB.databases()).length,
      cachedUrls,
    };
  });
  browserCheck(new URL(page.url()).hash === "", "WP2215_FRAGMENT_NOT_REMOVED");
  browserCheck(new URL(page.url()).search === "", "WP2215_QUERY_NOT_EMPTY");
  browserCheck(privacy.cookie === "", "WP2215_COOKIE_VISIBLE_TO_SCRIPT");
  browserCheck(
    privacy.localLength === 0 && privacy.sessionLength === 0 && privacy.databaseCount === 0,
    "WP2215_PRIVATE_BROWSER_STORAGE",
  );
  browserCheck(
    credentials.every((credential) => !privacy.html.includes(credential)),
    "WP2215_CREDENTIAL_IN_DOM",
  );
  browserCheck(
    privacy.cachedUrls.every((value) => {
      const url = new URL(value);
      return (
        url.origin === new URL(page.url()).origin &&
        !url.pathname.startsWith("/bff/") &&
        !url.pathname.startsWith("/api/") &&
        credentials.every((credential) => !value.includes(credential))
      );
    }),
    "WP2215_PRIVATE_RESPONSE_CACHED",
  );
}

async function navigateEntry(context, origin, token) {
  const page = await context.newPage();
  const [response] = await Promise.all([
    page.waitForResponse((value) => new URL(value.url()).pathname === "/bff/customer/entry"),
    page.goto(`${origin}/#qr=${token}`),
  ]);
  return { page, response };
}

async function expectPortClosed(port) {
  const closed = await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error) => {
      socket.destroy();
      resolve(error.code === "ECONNREFUSED");
    });
  });
  browserCheck(closed, "WP2215_LISTENER_REMAINS");
}

it("WP-2215 persists normal Customer browser entry and denies invalid or rolled-back entry", async () => {
  let phase = "DATABASE_SETUP";
  try {
    await withIsolatedDatabase({ caseId: "wp2215_browser" }, async (database) => {
      const admin = new Client(database.clientConfig);
      const role = `wp2215_entry_${database.runId}`;
      browserCheck(/^wp2215_entry_[a-f0-9]+$/u.test(role), "WP2215_ROLE_NAME_INVALID");
      const pools = [];
      let roleCreated = false;
      await admin.connect();
      try {
        await admin.query(
          `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        roleCreated = true;
        await admin.query(`GRANT USAGE ON SCHEMA bop_identity, platform_helpers TO ${role}`);
        await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
        await admin.query(
          `GRANT SELECT, INSERT ON bop_identity.guest_session, bop_identity.guest_session_operation TO ${role}`,
        );
        await admin.query(
          `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
        );
        const newRunner = () => {
          const pool = new Pool({
            ...database.clientConfig,
            max: 2,
            connectionTimeoutMillis: 2_000,
            query_timeout: 5_000,
          });
          pools.push(pool);
          return createTenantTransactionRunner(
            {
              options: pool.options,
              async connect() {
                const client = await pool.connect();
                try {
                  await client.query(`SET ROLE ${role}`);
                  return client;
                } catch {
                  client.release(true);
                  throw new Error("WP2215_ROLE_SETUP_FAILED");
                }
              },
            },
            { brandId: scope.brandReference, storeId: scope.storeReference },
          );
        };
        const pooled = newRunner();
        let failAfterInsert = false;
        let rolledBackInsert = false;
        const runner = {
          run(action) {
            return pooled.run(async (transaction) => {
              let inserted = false;
              const result = await action({
                async query(sql, values) {
                  const answer = await transaction.query(sql, values);
                  if (/^INSERT INTO bop_identity\.guest_session\s/u.test(sql)) inserted = true;
                  return answer;
                },
              });
              if (failAfterInsert && inserted) {
                rolledBackInsert = true;
                throw new Error("WP2215_INJECTED_PERSISTENCE_FAILURE");
              }
              return result;
            });
          },
        };
        const selectorKey = randomBytes(32);
        const credentials = createGuestSessionCredentialProvider(selectorKey);
        selectorKey.fill(0);
        const f = fixture();
        const store = createPostgresGuestSessionEntryStore(runner, scope);
        const options = { ...f.options, session: { ...f.options.session, credentials, store } };
        const port = createCustomerEntryComposition(options);
        const logs = [];
        let sequence = 800;
        let runtime;
        let httpsPort;
        let apiPort;
        phase = "BROWSER_SETUP";
        await withCustomerEntryBrowser(
          (origin) => {
            runtime = createApiServerRuntime({
              port: 0,
              logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
              customerEntry: new CustomerEntryHandler({
                port,
                allowedOrigin: origin,
                now: () => now,
                uuidV7Factory: () => id(++sequence),
              }),
            });
            return runtime;
          },
          async ({ origin, newContext, violations, entryStatus }) => {
            try {
              httpsPort = Number(new URL(origin).port);
              apiPort = runtime.server.address().port;
              phase = "HAPPY_ENTRY";
              const context = await newContext();
              const token = f.token();
              const { page, response } = await navigateEntry(context, origin, token);
              browserCheck(response.status() === 201, "WP2215_ENTRY_NOT_CREATED");
              await page.getByRole("heading", { name: "Synthetic Store", exact: true }).waitFor();
              browserCheck(
                await page.getByRole("button", { name: "Continue to menu" }).isVisible(),
                "WP2215_SUCCESS_UI_MISSING",
              );
              browserCheck(
                (await page.getByRole("status", { name: "Local synthetic preview" }).count()) === 0,
                "WP2215_DEMO_ENTRY_USED",
              );
              const body = await response.json();
              const cookies = await context.cookies();
              browserCheck(cookies.length === 1, "WP2215_COOKIE_COUNT");
              const cookie = cookies[0];
              browserCheck(
                cookie.name === "__Host-bop-guest" &&
                  cookie.secure &&
                  cookie.httpOnly &&
                  cookie.sameSite === "Lax" &&
                  cookie.path === "/" &&
                  cookie.domain === "127.0.0.1",
                "WP2215_COOKIE_ATTRIBUTES",
              );
              browserCheck(
                cookie.value.length === 43 && body.csrfToken.length === 43,
                "WP2215_CREDENTIAL_LENGTH",
              );
              phase = "SERVICE_WORKER_READY";
              await page.waitForFunction(
                async () => {
                  const registration = await globalThis.navigator.serviceWorker.getRegistration();
                  return registration?.active?.state === "activated";
                },
                null,
                { timeout: 10_000 },
              );
              await checkBrowserPrivacy(page, [token, cookie.value, body.csrfToken]);
              phase = "FRESH_CONNECTION";
              const freshStore = createPostgresGuestSessionEntryStore(newRunner(), scope);
              const selector = credentials.hashCredential("Session", cookie.value);
              const persisted = await freshStore.resolve(selector);
              browserCheck(
                persisted !== null &&
                  persisted.session.status === "Active" &&
                  persisted.session.version === 1 &&
                  persisted.session.diningState === "ContextOnly",
                "WP2215_FRESH_SESSION_MISSING",
              );
              browserCheck(
                persisted.sessionSelectorHash === selector &&
                  persisted.csrfSelectorHash === credentials.hashCredential("Csrf", body.csrfToken),
                "WP2215_PERSISTED_SELECTORS",
              );
              const storedText = JSON.stringify(persisted);
              browserCheck(
                [token, cookie.value, body.csrfToken].every((value) => !storedText.includes(value)),
                "WP2215_RAW_CREDENTIAL_PERSISTED",
              );
              const authorized = await new GuestSessionService({
                ...options.session,
                admission: { consume: async () => null },
                store: freshStore,
                now: () => now,
              }).authorize({
                sessionCredential: cookie.value,
                csrfCredential: body.csrfToken,
                observedAt: now,
              });
              browserCheck(
                authorized.sessionReference === persisted.session.sessionReference,
                "WP2215_COOKIE_AUTHORIZATION_FAILED",
              );
              browserCheck(
                f.create.mock.calls.length === 0 && f.records.size === 0,
                "WP2215_MEMORY_SESSION_STORE_USED",
              );
              await expectCounts(admin, 1);

              phase = "REQUEST_GUARDS";
              const admissionCount = f.admission.mock.calls.length;
              const headers = { origin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" };
              for (const override of [
                { origin: "https://127.0.0.1:1" },
                { "sec-fetch-site": "cross-site" },
                { "sec-fetch-mode": "navigate" },
              ]) {
                const status = await entryStatus(token, { ...headers, ...override });
                browserCheck(status === 400, "WP2215_REQUEST_GUARD_FAILED");
              }
              browserCheck(
                f.admission.mock.calls.length === admissionCount,
                "WP2215_GUARD_REACHED_DOMAIN",
              );
              await expectCounts(admin, 1);

              phase = "ISOLATED_CONTEXT";
              const isolated = await newContext();
              browserCheck((await isolated.cookies()).length === 0, "WP2215_COOKIE_CONTEXT_LEAK");
              const isolatedPage = await isolated.newPage();
              await isolatedPage.goto(origin);
              await isolatedPage
                .getByRole("heading", { name: "Scan the location QR code", exact: true })
                .waitFor();
              await checkBrowserPrivacy(isolatedPage);

              phase = "INVALID_FRAGMENT";
              const invalid = await newContext();
              const invalidPage = await invalid.newPage();
              const beforeInvalid = f.admission.mock.calls.length;
              await invalidPage.goto(`${origin}/#qr=invalid`);
              await invalidPage
                .getByRole("heading", { name: "Scan the location QR code", exact: true })
                .waitFor();
              browserCheck(
                f.admission.mock.calls.length === beforeInvalid &&
                  (await invalid.cookies()).length === 0,
                "WP2215_INVALID_FRAGMENT_CREATED_SESSION",
              );
              await checkBrowserPrivacy(invalidPage);

              phase = "REVOKED_ENTRY";
              f.context.qrState = "Revoked";
              const revoked = await newContext();
              const deniedEntry = await navigateEntry(revoked, origin, token);
              browserCheck(deniedEntry.response.status() === 422, "WP2215_REVOKED_ENTRY_ALLOWED");
              await deniedEntry.page
                .getByRole("heading", { name: "This entry link can’t be used", exact: true })
                .waitFor();
              browserCheck((await revoked.cookies()).length === 0, "WP2215_REVOKED_ENTRY_COOKIE");
              await expectCounts(admin, 1);
              await checkBrowserPrivacy(deniedEntry.page, [token]);

              phase = "ROLLED_BACK_ENTRY";
              f.context.qrState = "Enabled";
              failAfterInsert = true;
              const failed = await newContext();
              const failedEntry = await navigateEntry(failed, origin, token);
              // Existing composition maps persistence failure to the same unavailable Entry result.
              browserCheck(
                failedEntry.response.status() === 422,
                "WP2215_FAILED_PERSISTENCE_SUCCESS",
              );
              await failedEntry.page
                .getByRole("heading", { name: "This entry link can’t be used", exact: true })
                .waitFor();
              browserCheck(
                rolledBackInsert && (await failed.cookies()).length === 0,
                "WP2215_ROLLBACK_NOT_PROVEN",
              );
              browserCheck(
                (await failedEntry.page
                  .getByRole("button", { name: "Continue to menu" })
                  .count()) === 0,
                "WP2215_FAILED_ENTRY_SUCCESS_UI",
              );
              await expectCounts(admin, 1);
              await checkBrowserPrivacy(failedEntry.page, [token]);
              browserCheck(violations.length === 0, "WP2215_BROWSER_BOUNDARY_VIOLATION");
              const output = logs.join("\n");
              browserCheck(
                [token, cookie.value, body.csrfToken, "INSERT INTO", "guest_session"].every(
                  (value) => !output.includes(value),
                ),
                "WP2215_SENSITIVE_LOG_OUTPUT",
              );
            } catch (error) {
              if (/^WP2215_[A-Z_]+$/u.test(error?.message ?? "")) throw error;
              browserCheck(false, `WP2215_${phase}_FAILED`);
            }
          },
        );
        browserCheck(!runtime.server.listening, "WP2215_API_LISTENER_REMAINS");
        await expectPortClosed(httpsPort);
        await expectPortClosed(apiPort);
      } finally {
        const ended = await Promise.allSettled(pools.map((pool) => pool.end()));
        let roleCleanupFailed = false;
        try {
          if (roleCreated) {
            await admin.query(`DROP OWNED BY ${role}`);
            await admin.query(`DROP ROLE ${role}`);
          }
        } catch {
          roleCleanupFailed = true;
        }
        await admin.end();
        browserCheck(
          !roleCleanupFailed && ended.every((item) => item.status === "fulfilled"),
          "WP2215_DATABASE_CLEANUP_FAILED",
        );
      }
    });
  } catch (error) {
    if (/^WP2215_[A-Z_]+$/u.test(error?.message ?? "")) throw error;
    browserCheck(false, `WP2215_${phase}_FAILED`);
  }
});

it("WP-2215 closes browser and both listeners after a failing test callback", async () => {
  let runtime;
  let httpsPort;
  let apiPort;
  let failed = false;
  try {
    await withCustomerEntryBrowser(
      () => {
        runtime = createApiServerRuntime({
          port: 0,
          logger: createApiRuntimeLogger({ write: () => undefined }),
        });
        return runtime;
      },
      async ({ origin, newContext }) => {
        httpsPort = Number(new URL(origin).port);
        apiPort = runtime.server.address().port;
        const context = await newContext();
        const page = await context.newPage();
        await page.goto(origin);
        throw new Error("WP2215_EXPECTED_CALLBACK_FAILURE");
      },
    );
  } catch (error) {
    if (error.message !== "WP2215_EXPECTED_CALLBACK_FAILURE") throw error;
    failed = true;
  }
  browserCheck(failed && !runtime.server.listening, "WP2215_FAILURE_CLEANUP_NOT_PROVEN");
  await expectPortClosed(httpsPort);
  await expectPortClosed(apiPort);
});
