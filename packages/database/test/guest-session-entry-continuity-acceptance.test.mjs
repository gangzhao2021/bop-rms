import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import {
  fixture,
  id,
  now,
} from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createCustomerEntryComposition } from "../../../apps/api/src/customer-entry-composition.ts";
import { CustomerEntryHandler } from "../../../apps/api/src/customer-entry.ts";
import { createApiRuntimeLogger, createApiServerRuntime } from "../../../apps/api/src/server.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createTenantTransactionRunner } from "../src/index.ts";

const { Client, Pool } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };
const otherStore = { brandReference: id(1), storeReference: id(902) };
const hours = (n) => n * 3_600_000;

/**
 * M104/M105 (v15): a pickup code scanned again, or "Start a new order", started a new Guest
 * Session and replaced the cookie, so the phone lost its cart, order, receipt and pickup code. The
 * entry now goes on with this phone's visit. Code under test runs as a NOBYPASSRLS role holding
 * only the Guest Session grants the pilot API holds for entry.
 */
it("M104/M105: a rescan resumes the same Guest Session; replaced visits are kept; a failed read never replaces one", async () => {
  await withIsolatedDatabase({ caseId: "m104_entry" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const role = `m104_entry_${context.runId}`;
    assert.match(role, /^m104_entry_[a-f0-9]+$/u);
    const pool = new Pool({
      ...context.clientConfig,
      max: 2,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
    });
    const f = fixture();
    // Pickup: a poster at the counter, no table.
    f.payload.channel = f.context.channel = "Pickup";
    f.payload.publicTableReference =
      f.context.publicTableReference =
      f.context.tableReference =
        null;
    f.context.tableLifecycle = f.context.assignmentState = null;
    const credentials = createGuestSessionCredentialProvider(randomBytes(32));
    const logs = [];
    let failReads = false;
    let sequence = 700;
    let runtime;
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA bop_identity, platform_helpers TO ${role}`);
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT ON bop_identity.guest_session TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT ON bop_identity.guest_session_operation TO ${role}`);
      await admin.query(
        `GRANT UPDATE (last_seen_at, idle_expires_at, version) ON bop_identity.guest_session TO ${role}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );
      const runnerFor = (where) => {
        const pooled = createTenantTransactionRunner(
          {
            options: pool.options,
            async connect() {
              const client = await pool.connect();
              try {
                await client.query(`SET ROLE ${role}`);
                return client;
              } catch (error) {
                client.release(true);
                throw error;
              }
            },
          },
          { brandId: where.brandReference, storeId: where.storeReference },
        );
        return {
          run(action) {
            if (failReads)
              return Promise.reject(
                Object.assign(new Error("synthetic acquire failure"), {
                  code: "TENANT_DATABASE_ACQUIRE_FAILED",
                }),
              );
            return pooled.run(action);
          },
        };
      };
      const entryStore = createPostgresGuestSessionEntryStore(runnerFor(scope), scope);
      const unconfigured = async () => {
        throw new Error("synthetic lifecycle not configured");
      };
      const options = {
        ...f.options,
        session: {
          ...f.options.session,
          credentials,
          store: { ...entryStore, rotate: unconfigured, revoke: unconfigured },
        },
      };
      runtime = createApiServerRuntime({
        port: 0,
        logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
        customerEntry: new CustomerEntryHandler({
          requestAdmission: { consume: async () => ({ status: "Allowed" }) },
          port: createCustomerEntryComposition(options),
          allowedOrigin: "https://customer.invalid",
          now: () => now,
          uuidV7Factory: () => id(++sequence),
        }),
      });
      await runtime.listen();
      const address = runtime.server.address();
      assert(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/bff/customer/entry`;
      const enter = (cookie) =>
        globalThis.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://customer.invalid",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            ...(cookie === undefined ? {} : { cookie }),
          },
          body: JSON.stringify({ qrToken: f.token() }),
        });
      const cookies = (response) => {
        const set = response.headers.getSetCookie();
        const value = (name) => {
          const found = set.find((cookie) => cookie.startsWith(`${name}=`));
          return found === undefined ? undefined : found.split(";")[0].slice(name.length + 1);
        };
        return { guest: value("__Host-bop-guest"), visits: value("__Host-bop-visits") };
      };
      const sessions = async () =>
        (await admin.query("SELECT count(*)::int AS n FROM bop_identity.guest_session")).rows[0].n;
      const versionOf = async (credential) =>
        (await entryStore.resolve(credentials.hashCredential("Session", credential))).session
          .version;
      /** A visit that has already happened at `where`: a record as the entry store keeps it. */
      const visitAt = async (where, createdAt) => {
        const credential = credentials.generateCredential("Session");
        const record = createGuestSessionRecord({
          session: {
            sessionReference: id(++sequence),
            status: "Active",
            version: 1,
            brandReference: where.brandReference,
            storeReference: where.storeReference,
            publicStoreReference: where === scope ? id(4) : id(904),
            publicTableReference: null,
            channel: "Pickup",
            locale: "en-CA",
            qrReference: id(3),
            qrRevocationVersion: 1,
            diningState: "ContextOnly",
            diningSessionReference: null,
            diningParticipantReference: null,
            createdAt,
            lastSeenAt: createdAt,
            idleExpiresAt: new Date(Date.parse(createdAt) + hours(4)).toISOString(),
            absoluteExpiresAt: new Date(Date.parse(createdAt) + hours(24)).toISOString(),
            orderClosedAt: null,
            closureExpiresAt: null,
            rotatedFromGuestSessionReference: null,
            revocationReason: null,
            revokedAt: null,
          },
          sessionSelectorHash: credentials.hashCredential("Session", credential),
          csrfSelectorHash: credentials.hashCredential(
            "Csrf",
            credentials.generateCredential("Csrf"),
          ),
          operationReference: id(++sequence),
          operationIntentHash: credentials.hashOperationIntent(`Create:${sequence}`),
        });
        await createPostgresGuestSessionEntryStore(runnerFor(where), where).create({ record });
        return credential;
      };

      // 1. First scan: a new visit.
      const first = await enter();
      assert.equal(first.status, 201);
      const visit = cookies(first).guest;
      assert.match(visit, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(await sessions(), 1);
      assert.equal(await versionOf(visit), 1);

      // 2. The same poster scanned again: the same visit goes on, renewed; no cookie, no new row.
      const again = await enter(`__Host-bop-guest=${visit}`);
      assert.equal(again.status, 200);
      const body = await again.json();
      assert.equal(body.resumed, true);
      assert.equal(body.csrfToken, credentials.deriveForegroundCsrf(visit));
      assert.deepEqual(cookies(again), { guest: undefined, visits: undefined });
      assert.equal(await sessions(), 1);
      assert.equal(await versionOf(visit), 2);
      assert.equal(f.admission.mock.calls.length, 1);

      // 3. The visit can't be checked (database down): a retry, never a new visit.
      failReads = true;
      const outage = await enter(`__Host-bop-guest=${visit}`);
      failReads = false;
      assert.equal(outage.status, 503);
      assert.deepEqual(cookies(outage), { guest: undefined, visits: undefined });
      assert.equal(await sessions(), 1);

      // 4. A visit here that sat idle for 5 hours: a new visit, which keeps the old one for its
      //    receipts and says the earlier cart ended.
      const idle = await visitAt(scope, new Date(Date.parse(now) - hours(5)).toISOString());
      const afterIdle = await enter(`__Host-bop-guest=${idle}`);
      assert.equal(afterIdle.status, 201);
      assert.equal((await afterIdle.json()).previousVisit, "EndedReceiptsKept");
      const replacement = cookies(afterIdle);
      assert.notEqual(replacement.guest, idle);
      assert.equal(replacement.visits, idle);
      assert.equal(await sessions(), 3);

      // 5. A phone now at another Store, with this Store's visit kept: scanning here again goes
      //    back to it; the other Store's visit is kept in turn.
      const elsewhere = await visitAt(otherStore, now);
      const back = await enter(`__Host-bop-guest=${elsewhere}; __Host-bop-visits=${visit}`);
      assert.equal(back.status, 200);
      assert.equal((await back.json()).resumed, true);
      assert.deepEqual(cookies(back), { guest: visit, visits: elsewhere });
      assert.equal(await sessions(), 4);

      // Credentials never reach the request log.
      for (const credential of [visit, idle, elsewhere])
        assert(!logs.join("\n").includes(credential));
    } finally {
      if (runtime) await runtime.shutdown("SIGTERM");
      await pool.end();
      await admin.end();
    }
  });
});
