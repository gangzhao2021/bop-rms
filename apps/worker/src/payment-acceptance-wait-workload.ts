import { createOutboxWorkload } from "./outbox-workload.js";

/** Durable owner records are the queue; cursor is only fair scan progress.
 * Unsupervised, errors fail the workload instead of silently retrying or discarding paid work.
 * Supervised (pilot), a failed cycle is retried and reported in health; paid work is never dropped
 * because discovery rescans the durable owner records.
 */
export function createPaymentAcceptanceWaitWorkload(options: {
  discover(limit: number, after: string | null): Promise<readonly string[]>;
  resume(eventReference: string): Promise<unknown>;
  pageSize: number;
  pollIntervalMs: number;
  drainDeadlineMs: number;
  readonly onSnapshot?: Parameters<typeof createOutboxWorkload>[0]["onSnapshot"];
  /** Supervised cycle failures (pilot workers): one failure never stops sibling workloads. */
  readonly supervision?: Parameters<typeof createOutboxWorkload>[0]["supervision"];
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("PAYMENT_WAIT_CONFIG_INVALID");
  let cursor: string | null = null;
  let stopping = false;
  const workload = createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    ...(options.supervision ? { supervision: options.supervision } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        if (stopping) return 0;
        const events = await options.discover(options.pageSize, cursor);
        if (!Array.isArray(events) || events.length > options.pageSize)
          throw new Error("PAYMENT_WAIT_DISCOVERY_INVALID");
        let previous = cursor;
        for (const event of events) {
          if (typeof event !== "string" || !event || (previous !== null && event <= previous))
            throw new Error("PAYMENT_WAIT_DISCOVERY_INVALID");
          previous = event;
        }
        let processed = 0;
        for (const event of events) {
          if (stopping) break;
          await options.resume(event);
          processed++;
        }
        if (!stopping) cursor = events.length === options.pageSize ? previous : null;
        return processed;
      },
      async stop() {
        return "drained" as const;
      },
    },
  });
  return Object.freeze({
    completion: workload.completion,
    start: workload.start,
    stop() {
      stopping = true;
      return workload.stop();
    },
  });
}
