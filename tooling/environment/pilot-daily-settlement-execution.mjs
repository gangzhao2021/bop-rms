import { join } from "node:path";
import process from "node:process";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createInternalSimulatedProvider } from "./pilot-payment-provider.mjs";
import { createInternalReconciliationRuntime } from "./pilot-reconciliation-runtime.mjs";
import { createInternalDailySettlementSource } from "./pilot-daily-settlement-source.mjs";
import { createInternalClosedSettlementWindow } from "./pilot-settlement-window.mjs";
import { createDailySettlementBacklog } from "./pilot-daily-settlement-backlog.mjs";
import { createPostgresPaymentReconciliationRunSource } from "../../packages/rms/payment/src/index.ts";
export async function createConfiguredDailySettlementExecution(directory, resources) {
  const installation = await loadPilotInstallation(directory),
    config = await installation.loadCustomerRuntime(),
    coverage = await installation.loadDailySettlementCoverage();
  const simulator = await createInternalSimulatedProvider(
    {},
    {
      path: join(directory, "simulated-provider.sqlite"),
      loadProfile: installation.loadProfile,
      expectedDatabaseName: installation.database,
    },
  );
  try {
    const active = async () => {
      const p = await installation.loadProfile();
      return (
        process.env.NODE_ENV === "development" &&
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
    const runOnce = createDailySettlementBacklog({
      coverage,
      scope: resources.scope,
      now: resources.now,
      readWindow: createInternalClosedSettlementWindow({ resources, active }),
      prepare: createInternalDailySettlementSource({
        resources,
        simulator,
        providerAccountReference: config.providerAccountReference,
        active,
      }),
      readRun: (q) => resources.transactions.run((tx) => read(tx, q)),
      execute: (q, c) => runtime.run(q, c),
    });
    return { runOnce, close: () => simulator.close() };
  } catch (error) {
    simulator.close();
    throw error;
  }
}
