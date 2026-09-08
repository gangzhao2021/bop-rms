import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it, vi } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createGuestSessionRecord,
  createPostgresGuestSessionEntryStore,
  createPostgresGuestSessionLegacyInspector,
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
import { createTenantTransactionRunner } from "../src/index.ts";

const { Client, Pool } = pg;
const scope = { brandReference: id(1), storeReference: id(2) };

it.each(["synthetic", "crypto"])("HTTP Guest lifecycle with %s", async (mode) => {
  await withIsolatedDatabase({ caseId: `wp2216_${mode}` }, async (context) => {
    const admin = new Client(context.clientConfig);
    const role = `wp2216_${mode}_${context.runId}`;
    assert.match(role, /^wp2216_(?:synthetic|crypto)_[a-f0-9]+$/u);
    const pool = new Pool({
      ...context.clientConfig,
      max: 2,
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
    });
    const f = fixture();
    const selectorKey = randomBytes(32);
    const provider = createGuestSessionCredentialProvider(selectorKey);
    const credentials =
      mode === "crypto"
        ? { ...provider, generateCredential: vi.fn(provider.generateCredential) }
        : f.options.session.credentials;
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
      await admin.query(`GRANT SELECT, INSERT ON bop_identity.guest_session_operation TO ${role}`);
      await admin.query(
        `GRANT UPDATE (last_seen_at, idle_expires_at, version) ON bop_identity.guest_session TO ${role}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid), platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
      );

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
        { brandId: scope.brandReference, storeId: scope.storeReference },
      );
      const runner = {
        async run(action) {
          if (fault === null) {
            try {
              const value = await pooled.run(action);
              transactions.push("committed");
              return value;
            } catch (error) {
              failures.push({ code: "BOUNDED_FAILURE" });
              throw error;
            }
          }
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
      const options = { ...f.options, session: { ...f.options.session, credentials, store } };
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
      assert.match(sessionCredential, /^[A-Za-z0-9_-]{43}$/u);
      assert.match(body.csrfToken, /^[A-Za-z0-9_-]{43}$/u);
      assert.equal(Buffer.from(sessionCredential, "base64url").byteLength, 32);
      assert.equal(Buffer.from(body.csrfToken, "base64url").byteLength, 32);
      assert(sessionCredential !== body.csrfToken);
      assert.match(
        record.session.sessionReference,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      assert.equal(record.csrfSelectorHash, credentials.hashCredential("Csrf", body.csrfToken));
      assert(selector !== credentials.hashCredential("Csrf", sessionCredential));
      const tamperedCsrf = `${body.csrfToken[0] === "A" ? "B" : "A"}${body.csrfToken.slice(1)}`;
      for (const deniedInput of [
        { sessionCredential: body.csrfToken, csrfCredential: sessionCredential, observedAt: now },
        { sessionCredential, csrfCredential: sessionCredential, observedAt: now },
        { sessionCredential, csrfCredential: tamperedCsrf, observedAt: now },
      ])
        await assert.rejects(identity.authorize(deniedInput), {
          code: "GUEST_SESSION_UNAVAILABLE",
        });
      if (mode === "crypto") {
        const restarted = new GuestSessionService({
          ...options.session,
          credentials: createGuestSessionCredentialProvider(Buffer.from(selectorKey)),
          store: reconnected,
          admission: { consume: async () => null },
        });
        assert.deepEqual(
          await restarted.authorize({
            sessionCredential,
            csrfCredential: body.csrfToken,
            observedAt: now,
          }),
          record.session,
        );
        const otherKey = new GuestSessionService({
          ...options.session,
          credentials: createGuestSessionCredentialProvider(randomBytes(32)),
          store: reconnected,
          admission: { consume: async () => null },
        });
        await assert.rejects(
          otherKey.authorize({
            sessionCredential,
            csrfCredential: body.csrfToken,
            observedAt: now,
          }),
          { code: "GUEST_SESSION_UNAVAILABLE" },
        );
      }
      assert.deepEqual(await reconnected.resolve(selector), record);
      const issuedCredentials = credentials.generateCredential.mock.calls.length;
      const replay = await identity.create({
        entryRequestReference: id(601),
        operationReference: record.operationReference,
        requestedAt: now,
      });
      assert.equal(replay.status, "AlreadyApplied");
      assert(!("sessionCredential" in replay));
      assert.equal(credentials.generateCredential.mock.calls.length, issuedCredentials);
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
      assert.deepEqual(await reconnected.resolveOperation(record.operationReference), record);
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
        await assert.rejects(otherStore.create({ record }), {
          code: "GUEST_SESSION_UNAVAILABLE",
        });
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
        assert.equal(
          (
            await scoped.query(
              "SELECT count(*)::int AS count FROM bop_identity.guest_session_operation",
            )
          ).rows[0].count,
          0,
        );
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
      assert.equal(failures.at(-1).code, "BOUNDED_FAILURE");
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
      const credentialsAfterUnknown = credentials.generateCredential.mock.calls.length;
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
      assert.equal(credentials.generateCredential.mock.calls.length, credentialsAfterUnknown);
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

      // WP-2211: enable only lifecycle columns in this disposable role, never production grants.
      await admin.query(
        `GRANT UPDATE (status,revocation_reason,revoked_at) ON bop_identity.guest_session TO ${role}`,
      );
      const lifecycle = new GuestSessionService({
        ...options.session,
        store: reconnected,
        admission: {
          consume: async (input) =>
            parseGuestAdmissionEvidence({
              decision: "Allowed",
              evidenceReference: id(901),
              entryRequestReference: input.entryRequestReference,
              ...scope,
              publicStoreReference: record.session.publicStoreReference,
              publicTableReference: record.session.publicTableReference,
              channel: record.session.channel,
              locale: record.session.locale,
              qrReference: record.session.qrReference,
              qrRevocationVersion: record.session.qrRevocationVersion,
              evaluatedAt: now,
              validUntil: new Date(Date.parse(now) + 300_000).toISOString(),
            }),
        },
      });
      const rotateInput = {
        sessionCredential,
        expectedVersion: 4,
        entryRequestReference: id(902),
        operationReference: id(903),
        reason: "Rotated",
        requestedAt: observedAt,
      };
      fault = "rollback";
      await assert.rejects(lifecycle.rotate(rotateInput), { code: "GUEST_SESSION_UNAVAILABLE" });
      fault = null;
      assert.deepEqual(await reconnected.resolve(selector), beforeRls);
      assert.equal(await reconnected.resolveOperation(id(903)), null);
      const rotated = await lifecycle.rotate(rotateInput);
      assert.equal(rotated.status, "Issued");
      assert.notEqual(rotated.sessionCredential, sessionCredential);
      assert.notEqual(rotated.csrfCredential, body.csrfToken);
      assert.equal((await reconnected.resolve(selector)).session.status, "Revoked");
      await assert.rejects(
        lifecycle.authorize({ sessionCredential, csrfCredential: body.csrfToken, observedAt }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      assert.deepEqual(
        await lifecycle.authorize({
          sessionCredential: rotated.sessionCredential,
          csrfCredential: rotated.csrfCredential,
          observedAt,
        }),
        rotated.session,
      );
      const generated = options.session.credentials.generateCredential.mock.calls.length;
      const rotationReplay = await lifecycle.rotate(rotateInput);
      assert.equal(rotationReplay.status, "AlreadyApplied");
      assert.deepEqual(rotationReplay.session, rotated.session);
      assert(!("sessionCredential" in rotationReplay));
      assert.equal(options.session.credentials.generateCredential.mock.calls.length, generated);
      await assert.rejects(lifecycle.rotate({ ...rotateInput, reason: "RiskChanged" }), {
        code: "GUEST_SESSION_IDEMPOTENCY_CONFLICT",
      });
      assert.deepEqual(await reconnected.resolveOperation(record.operationReference), record);

      const revokeInput = {
        sessionCredential: rotated.sessionCredential,
        expectedVersion: 1,
        operationReference: id(904),
        reason: "Logout",
        requestedAt: observedAt,
      };
      const nextSelector = options.session.credentials.hashCredential(
        "Session",
        rotated.sessionCredential,
      );
      const activeNext = await reconnected.resolve(nextSelector);
      fault = "rollback";
      await assert.rejects(lifecycle.revoke(revokeInput), { code: "GUEST_SESSION_UNAVAILABLE" });
      fault = null;
      assert.deepEqual(await reconnected.resolve(nextSelector), activeNext);
      assert.equal(await reconnected.resolveOperation(id(904)), null);
      fault = "unknown";
      await assert.rejects(lifecycle.revoke(revokeInput), { code: "GUEST_SESSION_UNAVAILABLE" });
      fault = null;
      const revoked = await lifecycle.revoke(revokeInput);
      assert.equal(revoked.status, "Revoked");
      assert.equal(revoked.version, 2);
      assert.deepEqual((await reconnected.resolveOperation(id(903))).session, rotated.session);
      assert.deepEqual((await reconnected.resolveOperation(id(904))).session, revoked);
      assert.equal((await reconnected.resolve(nextSelector)).operationReference, id(903));
      await assert.rejects(
        lifecycle.authorize({
          sessionCredential: rotated.sessionCredential,
          csrfCredential: rotated.csrfCredential,
          observedAt,
        }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      await assert.rejects(lifecycle.revoke({ ...revokeInput, reason: "Administrative" }), {
        code: "GUEST_SESSION_IDEMPOTENCY_CONFLICT",
      });

      const fresh = createGuestSessionRecord({
        ...record,
        session: { ...record.session, sessionReference: id(910) },
        operationReference: id(911),
        sessionSelectorHash: "d".repeat(64),
        csrfSelectorHash: "e".repeat(64),
      });
      await reconnected.create({ record: fresh });
      const replacement = createGuestSessionRecord({
        ...fresh,
        session: {
          ...fresh.session,
          sessionReference: id(912),
          rotatedFromGuestSessionReference: id(910),
        },
        operationReference: id(913),
        sessionSelectorHash: "f".repeat(64),
        csrfSelectorHash: "0".repeat(64),
      });
      const rotation = {
        currentSelectorHash: fresh.sessionSelectorHash,
        expectedVersion: 1,
        reason: "Rotated",
        observedAt: now,
        nextRecord: replacement,
      };
      const raced = await Promise.allSettled([
        reconnected.rotate(rotation),
        entryStore.rotate(rotation),
      ]);
      assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(raced.filter((r) => r.status === "rejected").length, 1);
      assert.deepEqual(await reconnected.resolveOperation(id(913)), replacement);
      const revokeCommand = {
        selectorHash: replacement.sessionSelectorHash,
        expectedVersion: 1,
        reason: "Logout",
        observedAt: now,
        operationReference: id(914),
        operationIntentHash: "5".repeat(64),
      };
      await assert.rejects(reconnected.revoke({ ...revokeCommand, expectedVersion: 2 }), {
        code: "GUEST_SESSION_VERSION_CONFLICT",
      });
      // An operation collision must roll back the terminal update, not replace prior history.
      await assert.rejects(reconnected.revoke({ ...revokeCommand, operationReference: id(911) }), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await reconnected.resolve(replacement.sessionSelectorHash), replacement);
      for (const otherScope of [
        { ...scope, storeReference: id(88) },
        { ...scope, brandReference: id(88) },
      ]) {
        const other = createPostgresGuestSessionEntryStore(runner, otherScope);
        assert.equal(await other.resolveOperation(id(913)), null);
        await assert.rejects(other.revoke(revokeCommand), { code: "GUEST_SESSION_UNAVAILABLE" });
      }
      const inspector = createPostgresGuestSessionLegacyInspector(runner, scope);
      assert.deepEqual(await inspector.inspect(now), {
        classification: "NoLegacyRows",
        observedAt: now,
      });
      const legacySelector = "a3".repeat(32);
      await admin.query(
        `INSERT INTO bop_identity.guest_session (${`
        guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,
        brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,
        dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,
        order_closed_at,closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,
        version,dining_session_id,dining_participant_id`})
        SELECT $1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),brand_id,store_id,
          public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,
          status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,order_closed_at,
          closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,version,
          dining_session_id,dining_participant_id
        FROM bop_identity.guest_session WHERE guest_session_id=$6`,
        [
          id(930),
          legacySelector,
          "b4".repeat(32),
          id(931),
          "c5".repeat(32),
          replacement.session.sessionReference,
        ],
      );
      assert.deepEqual(await inspector.inspect(now), {
        classification: "LiveLegacyRowsPresent",
        observedAt: now,
      });
      const afterAbsolute = new Date(
        Date.parse(replacement.session.absoluteExpiresAt) + 1,
      ).toISOString();
      assert.deepEqual(await inspector.inspect(afterAbsolute), {
        classification: "InactiveLegacyRowsOnly",
        observedAt: afterAbsolute,
      });
      assert.deepEqual(
        await createPostgresGuestSessionLegacyInspector(runner, {
          ...scope,
          storeReference: id(88),
        }).inspect(now),
        { classification: "NoLegacyRows", observedAt: now },
      );
      await assert.rejects(
        reconnected.revoke({
          selectorHash: legacySelector,
          expectedVersion: 1,
          reason: "Logout",
          observedAt: now,
          operationReference: id(932),
          operationIntentHash: "d6".repeat(32),
        }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      fault = "unknown";
      await assert.rejects(reconnected.revoke(revokeCommand), {
        code: "GUEST_SESSION_UNAVAILABLE",
      });
      fault = null;
      assert.equal((await reconnected.resolveOperation(id(914))).session.status, "Revoked");
      await assert.rejects(
        reconnected.revoke({ ...revokeCommand, expectedVersion: 2, operationReference: id(915) }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );

      const unknownSource = createGuestSessionRecord({
        ...fresh,
        session: { ...fresh.session, sessionReference: id(920) },
        operationReference: id(921),
        sessionSelectorHash: "6".repeat(64),
        csrfSelectorHash: "7".repeat(64),
      });
      await reconnected.create({ record: unknownSource });
      const unknownNext = createGuestSessionRecord({
        ...unknownSource,
        session: {
          ...unknownSource.session,
          sessionReference: id(922),
          rotatedFromGuestSessionReference: id(920),
          diningState: "DiningBound",
          diningSessionReference: id(924),
          diningParticipantReference: id(925),
        },
        operationReference: id(923),
        sessionSelectorHash: "a".repeat(64),
        csrfSelectorHash: "1".repeat(64),
      });
      fault = "unknown";
      await assert.rejects(
        reconnected.rotate({
          currentSelectorHash: unknownSource.sessionSelectorHash,
          expectedVersion: 1,
          reason: "BindingChanged",
          observedAt: now,
          nextRecord: unknownNext,
        }),
        { code: "GUEST_SESSION_UNAVAILABLE" },
      );
      fault = null;
      assert.deepEqual(await reconnected.resolveOperation(id(923)), unknownNext);
      assert.equal(
        (await reconnected.resolve(unknownSource.sessionSelectorHash)).session.status,
        "Revoked",
      );
      const expiredRevocation = await reconnected.revoke({
        selectorHash: unknownNext.sessionSelectorHash,
        expectedVersion: 1,
        reason: "Logout",
        observedAt: new Date(Date.parse(now) + 25 * 60 * 60_000).toISOString(),
        operationReference: id(926),
        operationIntentHash: "2".repeat(64),
      });
      assert.equal(expiredRevocation.status, "Revoked");

      // Even the test owner cannot mutate existing history through normal SQL.
      for (const sql of [
        "UPDATE bop_identity.guest_session_operation SET version = version + 1",
        "DELETE FROM bop_identity.guest_session_operation",
        "TRUNCATE bop_identity.guest_session_operation",
      ])
        await assert.rejects(admin.query(sql), (error) => error.code === "55000");
      const history = JSON.stringify(
        (await admin.query("SELECT row_to_json(h) FROM bop_identity.guest_session_operation h"))
          .rows,
      );
      const stored = JSON.stringify(
        (await admin.query("SELECT row_to_json(g) AS row FROM bop_identity.guest_session AS g"))
          .rows,
      );
      const generatedCredentials = credentials.generateCredential.mock.results
        .filter((result) => result.type === "return")
        .map((result) => result.value);
      const sensitiveInputs = [
        qrToken,
        ...generatedCredentials,
        selectorKey.toString("hex"),
        selectorKey.toString("base64"),
        selectorKey.toString("base64url"),
      ];
      for (const secret of sensitiveInputs) {
        assert(typeof secret === "string" && secret.length > 0);
        assert(
          !history.includes(secret),
          "Session operation history must not contain credential material",
        );
        assert(!stored.includes(secret), "Session rows must not contain credential material");
        assert(
          !logs.join("").includes(secret),
          "Structured logs must not contain credential material",
        );
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
      const cleared = await pool.query(
        "SELECT current_setting('bop.brand_id', true) AS brand, current_setting('bop.store_id', true) AS store",
      );
      assert(cleared.rows.every((row) => !row.brand && !row.store));
    } finally {
      selectorKey.fill(0);
      if (runtime) await runtime.shutdown("SIGTERM");
      await pool.end();
      await admin.end();
    }
    assert.equal(runtime.server.listening, false);
  });
});
