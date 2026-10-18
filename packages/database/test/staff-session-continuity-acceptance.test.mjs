import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createIdentityActor,
  createPostgresBrowserSessionStore,
} from "../../bop/identity/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "0190b2e0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const actorReference = id(1);
const minutes = (n) => n * 60_000;
const selector = (n) => n.toString(16).padStart(2, "0").repeat(32);

/**
 * WP-2423 Q18 (DEC-STAFF-SESSION-CONTINUITY). Under a restricted NOBYPASSRLS role holding exactly
 * the rendered pilot API grants (matrix plus additions): genuine activity slides a Workforce
 * Session's idle deadline; activity inside one minute writes nothing; the idle deadline never
 * passes the absolute deadline; revoked, idle-expired and absolute-expired Sessions are never
 * revived; a role without UPDATE on the Session table cannot extend anything.
 */
it("WP-2423 Q18: activity slides the staff idle deadline within the absolute lifetime", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_q18" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_q18_api_" + context.runId,
      worker = "wp2423_q18_w_" + context.runId,
      readOnly = "wp2423_q18_ro_" + context.runId;
    try {
      for (const name of [role, worker, readOnly])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      // A role that may read and create Sessions but not update them.
      await admin.query("GRANT USAGE ON SCHEMA bop_identity,platform_helpers TO " + readOnly);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + readOnly);
      await admin.query(
        "GRANT SELECT,INSERT ON bop_identity.authentication_session TO " + readOnly,
      );

      const transactionsAs = (name) => ({
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + name);
            // The pilot tenant transaction runner's limits.
            await client.query("SET LOCAL lock_timeout='2s'");
            await client.query("SET LOCAL statement_timeout='5s'");
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      });
      const base = Date.parse(
        (
          await admin.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS at")
        ).rows[0].at.toISOString(),
      );
      const T = (offset) => new Date(base + minutes(offset)).toISOString();
      let clock = T(0);
      const storeAs = (name) =>
        createPostgresBrowserSessionStore({
          transactions: transactionsAs(name),
          environment: "internal-test",
          redirectUri: "https://127.0.0.1:4443/merchant/callback",
          allowedPostLoginPaths: ["/operations/orders"],
          now: () => clock,
          currentActor: async (_tx, reference, authenticatedAt) =>
            createIdentityActor({
              actorType: "User",
              actorReference: reference,
              accountKind: "Workforce",
              status: "Active",
              authenticationMethod: "Oidc",
              verificationLevel: "SingleFactor",
              authenticatedAt,
              recentMfaAt: null,
            }),
        });
      const store = storeAs(role);
      const issue = async (n, at, policyCode = "WorkforceStandard") => {
        clock = at;
        const sessionReference = id(100 + n);
        await store.createSession({
          sessionReference,
          actor: createIdentityActor({
            actorType: "User",
            actorReference,
            accountKind: "Workforce",
            status: "Active",
            authenticationMethod: "Oidc",
            verificationLevel: "SingleFactor",
            authenticatedAt: at,
            recentMfaAt: null,
          }),
          policyCode,
          sessionSelectorHash: selector(n),
          csrfSelectorHash: selector(n + 100),
          encryptedSecrets: {
            algorithm: "SYNTHETIC_AES_256_GCM",
            keyReference: "internal-test-key",
            ciphertext: Buffer.alloc(48, n).toString("base64url"),
            encryptionContext: "internal-test:session:" + sessionReference + ":" + actorReference,
          },
          observedAt: at,
        });
        return sessionReference;
      };
      const row = async (sessionReference) =>
        (
          await admin.query(
            "SELECT status,version,last_seen_at,idle_expires_at,absolute_expires_at,xmin::text AS xmin FROM bop_identity.authentication_session WHERE session_id=$1",
            [sessionReference],
          )
        ).rows[0];
      const result = (n, at, { using = store, extend = true, csrf = selector(n + 100) } = {}) => {
        clock = at;
        return using.recordActivity({
          selectorHash: selector(n),
          csrfSelectorHash: csrf,
          observedAt: at,
          extend,
        });
      };
      const activity = async (n, _sessionReference, at, using = store) =>
        (await result(n, at, { using })).session;
      const ENDED = { code: "BROWSER_SESSION_ENDED" };

      // --- Sliding with bounded writes --------------------------------------------------------
      const first = await issue(1, T(0));
      const created = await row(first);
      assert.equal(created.idle_expires_at.toISOString(), T(30));
      const quiet = await activity(1, first, new Date(base + 59_999).toISOString());
      assert.equal(quiet.idleExpiresAt, T(30));
      assert.equal((await row(first)).xmin, created.xmin, "no write inside one minute");
      const moved = await activity(1, first, T(20));
      assert.equal(moved.idleExpiresAt, T(50));
      const afterMove = await row(first);
      assert.equal(afterMove.last_seen_at.toISOString(), T(20));
      assert.equal(afterMove.idle_expires_at.toISOString(), T(50));
      assert.equal(afterMove.version, 1, "activity is not a lifecycle version change");
      assert.equal(afterMove.status, "Active");
      // Concurrent activity from several tabs: one write, the rest see it and write nothing.
      const together = await Promise.all([0, 1, 2, 3, 4].map(() => activity(1, first, T(25))));
      assert.ok(together.every((session) => session.idleExpiresAt === T(55)));
      const afterTogether = await row(first);
      assert.equal(afterTogether.idle_expires_at.toISOString(), T(55));
      const settled = afterTogether.xmin;
      await activity(1, first, new Date(base + minutes(25) + 30_000).toISOString());
      assert.equal((await row(first)).xmin, settled);
      // Resolution after the original idle deadline succeeds (the slide is effective).
      clock = T(45);
      assert.equal((await store.resolveSession(selector(1)))?.session.idleExpiresAt, T(55));

      // --- Never past the absolute deadline ---------------------------------------------------
      for (let at = 50; at <= 11 * 60 + 50; at += 25) await activity(1, first, T(at));
      const capped = await activity(1, first, T(11 * 60 + 55));
      assert.equal(capped.idleExpiresAt, T(12 * 60));
      const cappedRow = await row(first);
      assert.equal(cappedRow.idle_expires_at.toISOString(), T(12 * 60));
      assert.equal(cappedRow.absolute_expires_at.toISOString(), T(12 * 60));
      await assert.rejects(activity(1, first, T(12 * 60)), ENDED);
      assert.equal((await row(first)).idle_expires_at.toISOString(), T(12 * 60));

      // --- Revoked and idle-expired Sessions are never revived ---------------------------------
      const revoked = await issue(2, T(0));
      clock = T(5);
      await store.revokeSession({
        selectorHash: selector(2),
        expectedVersion: 1,
        reason: "Logout",
        observedAt: T(5),
      });
      const revokedRow = await row(revoked);
      await assert.rejects(activity(2, revoked, T(10)), ENDED);
      assert.deepEqual(await row(revoked), revokedRow);
      assert.equal(revokedRow.status, "Revoked");

      const idle = await issue(3, T(0));
      const idleRow = await row(idle);
      await assert.rejects(activity(3, idle, T(30)), ENDED);
      await assert.rejects(activity(3, idle, T(31)), ENDED);
      await assert.rejects(result(3, T(31), { extend: false }), ENDED);
      await assert.rejects(result(99, T(1)), ENDED, "an unknown Session has ended");
      assert.deepEqual(await row(idle), idleRow);

      // --- A wrong CSRF is refused (not "ended"); a role without UPDATE is "unavailable" ------
      const other = await issue(4, T(0));
      await assert.rejects(result(4, T(10), { csrf: selector(101) }), {
        code: "BROWSER_SESSION_DENIED",
      });
      const otherRow = await row(other);
      await assert.rejects(activity(4, other, T(10), storeAs(readOnly)), {
        code: "BROWSER_SESSION_UNAVAILABLE",
      });
      assert.deepEqual(await row(other), otherRow);
      assert.equal((await activity(4, other, T(10))).idleExpiresAt, T(40));

      // --- Business reads hold FOR SHARE on the Session row (merchant scope, reports, settlement)
      // for longer than the 2 s lock timeout. Activity neither waits nor fails: it skips the write,
      // returns the live deadlines, and records on the next report once the row is free.
      const busy = await issue(6, T(0));
      const holder = new Client(context.clientConfig);
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SET LOCAL ROLE " + role);
        await holder.query(
          "SELECT session_id FROM bop_identity.authentication_session WHERE session_id=$1 FOR SHARE",
          [busy],
        );
        const before = await row(busy);
        const started = Date.now();
        const skipped = await Promise.all([
          result(6, T(10)),
          result(6, T(10)),
          result(6, T(10), { extend: false }),
        ]);
        assert.ok(Date.now() - started < 2_000, "activity does not wait for business reads");
        assert.ok(skipped.every((value) => value.recorded === false));
        assert.ok(skipped.every((value) => value.session.idleExpiresAt === T(30)));
        assert.deepEqual(await row(busy), before);
        // Many concurrent business readers and activity reports together: none fails.
        const readers = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            index % 2 === 0
              ? transactionsAs(role).run((tx) =>
                  tx.query(
                    "SELECT session_id FROM bop_identity.authentication_session WHERE session_id=$1 FOR SHARE",
                    [busy],
                  ),
                )
              : result(6, T(11)),
          ),
        );
        assert.equal(readers.length, 6);
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
      const recorded = await result(6, T(12));
      assert.equal(recorded.recorded, true);
      assert.equal(recorded.session.idleExpiresAt, T(42));
      assert.equal((await row(busy)).idle_expires_at.toISOString(), T(42));

      // --- The named KDS policy slides by its own 60-minute idle timeout ----------------------
      const kds = await issue(5, T(0), "NamedKdsOperator");
      assert.equal((await activity(5, kds, T(50))).idleExpiresAt, T(110));
    } finally {
      await admin.end();
    }
  });
});
