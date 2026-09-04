import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
  GuestSessionService,
  parseGuestAdmissionEvidence,
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

const { Client } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };

it("WP-2209 persists real HTTP Guest entry with scoped transactions, reconnect, replay and failure isolation", async () => {
  await withIsolatedDatabase({ caseId: "wp2209_entry" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const role = `wp2209_entry_${context.runId}`;
    assert.match(role, /^wp2209_entry_[a-f0-9]+$/u);
    const f = fixture();
    const logs = [];
    const transactions = [];
    const failures = [];
    let fault = null;
    let sequence = 600;
    let runtime;
    await admin.connect();
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA bop_identity, platform_helpers TO ${role}`);
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(`GRANT SELECT, INSERT ON bop_identity.guest_session TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );

      const runner = {
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          let committed = false;
          let wrote = false;
          try {
            await client.query(`SET ROLE ${role}`);
            await client.query("BEGIN");
            await client.query("SET LOCAL statement_timeout = '5s'");
            await client.query("SET LOCAL lock_timeout = '2s'");
            await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
            const result = await action({
              async query(sql, values) {
                if (sql.startsWith("INSERT INTO bop_identity.guest_session")) wrote = true;
                return client.query(sql, [...values]);
              },
            });
            if (wrote && fault === "rollback")
              throw new Error("synthetic rollback SQL/bind detail");
            await client.query("COMMIT");
            committed = true;
            const cleared = await client.query(
              "SELECT current_setting('bop.brand_id', true) AS brand, current_setting('bop.store_id', true) AS store",
            );
            assert.deepEqual(cleared.rows, [{ brand: "", store: "" }]);
            transactions.push("committed");
            if (wrote && fault === "unknown")
              throw new Error("synthetic lost commit acknowledgement");
            return result;
          } catch (error) {
            failures.push({
              wrote,
              code: /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : "BOUNDED_FAILURE",
            });
            if (!committed) {
              await client.query("ROLLBACK");
              transactions.push("rolled_back");
            }
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const entryStore = createPostgresGuestSessionEntryStore(runner, scope);
      // Only creation and reads are implemented by the real adapter. All lifecycle calls are denied.
      const deniedLifecycle = async () => {
        throw new Error("synthetic lifecycle not configured");
      };
      const store = {
        ...entryStore,
        touchInteractive: deniedLifecycle,
        rotate: deniedLifecycle,
        revoke: deniedLifecycle,
      };
      const options = { ...f.options, session: { ...f.options.session, store } };
      const port = createCustomerEntryComposition(options);
      runtime = createApiServerRuntime({
        port: 0,
        logger: createApiRuntimeLogger({ write: (line) => logs.push(String(line)) }),
        customerEntry: new CustomerEntryHandler({
          port,
          allowedOrigin: "https://customer.invalid",
          now: () => now,
          uuidV7Factory: () => id(++sequence),
        }),
      });
      await runtime.listen();
      const address = runtime.server.address();
      assert(address && typeof address === "object");
      const url = `http://127.0.0.1:${address.port}/bff/customer/entry`;
      const qrToken = f.token();
      const request = (headers = {}) =>
        globalThis.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://customer.invalid",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            ...headers,
          },
          body: JSON.stringify({ qrToken }),
        });
      const denied = await request({ origin: "https://other.invalid" });
      assert.equal(denied.status, 400);
      await denied.text();
      assert.equal(transactions.length, 0);
      const response = await request();
      assert.equal(response.status, 201, JSON.stringify(failures));
      assert.match(response.headers.get("cache-control"), /no-store/u);
      const body = await response.json();
      const cookie = response.headers.get("set-cookie");
      assert.match(cookie, /^__Host-bop-guest=/u);
      assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/u);
      const sessionCredential = cookie.split(";")[0].split("=")[1];
      const selector = options.session.credentials.hashCredential("Session", sessionCredential);
      const record = await entryStore.resolve(selector);
      assert(record);
      assert.equal(record.session.diningState, "ContextOnly");
      assert.equal(record.session.brandReference, scope.brandReference);
      assert.equal(record.session.storeReference, scope.storeReference);
      assert.equal(record.session.createdAt, now);
      assert.equal(f.records.size, 0);
      assert.equal(f.create.mock.calls.length, 0);

      const reconnected = createPostgresGuestSessionEntryStore(runner, scope);
      assert.deepEqual(await reconnected.resolveOperation(record.operationReference), record);
      const identity = new GuestSessionService({
        ...options.session,
        store: { ...store, ...reconnected },
        admission: { consume: async () => null },
      });
      assert.deepEqual(
        await identity.authorize({
          sessionCredential,
          csrfCredential: body.csrfToken,
          observedAt: now,
        }),
        record.session,
      );
      const issuedCredentials = f.options.session.credentials.generateCredential.mock.calls.length;
      const replay = await identity.create({
        entryRequestReference: id(601),
        operationReference: record.operationReference,
        requestedAt: now,
      });
      assert.equal(replay.status, "AlreadyApplied");
      assert(!("sessionCredential" in replay));
      assert.equal(
        f.options.session.credentials.generateCredential.mock.calls.length,
        issuedCredentials,
      );
      const count = async () =>
        (await admin.query("SELECT count(*)::int AS count FROM bop_identity.guest_session")).rows[0]
          .count;
      assert.equal(await count(), 1);

      for (const otherScope of [
        { ...scope, brandReference: id(88) },
        { ...scope, storeReference: id(88) },
      ]) {
        const otherStore = createPostgresGuestSessionEntryStore(runner, otherScope);
        assert.equal(await otherStore.resolve(selector), null);
        assert.equal(await otherStore.resolveOperation(record.operationReference), null);
        await assert.rejects(otherStore.create({ record }), { code: "GUEST_SESSION_UNAVAILABLE" });
      }

      const scoped = new Client(context.clientConfig);
      await scoped.connect();
      try {
        await scoped.query(`SET ROLE ${role}`);
        assert.deepEqual(
          (
            await scoped.query(
              "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
            )
          ).rows,
          [{ rolsuper: false, rolbypassrls: false }],
        );
        assert.equal(
          (await scoped.query("SELECT count(*)::int AS count FROM bop_identity.guest_session"))
            .rows[0].count,
          0,
        );
        await scoped.query("BEGIN");
        await scoped.query(
          "SELECT set_config('bop.brand_id',$1,true), set_config('bop.store_id',$2,true)",
          [scope.brandReference, id(88)],
        );
        assert.equal(
          (await scoped.query("SELECT count(*)::int AS count FROM bop_identity.guest_session"))
            .rows[0].count,
          0,
        );
        await scoped.query("SELECT set_config('bop.store_id',$1,true)", [scope.storeReference]);
        assert.equal(
          (await scoped.query("SELECT count(*)::int AS count FROM bop_identity.guest_session"))
            .rows[0].count,
          1,
        );
        await scoped.query("ROLLBACK");
        await assert.rejects(
          scoped.query("DELETE FROM bop_identity.guest_session"),
          /permission denied/u,
        );
      } finally {
        await scoped.end();
      }

      const concurrent = createGuestSessionRecord({
        ...record,
        session: {
          ...record.session,
          sessionReference: id(800),
          createdAt: "2026-01-15T12:00:00.123Z",
          lastSeenAt: "2026-01-15T12:00:00.123Z",
          idleExpiresAt: "2026-01-15T16:00:00.123Z",
          absoluteExpiresAt: "2026-01-16T12:00:00.123Z",
        },
        operationReference: id(801),
        sessionSelectorHash: "8".repeat(64),
        csrfSelectorHash: "9".repeat(64),
      });
      const results = await Promise.allSettled([
        entryStore.create({ record: concurrent }),
        entryStore.create({ record: concurrent }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      assert.equal(await count(), 2);
      assert.deepEqual(
        await reconnected.resolveOperation(concurrent.operationReference),
        concurrent,
      );

      const wrongContextStore = createPostgresGuestSessionEntryStore(
        {
          run: (action) =>
            runner.run((transaction) =>
              action({
                async query(sql, values) {
                  if (sql.startsWith("INSERT INTO bop_identity.guest_session")) {
                    await transaction.query("SELECT set_config('bop.store_id', $1, true)", [
                      id(88),
                    ]);
                  }
                  return transaction.query(sql, values);
                },
              }),
            ),
        },
        scope,
      );
      const rlsDenied = createGuestSessionRecord({
        ...concurrent,
        session: { ...concurrent.session, sessionReference: id(810) },
        operationReference: id(811),
        sessionSelectorHash: "b".repeat(64),
        csrfSelectorHash: "c".repeat(64),
      });
      await assert.rejects(wrongContextStore.create({ record: rlsDenied }), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.equal(failures.at(-1).code, "42501");
      assert.equal(await count(), 2);

      fault = "rollback";
      const rollback = await request();
      assert.equal(rollback.status, 422);
      assert.equal(rollback.headers.get("set-cookie"), null);
      const rollbackBody = await rollback.text();
      assert(!rollbackBody.includes("SQL"));
      assert.equal(await count(), 2);
      fault = "unknown";
      const unknown = await request();
      assert.equal(unknown.status, 422);
      assert.equal(unknown.headers.get("set-cookie"), null);
      assert(!(await unknown.text()).includes("acknowledgement"));
      assert.equal(await count(), 3);
      fault = null;
      const credentialsAfterUnknown =
        f.options.session.credentials.generateCredential.mock.calls.length;
      // Re-enter the exact operation through composition: it must not issue replacement credentials.
      f.admission.mockImplementation(async (input) =>
        parseGuestAdmissionEvidence(f.admissionEvidence(input)),
      );
      const lost = await port.establish({
        entryRequestReference: id(605),
        operationReference: id(606),
        requestedAt: now,
        qrToken,
      });
      assert.deepEqual(lost, { status: "EntryUnavailable" });
      assert.equal(
        f.options.session.credentials.generateCredential.mock.calls.length,
        credentialsAfterUnknown,
      );
      assert.equal(await count(), 3);
      assert(transactions.includes("rolled_back"));

      const stored = JSON.stringify(
        (await admin.query("SELECT row_to_json(g) AS row FROM bop_identity.guest_session AS g"))
          .rows,
      );
      for (const secret of [qrToken, sessionCredential, body.csrfToken]) {
        assert(!stored.includes(secret));
        assert(!logs.join("").includes(secret));
      }
      for (const internal of [
        scope.brandReference,
        scope.storeReference,
        "synthetic rollback SQL",
        "synthetic lost commit",
      ])
        assert(!logs.join("").includes(internal));
      for (const field of [
        "sessionCredential",
        "sessionReference",
        "brandReference",
        "storeReference",
      ])
        assert(!(field in body));
    } finally {
      if (runtime) await runtime.shutdown("SIGTERM");
      await admin.end();
    }
    assert.equal(runtime.server.listening, false);
  });
});
