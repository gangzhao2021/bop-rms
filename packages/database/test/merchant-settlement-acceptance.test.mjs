import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createPersistentMerchantSettlement } from "../../../apps/api/src/persistent-merchant-settlement.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { createPersistentMerchantOrderExceptions } from "../../../apps/api/src/persistent-merchant-order-exceptions.ts";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
const id = (n) => "01a1e000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha = "sha256:" + "a".repeat(64);
const minutes = (n) => n * 60_000;

/**
 * WP-2423 Q7 (v15): the day-end settlement of the open business day, with payments taken on the
 * Store's card machine, read by a Store Manager under the rendered pilot API grants and the
 * pilot runner's limits (lock timeout 2 s, statement timeout 5 s), including while live work
 * holds a lock the read needs.
 */
it("loads the open business day's settlement with card-machine payments, also while live work holds a lock", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_settlement" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_st_" + context.runId,
      worker = "wp2423_st_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
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

      const now = () => new Date().toISOString();
      const scope = { brandReference: id(1), storeReference: id(2) };
      const ownerScope = { tenantReference: id(3), ...scope };
      const conflict = () =>
        Object.assign(new Error("TENANT_DATABASE_TRANSACTION_CONFLICT"), {
          code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
        });
      /**
       * The pilot runner's limits and conflict rule (packages/database transaction-runner): on its
       * own connection under the api role; a lock wait that timed out (55P03) anywhere in the
       * transaction reports the whole transaction as a retryable conflict, whatever the caller made
       * of the error.
       */
      const queryLog = [];
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          let conflicted = false;
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '5s'");
            await client.query("SET LOCAL lock_timeout = '2s'");
            const result = await work({
              query: async (sql, values) => {
                queryLog.push(sql);
                try {
                  return await client.query(sql, values === undefined ? [] : [...values]);
                } catch (error) {
                  if (["55P03", "40001", "40P01"].includes(error?.code)) conflicted = true;
                  throw conflicted ? conflict() : error;
                }
              },
            });
            if (conflicted) throw conflict();
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw conflicted ? conflict() : error;
          } finally {
            await client.end();
          }
        },
      };
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope: ownerScope,
        actor: id(10),
        at: now(),
        extraPermissions: ["operations.order-exception.manage"],
      });
      await seedJourneyStorePublication({
        client: admin,
        scope: ownerScope,
        publishedAt: new Date(Date.now() - minutes(300)).toISOString(),
        businessDayStart: "00:00:00",
        prefix: "01a1e100",
      });
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());

      // Two counter payments today (one entered after an outage) and one refund on the machine.
      const takenAt = new Date(Date.now() - minutes(2)).toISOString();
      for (const [n, total, tip, reason] of [
        [100, 1280, 150, "AtCounter"],
        [200, 1000, 0, "RecordedAfterOutage"],
      ]) {
        const preparation = {
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          orderReference: id(n + 1),
          orderBatchReference: id(n + 2),
          submissionReference: id(n + 3),
          orderAllocation: { amountMinor: String(total - tip), currencyCode: "CAD" },
          tip: { amountMinor: String(tip), currencyCode: "CAD" },
          total: { amountMinor: String(total), currencyCode: "CAD" },
        };
        await admin.query(
          `INSERT INTO rms_payment.card_machine_payment VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CAD','Test',NULL,$17,$18,$18,$19,$20,$21)`,
          [
            ownerScope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            id(n + 4),
            id(n + 5),
            id(n + 6),
            id(n + 7),
            id(n + 8),
            sha,
            id(n + 1),
            id(n + 2),
            id(n + 3),
            JSON.stringify(preparation),
            total - tip,
            tip,
            total,
            reason,
            takenAt,
            id(10),
            id(n + 9),
            id(n + 10),
          ],
        );
      }
      await admin.query(
        `INSERT INTO rms_payment.card_machine_refund VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,'StaffCancellation',$9,1280,'CAD',NULL,$10,$10,$11,$12)`,
        [
          ownerScope.tenantReference,
          scope.brandReference,
          scope.storeReference,
          id(300),
          id(104),
          id(101),
          id(301),
          sha,
          id(302),
          now().replace(/\.\d+Z$/u, ".000Z"),
          id(10),
          id(303),
        ],
      );

      const compose = (retryDelaysMs) =>
        createPersistentMerchantSettlement({
          persistence: {
            ...session.persistence,
            transactions,
            now,
            publication: {
              configurationType: "STORE_CONFIGURATION",
              purposeCode: "STORE_CONFIGURATION",
              requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
            },
          },
          resolveConfiguration: async () => ({
            providerAccountReference: id(20),
            environment: "Test",
          }),
          settlementRunReference: async () => null,
          ...(retryDelaysMs === undefined ? {} : { retryDelaysMs }),
        });
      const read = (settlement) =>
        settlement({ sessionCookie: session.sessionCookie, businessDate: today });
      const expected = {
        taken: { count: 2, amountMinor: "2280", currencyCode: "CAD" },
        tipMinor: "150",
        recordedAfterOutageCount: 1,
        refunded: { count: 1, amountMinor: "1280", currencyCode: "CAD" },
      };

      // The open day so far, with the counter's card-machine takings apart from online ones.
      queryLog.length = 0;
      const day = await read(compose());
      // Query budget (regression for the 16 s reports on v15): the caller's scope is resolved at
      // the start and once before the reply, not inside every owner read (~750 queries a day).
      assert.ok(
        queryLog.length <= 160,
        "the day's settlement took " + queryLog.length + " queries",
      );
      const scopeResolutions = queryLog.filter((sql) =>
        sql.includes("FROM bop_identity.browser_session_selection"),
      ).length;
      assert.ok(scopeResolutions <= 6, "scope resolved " + scopeResolutions + " times");
      assert.equal(day.businessDate, today);
      assert.equal(day.window.status, "Open");
      assert.deepEqual(day.cardMachine, expected);
      // WP-2423: Provider charges matching no Order are read (none here), not silently skipped.
      assert.deepEqual(day.unmatchedProviderCharges, {
        captured: { count: 0, amountMinor: "0", currencyCode: "CAD" },
        refunded: { count: 0, amountMinor: "0", currencyCode: "CAD" },
      });

      // WP-2423 (v15 Sep 19 answered 403): a day before the Store's settlement records begin is
      // an answer naming the first covered day, after the caller's scope is resolved; the first
      // covered day itself reads normally.
      const covered = createPersistentMerchantSettlement({
        persistence: {
          ...session.persistence,
          transactions,
          now,
          publication: {
            configurationType: "STORE_CONFIGURATION",
            purposeCode: "STORE_CONFIGURATION",
            requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
          },
        },
        resolveConfiguration: async () => ({
          providerAccountReference: id(20),
          environment: "Test",
        }),
        settlementRunReference: async () => null,
        firstBusinessDate: async () => today,
      });
      const dayBefore = new Date(Date.parse(today + "T12:00:00.000Z") - 86_400_000)
        .toISOString()
        .slice(0, 10);
      await assert.rejects(
        covered({ sessionCookie: session.sessionCookie, businessDate: dayBefore }),
        (error) =>
          error.code === "MERCHANT_SETTLEMENT_NOT_COVERED" && error.firstBusinessDate === today,
      );
      await assert.rejects(
        covered({ sessionCookie: "not-a-session", businessDate: dayBefore }),
        (error) => error.code !== "MERCHANT_SETTLEMENT_NOT_COVERED",
      );
      assert.equal((await read(covered)).businessDate, today);

      // The Store's order exceptions (same staff permission), measured here as the nearest
      // acceptance with a real staff session (WP-2423 query budget): the scope is resolved at the
      // start and once before the reply, not inside each owner read.
      queryLog.length = 0;
      const exceptions = await createPersistentMerchantOrderExceptions({
        persistence: { ...session.persistence, transactions, now },
        // Test-only: the projection metadata the pilot reads from the Store and Payment owners.
        metadata: async (_tx, { storeLabel }) => ({
          storeLabel,
          businessDate: today,
          checkpointReference: id(400),
          projectedAt: now(),
          freshnessStatus: "Stale",
        }),
      })(session.sessionCookie);
      assert.equal(exceptions.screenId, "OPS-ORDER-EXCEPTION");
      // Measured 2026-10-14: 200 queries before, 68 after.
      assert.ok(queryLog.length <= 90, "the order exceptions took " + queryLog.length + " queries");

      /**
       * Live work holds a lock the read needs (here: a writer on the Store's launch gate, which
       * every business-date proof reads in SHARE mode) for longer than the 2 s lock timeout.
       */
      const holdLock = async (ms) => {
        const holder = new Client(context.clientConfig);
        await holder.connect();
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE bop_publishing.live_gate_version IN ROW EXCLUSIVE MODE");
        // Wrapped so awaiting the holder does not wait for its release.
        return {
          released: new Promise((resolve) => setTimeout(resolve, ms)).then(async () => {
            await holder.query("COMMIT");
            await holder.end();
          }),
        };
      };
      // Held briefly beyond one lock wait: the read reruns itself and the day loads.
      let started = Date.now();
      let { released } = await holdLock(2_600);
      const retried = await read(compose());
      await released;
      assert.ok(Date.now() - started >= 2_600, "the read waited for the lock");
      assert.deepEqual(retried.cardMachine, expected);

      // Held beyond every rerun: staff are told to retry shortly (busy), never "permission denied".
      ({ released } = await holdLock(8_000));
      started = Date.now();
      await assert.rejects(read(compose([100])), { code: "MERCHANT_SETTLEMENT_BUSY" });
      assert.ok(Date.now() - started < 8_000, "busy is answered before the lock is released");
      await released;
      assert.deepEqual((await read(compose())).cardMachine, expected);
    } finally {
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
