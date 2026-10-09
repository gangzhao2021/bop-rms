import { createOutboxWorkload } from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
/** Opt-in assembly only. The injected owner dispatcher retains all publication and financial gates. */
export async function createOptionalBatchCancellationWorkloads({
  enabled,
  resources,
  onSnapshot,
  createDispatcher,
}) {
  if (enabled !== true) return [];
  if (!isPilotRuntime() || typeof createDispatcher !== "function")
    throw new Error("PILOT_BATCH_CANCELLATION_UNAVAILABLE");
  const dispatcher = await createDispatcher(resources);
  return [
    createOutboxWorkload({
      dispatcher,
      pollIntervalMs: 5000,
      drainDeadlineMs: 25000,
      ...(onSnapshot ? { onSnapshot } : {}),
    }),
  ];
}
