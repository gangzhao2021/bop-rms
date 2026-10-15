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
      pageSize: 5,
      pollIntervalMs: 5000,
      // An unchanged open case is rechecked at least every minute, so a case closes within a minute
      // of the Store recording its operations reconciliation.
      unchangedBackoffMaxMs: 60_000,
      drainDeadlineMs: 25000,
      supervision: supervisedCycleFailures,
      ...(onSnapshot ? { onSnapshot } : {}),
    }),
  ];
}
