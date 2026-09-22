import { createOutboxWorkload, type OutboxWorkloadSnapshot } from "./outbox-workload.js";

/** Owner ports perform scoped discovery, durable execution and failure recording.
 * Cursors are scan progress only: restart/full-round reset replays durable owner work.
 */
export function createPaymentCompensationWorkload<
  T extends { readonly dispositionReference: string },
>(options: {
  readonly discover: (input: {
    readonly afterDispositionReference: string | null;
    readonly limit: number;
  }) => Promise<{
    readonly candidates: readonly T[];
    readonly nextAfterDispositionReference: string | null;
  }>;
  readonly execute: (candidate: T) => Promise<unknown>;
  /** Refresh dependent projections after durable execution, including replay of Closed cases.
   * A failure is recorded and retried by the next owner scan; it cannot undo the refund.
   */
  readonly afterExecute?: (candidate: T, result: unknown) => Promise<void>;
  readonly recordFailure: (candidate: T, code: "COMPENSATION_EXECUTION_FAILED") => Promise<void>;
  readonly pageSize: number;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
  readonly onSnapshot?: (snapshot: OutboxWorkloadSnapshot) => void;
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("COMPENSATION_WORKLOAD_CONFIG_INVALID");
  const pageSize = options.pageSize;
  let cursor: string | null = null,
    stopping = false;
  const workload = createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        if (stopping) return 0;
        const page = await options.discover({ afterDispositionReference: cursor, limit: pageSize });
        if (!Array.isArray(page.candidates) || page.candidates.length > pageSize)
          throw new Error("COMPENSATION_DISCOVERY_INVALID");
        let previous = cursor;
        for (const candidate of page.candidates) {
          if (
            !candidate ||
            typeof candidate.dispositionReference !== "string" ||
            candidate.dispositionReference.length === 0 ||
            (previous !== null && candidate.dispositionReference <= previous)
          )
            throw new Error("COMPENSATION_DISCOVERY_INVALID");
          previous = candidate.dispositionReference;
        }
        if (
          page.nextAfterDispositionReference !== null &&
          (page.candidates.length !== pageSize || page.nextAfterDispositionReference !== previous)
        )
          throw new Error("COMPENSATION_DISCOVERY_INVALID");
        let executed = 0;
        for (const candidate of page.candidates) {
          if (stopping) break;
          try {
            const result = await options.execute(candidate);
            await options.afterExecute?.(candidate, result);
          } catch {
            // Never forward raw Provider/errors to generic worker logging.
            await options.recordFailure(candidate, "COMPENSATION_EXECUTION_FAILED");
          }
          executed++;
        }
        if (!stopping) cursor = page.nextAfterDispositionReference;
        return executed;
      },
      async stop() {
        return "drained" as const;
      },
    },
  });
  return Object.freeze({
    completion: workload.completion,
    snapshot: workload.snapshot,
    start: workload.start,
    stop() {
      stopping = true;
      return workload.stop();
    },
  });
}
