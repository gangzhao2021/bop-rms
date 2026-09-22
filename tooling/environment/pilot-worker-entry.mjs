import process from "node:process";
import { startWorkerRuntime } from "../../apps/worker/dist/index.js";
import { createKitchenQueueWorkload } from "../../apps/worker/dist/kitchen-queue-workload.js";
import {
  createPilotWorkloadHealthObserver,
  createPilotKitchenHealthObserver,
} from "./pilot-workload-health.mjs";
function resourceCloser(resources) {
  let closing;
  return () => (closing ??= Promise.resolve().then(() => resources.close()));
}
export async function startPilotBusinessWorker({
  directory,
  createInternalTestResources,
  createInternalWorker,
  enableBatchCancellation = false,
  enableCompensation = false,
  startRuntime = startWorkerRuntime,
}) {
  const resources = await createInternalTestResources(),
    close = resourceCloser(resources);
  try {
    const worker = await createInternalWorker(
      resources,
      {
        ...(enableBatchCancellation === true
          ? {
              batchCancellation: createPilotWorkloadHealthObserver(
                directory,
                "business-batch-cancellation",
              ),
            }
          : {}),
        ...(enableCompensation === true
          ? { compensation: createPilotWorkloadHealthObserver(directory, "business-compensation") }
          : {}),
        events: createPilotWorkloadHealthObserver(directory, "business-events"),
        paymentWait: createPilotWorkloadHealthObserver(directory, "business-payment-wait"),
        diningCheckoutExpiry: createPilotWorkloadHealthObserver(
          directory,
          "business-dining-checkout-expiry",
        ),
      },
      {
        cartExpiry: true,
        diningCheckoutExpiry: true,
        batchCancellation: enableBatchCancellation === true,
        compensation: enableCompensation === true,
      },
    );
    await startRuntime({
      workload: {
        completion: worker.workload.completion,
        start: () => worker.workload.start(),
        stop: async () => {
          try {
            await worker.workload.stop();
          } finally {
            await close();
          }
        },
      },
    });
  } catch {
    await close();
    process.exitCode = 1;
  }
}
export async function startPilotKitchenWorker({
  directory,
  createInternalTestResources,
  createInternalKitchenQueue,
  startRuntime = startWorkerRuntime,
}) {
  const resources = await createInternalTestResources(),
    close = resourceCloser(resources);
  try {
    const model = createInternalKitchenQueue(resources);
    await startRuntime({
      workload: createKitchenQueueWorkload({
        onSnapshot: createPilotKitchenHealthObserver(directory),
        refresh: () => model.refresh(),
        close,
        pollIntervalMs: 5000,
        drainDeadlineMs: 10000,
      }),
    });
  } catch {
    await close();
    process.exitCode = 1;
  }
}
