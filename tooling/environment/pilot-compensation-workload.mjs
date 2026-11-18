import console from "node:console";
import { createPaymentCompensationWorkload } from "../../apps/worker/dist/payment-compensation-workload.js";
import { supervisedCycleFailures } from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,79}$/u;
export async function createOptionalCompensationWorkloads({
  enabled,
  resources,
  onSnapshot,
  createService,
}) {
  if (enabled !== true) return [];
  if (!isPilotRuntime() || typeof createService !== "function")
    throw new Error("PILOT_COMPENSATION_UNAVAILABLE");
  const service = await createService(resources);
  if (
    !service ||
    ["discover", "execute", "afterExecute", "recordFailure", "recoverProjectionPage"].some(
      (key) => typeof service[key] !== "function",
    )
  )
    throw new Error("PILOT_COMPENSATION_UNAVAILABLE");
  return [
    createPaymentCompensationWorkload({
      discover: async (input) => {
        // WP-2423 pilot resilience: projection/receipt repair is housekeeping; its failure must
        // not hold back discovering and refunding paid orders. It is retried next cycle.
        try {
          await service.recoverProjectionPage();
        } catch (error) {
          const code = error?.code ?? error?.message;
          console.error(
            JSON.stringify({
              event: "INTERNAL_COMPENSATION_REPAIR_FAILED",
              code: typeof code === "string" && SAFE_CODE.test(code) ? code : null,
            }),
          );
        }
        return service.discover(input);
      },
      execute: (value) => service.execute(value),
      afterExecute: (candidate, result) => service.afterExecute(candidate, result),
      recordFailure: (candidate, code) => service.recordFailure(candidate, code),
      ...(typeof service.stillWaiting === "function"
        ? { stillWaiting: (candidate, result) => service.stillWaiting(candidate, result) }
        : {}),
      // WP-2423 b30: a payment whose lease another worker holds is skipped quietly: no failure
      // audit, no back-off; the next cycle looks again.
      skipped: (error) => error?.code === "PAYMENT_COMPENSATION_LEASE_HELD",
      // WP-2423 b30 (v15 lease churn): a case that needs a person to reconcile it changes only
      // when the Provider's record or another refund changes; it is rechecked (with a lease) at
      // least every ten minutes, not every minute.
      unchangedBackoffMaxMsFor: (result) =>
        result?.status === "ReconciliationRequired" ? 600_000 : undefined,
      pageSize: 5,
      pollIntervalMs: 5000,
      // An unchanged open case is rechecked at least every minute, so a case closes within a minute
      // of the Store recording its operations reconciliation (by a read while it only waits).
      unchangedBackoffMaxMs: 60_000,
      drainDeadlineMs: 25000,
      supervision: supervisedCycleFailures,
      ...(onSnapshot ? { onSnapshot } : {}),
    }),
  ];
}
