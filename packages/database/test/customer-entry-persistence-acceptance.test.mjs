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

it("WP-2209/WP-2210 persist HTTP Guest entry and interactive renewal with scoped failure isolation", async () => {
  await withIsolatedDatabase({ caseId: "wp2210_entry" }, async (context) => {
    const admin = new Client(context.clientConfig);
    const role = `wp2210_entry_${context.runId}`;
    assert.match(role, /^wp2210_entry_[a-f0-9]+$/u);
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
        `GRANT UPDATE (last_seen_at, idle_expires_at, version) ON bop_identity.guest_session TO ${role}`,
      );
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
                if (/^(INSERT INTO|UPDATE) bop_identity\.guest_session/u.test(sql)) wrote = true;
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
      // Rotation/revocation remain unconfigured; entry and interactive touch use real persistence.
      const deniedLifecycle = async () => {
        throw new Error("synthetic lifecycle not configured");
      };
      const store = {
        ...entryStore,
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
      // WP-2210: background reads never renew; interactive reads persist exactly three fields.
      const observedAt = new Date(Date.parse(now) + 60_000).toISOString();
      assert.deepEqual(
        await identity.resolve({ sessionCredential, activity: "Background", observedAt }),
        record.session,
      );
      assert.deepEqual(await reconnected.resolve(selector), record);
      const renewed = await identity.resolve({
        sessionCredential,
        activity: "Interactive",
        observedAt,
      });
      const renewedRecord = await reconnected.resolve(selector);
      assert.deepEqual(renewedRecord, {
        ...record,
        session: {
          ...record.session,
          version: 2,
          lastSeenAt: observedAt,
          idleExpiresAt: new Date(Date.parse(observedAt) + 4 * 60 * 60_000).toISOString(),
        },
      });
      assert.deepEqual(renewed, renewedRecord.session);
      assert.deepEqual(
        await reconnected.resolveOperation(record.operationReference),
        renewedRecord,
      );
      const touchCommand = {
        selectorHash: selector,
        expectedVersion: 2,
        observedAt,
        idleExpiresAt: renewed.idleExpiresAt,
      };
      const race = await Promise.all([
        entryStore.touchInteractive(touchCommand),
        reconnected.touchInteractive(touchCommand),
      ]);
      assert.equal(race.filter((result) => result !== null).length, 1);
      assert.equal(race.filter((result) => result === null).length, 1);
      const afterRace = await reconnected.resolve(selector);
      assert.equal(afterRace.session.version, 3);
      assert.equal(await entryStore.touchInteractive(touchCommand), null);
      assert.equal(
        await entryStore.touchInteractive({
          ...touchCommand,
          expectedVersion: 3,
          observedAt: now,
          idleExpiresAt: record.session.idleExpiresAt,
        }),
        null,
      );
      assert.deepEqual(await reconnected.resolve(selector), afterRace);

      fault = "rollback";
      await assert.rejects(entryStore.touchInteractive({ ...touchCommand, expectedVersion: 3 }), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      fault = null;
      assert.deepEqual(await reconnected.resolve(selector), afterRace);
      fault = "unknown";
      await assert.rejects(entryStore.touchInteractive({ ...touchCommand, expectedVersion: 3 }), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      fault = null;
      assert.equal((await reconnected.resolve(selector)).session.version, 4);
      assert.equal(
        await entryStore.touchInteractive({ ...touchCommand, expectedVersion: 3 }),
        null,
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
        assert.equal(
          await otherStore.touchInteractive({ ...touchCommand, expectedVersion: 4 }),
          null,
        );
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
          scoped.query("UPDATE bop_identity.guest_session SET status = 'Expired'"),
          /permission denied/u,
        );
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

      // Isolated setup only: place one synthetic record at each terminal/half-open boundary.
      const boundarySelector = concurrent.sessionSelectorHash;
      const baseTime = Date.parse(concurrent.session.createdAt);
      const at = (hours) => new Date(baseTime + hours * 60 * 60_000).toISOString();
      for (const scenario of [
        { status: "Active", last: 0, observed: 4, closure: false },
        { status: "Active", last: 21, observed: 24, closure: false },
        { status: "Active", last: 0, observed: 2, closure: true },
        { status: "Expired", last: 0, observed: 1, closure: false },
        { status: "Revoked", last: 0, observed: 1, closure: false },
      ]) {
        await admin.query(
          `UPDATE bop_identity.guest_session SET
          status = $2, version = 1, last_seen_at = $3, idle_expires_at = $4,
          order_closed_at = $5, closure_expires_at = $6,
          revocation_reason = $7, revoked_at = $8
          WHERE guest_session_id = $1`,
          [
            concurrent.session.sessionReference,
            scenario.status,
            at(scenario.last),
            at(scenario.last + 4),
            scenario.closure ? at(0) : null,
            scenario.closure ? at(2) : null,
            scenario.status === "Revoked" ? "Logout" : null,
            scenario.status === "Revoked" ? at(0) : null,
          ],
        );
        const before = await entryStore.resolve(boundarySelector);
        assert.equal(
          await entryStore.touchInteractive({
            selectorHash: boundarySelector,
            expectedVersion: 1,
            observedAt: at(scenario.observed),
            idleExpiresAt: at(scenario.observed + 4),
          }),
          null,
        );
        assert.deepEqual(await reconnected.resolve(boundarySelector), before);
      }
      const wrongTouchContext = createPostgresGuestSessionEntryStore(
        {
          run: (action) =>
            runner.run((transaction) =>
              action({
                async query(sql, values) {
                  if (sql.startsWith("UPDATE bop_identity.guest_session")) {
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
      const beforeRls = await reconnected.resolve(selector);
      assert.equal(
        await wrongTouchContext.touchInteractive({ ...touchCommand, expectedVersion: 4 }),
        null,
      );
      assert.deepEqual(await reconnected.resolve(selector), beforeRls);

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
