import { createOutboxWorkload } from "./outbox-workload.js";

/** Owner ports perform scoped discovery, durable execution and failure recording.
 * Cursors are scan progress only: restart/full-round reset replays durable owner work.
 */
export function createOrdinaryRefundWorkload<
  T extends { readonly operationReference: string; readonly workKind: "Dispatch" | "Reconcile" },
>(options: {
  readonly discover: (input: {
    readonly afterOperationReference: string | null;
    readonly limit: number;
  }) => Promise<{
    readonly candidates: readonly T[];
    readonly nextAfterOperationReference: string | null;
  }>;
  readonly dispatch: (candidate: T) => Promise<unknown>;
  readonly reconcile: (candidate: T) => Promise<unknown>;
  /** Runs after durable reconciliation, including later scans, so failed receipt/
   * projection work can recover. The owner must verify confirmed outcome before issuance. */
  readonly afterReconcile: (candidate: T, result: unknown) => Promise<void>;
  readonly recordFailure: (candidate: T, code: "ORDINARY_REFUND_EXECUTION_FAILED") => Promise<void>;
  readonly pageSize: number;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("ORDINARY_REFUND_WORKLOAD_CONFIG_INVALID");
  const pageSize = options.pageSize;
  let cursor: string | null = null,
    stopping = false;
  const workload = createOutboxWorkload({
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        if (stopping) return 0;
        const page = await options.discover({ afterOperationReference: cursor, limit: pageSize });
        if (!Array.isArray(page.candidates) || page.candidates.length > pageSize)
          throw new Error("ORDINARY_REFUND_DISCOVERY_INVALID");
        let previous = cursor;
        for (const candidate of page.candidates) {
          if (
            !candidate ||
            typeof candidate.operationReference !== "string" ||
            candidate.operationReference.length === 0 ||
            !["Dispatch", "Reconcile"].includes(candidate.workKind) ||
            (previous !== null && candidate.operationReference <= previous)
          )
            throw new Error("ORDINARY_REFUND_DISCOVERY_INVALID");
          previous = candidate.operationReference;
        }
        if (
          page.nextAfterOperationReference !== null &&
          (page.candidates.length !== pageSize || page.nextAfterOperationReference !== previous)
        )
          throw new Error("ORDINARY_REFUND_DISCOVERY_INVALID");
        let executed = 0;
        for (const candidate of page.candidates) {
          if (stopping) break;
          try {
            if (candidate.workKind === "Dispatch") await options.dispatch(candidate);
            else {
              const result = await options.reconcile(candidate);
              await options.afterReconcile(candidate, result);
            }
          } catch {
            // Never forward raw Provider/errors to generic worker logging.
            await options.recordFailure(candidate, "ORDINARY_REFUND_EXECUTION_FAILED");
          }
          executed++;
        }
        if (!stopping) cursor = page.nextAfterOperationReference;
        return executed;
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
