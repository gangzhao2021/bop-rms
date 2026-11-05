// WP-2423 Q13: the daily settlement status for the operations monitor, wired exactly as the
// existing status command (pilot-daily-settlement-status-cli.mjs) over the owner run source.
import { createPostgresPaymentReconciliationRunSource } from "../../packages/rms/payment/src/index.ts";
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

/** The read's own "no closed day yet": no published hours before today's business day began. */
const NO_CLOSED_DAY = new Set([
  "STORE_BUSINESS_DATE_UNAVAILABLE",
  "SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE",
]);
/** Set by the transaction runner when a query of the transaction failed (packages/database). */
const DATABASE_FAILURE = Symbol.for("bop.database.failure");

/**
 * DEC-PILOT-ALERTS-BACKUP correction 2: whether this Store has a closed business day to settle (its
 * published hours were in force before today's business day began). Only the read's own answer
 * says no. A read that was refused or failed throws: otherwise a grant a migration left out would
 * hide for good that this Store's payments are not compared with the Provider.
 */
export async function readPilotHasClosedBusinessDay({ resources, installation }) {
  const days = createInternalSettlementDays({
    resources,
    active: activeInstallation({ resources, installation }),
  });
  try {
    await days.bounds();
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      NO_CLOSED_DAY.has(error.message) &&
      Object.getOwnPropertyDescriptor(error, DATABASE_FAILURE) === undefined
    )
      return false;
    throw error;
  }
}

export async function readPilotSettlementProblems({ resources, installation }) {
  const active = activeInstallation({ resources, installation });
  const read = createPostgresPaymentReconciliationRunSource({
    scope: resources.scope,
    authorize: active,
  });
  const days = createInternalSettlementDays({ resources, active });
  return readPilotDailySettlementStatus({
    coverage: await installation.loadDailySettlementCoverage(),
    scope: resources.scope,
    now: resources.now,
    readWindow: days.window,
    // A day whose window is refused is listed (missing) instead of hiding every day.
    readBounds: days.bounds,
    readRun: (q) => resources.transactions.run((tx) => read(tx, q)),
  });
}
