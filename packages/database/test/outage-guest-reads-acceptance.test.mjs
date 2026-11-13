// WP-2423 (outage-reads-and-retry, v15 2026-11-11) on a real isolated PostgreSQL, the code under
// test as a NOBYPASSRLS role holding exactly the rendered pilot ACL:
//  1. with every pooled connection busy, a pickup guest's cart check of the Store's QR records is a
//     passing fault (dependencyFailure: the phone is told "busy, try again" and keeps its cart),
//     never "Unavailable" (read as "your session ended"); once a connection is free, what the
//     records say is the answer again;
//  2. the transactions of one request share one connection-waiting budget, so a request of
//     several reads answers "busy" within the budget instead of waiting it once per read;
//  4. a request's transaction that wrote marks the request, so its later transactions are never
//     cut short by the shared budget after some of its changes committed;
//  3. the same for a table guest's check of the table's QR records (the dining context), while a
//     registration that doesn't fit the phone's QR stays the answer "Unavailable" (scan again),
//     never "busy" for ever.
//  6. (reads-under-burst) the guest's Session read, the first step of every cart read, says why it
//     could not answer in a rush (no connection), and the request is noted as turned away by the
//     rush; a read cut at its answer time (or abandoned) takes no connection at all.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSession,
  createPostgresGuestSessionEntryStore,
} from "../../bop/identity/src/index.ts";
import { createConfiguredPickupSessionBinding } from "../../../apps/api/src/configured-pickup-session-binding.ts";
import { createConfiguredDiningGuestContext } from "../../../apps/api/src/configured-dining-guest-context.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import {
  remainingRequestAcquireBudgetMs,
  runWithRequestAcquireBudget,
} from "../src/connection-acquire.ts";
import { createTenantTransactionRunner } from "../src/transaction-runner.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const id = (n) => "01a1e400-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const later = new Date(Date.parse(at) + 3_600_000).toISOString();
const idleUntil = new Date(Date.parse(at) + 4 * 3_600_000).toISOString();
const absoluteUntil = new Date(Date.parse(at) + 24 * 3_600_000).toISOString();
const earlier = new Date(Date.now() - 3_600_000).toISOString();

it("an outage of the Store's records never reads as an ended guest session, and a request waits once", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_outage_reads" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_or_" + context.runId,
      worker = "wp2423_or_w_" + context.runId;
    const pool = new Pool({
      ...context.clientConfig,
      max: 1,
      connectionTimeoutMillis: 1000,
      query_timeout: 5000,
    });
    let held = null;
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));
      const scope = { brandId: id(1), storeId: id(2) };
      // The pilot's runner, every connection as the api role.
      const runner = createTenantTransactionRunner(
        {
          options: pool.options,
          async connect() {
            const client = await pool.connect();
            try {
              await client.query("SET ROLE " + api);
              return client;
            } catch (error) {
              client.release(true);
              throw error;
            }
          },
        },
        scope,
        { acquireBudgetMs: 3000 },
      );
      const payload = {
        schemaVersion: 1,
        qrReference: id(3),
        publicStoreReference: id(4),
        publicTableReference: null,
        channel: "Pickup",
        locale: "en-CA",
        issuedAt: earlier,
        expiresAt: later,
        revocationVersion: 1,
      };
      const binding = createConfiguredPickupSessionBinding({
        transactions: runner,
        binding: {
          tenantReference: id(5),
          publicStoreReference: id(4),
          brandReference: id(1),
          storeReference: id(2),
          lookupEvidenceReference: id(6),
          validFrom: earlier,
          validUntil: later,
        },
        authorize: async () => true,
        registration: {
          payload,
          state: "Enabled",
          contextEvidenceReference: id(7),
          validFrom: earlier,
          validUntil: later,
        },
        authorizeRegistration: async () => true,
      });
      const session = createGuestSession({
        sessionReference: id(8),
        status: "Active",
        version: 1,
        brandReference: id(1),
        storeReference: id(2),
        publicStoreReference: id(4),
        publicTableReference: null,
        channel: "Pickup",
        locale: "en-CA",
        qrReference: id(3),
        qrRevocationVersion: 1,
        diningState: "ContextOnly",
        diningSessionReference: null,
        diningParticipantReference: null,
        createdAt: at,
        lastSeenAt: at,
        idleExpiresAt: idleUntil,
        absoluteExpiresAt: absoluteUntil,
        orderClosedAt: null,
        closureExpiresAt: null,
        rotatedFromGuestSessionReference: null,
        revocationReason: null,
        revokedAt: null,
      });

      // The table guest's check: the same Store, a table QR, as the pilot composes it.
      const tablePayload = { ...payload, qrReference: id(13), publicTableReference: id(14) };
      tablePayload.channel = "DineIn";
      const tableContext = (registration = {}) =>
        createConfiguredDiningGuestContext({
          transactions: runner,
          binding: {
            tenantReference: id(5),
            publicStoreReference: id(4),
            brandReference: id(1),
            storeReference: id(2),
            lookupEvidenceReference: id(6),
            validFrom: earlier,
            validUntil: later,
          },
          authorize: async () => true,
          registration: {
            payload: tablePayload,
            tableReference: id(15),
            state: "Enabled",
            contextEvidenceReference: id(16),
            validFrom: earlier,
            validUntil: later,
            ...registration,
          },
          authorizeRegistration: async () => true,
        });
      const tableSession = createGuestSession({
        ...session,
        sessionReference: id(18),
        publicTableReference: id(14),
        channel: "DineIn",
        qrReference: id(13),
      });

      // 1. Every connection busy (a rush): the guest is told to try again, not that the visit ended.
      held = await pool.connect();
      // 6. The Session read in that rush keeps its safe code, and the request is noted as shed.
      const sessions = createPostgresGuestSessionEntryStore(runner, {
        brandReference: id(1),
        storeReference: id(2),
      });
      const shedStore = () =>
        globalThis[Symbol.for("bop.database.request-acquire-budget")]?.getStore();
      await runWithRequestAcquireBudget(
        1500,
        async () => {
          await assert.rejects(sessions.resolve("1".repeat(64)), (error) => {
            assert.equal(error.code, "GUEST_SESSION_UNAVAILABLE");
            assert.equal(
              Object.getOwnPropertyDescriptor(error, Symbol.for("bop.failure.cause"))?.value?.code,
              "TENANT_DATABASE_ACQUIRE_FAILED",
            );
            assert.equal(Object.keys(error).includes("cause"), false);
            return true;
          });
          assert.equal(shedStore()?.shed, true);
        },
        { answerWithinMs: 12_000 },
      );
      await assert.rejects(binding.validate(session, at), (error) => {
        assert.equal(error.dependencyFailure, true);
        assert.equal(error.cause?.code, "TENANT_DATABASE_ACQUIRE_FAILED");
        return true;
      });
      // A table guest too: before, the context answered null and the phone read "you left".
      await assert.rejects(tableContext().validate(tableSession, at), (error) => {
        assert.equal(error.dependencyFailure, true);
        assert.equal(error.cause?.code, "TENANT_DATABASE_ACQUIRE_FAILED");
        return true;
      });

      // 2. One request of three reads, each allowed 3 s: before, 9 s of waiting; now 3 s in all.
      const started = Date.now();
      const failures = await runWithRequestAcquireBudget(3000, async () => {
        const codes = [];
        for (let read = 0; read < 3; read++)
          await runner.run(async () => undefined).catch((error) => codes.push(error.code));
        return codes;
      });
      const elapsed = Date.now() - started;
      assert.deepEqual(failures, Array(3).fill("TENANT_DATABASE_ACQUIRE_FAILED"));
      assert.ok(elapsed < 4500, "the request waited " + elapsed + " ms for connections");

      // 3. A connection is free again: the records answer (no such Store here), and that answer
      // stands as it is: "Unavailable" for this QR, not a passing fault.
      held.release();
      held = null;
      assert.equal(await binding.validate(session, at), "Unavailable");
      assert.equal(await tableContext().validate(tableSession, at), "Unavailable");
      // A registration that can't fit any phone's QR (its validity ends as it begins) is an answer
      // too: "Unavailable", so the phone is told to scan again, not "busy" for ever.
      assert.equal(
        await tableContext({ validFrom: later, validUntil: later }).validate(tableSession, at),
        "Unavailable",
      );

      // 4. A request's transaction that wrote says so before it commits (PostgreSQL assigned it a
      // transaction id), under the api role: from then on the request's later transactions wait
      // their own budget, so a command is never cut short after some of its changes committed.
      // A read does not. Test-only write: a temporary table dropped at commit.
      await runWithRequestAcquireBudget(3000, async () => {
        await runner.run((tx) => tx.query("SELECT 1", []));
        // Still bounded (a new connection's handshake counts as waiting, a few ms).
        assert.ok(remainingRequestAcquireBudgetMs() > 2000);
        await runner.run(async (tx) => {
          await tx.query("CREATE TEMP TABLE wp2423_budget_probe (n int) ON COMMIT DROP", []);
          await tx.query("INSERT INTO wp2423_budget_probe (n) VALUES (1)", []);
        });
        assert.equal(remainingRequestAcquireBudgetMs(), undefined);
      });

      // 5. (guest-table-open-and-busy-reads) A read does all its work within its answer time: a
      // statement that would run past it is cut where the time ends (PostgreSQL's own limit,
      // narrowed under the api role), and once it is spent no statement is sent at all, so the
      // phone hears "busy" inside the 15 s it waits. Before, the statement ran its full 5 s.
      await runWithRequestAcquireBudget(
        3000,
        async () => {
          const startedRead = Date.now();
          await assert.rejects(
            runner.run(async (tx) => {
              await tx.query("SELECT 1", []);
              await tx.query("SELECT pg_sleep(4)", []);
            }),
            (error) => {
              assert.equal(error.code, "TENANT_DATABASE_TRANSACTION_FAILED");
              assert.equal(error.diagnostic?.sqlState, "57014");
              return true;
            },
          );
          const cut = Date.now() - startedRead;
          assert.ok(cut < 2500, "the read worked " + cut + " ms past a 1.5 s answer time");
          // The answer time is spent: no connection is taken, nothing is sent.
          await assert.rejects(
            runner.run((tx) => tx.query("SELECT 1", [])),
            (error) => {
              assert.equal(error.code, "TENANT_DATABASE_ACQUIRE_FAILED");
              return true;
            },
          );
        },
        { answerWithinMs: 1500 },
      );
      // The cut statement was the read's answer time ending: the request is noted as shed.
      await runWithRequestAcquireBudget(
        3000,
        async () => {
          await runner.run((tx) => tx.query("SELECT pg_sleep(2)", [])).catch(() => undefined);
          assert.equal(shedStore()?.shed, true);
        },
        { answerWithinMs: 1000 },
      );
      // 6. A read cut (answered busy at its time, or its phone went away) sends nothing more,
      // under the api role too: no connection is taken (none is busy now).
      await runWithRequestAcquireBudget(
        3000,
        async () => {
          shedStore().cut = true;
          await assert.rejects(
            runner.run((tx) => tx.query("SELECT 1", [])),
            (error) => error.code === "TENANT_DATABASE_ACQUIRE_FAILED",
          );
        },
        { answerWithinMs: 12_000 },
      );
      // A command has no answer time: the same statement runs to its end.
      await runWithRequestAcquireBudget(3000, () =>
        runner.run((tx) => tx.query("SELECT pg_sleep(2)", [])),
      );
    } finally {
      held?.release();
      await pool.end().catch(() => undefined);
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker])
        await admin
          .query("DROP OWNED BY " + name + " CASCADE")
          .then(() => admin.query("DROP ROLE " + name))
          .catch(() => undefined);
      await admin.end();
    }
  });
});
