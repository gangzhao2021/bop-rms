import { join } from "node:path";
import process from "node:process";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { isPilotRuntime, matchesPilotEnvironment } from "./pilot-environment.mjs";
import { createPilotPaymentProvider } from "./pilot-stripe-provider.mjs";
import { createInternalReconciliationRuntime } from "./pilot-reconciliation-runtime.mjs";
import { createInternalDailySettlementSource } from "./pilot-daily-settlement-source.mjs";
import { createInternalSettlementDays } from "./pilot-settlement-window.mjs";
import { createDailySettlementBacklog } from "./pilot-daily-settlement-backlog.mjs";
import { resolveDailySettlementCoverage } from "./pilot-daily-settlement-coverage.mjs";
import {
  createDailySettlementRecheck,
  withDailySettlementRecheck,
} from "./pilot-daily-settlement-recheck.mjs";
import { createPostgresPaymentReconciliationRunSource } from "../../packages/rms/payment/src/index.ts";
// WP-2423 (v15 2026-10-28 finding c): `resources` are a background worker's
// (createBackgroundPilotResources): a menu listing in flight delays these reads, never fails them.
export async function createConfiguredDailySettlementExecution(directory, resources) {
  const installation = await loadPilotInstallation(directory),
    config = await installation.loadCustomerRuntime();
  const simulator = await createPilotPaymentProvider(
    {},
    {
      directory,
      path: join(directory, "simulated-provider.sqlite"),
      loadProfile: installation.loadProfile,
      expectedDatabaseName: installation.database,
    },
  );
  try {
    const active = async () => {
      const p = await installation.loadProfile();
      return (
        // DEC-PILOT-RUNTIME-ENVIRONMENT: either pilot process; the profile declares the same one.
        isPilotRuntime() &&
        matchesPilotEnvironment(p.environment) &&
        p.database === installation.database &&
        p.binding.brandReference === resources.scope.brandReference &&
        p.binding.storeReference === resources.scope.storeReference &&
        resources.now() < p.binding.validUntil
      );
    };
    const runtime = createInternalReconciliationRuntime({
      resources,
      simulator,
      providerAccountReference: config.providerAccountReference,
    });
    const read = createPostgresPaymentReconciliationRunSource({
      scope: resources.scope,
      authorize: active,
    });
    const days = createInternalSettlementDays({ resources, active });
    const shared = {
      scope: resources.scope,
      now: resources.now,
      readWindow: days.window,
      prepare: createInternalDailySettlementSource({
        resources,
        simulator,
        providerAccountReference: config.providerAccountReference,
        active,
      }),
      readRun: (q) => resources.transactions.run((tx) => read(tx, q)),
      execute: (q, c) => runtime.run(q, c),
    };
    // WP-2423: the worker always runs; it settles from the Store's own first business day once
    // that day has closed (or from a Pilot Store's issued record).
    const runOnce = createCoverageGatedRun({
      now: resources.now,
      resolveCoverage: () => resolveDailySettlementCoverage({ installation, days }),
      build: (coverage) =>
        withDailySettlementRecheck({
          // Days are found by their bounds; each day's window is verified when it is settled.
          backlog: createDailySettlementBacklog({
            ...shared,
            coverage,
            readBounds: days.bounds,
            onDayFailure: reportDailySettlementDayFailure,
          }),
          // Re-checks walk days by bounds too; preparing a day verifies its window.
          recheck: createDailySettlementRecheck({ ...shared, coverage, readWindow: days.bounds }),
          now: resources.now,
        }),
    });
    return { runOnce, close: () => simulator.close() };
  } catch (error) {
    simulator.close();
    throw error;
  }
}

export const DAILY_SETTLEMENT_COVERAGE_RECHECK_MS = 60_000;
const IDLE = Object.freeze({ status: "Idle", checkCount: 0 });
/**
 * WP-2423: Idle until coverage resolves (the Store's first business day has closed), asking again
 * at most every `recheckMs`; then the settlement built for that coverage runs from there on. A
 * coverage read that fails throws, so the cycle is reported failed (health attention), never Idle.
 */
export function createCoverageGatedRun({
  resolveCoverage,
  build,
  now,
  recheckMs = DAILY_SETTLEMENT_COVERAGE_RECHECK_MS,
}) {
  let run = null,
    nextAt = -Infinity;
  return async () => {
    if (run === null) {
      const at = Date.parse(now());
      if (at < nextAt) return IDLE;
      const coverage = await resolveCoverage();
      if (coverage?.kind === "NotYet") {
        nextAt = at + recheckMs;
        return IDLE;
      }
      if (coverage?.kind !== "Covered") throw Error("DAILY_SETTLEMENT_COVERAGE_UNAVAILABLE");
      run = build(coverage);
    }
    return run();
  };
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,79}$/u;
/** One service-log line per failed day attempt: the business date and a safe code only. */
export function reportDailySettlementDayFailure({ businessDate, failures, error }) {
  let code = null;
  try {
    for (const key of ["code", "message"]) {
      const value = Object.getOwnPropertyDescriptor(error ?? {}, key)?.value;
      if (typeof value === "string" && SAFE_CODE.test(value)) {
        code = value;
        break;
      }
    }
  } catch {
    /* Untrusted errors must never break reporting. */
  }
  process.stderr.write(
    JSON.stringify({
      level: 50,
      time: new Date().toISOString(),
      module: "pilot-daily-settlement",
      event: "daily_settlement_day_failed",
      businessDate: /^\d{4}-\d{2}-\d{2}$/u.test(businessDate) ? businessDate : null,
      failures: Number.isSafeInteger(failures) ? failures : null,
      code,
    }) + "\n",
  );
}
