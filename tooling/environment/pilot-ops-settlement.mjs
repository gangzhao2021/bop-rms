// WP-2423 Q13: the daily settlement status for the operations monitor, wired exactly as the
// existing status command (pilot-daily-settlement-status-cli.mjs) over the owner run source.
import { createPostgresPaymentReconciliationRunSource } from "../../packages/rms/payment/src/index.ts";
import { readPilotDailySettlementStatus } from "./pilot-daily-settlement-status.mjs";
import { matchesPilotEnvironment } from "./pilot-environment.mjs";
import { createInternalClosedSettlementWindow } from "./pilot-settlement-window.mjs";

export async function readPilotSettlementProblems({ resources, installation }) {
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
  return readPilotDailySettlementStatus({
    coverage: await installation.loadDailySettlementCoverage(),
    scope: resources.scope,
    now: resources.now,
    readWindow: createInternalClosedSettlementWindow({ resources, active }),
    readRun: (q) => resources.transactions.run((tx) => read(tx, q)),
  });
}
