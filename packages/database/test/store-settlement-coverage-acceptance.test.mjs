import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createPaymentReconciliationService,
  createPostgresPaymentReconciliationRepository,
  parseSettlementReconciliationCandidate,
} from "../../rms/payment/src/index.ts";
import { createPersistentMerchantSettlement } from "../../../apps/api/src/persistent-merchant-settlement.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createDailySettlementBacklog } from "../../../tooling/environment/pilot-daily-settlement-backlog.mjs";
import {
  DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS,
  resolveDailySettlementCoverage,
} from "../../../tooling/environment/pilot-daily-settlement-coverage.mjs";
import { createCoverageGatedRun } from "../../../tooling/environment/pilot-daily-settlement-execution.mjs";
import { dailySettlementRunReference } from "../../../tooling/environment/pilot-daily-settlement-reference.mjs";
import { createInternalSettlementDays } from "../../../tooling/environment/pilot-settlement-window.mjs";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

const { Client } = pg;
const id = (n) => "01a9e700-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 (settlement-coverage): v15 demo-3, merchant-2, dessert, hotpot and tea never compared a
 * day with the payment provider: the worker waited for a coverage file nobody writes. Under the
 * rendered pilot grants (NOBYPASSRLS api role), a Store opened mid-day on the DST fall-back
 * business day (Sat Oct 31 2026, 25 h, America/Toronto) and with no coverage file:
 * - is not yet covered while that first day is open, then covered from that first day (its
 *   nominal 04:00 EDT start, with opensAt inside it), never from the latest closed day;
 * - is settled day by day from there by the real backlog, behind the coverage gate;
 * - the first day's DailySettlement run, keyed by that nominal window, is the run the Settlement
 *   page finds for the day ("Settled"), and a later day with no run says "not run" on server time;
 * - a refused grant is a failed cycle, never "not yet"; a recorded start before the Store's
 *   records is refused.
 */
it("a Store with no coverage file is settled from its own first business day", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_cover" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_cv_" + context.runId,
      worker = "wp2423_cv_w_" + context.runId;
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

      const scope = { brandReference: id(1), storeReference: id(2) };
      const ownerScope = { tenantReference: id(3), ...scope };
      let clock = "2026-11-01T05:00:00.000Z";
      const now = () => clock;
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '5s'");
            const result = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
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
        at: new Date().toISOString(),
        extraPermissions: ["payment.settlement.read"],
        referencePrefix: "01a9e701",
        sessionReferencePrefix: "01a9e702",
      });
      // Opened at 16:15 EDT on Sat Oct 31: inside the 25 h business day Oct 31 04:00 EDT (08:00Z)
      // to Nov 1 04:00 EST (09:00Z).
      const openedAt = "2026-10-31T20:15:00.000Z";
      const { storeOptions } = await seedJourneyStorePublication({
        client: admin,
        scope: ownerScope,
        publishedAt: openedAt,
        validUntil: "2026-12-31T00:00:00.000Z",
        businessDayStart: "04:00:00",
        prefix: "01a9e703",
      });
      const resources = {
        scope,
        operating: {
          ...storeOptions,
          tenantReference: ownerScope.tenantReference,
          hashContent: (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
        },
        now,
        transactions,
      };
      const days = createInternalSettlementDays({ resources, active: async () => true });
      const installation = (recorded = null) => ({
        loadRecordedDailySettlementCoverage: async () => recorded,
        loadProfile: async () => ({
          binding: { ...ownerScope, validUntil: "2026-12-31T00:00:00.000Z" },
        }),
      });
      const resolve = (recorded) =>
        resolveDailySettlementCoverage({
          installation: installation(recorded),
          days,
          pilotStore: false,
        });

      // The first business day is still open: not yet, and the worker is Idle.
      assert.deepEqual(await resolve(), { kind: "NotYet" });
      const settled = [];
      const run = createCoverageGatedRun({
        now,
        recheckMs: 0,
        resolveCoverage: () => resolve(),
        build: (coverage) =>
          createDailySettlementBacklog({
            coverage,
            scope,
            now,
            readWindow: days.window,
            readBounds: days.bounds,
            prepare: async () => assert.fail("prepared by the stubbed scheduler"),
            readRun: async () => null,
            execute: async () => assert.fail("executed by the stubbed scheduler"),
            createScheduler:
              ({ readWindow }) =>
              async () => {
                const day = await readWindow();
                settled.push(day);
                return { status: "Created", checkCount: 1 };
              },
          }),
      });
      assert.deepEqual(await run(), { status: "Idle", checkCount: 0 });

      // Read three days late: coverage starts on the first day, not on the latest closed one.
      clock = "2026-11-03T12:00:00.000Z";
      const coverage = await resolve();
      assert.equal(coverage.kind, "Covered");
      assert.equal(coverage.source, "StoreRecords");
      assert.deepEqual(coverage.firstWindow, {
        businessDate: "2026-10-31",
        startsAt: "2026-10-31T08:00:00.000Z",
        endsAt: "2026-11-01T09:00:00.000Z",
        configurationReference: "01a9e703-0000-7000-8000-000000000001",
        configurationVersion: 1,
        contentDigest: coverage.firstWindow.contentDigest,
      });
      const first = await days.first();
      assert.equal(first.opensAt, openedAt);
      assert.equal(Date.parse(first.endsAt) - Date.parse(first.startsAt), 25 * 3600_000);

      for (let n = 0; n < 6; n++) await run();
      assert.deepEqual(
        settled.map((day) => `${day.businessDate} ${day.startsAt}`),
        [
          "2026-10-31 2026-10-31T08:00:00.000Z",
          "2026-11-01 2026-11-01T09:00:00.000Z",
          "2026-11-02 2026-11-02T09:00:00.000Z",
        ],
      );
      assert.equal(settled[0].opensAt, openedAt);

      // The first day's DailySettlement run, under the reference the worker derives from that
      // nominal window, through the real reconciliation service (nothing captured: a match).
      const firstDay = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        businessDate: first.businessDate,
        startsAt: first.startsAt,
        endsAt: first.endsAt,
      };
      const { runReference } = dailySettlementRunReference(firstDay);
      let sequence = 0x900;
      const zero = { amountMinor: 0n, currencyCode: "CAD" };
      const candidate = parseSettlementReconciliationCandidate({
        candidateReference: id(0x800),
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        settlementReference: "simset_20261031_" + "d".repeat(64),
        businessDate: "2026-10-31",
        internalCapturedAmount: zero,
        providerCapturedAmount: zero,
        internalRefundedAmount: zero,
        providerRefundedAmount: zero,
        evidenceObservedAt: "2026-11-03T11:59:00.000Z",
      });
      const recorded = await createPaymentReconciliationService({
        authorization: { authorize: async () => true },
        lease: { claim: async () => true, release: async () => undefined },
        repository: createPostgresPaymentReconciliationRepository({
          scope,
          transactions,
          authorize: async () => true,
          resolutions: { nextReference: () => id(++sequence) },
        }),
        candidates: {
          claimOperational: async () => [],
          claimDailySettlement: async () => [candidate],
        },
        provider: { retrieveIntent: async () => assert.fail("no Provider call") },
        observations: { record: async () => assert.fail("no observation") },
        terminal: {
          occurrence: async () => assert.fail("no terminal"),
          record: async () => assert.fail("no terminal"),
        },
        references: { generate: () => id(++sequence), exceptionFor: () => id(++sequence) },
        clock: { now },
      }).run({
        runReference,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        actorReference: null,
        mode: "DailySettlement",
        purpose: "ReconcilePayments",
        scheduledAt: clock,
        cutoffAt: clock,
        maxCandidates: 1,
      });
      assert.equal(recorded.result.checks[0].outcome, "Matched");

      // What the Settlement page reads, with the run references the pilot composition derives.
      const page = createPersistentMerchantSettlement({
        persistence: {
          ...session.persistence,
          transactions,
          // The staff session is checked at the instant it is used: the page reads in real time.
          now: () => new Date().toISOString(),
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
        settlementRunReference: async (_scope, window) =>
          dailySettlementRunReference({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            businessDate: window.businessDate,
            startsAt: window.startsAt,
            endsAt: window.endsAt,
          }).runReference,
        dayEndCheckAlerted: async () => false,
      });
      const day1 = await page({ sessionCookie: session.sessionCookie, businessDate: "2026-10-31" });
      assert.equal(day1.window.startsAt, first.startsAt);
      assert.equal(day1.window.endsAt, first.endsAt);
      assert.notEqual(day1.reconciliation.settlement, null, "the page finds the first day's run");
      assert.equal(day1.reconciliation.settlement.checks[0].outcome, "Matched");
      assert.equal(day1.dayEndCheck, null);
      // Nov 1 closed long ago with no run: not run, decided on server time; BOP not claimed told.
      const day2 = await page({ sessionCookie: session.sessionCookie, businessDate: "2026-11-01" });
      assert.equal(day2.reconciliation.settlement, null);
      assert.equal(day2.dayEndCheck.state, "NotRun");
      assert.equal(day2.dayEndCheck.supportAlerted, false);
      assert.ok(
        Math.abs(
          day2.dayEndCheck.closedForMs -
            (Date.parse(day2.projectedAt) - Date.parse("2026-11-02T09:00:00.000Z")),
        ) <= 1,
      );

      // A recorded start before the Store's records is refused; a later one never shortens it.
      const record = (window) => ({ scope: ownerScope, firstWindow: window });
      await assert.rejects(
        resolve(
          record({
            ...coverage.firstWindow,
            businessDate: "2026-10-30",
            startsAt: "2026-10-30T08:00:00.000Z",
            endsAt: "2026-10-31T08:00:00.000Z",
          }),
        ),
        new RegExp(DAILY_SETTLEMENT_COVERAGE_BEFORE_STORE_RECORDS, "u"),
      );
      const later = await resolve(
        record({
          ...coverage.firstWindow,
          businessDate: "2026-11-01",
          startsAt: "2026-11-01T09:00:00.000Z",
          endsAt: "2026-11-02T09:00:00.000Z",
        }),
      );
      assert.equal(later.firstWindow.businessDate, "2026-10-31");

      // Refused, as by a grant a migration left out: the cycle fails, it is never "not yet".
      await admin.query(
        `REVOKE SELECT ON rms_store.store_configuration_publication_content FROM ${api}`,
      );
      const refusedRun = createCoverageGatedRun({
        now,
        resolveCoverage: () => resolve(),
        build: () => assert.fail("never built without coverage"),
      });
      await assert.rejects(refusedRun());
      await admin.query(
        `GRANT SELECT ON rms_store.store_configuration_publication_content TO ${api}`,
      );
      assert.equal((await resolve()).kind, "Covered");
    } finally {
      await admin.end();
    }
  });
}, 180_000);
