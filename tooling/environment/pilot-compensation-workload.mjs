import process from "node:process";
import { createPaymentCompensationWorkload } from "../../apps/worker/dist/payment-compensation-workload.js";
export async function createOptionalCompensationWorkloads({
  enabled,
  resources,
  onSnapshot,
  createService,
}) {
  if (enabled !== true) return [];
  if (process.env.NODE_ENV !== "development" || typeof createService !== "function")
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
        await service.recoverProjectionPage();
        return service.discover(input);
      },
      execute: (value) => service.execute(value),
      afterExecute: (candidate, result) => service.afterExecute(candidate, result),
      recordFailure: (candidate, code) => service.recordFailure(candidate, code),
      pageSize: 5,
      pollIntervalMs: 5000,
      drainDeadlineMs: 25000,
      ...(onSnapshot ? { onSnapshot } : {}),
    }),
  ];
}
