// WP-2423 Q13: the daily settlement status for the operations monitor, wired exactly as the
// existing status command (pilot-daily-settlement-status-cli.mjs) over the owner run source.
import { createPostgresPaymentReconciliationRunSource } from "../../packages/rms/payment/src/index.ts";
import { resolveDailySettlementCoverage } from "./pilot-daily-settlement-coverage.mjs";
import { readPilotDailySettlementStatus } from "./pilot-daily-settlement-status.mjs";
import { matchesPilotEnvironment } from "./pilot-environment.mjs";
import { createInternalSettlementDays } from "./pilot-settlement-window.mjs";

const activeInstallation =
  ({ resources, installation }) =>
  async () => {
    const p = await installation.loadProfile();
    return (
      matchesPilotEnvironment(p.environment) &&
      p.database === installation.database &&
      p.binding.brandReference === resources.scope.brandReference &&
      p.binding.storeReference === resources.scope.storeReference &&
      resources.now() < p.binding.validUntil
    );
  };

/**
 * WP-2423 (settlement-coverage): every closed business day from where the Store's settlement
 * starts (its own first business day, or a Pilot Store's issued record), each Recorded or Missing.
 * No closed day yet is an empty list. A read that was refused or failed throws: a grant a migration
 * left out must never read as "every day settled".
 */
export async function readPilotSettlementProblems({ resources, installation }) {
  const active = activeInstallation({ resources, installation });
  const read = createPostgresPaymentReconciliationRunSource({
    scope: resources.scope,
    authorize: active,
  });
  const days = createInternalSettlementDays({ resources, active });
  const coverage = await resolveDailySettlementCoverage({ installation, days });
  if (coverage.kind === "NotYet") return Object.freeze({ days: Object.freeze([]) });
  return readPilotDailySettlementStatus({
    coverage,
    scope: resources.scope,
    now: resources.now,
    readWindow: days.window,
    // A day whose window is refused is listed (missing) instead of hiding every day.
    readBounds: days.bounds,
    readRun: (q) => resources.transactions.run((tx) => read(tx, q)),
  });
}
