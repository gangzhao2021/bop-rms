import { join } from "node:path";
import process from "node:process";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { isPilotRuntime, matchesPilotEnvironment } from "./pilot-environment.mjs";
import { createPilotPaymentProvider } from "./pilot-stripe-provider.mjs";
import { createInternalReconciliationRuntime } from "./pilot-reconciliation-runtime.mjs";
import { createInternalDailySettlementSource } from "./pilot-daily-settlement-source.mjs";
import { createInternalSettlementDays } from "./pilot-settlement-window.mjs";
import { createDailySettlementBacklog } from "./pilot-daily-settlement-backlog.mjs";
import {
  createDailySettlementRecheck,
  withDailySettlementRecheck,
} from "./pilot-daily-settlement-recheck.mjs";
import { createPostgresPaymentReconciliationRunSource } from "../../packages/rms/payment/src/index.ts";
// WP-2423 (v15 2026-10-28 finding c): `resources` are a background worker's
// (createBackgroundPilotResources): a menu listing in flight delays these reads, never fails them.
export async function createConfiguredDailySettlementExecution(directory, resources) {
  const installation = await loadPilotInstallation(directory),
    config = await installation.loadCustomerRuntime(),
    coverage = await installation.loadDailySettlementCoverage();
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
      coverage,
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
    const runOnce = withDailySettlementRecheck({
      // Days are found by their bounds; each day's window is verified when it is settled.
      backlog: createDailySettlementBacklog({
        ...shared,
        readBounds: days.bounds,
        onDayFailure: reportDailySettlementDayFailure,
      }),
      // Re-checks walk days by bounds too; preparing a day verifies its window.
      recheck: createDailySettlementRecheck({ ...shared, readWindow: days.bounds }),
      now: resources.now,
    });
    return { runOnce, close: () => simulator.close() };
  } catch (error) {
    simulator.close();
    throw error;
  }
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
