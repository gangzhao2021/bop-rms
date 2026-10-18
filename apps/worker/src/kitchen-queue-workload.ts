import { createOutboxWorkload } from "./outbox-workload.js";

/** Schedules real bounded owner snapshot comparison/activation. Owner refresh
 * returns zero for unchanged source and one only after durable activation.
 */
export function createKitchenQueueWorkload(options: {
  readonly refresh: () => Promise<0 | 1>;
  readonly close: () => Promise<void>;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
  readonly onSnapshot?: Parameters<typeof createOutboxWorkload>[0]["onSnapshot"];
  /** Supervised cycle failures (pilot workers): one failure never stops sibling workloads. */
  readonly supervision?: Parameters<typeof createOutboxWorkload>[0]["supervision"];
}) {
  let closing: Promise<void> | undefined;
  return createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    ...(options.supervision ? { supervision: options.supervision } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        try {
          const result = await options.refresh();
          if (result !== 0 && result !== 1) throw new Error("invalid refresh result");
          return result;
        } catch (error) {
          // The cause keeps only what classification and safe logging read (code, SQLSTATE).
          throw new Error("KITCHEN_QUEUE_REFRESH_UNAVAILABLE", { cause: error });
        }
      },
      async stop() {
        closing ??= Promise.resolve().then(options.close);
        await closing;
        return "drained";
      },
    },
  });
}
