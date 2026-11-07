import { createOrdinaryRefundProcessing } from "../../apps/api/dist/ordinary-refund-processing.js";
import { createOrdinaryRefundFailureRecorder } from "../../apps/api/dist/ordinary-refund-failure-recorder.js";
import { createOrdinaryRefundWorkload } from "../../apps/worker/dist/ordinary-refund-workload.js";

/**
 * Trusted local configuration. open() must clean up its own partial acquisition
 * if it rejects; after it returns, this workload owns close().
 * @param {{
 *   open: () => Promise<{
 *     processing: Parameters<typeof createOrdinaryRefundProcessing>[0],
 *     failure: Omit<Parameters<typeof createOrdinaryRefundFailureRecorder>[0], "scope" | "transactions">,
 *     close: () => Promise<void>
 *   }>,
 *   pageSize: number, pollIntervalMs: number, drainDeadlineMs: number
 * }} options
 */
export function createConfiguredOrdinaryRefundWorker(options) {
  let resource, child, startup, shutdown, closing;
  let state = "idle";
  let failed = false;
  let finish;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  const fail = () => {
    failed = true;
    finish("failed");
  };
  const close = () => {
    closing ??= Promise.resolve().then(() => resource?.close());
    return closing;
  };
  const start = () => {
    if (state !== "idle") return Promise.reject(new Error("ORDINARY_REFUND_WORKER_START_INVALID"));
    state = "starting";
    startup = (async () => {
      try {
        resource = await options.open();
        if (!resource || typeof resource.close !== "function")
          throw new Error("ORDINARY_REFUND_WORKER_RESOURCE_INVALID");
        if (state === "stopping") return;
        const processing = createOrdinaryRefundProcessing(resource.processing);
        const recordFailure = createOrdinaryRefundFailureRecorder({
          ...resource.failure,
          scope: resource.processing.payment.dispatch.scope,
          transactions: resource.processing.payment.transactions,
        });
        child = createOrdinaryRefundWorkload({
          ...processing,
          recordFailure,
          pageSize: options.pageSize,
          pollIntervalMs: options.pollIntervalMs,
          drainDeadlineMs: options.drainDeadlineMs,
        });
        void child.completion.then(() => {
          if (state !== "stopping" && state !== "stopped") fail();
        }, fail);
        await child.start();
        if (state === "starting") state = "running";
      } catch {
        fail();
        try {
          try {
            await child?.stop();
          } finally {
            await close();
          }
        } catch {
          // Completion is already failed; never leak adapter/configuration errors.
        }
        throw new Error("ORDINARY_REFUND_WORKER_START_FAILED");
      }
    })();
    return startup;
  };
  const stop = () => {
    if (shutdown) return shutdown;
    state = "stopping";
    shutdown = (async () => {
      let stopFailed = false,
        closeFailed = false;
      try {
        await startup?.catch(() => undefined);
        await child?.stop();
      } catch {
        stopFailed = true;
        fail();
      }
      try {
        await close();
      } catch {
        closeFailed = true;
        fail();
      }
      state = "stopped";
      finish(failed ? "failed" : "stopped");
      if (closeFailed) throw new Error("ORDINARY_REFUND_WORKER_CLOSE_FAILED");
      if (stopFailed) throw new Error("ORDINARY_REFUND_WORKER_STOP_FAILED");
    })();
    return shutdown;
  };
  return Object.freeze({ start, stop, completion });
}
