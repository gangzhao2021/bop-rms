import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
} from "../../bop/identity/src/index.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import {
  fixture,
  id,
  now as at,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createTenantTransactionRunner } from "../src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client, Pool } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };
import { seedMenu } from "../test-support/local-customer-menu-seed.mjs";
it("composes scoped persisted entry and menu through one restartable loopback runtime", async () => {
  await withIsolatedDatabase({ caseId: "wp2221_runtime" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const pool = new Pool({
      ...context.clientConfig,
      max: 2,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
    });
    const sessionRole = `wp2221_s_${context.runId}`;
    const menuRole = `wp2221_m_${context.runId}`;
    const f = fixture();
    const key = randomBytes(32);
    const credentials = createGuestSessionCredentialProvider(key);
    const logs = [];
    const secrets = [key.toString("hex"), key.toString("base64"), f.token()];
    let runtime;
    let sequence = 600;
    let entryFault = false;
    let menuFault = false;
    let reads = 0;
    let writes = 0;
    await admin.connect();
    try {
      for (const role of [sessionRole, menuRole]) {
        assert.match(role, /^wp2221_[sm]_[a-f0-9]+$/u);
        await admin.query(
          `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        await admin.query(`GRANT USAGE ON SCHEMA platform_helpers TO ${role}`);
        await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
        );
      }
      await admin.query(`GRANT USAGE ON SCHEMA bop_identity TO ${sessionRole}`);
      await admin.query(
        `GRANT SELECT, INSERT ON bop_identity.guest_session, bop_identity.guest_session_operation TO ${sessionRole}`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_catalog TO ${menuRole}`);
      await admin.query(
        `GRANT SELECT ON rms_catalog.published_menu_projection_generation, rms_catalog.published_menu_projection, rms_catalog.published_menu_projection_section, rms_catalog.published_menu_projection_sellable, rms_catalog.published_menu_projection_checkpoint TO ${menuRole}`,
      );
      await seedMenu(admin);
      const sessionRunner = createTenantTransactionRunner(
        {
          options: pool.options,
          async connect() {
            const client = await pool.connect();
            try {
              await client.query(`SET ROLE ${sessionRole}`);
              return client;
            } catch (error) {
              client.release(true);
              throw error;
            }
          },
        },
        { brandId: scope.brandReference, storeId: scope.storeReference },
      );
      const sessionTransactions = {
        async run(action) {
          writes++;
          if (entryFault) throw new Error("synthetic_session_driver_fault");
          return sessionRunner.run(action);
        },
      };
      const menuTransactions = {
        async run(action) {
          reads++;
          if (menuFault) throw new Error("synthetic_menu_driver_fault");
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN READ ONLY");
            await client.query(`SET LOCAL ROLE ${menuRole}`);
            await client.query("SET LOCAL statement_timeout='5s'");
            assert.equal(
              (await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only,
              "on",
            );
            const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            const cleared = await client.query(
              "SELECT current_setting('bop.brand_id',true) AS brand, current_setting('bop.store_id',true) AS store",
            );
            assert(!cleared.rows[0].brand && !cleared.rows[0].store);
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const options = {
        scope,
        entry: { ...f.options, session: { binding: f.options.session.binding, credentials } },
        menuStores: {
          resolvePublic: async (reference) =>
            reference === id(4) ? { ...scope, status: "Active" } : null,
        },
        sessionTransactions,
        menuTransactions,
        allowedOrigin: "https://customer.invalid",
        now: () => at,
        uuidV7Factory: () => id(++sequence),
        runtime: { logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }) },
      };
      const start = async () => {
        runtime = createLocalCustomerRuntime(options);
        await runtime.listen();
        const address = runtime.server.address();
        assert(address && typeof address === "object" && address.address === "127.0.0.1");
        return `http://127.0.0.1:${address.port}`;
      };
      let root = await start();
      const entry = (overrides = {}, qrToken = secrets[2]) =>
        globalThis.fetch(`${root}/bff/customer/entry`, {
          method: "POST",
          headers: {
            origin: options.allowedOrigin,
            "content-type": "application/json",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            ...overrides,
          },
          body: JSON.stringify({ qrToken }),
        });
      const menu = (publicStore = id(4)) =>
        globalThis.fetch(
          `${root}/api/v1/public/stores/${publicStore}/menu?channel=DINE_IN&orderType=TABLE_SERVICE&locale=en-CA`,
        );
      for (const response of [
        await entry({ origin: "https://wrong.invalid" }),
        await entry({}, "bad-qr"),
      ]) {
        assert.equal(response.status, 400);
        await response.text();
      }
      assert.equal(writes, 0);
      const issued = await entry();
      assert.equal(issued.status, 201);
      const body = await issued.json();
      const cookie = issued.headers.get("set-cookie");
      assert.match(cookie, /^__Host-bop-guest=/u);
      assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/u);
      const sessionCredential = cookie.split(";")[0].split("=")[1];
      const selector = credentials.hashCredential("Session", sessionCredential);
      secrets.push(sessionCredential, body.csrfToken, selector);
      assert.equal(f.records.size, 0);
      const sessionStore = createPostgresGuestSessionEntryStore(sessionRunner, scope);
      const record = await sessionStore.resolve(selector);
      assert(record);
      assert.equal(record.session.diningState, "ContextOnly");
      assert.equal(record.session.storeReference, scope.storeReference);
      assert(!JSON.stringify(record).includes(sessionCredential));
      assert(!JSON.stringify(record).includes(body.csrfToken));
      const found = await menu(body.publicStoreReference);
      assert.equal(found.status, 200);
      const publicMenu = await found.json();
      assert.equal(publicMenu.menu.sections[0].sellables[0].name, "Latte");
      assert.equal(publicMenu.menu.sections[0].sellables[0].displayPrice.status, "Unavailable");
      assert.equal(publicMenu.scope.publicStoreReference, id(4));
      const beforeUnknown = reads;
      const unknown = await menu(id(99));
      assert.equal(unknown.status, 404);
      await unknown.text();
      assert.equal(reads, beforeUnknown);
      entryFault = true;
      const denied = await entry();
      assert.equal(denied.status, 422);
      await denied.text();
      entryFault = false;
      assert.equal(
        (await admin.query("SELECT count(*)::int AS count FROM bop_identity.guest_session")).rows[0]
          .count,
        1,
      );
      menuFault = true;
      const unavailable = await menu();
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get("retry-after"), "5");
      assert.deepEqual(await unavailable.json(), {
        schemaVersion: 1,
        error: {
          code: "menu_service_unavailable",
          messageKey: "customer.menu.service_unavailable",
        },
      });
      menuFault = false;
      await runtime.shutdown("SIGTERM");
      assert.equal(runtime.server.listening, false);
      root = await start();
      const afterRestart = await menu();
      assert.equal(afterRestart.status, 200);
      assert.deepEqual(await afterRestart.json(), publicMenu);
      const recreated = new GuestSessionService({
        ...options.entry.session,
        credentials: createGuestSessionCredentialProvider(key),
        store: createPostgresGuestSessionEntryStore(sessionRunner, scope),
        admission: { consume: async () => null },
      });
      assert.deepEqual(
        await recreated.authorize({
          sessionCredential,
          csrfCredential: body.csrfToken,
          observedAt: at,
        }),
        record.session,
      );
      const ready = await globalThis.fetch(`${root}/ready`);
      assert.equal(ready.status, 503);
      await ready.text();
      await runtime.shutdown("SIGTERM");
      assert.equal(runtime.server.listening, false);
      assert(logs.length > 0);
      for (const line of logs) assert.equal(typeof JSON.parse(line), "object");
      for (const forbidden of [
        ...secrets,
        "synthetic_session_driver_fault",
        "synthetic_menu_driver_fault",
        "rms_catalog.",
        "bop_identity.",
      ])
        assert(
          !logs.join("").includes(forbidden),
          "logs must exclude credentials, selectors and driver details",
        );
    } finally {
      try {
        if (runtime) await runtime.shutdown("SIGTERM");
      } finally {
        try {
          await pool.end();
        } finally {
          await admin.end();
        }
      }
      key.fill(0);
    }
  });
}, 120_000);
