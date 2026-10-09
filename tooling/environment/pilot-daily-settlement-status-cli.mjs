import console from "node:console";
import process from "node:process";
import path from "node:path";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createInternalClosedSettlementWindow } from "./pilot-settlement-window.mjs";
import { createPostgresPaymentReconciliationRunSource } from "../../packages/rms/payment/src/index.ts";
import { parsePilotRuntimeDirectory } from "./pilot-service.mjs";
import { readPilotDailySettlementStatus } from "./pilot-daily-settlement-status.mjs";
import { isPilotRuntime, matchesPilotEnvironment } from "./pilot-environment.mjs";
let resources;
try {
  if (!isPilotRuntime() || process.argv.length !== 3) throw Error("UNAVAILABLE");
  const directory = path.resolve(parsePilotRuntimeDirectory(process.argv[2]));
  const installation = await loadPilotInstallation(directory);
  resources = await createConfiguredPilotResources(directory);
  const active = async () => {
    const p = await installation.loadProfile();
    return (
      matchesPilotEnvironment(p.environment) &&
      p.database === installation.database &&
      p.binding.brandReference === resources.scope.brandReference &&
      p.binding.storeReference === resources.scope.storeReference &&
      resources.now() < p.binding.validUntil
    );
  };
  const read = createPostgresPaymentReconciliationRunSource({
    scope: resources.scope,
    authorize: active,
  });
  const result = await readPilotDailySettlementStatus({
    coverage: await installation.loadDailySettlementCoverage(),
    scope: resources.scope,
    now: resources.now,
    readWindow: createInternalClosedSettlementWindow({ resources, active }),
    readRun: (q) => resources.transactions.run((tx) => read(tx, q)),
  });
  console.log(JSON.stringify(result));
} catch {
  console.error("DAILY_SETTLEMENT_STATUS_UNAVAILABLE");
  process.exitCode = 1;
} finally {
  await resources?.close();
}
