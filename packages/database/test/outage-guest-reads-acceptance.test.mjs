// WP-2423 (outage-reads-and-retry, v15 2026-11-11) on a real isolated PostgreSQL, the code under
// test as a NOBYPASSRLS role holding exactly the rendered pilot ACL:
//  1. with every pooled connection busy, a pickup guest's cart check of the Store's QR records is a
//     passing fault (dependencyFailure: the phone is told "busy, try again" and keeps its cart),
//     never "Unavailable" (read as "your session ended"); once a connection is free, what the
//     records say is the answer again;
//  2. the transactions of one request share one connection-waiting budget, so a request of
//     several reads answers "busy" within the budget instead of waiting it once per read.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createGuestSession } from "../../bop/identity/src/index.ts";
import { createConfiguredPickupSessionBinding } from "../../../apps/api/src/configured-pickup-session-binding.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { runWithRequestAcquireBudget } from "../src/connection-acquire.ts";
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

      // 1. Every connection busy (a rush): the guest is told to try again, not that the visit ended.
      held = await pool.connect();
      await assert.rejects(binding.validate(session, at), (error) => {
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
